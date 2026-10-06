/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 135 `maths.integral-area`)
 *
 * ## THE ERROR IS A DIFFERENCE, NOT A PERCENTAGE OF THE SUM
 *
 * The card is explicit: "the error is `exact − sum` rather than a percentage of the sum, which would blow up
 * when the sum is near zero." The sum here crosses zero — `f(x) = x² − 2` is negative below `√2` and positive
 * above it — so a relative error on the SUM is a quantity with no meaning at the crossing and no bound
 * anywhere near it. `truncationError` returns the difference, in the function's own units, and the tests
 * assert it converges at the rate Riemann's theorem says it does rather than asserting a value.
 *
 * ## BOTH SUMS USE THE SAME RECTANGLE COUNT
 *
 * The only way a student can see that the left sum under-estimates and the right over-estimates is to
 * compare two numbers computed the same way. Two independent rectangle counts make the comparison a
 * comparison of two different questions, so `leftSum(n)` and `rightSum(n)` take the same `n` by construction.
 *
 * ## THE ANSWER IS NEGATIVE, AND A MINUS SIGN IS NOT A NUMBER
 *
 * `asNumber` strips everything outside `[0-9.eE+-]` (`grading.ts:155`), so a student who types the true
 * minus sign U+2212 — which is what a word processor produces — has it REMOVED rather than translated, and
 * a correct −1.8125 arrives as 1.8125. That is a false wrong answer for a student who did nothing wrong, and
 * the fix belongs in the model rather than at the call site because every one of the numeric fields needs it.
 */

export interface IntegralParams {
  /** How many rectangles the sum uses. */
  readonly rectangles: number;
}

export const MIN_RECTANGLES = 2;
export const MAX_RECTANGLES = 64;
export const LOWER = 0;
export const UPPER = 2;

/**
 * The integrand, DECLARED rather than tabulated.
 *
 * `x² − 2` over `[0, 2]` on purpose: it crosses the axis inside the interval, so the signed area is NEGATIVE
 * and misconception (1) — "area under a curve is always positive" — is contradicted by the arithmetic
 * rather than by a sentence.
 */
export const f = (x: number): number => x * x - 2;

/** The exact definite integral, in closed form. Not a number the sum converges to at run time. */
export function exactIntegral(lower = LOWER, upper = UPPER): number {
  return (upper * upper * upper - lower * lower * lower) / 3 - 2 * (upper - lower);
}

/** The left-endpoint Riemann sum. UNDER-estimates an increasing function; here it is the negative one. */
export function leftSum(rectangles: number): number {
  const width = (UPPER - LOWER) / rectangles;
  let total = 0;
  for (let i = 0; i < rectangles; i += 1) total += f(LOWER + i * width) * width;
  return total;
}

/** The right-endpoint Riemann sum, on the SAME rectangle count so the two can be compared. */
export function rightSum(rectangles: number): number {
  const width = (UPPER - LOWER) / rectangles;
  let total = 0;
  for (let i = 1; i <= rectangles; i += 1) total += f(LOWER + i * width) * width;
  return total;
}

/** The midpoint sum, which converges at twice the order and is what makes misconception (2) checkable. */
export function midpointSum(rectangles: number): number {
  const width = (UPPER - LOWER) / rectangles;
  let total = 0;
  for (let i = 0; i < rectangles; i += 1) total += f(LOWER + (i + 0.5) * width) * width;
  return total;
}

/**
 * `exact − sum`, in the function's own units.
 *
 * A DIFFERENCE and never a ratio: the left sum passes through zero as `n` changes, and a ratio whose
 * denominator is zero is not a small number, it is a statement the item cannot make.
 */
export function truncationError(sum: number): number {
  return exactIntegral() - sum;
}

export const clamp = (raw: Partial<IntegralParams>): IntegralParams => {
  const asked = Math.round(Number(raw.rectangles));
  const rectangles = Number.isFinite(asked) ? asked : 8;
  return { rectangles: Math.min(MAX_RECTANGLES, Math.max(MIN_RECTANGLES, rectangles)) };
};

/**
 * Repair a typed number WITHOUT repairing its meaning.
 *
 * Three substitutions and nothing else: the true minus and en-dash become an ASCII hyphen, a Unicode
 * thousands separator becomes a comma, and a thin space between a digit and its sign goes. Nothing rounds
 * and nothing rescales — a student who writes `2x10^-3` still gets the `210` that `asNumber` gives them,
 * because that is a different mistake and this function is not here to hide it.
 */
export function normaliseNumber(value: unknown): string | number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return String(value ?? '');
  return value
    .replace(/[−–—]/gu, '-')
    .replace(/[\u202f\u2009\u2012]/gu, '')
    .replace(/(\d),(?=\d{3}\b)/gu, '$1');
}

/** Two decimals, and a non-finite value named rather than printed. */
export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** The text alternative, DERIVED, quoting the three sums and the exact value it is converging to. */
export function describeSums(params: IntegralParams): string {
  const n = params.rectangles;
  return (
    `The curve y = x² − 2 between x = 0 and x = 2, with ${String(n)} rectangles of equal width. The ` +
    `left-endpoint sum is ${format(leftSum(n))}, the right-endpoint sum is ${format(rightSum(n))}, and ` +
    `the exact signed area is ${format(exactIntegral())}. Because the curve is below the axis for most of ` +
    'the interval, all three are negative: the signed area subtracts what is below.'
  );
}
