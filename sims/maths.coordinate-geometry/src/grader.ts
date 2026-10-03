/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 20)
 *
 * ## THE MARKER IS WHERE THE ANSWER IS FOUND; THE BOX IS WHAT IS GRADED
 *
 * The student drags a marker along the y-axis, reads the coordinate off the grid, and types it. Two sources
 * of truth can disagree here — where the marker sits, and what the student read off it — and this grades the
 * SECOND. That is deliberate rather than an oversight: a student who dragged to the right place and misread
 * the grid has made a reading error, and grading the marker would report that as a geometry error.
 *
 * The marker is still in the STATE and `validateState` checks it, because a restored attempt must bring back
 * the diagram as well as the number. A save that kept the answer and dropped the working would leave a
 * student unable to see what they had done.
 *
 * ## WHY THE FULL-MARK BAND IS A QUARTER UNIT AND NOT ZERO
 *
 * The grid snaps to halves, so a marker cannot sit at `1.1`. But a student TYPING `1.2` has read the grid
 * correctly and mis-typed, and marking that zero punishes the keyboard rather than the understanding. A
 * quarter of a unit is half a snap: anything inside it is indistinguishable from a correct reading in this
 * interface, and a grader that demands exactness from a control that cannot be exact is grading the pointer.
 */

import { defineSim, num } from '@orrery/sim-sdk/grader';
import {
  clamp,
  describeTask,
  format,
  isVertical,
  type LineParams,
  slope,
  yIntercept,
} from './model.js';

const MAX = 4;

/**
 * FULL MARKS INSIDE A QUARTER OF A GRID UNIT — half a snap.
 *
 * ## WHY THE PARTIAL-CREDIT BAND IS NOT `tolerance`'s
 *
 * `tolerance`'s decay is measured in RELATIVE error, and it says so: with `relative: 0` there is no scale to
 * decay over, so every answer outside the absolute band scores exactly 0. A grid reading has no business
 * being scored relatively — 1.2 and an answer of 1 is a fifth of a unit out, not 20% out — so passing
 * `relative: 0` bought a 4-or-0 cliff while the manifest promised `partialCredit: true`.
 *
 * The first version did exactly that, and the test caught it: it asserted partial credit and got zero. So the
 * band is computed from DISTANCE HERE, which is the quantity the student can actually see on the grid.
 */
const FULL_MARKS = 0.25;
/** Partial credit REACHES ZERO at three units. Beyond that the student is guessing, not reading. */
const NO_MARKS_BEYOND = 3;

/** Points as a function of distance from the correct reading. Half-marks, because half a mark is readable. */
export function pointsForDistance(distance: number): number {
  if (distance <= FULL_MARKS) return MAX;
  if (distance >= NO_MARKS_BEYOND) return 0;
  const fraction = 1 - (distance - FULL_MARKS) / (NO_MARKS_BEYOND - FULL_MARKS);
  /**
   * ROUNDED TO QUARTERS, NOT HALVES, because rounding to halves made the band invisible at the top.
   *
   * At a distance of 0.26 the fraction is 0.994, and `Math.round(0.994 * 4 * 2) / 2` is `Math.round(7.95) / 2`
   * = 8/2 = **4** — full marks for an answer a quarter of a grid unit out. The first band edge was therefore
   * not 0.25 but 0.375, while the spec said 0.25, and the manifest said 0.25 as well. Three declarations of
   * one band, two of them honest, and a test asserting the boundary found it.
   *
   * A QUARTER of a mark is the finest distinction worth drawing here: the grid has quarter-unit readability
   * at best, the snapshot is 0.5 marks, and below that the number is noise on a report.
   */
  const points = Math.round(fraction * MAX * 4) / 4;
  // AND THE CEILING IS RE-APPLIED AFTER ROUNDING, because `points` can exceed MAX by a rounding step when
  // the fraction is just under 1.
  if (points >= MAX) return MAX;
  return points <= 0 ? 0 : points;
}

