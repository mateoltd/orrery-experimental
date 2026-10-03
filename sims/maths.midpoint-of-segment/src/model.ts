/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 17)
 *
 * ## THE ANSWER IS AN ORDERED PAIR, AND HALF OF IT CAN BE RIGHT
 *
 * Every other simulation in this set has a single answer, or a list, or a sentence. This one's answer is
 * two numbers that belong together, and a student who averages only the x-coordinates has produced half
 * an answer that is not wrong so much as incomplete. Grading is therefore **per component**, which is the
 * first time the platform has had to divide marks across the parts of one answer.
 *
 * ## NEGATIVE COORDINATES ARE WHERE THE CARELESS ANSWER GOES WRONG
 *
 * Nothing else in the sixteen simulations has asked for a negative number. A midpoint between (-4, 7)
 * and (2, -1) is (-1, 3): the x-coordinate is negative even though BOTH endpoints have one positive and one
 * negative x, and averaging magnitudes gives 3 where the answer is -1. The midpoint of a segment lies
 * BETWEEN its endpoints, and a student who averages the absolute values has left the segment.
 */

export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export const clamp = (params: Partial<Segment>): Segment => {
  const bounded = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(20, Math.max(-20, Math.round(parsed * 10) / 10));
  };
  return {
    x1: bounded(params.x1, -4),
    y1: bounded(params.y1, 7),
    x2: bounded(params.x2, 2),
    y2: bounded(params.y2, -1),
  };
};

/** The midpoint. Averaging, and the signs are the whole difficulty. */
export function midpoint(segment: Segment): { x: number; y: number } {
  return {
    x: round((segment.x1 + segment.x2) / 2),
    y: round((segment.y1 + segment.y2) / 2),
  };
}

/** ONE DECIMAL, because the endpoints are given to one and half of one is still one. */
export const round = (value: number): number => {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * THE MIDPOINT LIES BETWEEN THE ENDPOINTS, and that is a checkable fact.
 *
 * A midpoint that is outside the segment is not a midpoint, whatever the arithmetic says, and this is
 * exported so a test can assert the property rather than three example answers.
 */
export function liesBetween(segment: Segment, point: { x: number; y: number }): boolean {
  const within = (a: number, b: number, v: number): boolean =>
    v >= Math.min(a, b) - 1e-9 && v <= Math.max(a, b) + 1e-9;
  return within(segment.x1, segment.x2, point.x) && within(segment.y1, segment.y2, point.y);
}

export function describeSegment(segment: Segment): string {
  return (
    `A line segment joins the point (${format(segment.x1)}, ${format(segment.y1)}) to the point ` +
    `(${format(segment.x2)}, ${format(segment.y2)}). Work out the coordinates of its MIDPOINT.`
  );
}

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return Object.is(value, -0) ? '0' : String(value);
}
