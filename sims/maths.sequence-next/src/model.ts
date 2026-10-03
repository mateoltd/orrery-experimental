/**
 * The model. Pure, DOM-free, deterministic GIVEN A SEED.  (P6-T11, gold sim 6)
 *
 * ## THE FIRST GOLD SIM THAT USES THE SEED, AND THAT IS THE POINT
 *
 * Every other gold sim is deterministic in its inputs, so nothing has exercised the path from the host's
 * seed policy through `deriveSeed` into a simulation's own randomness. This one does: two students with
 * different seeds get different sequences, and the SAME student gets the SAME sequence on every re-sit —
 * which is what "reproducible" has to mean for a teacher asking "what did they actually get?".
 *
 * The randomness lives here, in one function, taking a seed. Nothing calls `Math.random`, and the grader
 * reconstructs the sequence from the seed the grader was given rather than from anything the browser
 * remembered — so a grade can be recomputed on a server with no browser at all.
 *
 * ## THE SEQUENCE IS INTEGER-VALUED ON PURPOSE
 *
 * A student's answer to "what is the next term" is a whole number, and grading it with a floating-point
 * tolerance invites an argument about whether 30.0000001 is 30. `EXACT` is the honest strategy here.
 */

export interface SequenceParams {
  readonly seed: number;
  /** How many terms are shown. */
  readonly shown: number;
  /** The step between terms. Zero gives a constant sequence, which is a legitimate answer. */
  readonly step: number;
  /** Where the sequence starts. */
  readonly start: number;
}

/** Derive the starting term from the seed. Deterministic, and inside a sane range. */
export function startFromSeed(seed: number): number {
  // `>>> 0` because a seed arrives as a hash and a negative shift makes the arithmetic surprising.
  const mixed = (seed >>> 0) % 17;
  return 3 + mixed;
}

/** Derive the step from the seed, and never zero: a constant sequence has no "next". */
export function stepFromSeed(seed: number): number {
  return 1 + ((seed >>> 8) % 9);
}

/** The full parameter set a given seed produces. The one place randomness happens. */
export function paramsFromSeed(seed: number, shown = 5): SequenceParams {
  return { seed, shown, start: startFromSeed(seed), step: stepFromSeed(seed) };
}

/** The terms the student is shown. */
export function terms(params: SequenceParams): number[] {
  const out: number[] = [];
  for (let index = 0; index < params.shown; index += 1) {
    out.push(params.start + params.step * index);
  }
  return out;
}

/** The term after the last one shown. The answer. */
export function nextTerm(params: SequenceParams): number {
  return params.start + params.step * params.shown;
}

/**
 * One sentence, and it deliberately does NOT contain the answer.
 *
 * ## THE TEXT ALTERNATIVE MUST NOT GIVE THE ANSWER AWAY
 *
 * The alternative exists for a student whose browser cannot run the simulation, and for a printed
 * worksheet. The first version ended with *"The next term is 41"* — which means a blocked student reads
 * the answer instead of the question, and a printed worksheet gives the answer to the exercise printed on
 * it. The alternative describes the SEQUENCE; the answer stays in the grader.
 *
 * The feedback after grading is where the answer belongs, and a student who has tried has earned it.
 */
export function describeSequence(params: SequenceParams): string {
  const shown = terms(params);
  const stepText =
    params.step === 0
      ? 'the same number every time'
      : `each term ${params.step > 0 ? 'goes up' : 'goes down'} by ${Math.abs(params.step)}`;
  return (
    `A sequence of ${String(params.shown)} numbers: ${shown.join(', ')}. ` +
    `The first term is ${String(shown[0] ?? 0)}, and ${stepText}. The task is to work out the number that comes next.`
  );
}
