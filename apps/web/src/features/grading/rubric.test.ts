/**
 * Rubric bands and the mark bound.  (P9-T3)
 *
 * The property under test is that there is ONE door for a hand-entered mark and that it does not open below zero or
 * above the question's points. `plans/07` §3.2 allows negative RAW scores for two named methods behind §3.3's publish
 * guard; a band is neither, and a band that could go negative would be a penalty no publish check can see.
 */

import { describe, expect, it } from 'vitest';

import {
  addBand,
  blocksSave,
  checkMark,
  fromSpecRubric,
  type MarkingRubric,
  moveBand,
  nextBandId,
  parseMark,
  prefillFor,
  removeBand,
  updateBand,
  validateRubric,
} from './rubric';

const rubric = (over: Partial<MarkingRubric> = {}): MarkingRubric => ({
  questionId: 'q7',
  maxPoints: 5,
  bands: [
    {
      id: 'band-1',
      points: 5,
      descriptor: 'names both forces and the resulting acceleration',
      feedback: 'Both forces are named and linked to the acceleration.',
    },
    {
      id: 'band-2',
      points: 2,
      descriptor: 'names one force',
      feedback: 'One force is named. The second force is not mentioned.',
    },
    { id: 'band-3', points: 0, descriptor: 'no force named', feedback: '' },
  ],
  ...over,
});

describe('checkMark: the one door for a hand-entered mark', () => {
  it('accepts the two ends of the range and a value between them', () => {
    expect(checkMark(0, 5)).toEqual({ ok: true, points: 0 });
    expect(checkMark(5, 5)).toEqual({ ok: true, points: 5 });
    expect(checkMark(2.25, 5)).toEqual({ ok: true, points: 2.25 });
  });

  it('REFUSES a negative mark, however small, and says where a penalty belongs instead', () => {
    for (const value of [-0.01, -1, -1000]) {
      const outcome = checkMark(value, 5);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('BELOW_ZERO');
        expect(outcome.message).toContain('scoring method on the question');
      }
    }
  });

  it('REFUSES a mark above the maximum rather than clamping it, because 7 on a 5-mark question is a typing slip', () => {
    const outcome = checkMark(7, 5);
    expect(outcome).toEqual({
      ok: false,
      reason: 'ABOVE_MAXIMUM',
      message: 'This question is worth 5. A mark cannot be above that.',
    });
    // The smallest step over is still over.
    expect(checkMark(5.01, 5).ok).toBe(false);
  });

  it('refuses NaN and both infinities, which would otherwise serialise to null in a stored column', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const outcome = checkMark(value, 5);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('NOT_A_NUMBER');
    }
  });

  it('refuses a third decimal place, which the Decimal(9,2) column would round without telling anyone', () => {
    const outcome = checkMark(2.555, 5);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('TOO_PRECISE');
  });

  it('does not report a two-decimal value as too precise because of binary rounding', () => {
    // `1.005 * 100` is 100.49999999999999, so a multiply-and-round check calls these changed. They are not.
    for (const value of [1.1, 2.3, 0.07, 4.35, 1.15]) {
      expect(checkMark(value, 5)).toEqual({ ok: true, points: value });
    }
  });

  it('normalises -0 to 0, which would otherwise compare unequal to the zero already stored', () => {
    const outcome = checkMark(-0, 5);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(Object.is(outcome.points, 0)).toBe(true);
  });
});

