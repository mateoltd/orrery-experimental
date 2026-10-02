/**
 * A grader with no clock, no I/O and no randomness — and it is still non-deterministic.  (fixture)
 *
 * A module-level counter is invisible to every static rule `sim:validate` has, because nothing in
 * the source names a clock or a random source. This is the fixture that justifies running the
 * grader three times rather than only reading it: the text is clean and the behaviour is not.
 */
let calls = 0;

export function grade(state) {
  calls += 1;
  const awarded = calls === 1 ? 1 : 0;
  const seen = Object.keys(state ?? {}).length;
  return { points: awarded, correct: awarded === 1, rationale: `run ${calls} over ${seen} keys` };
}
