/**
 * A grader that reads the clock.  (fixture)
 *
 * Caught STATICALLY, by pattern. `Date.now() % 2` returns the same value for all three runs when they
 * happen within one millisecond, so the run-based check would pass this — which is why both exist.
 */
export function grade(state) {
  const drift = Date.now() % 2;
  const seen = Object.keys(state ?? {}).length;
  return {
    points: drift === 0 ? 1 : 0,
    correct: drift === 0,
    rationale: `clock said ${drift}, saw ${seen} keys`,
  };
}