export default defineSim({
  meta: {
    id: 'maths.coordinate-geometry',
    title: 'Where does the line cross the y-axis?',
    version: '1.0.0',
    subjects: ['maths'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    x1: num({ name: 'x1', label: 'first x', unit: '', min: -10, max: 10, default: -6 }),
    y1: num({ name: 'y1', label: 'first y', unit: '', min: -10, max: 10, default: -2 }),
    x2: num({ name: 'x2', label: 'second x', unit: '', min: -10, max: 10, default: 6 }),
    y2: num({ name: 'y2', label: 'second y', unit: '', min: -10, max: 10, default: 4 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A grid with a line through two marked points, a square marker on the y-axis, arrow-key controls, and undo.',
    reducedMotion: true,
    // THE INTERCEPT IS NOT IN HERE. The two marked points are the question's own inputs and belong in the
    // alternative; the crossing is the answer, and a screen-reader user gets the same grid, not a
    // description that ends with the number they are being asked for.
    textAlternative:
      'A square grid running from -10 to 10 in both directions, with a straight line drawn through two marked ' +
      'points. The line is also marked where it crosses the vertical axis. The task is to read off that ' +
      'y-coordinate.',
    summary: 'Read where a line crosses the y-axis, using a draggable marker on a coordinate grid.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, rawParams: LineParams, answer: unknown) {
    const params = clamp(rawParams);
    const expected = yIntercept(params);

    /**
     * A VERTICAL LINE HAS NO SINGLE INTERCEPT, and the honest response is that the QUESTION is wrong.
     *
     * It crosses the y-axis at every point on it at once, so there is nothing to read off. `clamp`
     * prevents the generator producing one and this is the belt to that braces, because a host can send its
     * own parameters. Awarding zero here would read as a student being wrong for a question that cannot be
     * asked of their line.
     */
    if (isVertical(params) || expected === null) {
      return {
        points: 0,
        max: MAX,
        code: 'NO_INTERCEPT',
        feedback:
          'This line is vertical, so it crosses the y-axis at every point on it and there is no single ' +
          'y-coordinate to read. The line has to slope.',
      };
    }

    if (answer === null || answer === undefined || String(answer).trim() === '') {
      return {
        points: 0,
        max: MAX,
        code: 'MISSING',
        feedback: `Drag the marker to where the line meets the vertical axis, then type that y-coordinate. ${describeTask(params)}`,
      };
    }

    const typed = Number(answer);
    if (!Number.isFinite(typed)) {
      return {
        points: 0,
        max: MAX,
        code: 'UNPARSEABLE',
        feedback: `Type one number, with no brackets or units. ${describeTask(params)}`,
      };
    }

    const distance = Math.abs(typed - expected);
    const points = pointsForDistance(distance);
    if (points === MAX) {
      return {
        points,
        max: MAX,
        code: 'CORRECT',
        feedback: `Correct: the line crosses the vertical axis at y = ${format(expected)}.`,
      };
    }

    /**
     * THE FEEDBACK GIVES THE METHOD, NOT JUST THE NUMBER.
     *
     * "Not quite" teaches nothing. Naming the gradient and the distance to travel from the first point is
     * the two steps a student needs, and it is what a teacher would write.
     */
    return {
      points,
      max: MAX,
      code: points > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        `You read ${format(typed)}; the line crosses the vertical axis at ${format(expected)}. From ` +
        `(${format(params.x1)}, ${format(params.y1)}) the gradient is ` +
        `${format(Math.round(slope(params) * 100) / 100)}, so work back to x = 0 and read the height there. ` +
        describeTask(params),
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const s = state as { marker?: unknown };
    const marker = s.marker;
    if (marker === null || typeof marker !== 'object') return 'the state has no `marker`';
    const point = marker as { x?: unknown; y?: unknown };
    if (typeof point.x !== 'number' || !Number.isFinite(point.x))
      return 'the marker has no finite `x`';
    if (typeof point.y !== 'number' || !Number.isFinite(point.y))
      return 'the marker has no finite `y`';
    return null;
  },
});

export { yIntercept };
