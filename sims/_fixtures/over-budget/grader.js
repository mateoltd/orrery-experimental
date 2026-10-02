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

// Padding: this file exists to be LARGER than the declared budget, so the size check fires on
// the budget rule rather than on the schema's own minimum. Without the padding the fixture proved
// nothing about `sim:validate` and everything about JSON Schema's arithmetic.
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
// padding padding padding padding padding padding padding
