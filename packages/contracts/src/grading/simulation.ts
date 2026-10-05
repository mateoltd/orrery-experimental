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

/**
 * A sim's grader, exactly as its Node bundle declares it: `grade(state, params, answer)`.
 *
 * Every field of the return is `unknown`, and `maxPoints` is optional, because this is what an UNTRUSTED bundle can
 * hand back rather than what a conforming one must. What a conforming one must is `readAward`'s business.
 */
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

const unreadable = (detail: string): SimOutcome => ({
  kind: 'NEEDS_HUMAN',
  reason: 'GRADER_UNREADABLE',
  detail,
});

/**
 * WHAT WAS THROWN, FOR A MARKER TO READ -- and it cannot throw while saying so.
 *
 * `String(error)` looks total and is not: `String(Object.create(null))` is a `TypeError`, and so is an `Error`
 * whose `message` is a getter that throws. The bundle is third-party code and may throw anything at all, so a
 * description that can itself throw is a `catch` that rejects the dispatch it was written to protect.
 */
const describeThrown = (error: unknown): string => {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return 'something that could not be described';
  }
};

/**
 * A VALUE THE BUNDLE RETURNED, FOR A MARKER TO READ. Total, for the same reason as `describeThrown`.
 *
 * `JSON.stringify` was here first. It throws on a `BigInt`, and it prints `NaN` as `null` -- so the one detail a
 * marker was given about an unreadable score named a value the grader had not returned.
 */
const show = (value: unknown): string => {
  switch (typeof value) {
    case 'string':
      // Quoted, so that `''` is visibly an empty string and not a missing word in the sentence.
      return JSON.stringify(value);
    case 'bigint':
      return `${String(value)}n`;
    case 'function':
      return '[function]';
    case 'object':
      // Named and not printed: an object's `toString` is the bundle's code.
      return value === null ? 'null' : Array.isArray(value) ? '[array]' : '[object]';
    default:
      return String(value);
  }
};

/**
 * A NUMBER THAT IS ALREADY A NUMBER, or nothing.  (`ADV-S4`)
 *
 * ## `Number()` IS A COERCION, AND FOUR OF ITS ANSWERS ARE A STUDENT'S ZERO
 *
 * The award was read with `Number(raw?.points)`. `Number(null)`, `Number('')`, `Number([])` and `Number(false)`
 * are all `0`, and `0` is finite -- so a bundle returning `{ points: null }`, which is what a grader returns when it
 * could NOT compute a score, was reported as `GRADED` with zero marks. That is the auto-zero `INV-SIM-2` is named
 * for, reached through the one line written to prevent it. `undefined` was handled only by the accident that
 * `Number(undefined)` is `NaN`.
 *
 * So nothing is coerced. A numeric STRING is refused too: `'4'` is not a number a grader computed, and the reader
 * that accepts it is the reader that accepts `''`.
 */
const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * READ WHAT THE BUNDLE RETURNED, AS UNTRUSTED. This is the ONLY place a `GRADED` outcome is built.
 *
 * ## AN AWARD OUTSIDE ITS OWN RANGE IS REFUSED, NOT CLAMPED  (`ADV-S5`)
 *
 * `plans/07` section 4: "`0 <= points <= maxPoints` always, including on malformed input." The dispatch passed the
 * bundle's number straight through, so a billion points, or minus fifty, was a `GRADED` outcome.
 *
 * Clamping would make the number legal and the mark a fiction: `-50` becomes a zero the student did not earn and
 * `1e9` becomes full marks they did not earn either, and both are written by a grader that has just shown it
 * cannot be trusted with this response. A bundle that contradicts the range it declared has not returned a grade,
 * so it goes to a human like every other unreadable return -- `INV-SIM-2`, again.
 *
 * A missing or non-finite `maxPoints` is the same refusal, because there is then no range to hold the award to.
 * It used to be normalised to `0` and reported as `GRADED`, which is "3 marks out of 0": above its own ceiling,
 * unrenderable as a fraction, and the way a bundle escaped the bound by not declaring one.
 *
 * ## AND THIS IS NOT THE FLOOR `plans/07` SECTION 3.2 FORBIDS
 *
 * `GradeOutput.rawPoints` is deliberately unclamped so that `NG` and `PM` can be negative: that is a PENALTY the
 * question's scoring policy imposes, computed by our own `applyMethod`, and its floor belongs in the attempt total.
 * This is the bundle's AWARD -- a different quantity, in a different type, from code we did not write, whose own
 * contract (`Grade` in `@orrery/sim-sdk`) is "never negative, never above the maximum". A simulation has no
 * penalising method, so a negative award is never a penalty; it is a defect. Nothing here touches `rawPoints`.
 */
