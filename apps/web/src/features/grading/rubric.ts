/**
 * Rubric bands: the shape, the bound, and the one door every hand-entered mark goes through.  (P9-T3)
 *
 * ## A BAND IS BOUNDED TO `[0, maxPoints]`, AND SO IS EVERY OTHER MARK A TEACHER CAN ENTER
 *
 * `plans/07` §3.2 says `NG` and `PM` produce negative raw scores BY DESIGN, and it is tempting to read that as "negative
 * marks are allowed". They are allowed for two NAMED methods, on the RAW scale, behind §3.3's publish-time guard that
 * refuses a configuration whose select-all score is positive. None of that apparatus exists for a hand-entered mark:
 *
 *  · a band lands in `manualScore`, which has no raw/bounded pair -- `autoRawScore` is the only column that carries a
 *    negative, and it is written by the grader;
 *  · `computeScore` sums `finalScore` with no floor per response, so a band worth `-10` on a 5-mark question subtracts
 *    ten marks from the attempt total and nothing between here and release would notice;
 *  · §3.3 inspects the METHOD on the question. It never reads a rubric, so a penalty expressed as a band is invisible
 *    to the only guard the plan has.
 *
 * So a band editor that accepted a negative would be a way to write a penalty that no publish check can see. Bands are
 * `0 <= points <= maxPoints`, and `checkMark` is the single function that says so -- the rubric editor, the score
 * field and the quick-score keys all call it, because a bound enforced on bands and not on the field next to them is
 * a bound with a second door.
 *
 * ## A MARK OUT OF RANGE IS REFUSED, NOT CLAMPED
 *
 * Clamping `7` to `5` on a 5-mark question turns a typing slip into full marks, silently, and the teacher who meant
 * `0.7` never finds out. A refusal names the number and the range and leaves the draft exactly as typed.
 *
 * ## THIS FILE IMPORTS NOTHING FROM THE WEB APP, ON PURPOSE
 *
 * The bound has to be enforced where the mark is WRITTEN, and a check that exists only in a browser is a suggestion.
 * This module is pure and depends on one contracts type so it can move to `@orrery/contracts/grading/rubric` unchanged;
 * it is here only because a subpath export needs an entry in a `package.json` this task may not edit.
 */

import type { RubricBand } from '@orrery/contracts/question';

/** `manualScore` is `Decimal(9, 2)`. A third decimal place would be rounded by the database, not by the teacher. */
export const MARK_DECIMALS = 2;

/** A band as the marker works with it: what earns it, what it is worth, and the comment it prefills. */
export interface MarkingBand {
  /** Stable across reordering, so a saved mark can say which band it came from after the list is rearranged. */
  readonly id: string;
  readonly points: number;
  /** What earns this band. Written for the MARKER, and never sent to a student by this module. */
  readonly descriptor: string;
  /** The comment prefilled into the feedback field when this band is applied. May be empty. */
  readonly feedback: string;
}

export interface MarkingRubric {
  readonly questionId: string;
  /** The question's `points`. Not editable here: it is the question's, and changing it is a regrade. */
  readonly maxPoints: number;
  /** In the teacher's own order. The digit keys address bands by POSITION, so this order is never sorted for them. */
  readonly bands: readonly MarkingBand[];
}

export type MarkRefusal = 'EMPTY' | 'NOT_A_NUMBER' | 'BELOW_ZERO' | 'ABOVE_MAXIMUM' | 'TOO_PRECISE';

export type MarkOutcome =
  | { readonly ok: true; readonly points: number }
  | { readonly ok: false; readonly reason: MarkRefusal; readonly message: string };

/**
 * IS THIS A MARK A TEACHER MAY ENTER FOR A QUESTION WORTH `maxPoints`?
 *
 * The one door. Every refusal carries the sentence shown next to the field, so the wording cannot drift between the
 * rubric editor and the score box.
 */
