/**
 * The simulation grader dispatch.  (P7-T4)
 *
 * ## `INV-SIM-2`: A STUDENT IS NEVER AUTO-ZEROED BECAUSE OUR CODE FAILED
 *
 * That invariant is the reason this module exists in the shape it does. A simulation's grader is a third-party
 * bundle we did not write, running in a worker, against a state we did not produce. It can throw, hang, time out
 * or return something unreadable, and **every one of those is our failure and not the student's**.
 *
 * So the dispatch has exactly two outcomes: a grade, or `NEEDS_HUMAN` with a reason. There is no path from "the
 * sim's grader threw" to "0 marks", because a student cannot be penalised for a defect in code we shipped --
 * and a zero is indistinguishable, in a release batch, from a wrong answer. A marker seeing a run of zeros
 * would mark them wrong, and the student would have no way to contest it.
 *
 * ## AND `scoringSurface` IS MANDATORY, BECAUSE WITHOUT IT THE ITEM MEASURES SEARCHING
 *
 * `V-11`: "`sim:answer` is overwritable indefinitely; hiding the `sim:gradePreview` FRAME is not the same as
 * suppressing the sim's own rendered 'Correct [check]'. The item then measures parameter-space search -- and its
 * facility will look EXCELLENT."
 *
 * A student's facility looks excellent when the answer can be retried until it is right, so `ENDPOINT_ONLY`
 * declares that only the final answer is read, and `PATH_SENSITIVE` that the grader consumes the interaction
 * trace. Without the field we cannot tell which we are grading, so `publishRefusal` refuses the item rather than
 * guessing -- an unguarded sim question is a search problem wearing a measurement's clothes.
 */

/**
 * WHAT THE GRADER IS PERMITTED TO READ.
 *
 * `ENDPOINT_ONLY` reads the final answer and nothing else, which is the honest description of a question whose
 * only state is "what did they end up with". `PATH_SENSITIVE` additionally reads a bounded interaction trace,
 * which is the only way a question can ask "did they get there by reasoning or by trying everything".
 */
export const SCORING_SURFACES = ['ENDPOINT_ONLY', 'PATH_SENSITIVE'] as const;
export type ScoringSurface = (typeof SCORING_SURFACES)[number];

/** A simulation manifest's declared surface, or null when it declares none -- which is a REFUSAL, not a default. */
export type DeclaredSurface = ScoringSurface | null | undefined;

