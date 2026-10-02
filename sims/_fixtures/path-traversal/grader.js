/**
 * A pure, deterministic grader.  (fixture)
 *
 * No clock, no I/O, no unseeded randomness: three runs on one state produce identical output, which
 * is what `sim:validate` proves by RUNNING it three times rather than by reading this comment.
 */
export function grade(state) {
  const expected = 7;
  const given = typeof state?.value === 'number' ? state.value : Number.NaN;
  const within = Math.abs(given - expected) <= 0.01;
  return { points: within ? 1 : 0, correct: within, rationale: `expected ${expected}` };
}