const readAward = (raw: unknown): SimOutcome => {
  if (typeof raw !== 'object' || raw === null) {
    return unreadable(`the grader returned ${show(raw)} rather than a grade`);
  }
  // Each field is read ONCE. They may be getters, and a getter is allowed to answer differently the second time.
  const {
    points: awarded,
    maxPoints: ceiling,
    code,
  } = raw as { points?: unknown; maxPoints?: unknown; code?: unknown };
  const points = asFiniteNumber(awarded);
  if (points === null) {
    return unreadable(`the grader returned points=${show(awarded)}`);
  }
  const maxPoints = asFiniteNumber(ceiling);
  if (maxPoints === null || maxPoints < 0) {
    return unreadable(
      `the grader returned maxPoints=${show(ceiling)}, so there is no range to read ` +
        `points=${String(points)} against`,
    );
  }
  if (points < 0 || points > maxPoints) {
    return unreadable(
      `the grader awarded ${String(points)}, outside the 0 to ${String(maxPoints)} it declared`,
    );
  }
  return {
    kind: 'GRADED',
    // `-0` is in range and is not `0` under `Object.is`, so it would differ from a zero stored beside it.
    points: points === 0 ? 0 : points,
    maxPoints: maxPoints === 0 ? 0 : maxPoints,
    code: typeof code === 'string' ? code : 'CORRECT',
  };
};

/**
 * THE DISPATCH. Total over everything it is HANDED: whatever the state, the answer, the trace, the validator, the
 * loader and the bundle do, it resolves to a `SimOutcome`, and no failure among them resolves to a mark.
 *
 * That sentence used to read "total by construction: every arm returns a `SimOutcome`" while `validateState` was
 * called outside any `try` -- so the arm a malformed state reaches FIRST was the one that rejected (`ADV-S3`).
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
  const sim = `${input.spec.simId}@${input.spec.simVersion}`;
  let verdict: unknown;
  try {
    verdict = input.validateState(input.spec.simId, input.spec.simVersion, input.state);
  } catch (error) {
    // A VALIDATOR THAT THROWS HAS NOT VALIDATED ANYTHING.  (`ADV-S3`)
    //
    // A schema validator meets a `BigInt`, a getter, or a depth it was not written for, and throws. That is the
    // hostile state arriving exactly where it was expected, and it used to reject the whole dispatch: no outcome,
    // no reason, and a submission that failed instead of one question that went to a marker.
    return {
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
      detail: `${sim} state could not be checked against its declared stateSchema: ${describeThrown(error)}`,
    };
  }
  /**
   * ONLY `true` IS A PASS. The test was `!verdict`, which admits everything truthy -- and the validators most
   * likely to be wired in here return truthy things on FAILURE: an async one returns a promise, and a
   * `safeParse` returns its result object. Either would have declared every state valid and handed it to the
   * bundle.
   */
  if (verdict !== true) {
    return {
      kind: 'NEEDS_HUMAN',
      reason: 'STATE_FAILED_ITS_SCHEMA',
      detail:
        verdict === false
          ? `${sim} state does not satisfy its declared stateSchema`
          : `${sim} state was not validated: the validator returned ${show(verdict)} rather than a verdict`,
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
      return timedOut(`loading ${sim} exceeded ${String(budget)}ms`);
    }
    grader = loaded;
  } catch (error) {
    return unreadable(`could not load grader: ${describeThrown(error)}`);
  }

  if (typeof grader !== 'function') {
    return unreadable('the bundle exported something that is not a function');
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
      // Read INSIDE the `try`: the return is the bundle's object, and a getter on it is the bundle's code.
      return readAward(grader(gradingState, input.spec.params ?? {}, input.answer));
    } catch (error) {
      // A THROW IS OURS. The bundle is not the student's, so its exception is routed to a marker with the
      // message, and never becomes a zero.
      return { kind: 'NEEDS_HUMAN', reason: 'GRADER_THREW', detail: describeThrown(error) };
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