export interface SimulationQuestionSpec {
  readonly simId: string;
  readonly simVersion: string;
  /** `V-11`: mandatory. A sim usable as a question must say which surface it grades. */
  readonly scoringSurface: DeclaredSurface;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** WHY A SIM ITEM MAY NOT BE PUBLISHED, or `null`. Written once, consulted by authoring and by the grader. */
export const simPublishRefusal = (spec: SimulationQuestionSpec): string | null => {
  const surface = spec.scoringSurface;
  if (surface === null || surface === undefined) {
    return (
      `${spec.simId}@${spec.simVersion} declares no scoringSurface, so an item built on it cannot say whether ` +
      'it is reading the final answer or the path taken. Without that field the item measures parameter-space ' +
      'search rather than understanding, and its facility will look excellent while measuring nothing (V-11). ' +
      'Declare ENDPOINT_ONLY or PATH_SENSITIVE.'
    );
  }
  if (!SCORING_SURFACES.includes(surface)) {
    return `scoringSurface ${String(surface)} is not one of ${SCORING_SURFACES.join(', ')}.`;
  }
  return null;
};

/** What a sim's grader returned, or why it did not. The two are never conflated. */
export type SimOutcome =
  | {
      readonly kind: 'GRADED';
      readonly points: number;
      readonly maxPoints: number;
      readonly code: string;
    }
  /**
   * `NEEDS_HUMAN`, AND THE REASON IS OURS.
   *
   * Named `TECHNICAL` rather than `INCORRECT` so it can never be rendered as a mark. Every arm here is a defect
   * in the platform, the simulation bundle, or the stored state -- never in the student's work.
   */
  | { readonly kind: 'NEEDS_HUMAN'; readonly reason: SimTechnicalReason; readonly detail: string };

export const SIM_TECHNICAL_REASONS = [
  'GRADER_THREW',
  'GRADER_TIMED_OUT',
  'GRADER_UNREADABLE',
  'GRADER_REFUSED_THE_SPEC',
  'STATE_FAILED_ITS_SCHEMA',
  'NO_SCORING_SURFACE',
] as const;
export type SimTechnicalReason = (typeof SIM_TECHNICAL_REASONS)[number];

/** A sim's grader, exactly as its Node bundle declares it: `grade(state, params, answer)`. */
export type SimGrader = (
  state: unknown,
  params: Readonly<Record<string, unknown>>,
  answer: unknown,
) => { points: unknown; maxPoints?: unknown; code?: unknown };

export interface DispatchInput {
  readonly spec: SimulationQuestionSpec;
  /** The student's stored state. Read by the grader when the surface is `PATH_SENSITIVE` as well. */
  readonly state: unknown;
  readonly answer: unknown;
  /**
   * The student's bounded interaction trace. Required by `PATH_SENSITIVE` and IGNORED by `ENDPOINT_ONLY` --
   * which is the whole difference between the two surfaces.
   */
  readonly trace?: readonly unknown[];
  /** Resolves the sim's Node grader bundle. Rejects or throws if the bundle is missing or broken. */
  readonly loadGrader: (simId: string, simVersion: string) => Promise<SimGrader>;
  /** Validates the stored state against the sim's declared `stateSchema`. Rejects if it does not fit. */
  readonly validateState: (simId: string, simVersion: string, state: unknown) => boolean;
  /** Milliseconds before the worker is abandoned. Present because a hung bundle must not hang a submission. */
  readonly timeoutMs?: number;
}

const timedOut = (detail: string): SimOutcome => ({
  kind: 'NEEDS_HUMAN',
  reason: 'GRADER_TIMED_OUT',
  detail,
});

/**
 * THE DISPATCH. Total by construction: every arm returns a `SimOutcome`, and none of them returns zero.
 *
 * ## AND WHAT THIS TIMEOUT ACTUALLY CATCHES, WHICH IS NOT EVERYTHING
 *
 * It catches a hung LOADER — `loadGrader` is genuinely async, and a registry read or a dynamic import that
 * never settles is resolved by the timer.
 *
 * It does NOT catch a grader whose body BLOCKS. `Promise.race` resolves the timer on a MICROTASK, and a
 * microtask never runs while a synchronous call is on the stack, so an infinite loop inside the grader
 * suspends the submission with no timer in the world able to interrupt it. There is no version of this that
 * fixes it in-process, because the thread cannot observe its own timer.
 *
 * So the escape is the one this module names and does not perform: the grader runs in a WORKER THREAD and the
 * CALLER terminates that worker. A timeout here that is believed to bound grading time would be worse than no
 * timeout, because it would be a bound that does not exist.
 */
export async function dispatchToSim(input: DispatchInput): Promise<SimOutcome> {
  const refusal = simPublishRefusal(input.spec);
  if (refusal !== null) {
    return { kind: 'NEEDS_HUMAN', reason: 'NO_SCORING_SURFACE', detail: refusal };
  }

  // A STATE THAT FAILS ITS OWN SCHEMA IS ROUTED TO A HUMAN, not zeroed.
  //
  // `INV-SIM-2` again: the state was written by a student using our platform, and it failing our schema is our
  // defect. Zeroing it would mark a student's method wrong because our validator changed under them.
  if (!input.validateState(input.spec.simId, input.spec.simVersion, input.state)) {
    return {
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
      detail: `${input.spec.simId}@${input.spec.simVersion} state does not satisfy its declared stateSchema`,
    };
  }

  const budget = input.timeoutMs ?? 5000;

  /**
   * THE TIMER IS CREATED **BEFORE** THE LOADER IS AWAITED, and that ordering is the whole fix.
   *
   * The first version built the race AFTER `await loadGrader(...)`, which meant a loader that never settled
   * hung the submission with no timer in existence to interrupt it -- and `loadGrader` is a registry read and
   * a dynamic import, the two operations most likely to hang on a network. The test caught it by hanging.
   */
  const deadline = new Promise<'TIMED_OUT'>((resolve) => {
    setTimeout(() => {
      resolve('TIMED_OUT');
    }, budget).unref?.();
  });

  let grader: SimGrader;
  try {
    const loaded = await Promise.race([
      input.loadGrader(input.spec.simId, input.spec.simVersion),
      deadline,
    ]);
    if (loaded === 'TIMED_OUT') {
      return timedOut(
        `loading ${input.spec.simId}@${input.spec.simVersion} exceeded ${String(budget)}ms`,
      );
    }
    grader = loaded;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail: `could not load grader: ${detail}`,
    };
  }

