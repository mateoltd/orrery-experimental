/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 7)
 *
 * ## TWO ROOTS, IN EITHER ORDER, AND SOMETIMES NONE
 *
 * `ax² + bx + c = 0` has two roots, one repeated root, or none at all — and "none" is a real answer, not
 * a failure to find one. Three shapes of answer from one question, which is why this simulation exists:
 * it is the first gold sim with MORE THAN ONE GRADED QUANTITY, so it is the first to exercise partial
 * credit across parts. `plans/20` needs that in P7 for every multi-part question, and building it here
 * means the multi-part path is exercised by a simulation rather than only by the grading service's tests.
 *
 * ## THE ORDER A STUDENT WRITES THEM IN IS NOT PART OF THE ANSWER
 *
 * `-1` and `3` are the roots of `(x+1)(x-3)` in either order, and marking the second one wrong would be
 * pedantry dressed as rigour. The answer is compared as a SET of numbers.
 */

export interface QuadraticParams {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/** The discriminant, `b² - 4ac`. Negative means no real roots. */
export function discriminant(params: QuadraticParams): number {
  return params.b * params.b - 4 * params.a * params.c;
}

/** The roots, or `null` when there are none. A repeated root is returned once. */
export function roots(params: QuadraticParams): number[] | null {
  if (!(params.a !== 0)) return null;
  const d = discriminant(params);
  if (d < 0) return null;
  if (Math.abs(d) < 1e-12) return [-params.b / (2 * params.a)];
  const root = Math.sqrt(d);
  return [(-params.b + root) / (2 * params.a), (-params.b - root) / (2 * params.a)];
}

/** Vertex, for the picture. */
export function vertex(params: QuadraticParams): { x: number; y: number } {
  const x = -params.b / (2 * params.a);
  return { x, y: params.a * x * x + params.b * x + params.c };
}

/** The student's two answers, or `null` for "no real roots". */
export function parseAnswer(answer: unknown): number[] | null | 'INVALID' {
  if (answer === null || answer === undefined) return 'INVALID';
  if (typeof answer === 'string') {
    const key = answer.trim().toLowerCase();
    if (key === 'none' || key === 'no real roots' || key === 'no roots') return null;
    return 'INVALID';
  }
  if (typeof answer !== 'object') return 'INVALID';
  const record = answer as Record<string, unknown>;
  if (record.roots === null) return null;
  if (!Array.isArray(record.roots)) return 'INVALID';
  const out: number[] = [];
  for (const item of record.roots) {
    const value = Number(item);
    if (!Number.isFinite(value)) return 'INVALID';
    out.push(value);
  }
  return out;
}

/** One sentence. It does NOT contain the roots — see the note on the text alternative. */
export function describeQuadratic(params: QuadraticParams): string {
  const d = discriminant(params);
  const shape =
    d < 0
      ? 'The graph never crosses the x-axis, so there are no real roots.'
      : d === 0
        ? 'The graph touches the x-axis at one point, so there is one repeated root.'
        : 'The graph crosses the x-axis twice, so there are two real roots.';
  return (
    `The curve y = ${format(params.a)}x² ${params.b < 0 ? '−' : '+'} ${format(Math.abs(params.b))}x ` +
    `${params.c < 0 ? '−' : '+'} ${format(Math.abs(params.c))}. ${shape} The task is to find them.`
  );
}

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};
