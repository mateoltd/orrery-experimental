/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 20)
 *
 * ## THE FIRST SIMULATION DRAWN IN SVG
 *
 * Nineteen simulations in, every one of them draws into a `<canvas>`. That is a decision, and it has a cost
 * nobody had named until now: a canvas is a bitmap, so nothing in it is addressable. A grid line cannot be
 * styled, a point cannot carry a tooltip, and a focus ring cannot be drawn around a shape. For an
 * orrery or a parabola that is the right trade — thousands of moving marks, no need for semantics. For a
 * coordinate grid it is not, because a grid is *meant* to be inspected: a student needs to read the
 * coordinates off it, which means the numbers have to be in the DOM.
 *
 * `plans/10` asks this simulation for SVG and it is the only one of the twenty-four for which that is the
 * point rather than an implementation detail.
 *
 * ## UNDO IS A HISTORY OF POINTS, NOT A SNAPSHOT OF EVERYTHING
 *
 * The whole history is a list of positions. That is only possible because the draggable thing is one number
 * pair — and it is worth saying why that matters: an undo stack that stores rendered state cannot be
 * replayed, while an undo stack that stores the student's own inputs can. A teacher asking "what did they do
 * before this?" gets a real answer.
 */

export interface GridPoint {
  readonly x: number;
  readonly y: number;
}

export interface LineParams {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The grid is drawn from -10 to 10, and the marker is kept inside it. */
export const EXTENT = 10;

/** SNAP INCREMENT, in grid units. A snap is what makes a dragged point land ON a lattice point. */
export const SNAP = 0.5;

export const clamp = (params: Partial<LineParams>): LineParams => {
  const bounded = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(EXTENT, Math.max(-EXTENT, Math.round(parsed * 10) / 10));
  };
  return {
    x1: bounded(params.x1, -6),
    y1: bounded(params.y1, -2),
    x2: bounded(params.x2, 6),
    y2: bounded(params.y2, 4),
  };
};

/**
 * THE SLOPE, and the case where there isn't one.
 *
 * A vertical line has no slope and no y-intercept either — it crosses the y-axis at every y at once. The
 * simulation therefore CANNOT generate a vertical line, because the question ("where does this line cross
 * the y-axis?") has no single answer for it. That is a constraint from the QUESTION, and the generator
 * enforces it rather than leaving a marker to discover it.
 */
export function slope(params: LineParams): number {
  const run = params.x2 - params.x1;
  if (run === 0) return Number.NaN;
  return (params.y2 - params.y1) / run;
}

export function isVertical(params: LineParams): boolean {
  return params.x2 === params.x1;
}

/** WHERE THE LINE CROSSES THE Y-AXIS. `null` for a vertical line, which crosses it everywhere. */
export function yIntercept(params: LineParams): number | null {
  if (isVertical(params)) return null;
  const m = slope(params);
  return params.y1 - m * params.x1;
}

/**
 * THE ANSWER, DERIVED.
 *
 * Derived rather than stored so the marker a student drags and the number the grader checks cannot drift
 * apart. A manifest that declares `-2` while the drawing puts the crossing at `-1.5` passes every gate and
 * fails every student, which is the failure mode this function exists to make impossible.
 */
export function answerFor(params: LineParams): number | null {
  return yIntercept(params);
}

/** SNAP A DRAGGED POSITION TO THE LATTICE. */
export function snap(value: number): number {
  const snapped = Math.round(value / SNAP) * SNAP;
  // `-0` is not zero to `Object.is`, and `-0` in a state checksum is a different string from `0`.
  return Object.is(snapped, -0) ? 0 : snapped;
}

export function snapPoint(point: GridPoint): GridPoint {
  return { x: snap(point.x), y: snap(point.y) };
}

/** KEEP THE MARKER INSIDE THE GRID, then snap it. Order matters: clamping then snapping can land outside. */
export function constrain(point: GridPoint): GridPoint {
  return snapPoint({
    x: Math.min(EXTENT, Math.max(-EXTENT, point.x)),
    y: Math.min(EXTENT, Math.max(-EXTENT, point.y)),
  });
}

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  // `Object.is(-0, 0)` is false, so `-0` prints as `0` and never as `-0`.
  return Object.is(value, -0) ? '0' : String(Number(value.toFixed(4)));
};

/**
 * UNDO AND REDO OVER A HISTORY OF POSITIONS.
 *
 * ## WHY REDO CLEARS WHEN A NEW MOVE IS MADE
 *
 * The usual alternative is to keep the redo branch alive and let the student "go back and take a different
 * path", which is a plausible thing to want and a disaster to implement: the student ends up with two
 * futures and no way to tell which one the submission refers to. Clearing is the honest behaviour, and it is
 * what every editor that cannot represent a branching history does.
 *
 * The history is capped, because a student holding a pointer down would otherwise put ten thousand entries
 * in a state that gets checksummed on every checkpoint.
 */
export interface History {
  readonly past: readonly GridPoint[];
  readonly present: GridPoint;
  readonly future: readonly GridPoint[];
}

export const HISTORY_LIMIT = 64;

export const initialHistory = (present: GridPoint): History => ({
  past: [],
  present,
  future: [],
});

/** A MOVE. Recorded only when it actually moved, so a click without a drag is not an undo step. */
export function push(history: History, next: GridPoint): History {
  if (next.x === history.present.x && next.y === history.present.y) return history;
  const past = [...history.past, history.present];
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present: next,
    future: [],
  };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: History): History {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export const canUndo = (history: History): boolean => history.past.length > 0;
export const canRedo = (history: History): boolean => history.future.length > 0;

/** THE QUESTION. It names the two marked points and asks for the y-intercept, and it gives nothing away. */
export function describeTask(params: LineParams): string {
  return (
    `A straight line is drawn through the two marked points (${format(params.x1)}, ${format(params.y1)}) and ` +
    `(${format(params.x2)}, ${format(params.y2)}). Drag the square marker until it sits where the line crosses ` +
    `the vertical axis, then type that y-coordinate in the box.`
  );
}

/** FOR THE TEXT ALTERNATIVE. The grid is the question, so this describes it without naming the crossing. */
export function describeAlternative(params: LineParams): string {
  return (
    `A straight line crosses a square grid running from ${String(-EXTENT)} to ${String(EXTENT)} in both ` +
    `directions. It passes through two marked points, at (${format(params.x1)}, ${format(params.y1)}) and ` +
    `(${format(params.x2)}, ${format(params.y2)}). The task is to work out where the line crosses the ` +
    `vertical axis.`
  );
}
