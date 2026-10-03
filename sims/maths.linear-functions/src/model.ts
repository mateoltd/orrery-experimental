/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 2)
 *
 * ## WHY A STRAIGHT LINE AND NOT A CURVE
 *
 * A straight line is the only shape where a student's arithmetic and the screen cannot disagree for an
 * interesting reason. `y = mx + c` is checkable with a pencil, which is the point: the simulation's job is
 * to make the *relationship* visible, not to be the thing that is hard.
 *
 * ## THE INTERCEPT IS WHERE THE STUDENT LOOKS
 *
 * Two params, one question: where does the line cross the x-axis? `x = -c / m`, and the interesting case
 * is `m = 0`, where there is no crossing at all. That case is handled explicitly rather than producing
 * `Infinity`, because a division by zero that reaches the grader is a bug report three weeks later.
 */

export interface LineParams {
  /** Gradient. Zero means a horizontal line, which has no x-intercept unless it is also the axis. */
  readonly m: number;
  /** y-intercept. */
  readonly c: number;
  /** How far the x-axis is drawn either side of the origin. */
  readonly span: number;
}

export interface LineState {
  /** The student's current marker position on the line, or null when nothing is marked. */
  readonly markerX: number | null;
  /** Whether the student has revealed the intercept guide. */
  readonly showIntercept: boolean;
}

export const initialLineState = (): LineState => ({ markerX: null, showIntercept: false });

export const yAt = (params: LineParams, x: number): number => params.m * x + params.c;

/**
 * Where the line crosses the x-axis, or null when it never does.
 *
 * ## NULL RATHER THAN INFINITY
 *
 * `m === 0` divides by zero. Returning `Infinity` puts a non-finite number into a student's answer field,
 * into a JSON document, and into a numeric grader's tolerance check — where `Infinity - Infinity` is `NaN`
 * and every comparison with it is false. `null` is a value that means "there is no answer", and it survives
 * serialisation.
 */
export function xIntercept(params: LineParams): number | null {
  if (params.m === 0) return null;
  return -params.c / params.m;
}

/** The points to draw, left to right, always including the intercept when there is one. */
export function linePath(params: LineParams): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const steps = 40;
  for (let index = 0; index <= steps; index += 1) {
    const x = -params.span + (2 * params.span * index) / steps;
    points.push({ x, y: yAt(params, x) });
  }
  return points;
}

/**
 * One sentence, for the text alternative and for the screen reader.
 *
 * Derived from the same functions the canvas draws from, so it cannot drift from the picture. A hard-coded
 * alternative is a caption of a different simulation.
 */
export function describeLine(params: LineParams): string {
  const intercept = xIntercept(params);
  const crossing =
    intercept === null
      ? `the line is horizontal at y = ${format(params.c)}, so it never crosses the x-axis`
      : `the line crosses the x-axis at x = ${format(intercept)}`;
  const direction = params.m > 0 ? 'rising' : params.m < 0 ? 'falling' : 'flat';
  return (
    `A ${direction} straight line with gradient ${format(params.m)} and ${crossing}. ` +
    `Press step forward to mark points along it.`
  );
}

/** Two decimals, and no trailing `.0` — a caption reading "y = 5.0" looks like a machine talking. */
export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};