export const checkMark = (value: number, maxPoints: number): MarkOutcome => {
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'NOT_A_NUMBER', message: 'A mark has to be a number.' };
  }
  if (value < 0) {
    return {
      ok: false,
      reason: 'BELOW_ZERO',
      message:
        'A mark cannot be below 0. A penalty for wrong selections is a scoring method on the question, where it is ' +
        'checked before the question can be published; it cannot be entered as a mark.',
    };
  }
  if (value > maxPoints) {
    return {
      ok: false,
      reason: 'ABOVE_MAXIMUM',
      message: `This question is worth ${String(maxPoints)}. A mark cannot be above that.`,
    };
  }
  // `toFixed` rather than `Math.round(value * 100) / 100`: `1.005 * 100` is `100.49999999999999`, so the
  // multiplication rounds a value that was never too precise and then reports it as changed.
  if (Number(value.toFixed(MARK_DECIMALS)) !== value) {
    return {
      ok: false,
      reason: 'TOO_PRECISE',
      message: `A mark is stored to ${String(MARK_DECIMALS)} decimal places. Enter it to that precision.`,
    };
  }
  // `-0` passes `value < 0` and would be stored and compared as a different value from `0`.
  return { ok: true, points: Object.is(value, -0) ? 0 : value };
};

/** A plain decimal: digits, optionally a point and more digits. Nothing `Number()` would otherwise be generous about. */
const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * READ A MARK AS TYPED.
 *
 * `Number('')` is `0`, `Number(' ')` is `0`, `Number('1e3')` is `1000` and `Number('0x10')` is `16`. Each of those is a
 * mark a teacher did not enter, so the text is checked against a plain decimal BEFORE it is converted -- and an empty
 * field is its own refusal, because "no mark yet" and "a mark of zero" are the distinction this whole screen exists to
 * keep.
 */
export const parseMark = (raw: string, maxPoints: number): MarkOutcome => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'EMPTY', message: 'Enter a mark before saving.' };
  }
  if (!PLAIN_DECIMAL.test(trimmed)) {
    return {
      ok: false,
      reason: 'NOT_A_NUMBER',
      message: 'A mark has to be a number, written with digits and a decimal point.',
    };
  }
  return checkMark(Number(trimmed), maxPoints);
};

export type RubricIssueCode =
  | 'POINTS_NOT_A_NUMBER'
  | 'POINTS_BELOW_ZERO'
  | 'POINTS_ABOVE_MAXIMUM'
  | 'POINTS_TOO_PRECISE'
  | 'DESCRIPTOR_EMPTY'
  | 'DUPLICATE_ID'
  | 'NO_BAND_AWARDS_FULL_MARKS';

export interface RubricIssue {
  /** `null` when the issue is about the rubric as a whole. */
  readonly bandId: string | null;
  readonly code: RubricIssueCode;
  /**
   * `BLOCKS_SAVE` is a rubric that would write a mark the system must not hold. `ADVISORY` is a rubric that is legal
   * and probably not what was meant; it is shown and does not stop anything, because a teacher may mean it.
   */
  readonly severity: 'BLOCKS_SAVE' | 'ADVISORY';
  readonly message: string;
}

const POINTS_ISSUE: Readonly<Record<Exclude<MarkRefusal, 'EMPTY'>, RubricIssueCode>> = {
  NOT_A_NUMBER: 'POINTS_NOT_A_NUMBER',
  BELOW_ZERO: 'POINTS_BELOW_ZERO',
  ABOVE_MAXIMUM: 'POINTS_ABOVE_MAXIMUM',
  TOO_PRECISE: 'POINTS_TOO_PRECISE',
};

/**
 * EVERYTHING WRONG WITH A RUBRIC, in band order.
 *
 * A list rather than the first failure, so the editor can mark every band that needs attention at once instead of
 * making the teacher save five times to find five problems.
 */
export const validateRubric = (rubric: MarkingRubric): readonly RubricIssue[] => {
  const issues: RubricIssue[] = [];
  const seen = new Set<string>();

  for (const band of rubric.bands) {
    const mark = checkMark(band.points, rubric.maxPoints);
    if (!mark.ok && mark.reason !== 'EMPTY') {
      issues.push({
        bandId: band.id,
        code: POINTS_ISSUE[mark.reason],
        severity: 'BLOCKS_SAVE',
        message: mark.message,
      });
    }
    if (band.descriptor.trim() === '') {
      // A band nobody can describe is a band two markers will apply differently, and §3.6 treats that disagreement
      // as a defect in the rubric rather than in either marker.
      issues.push({
        bandId: band.id,
        code: 'DESCRIPTOR_EMPTY',
        severity: 'BLOCKS_SAVE',
        message: 'Say what an answer has to do to earn this band.',
      });
    }
    if (seen.has(band.id)) {
      // A saved mark records the band it came from by id. Two bands with one id make that record ambiguous.
      issues.push({
        bandId: band.id,
        code: 'DUPLICATE_ID',
        severity: 'BLOCKS_SAVE',
        message:
          'Two bands share an identifier, so a saved mark could not say which one it came from.',
      });
    }
    seen.add(band.id);
  }

  if (rubric.bands.length > 0 && !rubric.bands.some((band) => band.points === rubric.maxPoints)) {
    issues.push({
      bandId: null,
      code: 'NO_BAND_AWARDS_FULL_MARKS',
      severity: 'ADVISORY',
      message: `No band awards the full ${String(rubric.maxPoints)}. Full marks can still be typed into the mark field.`,
    });
  }

  return issues;
};