describe('parseMark: the mark as TYPED', () => {
  it('reads plain decimals, with surrounding whitespace', () => {
    expect(parseMark('3', 5)).toEqual({ ok: true, points: 3 });
    expect(parseMark(' 2.5 ', 5)).toEqual({ ok: true, points: 2.5 });
    expect(parseMark('.5', 5)).toEqual({ ok: true, points: 0.5 });
    expect(parseMark('3.', 5)).toEqual({ ok: true, points: 3 });
  });

  it('treats an EMPTY field as no mark, never as a mark of zero', () => {
    // `Number('')` and `Number('  ')` are both 0. An unmarked response saved as zero is the failure this screen
    // exists to prevent.
    for (const raw of ['', '   ', '\t']) {
      const outcome = parseMark(raw, 5);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('EMPTY');
    }
  });

  it('refuses every spelling `Number()` would be generous about', () => {
    // 1e0 -> 1, 0x2 -> 2, Infinity, "2,5" (a decimal comma), "3 marks".
    for (const raw of ['1e0', '0x2', 'Infinity', '2,5', '3 marks', 'three', '--1', '1.2.3']) {
      const outcome = parseMark(raw, 5);
      expect(outcome.ok, raw).toBe(false);
      if (!outcome.ok) expect(outcome.reason, raw).toBe('NOT_A_NUMBER');
    }
  });

  it('refuses a typed negative through the same door as a negative band', () => {
    const outcome = parseMark('-1', 5);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('BELOW_ZERO');
  });

  it('refuses a typed mark above the maximum', () => {
    const outcome = parseMark('6', 5);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ABOVE_MAXIMUM');
  });
});

describe('validateRubric', () => {
  it('finds nothing wrong with a rubric whose bands are in range, described, and reach full marks', () => {
    expect(validateRubric(rubric())).toEqual([]);
  });

  it('BLOCKS a negative band: a penalty written as a band is invisible to the publish-time guard', () => {
    const issues = validateRubric(updateBand(rubric(), 'band-3', { points: -2 }));
    expect(issues.map((issue) => [issue.bandId, issue.code, issue.severity])).toEqual([
      ['band-3', 'POINTS_BELOW_ZERO', 'BLOCKS_SAVE'],
    ]);
    expect(blocksSave(issues)).toBe(true);
  });

  it('BLOCKS a band worth more than the question', () => {
    const issues = validateRubric(updateBand(rubric(), 'band-1', { points: 6 }));
    expect(issues.map((issue) => [issue.bandId, issue.code])).toContainEqual([
      'band-1',
      'POINTS_ABOVE_MAXIMUM',
    ]);
    expect(blocksSave(issues)).toBe(true);
  });

  it('BLOCKS a band with a non-finite or over-precise value', () => {
    expect(
      validateRubric(updateBand(rubric(), 'band-2', { points: Number.NaN })).map((i) => i.code),
    ).toContain('POINTS_NOT_A_NUMBER');
    expect(
      validateRubric(updateBand(rubric(), 'band-2', { points: 1.999 })).map((i) => i.code),
    ).toContain('POINTS_TOO_PRECISE');
  });

  it('BLOCKS a band with no descriptor, including one that is only whitespace', () => {
    const issues = validateRubric(updateBand(rubric(), 'band-2', { descriptor: '   ' }));
    expect(issues.map((issue) => [issue.bandId, issue.code])).toEqual([
      ['band-2', 'DESCRIPTOR_EMPTY'],
    ]);
  });

  it('reports EVERY problem at once, in band order, rather than the first', () => {
    const broken = updateBand(updateBand(rubric(), 'band-1', { points: 9 }), 'band-3', {
      points: -1,
      descriptor: '',
    });
    expect(validateRubric(broken).map((issue) => [issue.bandId, issue.code])).toEqual([
      ['band-1', 'POINTS_ABOVE_MAXIMUM'],
      ['band-3', 'POINTS_BELOW_ZERO'],
      ['band-3', 'DESCRIPTOR_EMPTY'],
      [null, 'NO_BAND_AWARDS_FULL_MARKS'],
    ]);
  });

  it('BLOCKS two bands sharing an id, because a saved mark names its band by id', () => {
    const duplicated: MarkingRubric = {
      ...rubric(),
      bands: [...rubric().bands, { id: 'band-2', points: 1, descriptor: 'a copy', feedback: '' }],
    };
    expect(validateRubric(duplicated).map((issue) => issue.code)).toEqual(['DUPLICATE_ID']);
  });

  it('only ADVISES when no band reaches full marks, because a teacher may mean that', () => {
    const issues = validateRubric(updateBand(rubric(), 'band-1', { points: 4 }));
    expect(issues.map((issue) => [issue.code, issue.severity])).toEqual([
      ['NO_BAND_AWARDS_FULL_MARKS', 'ADVISORY'],
    ]);
    expect(blocksSave(issues)).toBe(false);
  });

  it('does not advise about full marks on an EMPTY rubric, which is simply a question marked without bands', () => {
    expect(validateRubric(rubric({ bands: [] }))).toEqual([]);
  });

  it('allows two bands worth the same, which is two routes to one mark and not a defect', () => {
    const issues = validateRubric(updateBand(rubric(), 'band-3', { points: 2 }));
    expect(issues).toEqual([]);
  });
});