  if (typeof grader !== 'function') {
    return {
      kind: 'NEEDS_HUMAN',
      reason: 'GRADER_UNREADABLE',
      detail: 'the bundle exported something that is not a function',
    };
  }

  /**
   * WHAT IS PASSED AS THE STATE DEPENDS ON THE SURFACE, and this is the field's whole purpose.
   *
   * `ENDPOINT_ONLY` gets the ANSWER alone: a question that claims to measure only the endpoint must not be able
   * to read the path, or retry-until-correct raises the score without any change in understanding.
   *
   * `PATH_SENSITIVE` gets the stored state AND the bounded trace, which is the only way a question can ask how
   * the student got there.
   */
  const gradingState =
    input.spec.scoringSurface === 'PATH_SENSITIVE'
      ? { state: input.state, trace: input.trace ?? [] }
      : { state: null, trace: [] };

  const work = (async (): Promise<SimOutcome> => {
    try {
      const raw = grader(gradingState, input.spec.params ?? {}, input.answer);
      const points = Number(raw?.points);
      const maxPoints = Number(raw?.maxPoints ?? 0);
      if (!Number.isFinite(points)) {
        return {
          kind: 'NEEDS_HUMAN',
          reason: 'GRADER_UNREADABLE',
          detail: `the grader returned points=${JSON.stringify(raw?.points)}`,
        };
      }
      return {
        kind: 'GRADED',
        points,
        maxPoints: Number.isFinite(maxPoints) && maxPoints > 0 ? maxPoints : 0,
        code: typeof raw?.code === 'string' ? raw.code : 'CORRECT',
      };
    } catch (error) {
      // A THROW IS OURS. The bundle is not the student's, so its exception is routed to a marker with the
      // message, and never becomes a zero.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { kind: 'NEEDS_HUMAN', reason: 'GRADER_THREW', detail };
    }
  })();

  /**
   * THERE IS NO TIMER AROUND THE GRADER CALL, AND ITS ABSENCE IS CORRECT.
   *
   * A sim grader is SYNCHRONOUS — `grade(state, params, answer)` returns a value, which is what `INV-SIM-2`
   * and the sandboxed Node bundle both assume. So `work` resolves on a microtask while a timer would fire on a
   * macrotask, and the race would ALWAYS be won by the grader. The timeout branch was unreachable: a grader
   * that returned a promise produced `points === undefined` and `GRADER_UNREADABLE`, which is the honest
   * reading of "this bundle did not return a grade".
   *
   * The only awaitable step is `loadGrader`, and THAT is what the budget above covers. A grader whose body
   * blocks cannot be interrupted by a timer in any case — a microtask never runs while a synchronous call is
   * on the stack — so the escape is the worker thread the CALLER terminates.
   */
  return work;
}
