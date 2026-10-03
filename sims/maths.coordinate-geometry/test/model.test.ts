/**
 * The model, in bare Node.  (P6-T11, gold sim 20)
 *
 * The cases that matter here are the two new corners: undo/redo as a HISTORY OF THE STUDENT'S OWN INPUTS,
 * and the snapping rule. Everything else — a slope, an intercept — is arithmetic the platform's own
 * tolerance tests already cover.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  canRedo,
  canUndo,
  clamp,
  constrain,
  describeAlternative,
  EXTENT,
  type GridPoint,
  HISTORY_LIMIT,
  initialHistory,
  isVertical,
  push,
  redo,
  slope,
  snap,
  snapPoint,
  undo,
  yIntercept,
} from '../src/model.js';

const P = clamp({ x1: -6, y1: -2, x2: 6, y2: 4 });
const grade = (answer: unknown, params = P) => sim.grader.grade(null, params, answer);

describe('the line', () => {
  it('HAS A SLOPE, and it is the one you can check by hand', () => {
    // From (-6,-2) to (6,4): rise 6 over run 12, so 0.5. The intercept is then -2 - (0.5 * -6) = 1.
    expect(slope(P)).toBe(0.5);
    expect(yIntercept(P)).toBe(1);
  });

  it('A VERTICAL LINE HAS NO INTERCEPT, AND SAYING SO IS THE POINT', () => {
    // The generator must never produce one, because the question has no single answer for it. Asserted
    // anyway, because the grader is what a student meets when a manifest is wrong.
    const vertical = clamp({ x1: 3, y1: -4, x2: 3, y2: 7 });
    expect(isVertical(vertical)).toBe(true);
    expect(yIntercept(vertical)).toBeNull();
    expect(grade(1, vertical).code).toBe('NO_INTERCEPT');
  });

  it('REJECTS A SLOPE OF NaN RATHER THAN DIVIDING BY ZERO', () => {
    expect(Number.isNaN(slope(clamp({ x1: 1, y1: 1, x2: 1, y2: 2 })))).toBe(true);
  });

  it('CLAMPS ITS INPUTS INTO THE GRID', () => {
    expect(clamp({ x1: 999 }).x1).toBe(EXTENT);
    expect(clamp({ y1: -999 }).y1).toBe(-EXTENT);
    expect(clamp({ x1: Number.NaN }).x1).toBe(-6);
  });
});

describe('snapping', () => {
  it('LANDS ON THE LATTICE, so a dragged marker is on a grid intersection', () => {
    expect(snap(0.3)).toBe(0.5);
    expect(snap(-0.3)).toBe(-0.5);
    expect(snap(2.24)).toBe(2);
    expect(snap(-2.24)).toBe(-2);
  });

  it('NEVER PRODUCES -0, WHICH IS A DIFFERENT STRING AND A DIFFERENT CHECKSUM', () => {
    // `Math.round(-0.25 / 0.5) * 0.5` is `-0`, and `Object.is(-0, 0)` is false, so an equality check written
    // with `===` passes while a checksum computed from the string does not.
    expect(Object.is(snap(-0.1), -0)).toBe(false);
    expect(Object.is(snap(-0), -0)).toBe(false);
    expect(String(snap(-0.1))).toBe('0');
  });

  it('CONSTRAINS BEFORE SNAP SO A POINT CANNOT LAND OUTSIDE THE GRID', () => {
    // Snapping first would push 10.2 up to 10.5, which is outside the grid the drawing uses.
    expect(constrain({ x: 10.4, y: 0 }).x).toBe(EXTENT);
    expect(constrain({ x: -99, y: 99 })).toEqual({ x: -EXTENT, y: EXTENT });
    expect(snapPoint({ x: 1.2, y: -1.2 })).toEqual({ x: 1, y: -1 });
  });
});

describe("undo and redo are a HISTORY OF THE STUDENT'S OWN INPUTS", () => {
  // The distinction that matters: an undo stack holding RENDERED state cannot be replayed, and a teacher
  // asking "what did they try first?" gets no answer from pixels. This one holds positions.
  const at = (x: number, y: number): GridPoint => ({ x, y });

  it('STARTS WITH NOTHING TO UNDO', () => {
    const history = initialHistory(at(0, 0));
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history)).toBe(history);
  });

  it('RECORDS A MOVE AND STEPS BACK TO IT', () => {
    let history = initialHistory(at(0, 0));
    history = push(history, at(1, 1));
    history = push(history, at(2, 2));
    expect(history.present).toEqual(at(2, 2));

    history = undo(history);
    expect(history.present).toEqual(at(1, 1));
    history = undo(history);
    expect(history.present).toEqual(at(0, 0));
    expect(canUndo(history)).toBe(false);
  });

  it('DOES NOT RECORD A MOVE THAT DID NOT MOVE', () => {
    // A click without a drag is not an undo step, and treating it as one makes undo feel broken: the
    // student presses it and nothing appears to happen.
    const history = initialHistory(at(1, 1));
    expect(push(history, at(1, 1))).toBe(history);
    expect(canUndo(history)).toBe(false);
  });

  it('REDOES, AND CLEARING THE REDO BRANCH ON A NEW MOVE IS DELIBERATE', () => {
    let history = initialHistory(at(0, 0));
    history = push(history, at(1, 0));
    history = push(history, at(2, 0));
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = redo(history);
    expect(history.present).toEqual(at(2, 0));

    // Undo, then take a DIFFERENT path. The future is dropped, because two futures means the submission
    // refers to an ambiguous day and no editor should leave that to the student's memory.
    history = undo(history);
    history = push(history, at(9, 9));
    expect(canRedo(history)).toBe(false);
    expect(history.present).toEqual(at(9, 9));
  });

  it('CAPS THE HISTORY, because a held pointer would otherwise fill a checksummed state', () => {
    let history = initialHistory(at(0, 0));
    for (let i = 1; i <= HISTORY_LIMIT + 40; i += 1) history = push(history, at(i, 0));
    expect(history.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(history.present).toEqual(at(HISTORY_LIMIT + 40, 0));
  });

  it('UNDO AT THE START IS A NO-OP RATHER THAN AN ERROR', () => {
    const history = initialHistory(at(3, 3));
    expect(undo(undo(history))).toBe(history);
    expect(redo(redo(history))).toBe(history);
  });
});

describe('the grading is on what the STUDENT TYPED, not where they dragged', () => {
  it('AWARDS FULL MARKS for the intercept read off the grid', () => {
    expect(grade(1).points).toBe(4);
    expect(grade(1).code).toBe('CORRECT');
  });

  it('TOLERATES A QUARTER OF A GRID UNIT, because that is inside a snap', () => {
    // The grid snaps to halves, so a marker cannot sit at 1.2; but a student TYPING 1.2 has read the grid
    // correctly and mis-typed. Marking that zero punishes the keyboard rather than the understanding.
    //
    // AND IT DOES NOT FALL OFF A CLIFF. `tolerance`'s partial credit is measured in RELATIVE error, so with
    // an absolute-only band it has no scale to decay over and every wrong answer scores zero -- which is what
    // the first version did, while the manifest promised partial credit. The band is computed from distance.
    expect(grade(1.25).points).toBe(4);
    // AND THE NEXT MARK DOWN IS A WHOLE HALF AWAY, because the decay rounds to half marks.
    //
    // My first version asserted `1.26` scores less than 4, and it scored 4 -- correctly. At a distance of
    // 0.26 the remaining fraction is 0.996, and rounding to half marks gives 4. Half marks are the right
    // granularity for a number read off a grid; anything finer would award a quarter of a mark for a
    // difference no student can see. So the band is "inside a quarter", and the STEPS are half a unit wide.
    expect(grade(1.26).points).toBe(4);
    // Half a unit out is still most of the marks, and that is correct: the answer is 1, the student read
    // 1.5, and they have found the intercept and misread the grid by two snap increments. The band runs
    // from a quarter of a unit (4 marks) down to three units (nothing), and the values in between are
    // whatever that line gives.
    // Quarter-marks, so these are exact rather than approximate -- the rounding IS the granularity.
    // THE WHOLE CURVE, spelled out, because I asserted this three times by guessing.
    //
    // Full marks inside a quarter of a unit, then quarter-mark steps down to nothing at three units away:
    //   0.5 out -> 3.75    1.5 out -> 2.25    2.5 out -> 0.75
    //   1.0 out -> 3.00    2.0 out -> 1.50    2.75 out -> 0.25
    // and zero beyond. Writing the curve down is what makes a change to FULL_MARKS or NO_MARKS_BEYOND a
    // visible edit to the marks rather than a silent shift in every score on the platform.
    expect(grade(1.5).points).toBe(3.75);
    expect(grade(2).points).toBe(3);
    expect(grade(2.5).points).toBe(2.25);
    expect(grade(3).points).toBe(1.5);
    expect(grade(3.5).points).toBe(0.75);
    expect(grade(3.75).points).toBe(0.25);
    expect(grade(4).points).toBe(0);
  });

  it('DISTINGUISHES EMPTY from UNREADABLE', () => {
    expect(grade(null).code).toBe('MISSING');
    expect(grade('').code).toBe('MISSING');
    expect(grade('up there').code).toBe('UNPARSEABLE');
  });

  it('GIVES THE METHOD, NOT JUST THE NUMBER', () => {
    const feedback = grade(4).feedback;
    expect(feedback).toMatch(/gradient is 0.5/u);
    expect(feedback).toMatch(/crosses the vertical axis at 1/u);
  });

  it('AWARDS NOTHING FOR A NUMBER FROM A DIFFERENT ORBIT', () => {
    // A different line has a different intercept (3.5 here), and a guess from the PREVIOUS question is not
    // merely imprecise -- it is a long way off, so it earns nothing rather than a sliver.
    expect(grade(8, clamp({ x1: -6, y1: -2, x2: 6, y2: 9 })).points).toBe(0);
  });
});

describe('the text alternative does not give the intercept away', () => {
  it('describes the grid and the line, and never the crossing', () => {
    const text = describeAlternative(P);
    expect(text).toMatch(/-10 to 10/u);
    expect(text).toMatch(/crosses the vertical axis/u);
    // It must not become "the line crosses at 1" — which is the answer, in the place a screen-reader user
    // is told to look.
    expect(text).not.toMatch(/crosses (?:the )?(?:vertical axis|y-axis) at -?\d/u);
  });
});