export const blocksSave = (issues: readonly RubricIssue[]): boolean =>
  issues.some((issue) => issue.severity === 'BLOCKS_SAVE');

/**
 * THE COMMENT A BAND PREFILLS, OR `null` WHEN IT HAS NONE.
 *
 * ## THE DESCRIPTOR IS NEVER USED AS A FALLBACK
 *
 * A descriptor is written for the marker -- "vague; restates the question" is a perfectly good one -- and prefilling
 * it into a field that is sent to a student would put marker shorthand in the teacher's mouth with the platform's
 * hand. So a band with no comment prefills nothing and the screen says so. Only text a teacher wrote AS feedback is
 * ever offered as feedback.
 */
export const prefillFor = (band: MarkingBand): string | null =>
  band.feedback.trim() === '' ? null : band.feedback;

/**
 * THE QUESTION'S OWN RUBRIC, as marking bands.
 *
 * `RubricBand` in the question contract has `points` and `descriptor` and nothing else, so the comment is empty and
 * the id is positional. The ids are stable for as long as the authored order is, which is the only stability a spec
 * rubric can offer until the contract carries an id of its own.
 */
export const fromSpecRubric = (
  questionId: string,
  maxPoints: number,
  bands: readonly RubricBand[],
): MarkingRubric => ({
  questionId,
  maxPoints,
  bands: bands.map((band, index) => ({
    id: `band-${String(index + 1)}`,
    points: band.points,
    descriptor: band.descriptor,
    feedback: '',
  })),
});

/* ───────────────────────────────────────────────────────────── editing ── */

/**
 * AN ID NO EXISTING BAND HAS. Counted, not drawn: `INV-RNG-1` forbids `Math.random`, and a counter over the existing
 * ids cannot collide with one of them, which a random suffix only probably cannot.
 */
export const nextBandId = (rubric: MarkingRubric): string => {
  let highest = 0;
  for (const band of rubric.bands) {
    const match = /^band-(\d+)$/.exec(band.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `band-${String(highest + 1)}`;
};

export const addBand = (rubric: MarkingRubric): MarkingRubric => ({
  ...rubric,
  bands: [...rubric.bands, { id: nextBandId(rubric), points: 0, descriptor: '', feedback: '' }],
});

export const updateBand = (
  rubric: MarkingRubric,
  bandId: string,
  change: Partial<Omit<MarkingBand, 'id'>>,
): MarkingRubric => ({
  ...rubric,
  bands: rubric.bands.map((band) => (band.id === bandId ? { ...band, ...change } : band)),
});

export const removeBand = (rubric: MarkingRubric, bandId: string): MarkingRubric => ({
  ...rubric,
  bands: rubric.bands.filter((band) => band.id !== bandId),
});

/**
 * MOVE A BAND ONE PLACE. At either end it is a no-op returning the SAME object, so a caller can tell "nothing moved"
 * from "moved" by identity and does not announce a move that did not happen.
 */
export const moveBand = (
  rubric: MarkingRubric,
  bandId: string,
  direction: 'UP' | 'DOWN',
): MarkingRubric => {
  const from = rubric.bands.findIndex((band) => band.id === bandId);
  const to = direction === 'UP' ? from - 1 : from + 1;
  const moving = rubric.bands[from];
  const displaced = rubric.bands[to];
  if (moving === undefined || displaced === undefined) return rubric;
  const bands = [...rubric.bands];
  bands[from] = displaced;
  bands[to] = moving;
  return { ...rubric, bands };
};