describe('prefillFor', () => {
  it('returns the comment a teacher wrote for the band, verbatim', () => {
    const band = rubric().bands[1];
    expect(band && prefillFor(band)).toBe('One force is named. The second force is not mentioned.');
  });

  it('returns NULL for a band with no comment, and never falls back to the descriptor', () => {
    // The descriptor is marker shorthand. Sending it to a student as prefilled feedback would be the platform
    // choosing words for the teacher.
    const band = rubric().bands[2];
    expect(band && prefillFor(band)).toBeNull();
    expect(prefillFor({ id: 'b', points: 1, descriptor: 'vague', feedback: '  \n ' })).toBeNull();
  });
});

describe('fromSpecRubric', () => {
  it('carries points and descriptors across with positional ids and NO invented comment', () => {
    expect(
      fromSpecRubric('q1', 3, [
        { points: 3, descriptor: 'names both forces' },
        { points: 1, descriptor: 'names one force' },
      ]),
    ).toEqual({
      questionId: 'q1',
      maxPoints: 3,
      bands: [
        { id: 'band-1', points: 3, descriptor: 'names both forces', feedback: '' },
        { id: 'band-2', points: 1, descriptor: 'names one force', feedback: '' },
      ],
    });
  });
});

describe('editing', () => {
  it('adds a band with an id no existing band has, worth zero, with nothing written', () => {
    const next = addBand(rubric());
    expect(next.bands).toHaveLength(4);
    expect(next.bands[3]).toEqual({ id: 'band-4', points: 0, descriptor: '', feedback: '' });
  });

  it('does not reuse the id of a band removed from the middle', () => {
    // band-2 is gone, band-3 remains: a count-based id would produce `band-3` again.
    const next = addBand(removeBand(rubric(), 'band-2'));
    expect(next.bands.map((band) => band.id)).toEqual(['band-1', 'band-3', 'band-4']);
    expect(nextBandId(rubric({ bands: [] }))).toBe('band-1');
  });

  it('moves a band one place and leaves the others in order', () => {
    expect(moveBand(rubric(), 'band-3', 'UP').bands.map((band) => band.id)).toEqual([
      'band-1',
      'band-3',
      'band-2',
    ]);
    expect(moveBand(rubric(), 'band-1', 'DOWN').bands.map((band) => band.id)).toEqual([
      'band-2',
      'band-1',
      'band-3',
    ]);
  });

  it('returns the SAME rubric when a move runs off either end or names no band', () => {
    const original = rubric();
    expect(moveBand(original, 'band-1', 'UP')).toBe(original);
    expect(moveBand(original, 'band-3', 'DOWN')).toBe(original);
    expect(moveBand(original, 'nope', 'UP')).toBe(original);
  });

  it('updates only the named band and only the named fields', () => {
    const next = updateBand(rubric(), 'band-2', { points: 3 });
    expect(next.bands[1]).toEqual({
      id: 'band-2',
      points: 3,
      descriptor: 'names one force',
      feedback: 'One force is named. The second force is not mentioned.',
    });
    expect(next.bands[0]).toEqual(rubric().bands[0]);
    expect(next.bands[2]).toEqual(rubric().bands[2]);
  });
});
