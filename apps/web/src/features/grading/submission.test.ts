/**
 * From a draft to a submission.  (P9-T2)
 *
 * The refusals are the point: an empty mark is not a zero, a mark out of range does not leave the browser, an excuse
 * needs a reason, and nothing but a flag can be sent for a sealed auto-grade.
 */

import { describe, expect, it } from 'vitest';

import { EXCUSE_REASON_REQUIRED } from './copy';
import { EMPTY_DRAFT, type MarkDraft } from './draft';
import { choiceWrong, essayAwaiting, multiPenalised, simFault } from './fixtures';
import { markingStateOf } from './markingState';
import { applyAcknowledged, buildSubmission, initialDraftFor } from './submission';

const draft = (over: Partial<MarkDraft> = {}): MarkDraft => ({ ...EMPTY_DRAFT, ...over });
const build = (facts: Parameters<typeof buildSubmission>[0], over: Partial<MarkDraft> = {}) =>
  buildSubmission(facts, draft(over), EXCUSE_REASON_REQUIRED);

describe('buildSubmission: a mark', () => {
  it('sends the parsed mark, the comment, the band and how it was entered', () => {
    expect(
      build(essayAwaiting(), {
        score: ' 2.5 ',
        feedback: 'One force is named.',
        bandId: 'band-2',
        quickScored: true,
        flagged: true,
      }),
    ).toEqual({
      ok: true,
      submission: {
        responseId: 'r-essay',
        questionId: 'q-essay',
        basedOn: 'v1',
        flagged: true,
        resolution: 'MARK',
        points: 2.5,
        feedback: 'One force is named.',
        bandId: 'band-2',
        quickScored: true,
      },
    });
  });

  it('REFUSES an empty mark and points at the mark field -- an unmarked response is never saved as zero', () => {
    const built = build(essayAwaiting(), { feedback: 'A comment with no mark.' });
    expect(built).toEqual({ ok: false, field: 'score', message: 'Enter a mark before saving.' });
  });

  it('sends an explicit zero, which IS a mark', () => {
    const built = build(essayAwaiting(), { score: '0' });
    expect(built.ok && built.submission?.resolution === 'MARK' && built.submission.points).toBe(0);
  });

  it('REFUSES a mark above the question’s points, a negative mark, and text', () => {
    for (const [score, fragment] of [
      ['6', 'cannot be above'],
      ['-1', 'cannot be below 0'],
      ['five', 'has to be a number'],
      ['2.555', 'decimal places'],
    ] as const) {
      const built = build(essayAwaiting(), { score });
      expect(built.ok, score).toBe(false);
      if (!built.ok) {
        expect(built.field, score).toBe('score');
        expect(built.message, score).toContain(fragment);
      }
    }
  });
});

describe('buildSubmission: a response already marked', () => {
  const marked = essayAwaiting({
    needsHuman: false,
    manual: { points: 2, feedback: 'One force is named.', bandId: 'band-2' },
  });

  it('sends NOTHING when the draft is the saved mark untouched, so moving past it writes no new grade', () => {
    expect(buildSubmission(marked, initialDraftFor(marked), EXCUSE_REASON_REQUIRED)).toEqual({
      ok: true,
      submission: null,
    });
  });

  it('sends the mark again once anything about it has changed', () => {
    const built = buildSubmission(
      marked,
      { ...initialDraftFor(marked), feedback: 'One force is named. See page 4.' },
      EXCUSE_REASON_REQUIRED,
    );
    expect(built.ok && built.submission?.resolution).toBe('MARK');
  });

  it('still refuses an empty mark on an UNMARKED response whose draft is untouched', () => {
    // The shortcut above is only for a response somebody has already decided. An untouched draft on an unmarked
    // essay is not "nothing to save" -- it is nothing entered.
    const facts = essayAwaiting();
    expect(buildSubmission(facts, initialDraftFor(facts), EXCUSE_REASON_REQUIRED).ok).toBe(false);
  });
});

describe('buildSubmission: an excuse', () => {
  it('REFUSES an excuse with no reason, or a reason that is only whitespace, and points at the reason field', () => {
    for (const excuseReason of ['', '   ', '\n']) {
      expect(build(essayAwaiting(), { excused: true, excuseReason })).toEqual({
        ok: false,
        field: 'excuseReason',
        message: EXCUSE_REASON_REQUIRED,
      });
    }
  });

  it('sends the trimmed reason and NO mark, even when one is sitting in the draft', () => {
    const built = build(essayAwaiting(), {
      excused: true,
      excuseReason: '  Fire alarm during this question. ',
      score: '2',
    });
    expect(built).toEqual({
      ok: true,
      submission: {
        responseId: 'r-essay',
        questionId: 'q-essay',
        basedOn: 'v1',
        flagged: false,
        resolution: 'EXCUSE',
        reason: 'Fire alarm during this question.',
        feedback: '',
      },
    });
  });

  it('does not check the mark of an excused response, because the mark is not used', () => {
    expect(build(essayAwaiting(), { excused: true, excuseReason: 'Absent.', score: '99' }).ok).toBe(
      true,
    );
  });
});

describe('buildSubmission: accepting the automatic mark', () => {
  it('sends ACCEPT_AUTO_MARK with no points for a penalised-below-zero response', () => {
    const built = build(multiPenalised(), { acceptAuto: true });
    expect(built.ok && built.submission).toEqual({
      responseId: 'r-multi',
      questionId: 'q-multi',
      basedOn: 'v1',
      flagged: false,
      resolution: 'ACCEPT_AUTO_MARK',
      feedback: '',
    });
  });

  it('IGNORES `acceptAuto` where there is no automatic mark to accept, and asks for a real one', () => {
    // A draft carrying the flag for the wrong response -- restored, or edited by hand -- must not turn an unmarked
    // essay or a simulation fault into an accepted zero.
    for (const facts of [essayAwaiting(), simFault()]) {
      expect(build(facts, { acceptAuto: true })).toEqual({
        ok: false,
        field: 'score',
        message: 'Enter a mark before saving.',
      });
    }
  });
});

describe('buildSubmission: a sealed auto-grade', () => {
  it('sends NOTHING when only the flag could change and it has not', () => {
    expect(build(choiceWrong())).toEqual({ ok: true, submission: null });
  });

  it('sends the flag alone when it changed', () => {
    const built = build(choiceWrong(), { flagged: true });
    expect(built.ok && built.submission).toEqual({
      responseId: 'r-choice-wrong',
      questionId: 'q-choice',
      basedOn: 'v1',
      flagged: true,
      resolution: 'FLAG_ONLY',
    });
  });

  it('NEVER sends a mark or an excuse for a sealed response, whatever the draft holds', () => {
    const built = build(choiceWrong(), {
      score: '2',
      excused: true,
      excuseReason: 'x',
      acceptAuto: true,
      feedback: 'override',
    });
    expect(built).toEqual({ ok: true, submission: null });
  });
});

describe('initialDraftFor', () => {
  it('is empty for an unmarked response, carrying only its stored flag and excuse', () => {
    expect(initialDraftFor(essayAwaiting({ flagged: true }))).toEqual({
      ...EMPTY_DRAFT,
      flagged: true,
    });
  });

  it('opens on the saved mark, comment and band when there is one', () => {
    const facts = essayAwaiting({
      manual: { points: 2, feedback: 'One force is named.', bandId: 'band-2' },
    });
    expect(initialDraftFor(facts)).toEqual({
      ...EMPTY_DRAFT,
      score: '2',
      feedback: 'One force is named.',
      bandId: 'band-2',
    });
  });

  it('does not treat a saved comment as replaceable prefill', () => {
    const facts = essayAwaiting({ manual: { points: 2, feedback: 'Saved.', bandId: 'band-2' } });
    expect(initialDraftFor(facts).prefill).toBeNull();
  });
});

describe('applyAcknowledged', () => {
  it('turns an awaiting response into a marked one, with the mark that was sent', () => {
    const facts = essayAwaiting();
    const built = build(facts, { score: '3', feedback: 'f', bandId: null });
    if (!built.ok || built.submission === null) throw new Error('expected a submission');
    const after = applyAcknowledged(facts, built.submission, 'v2');
    expect(markingStateOf(after)).toEqual({ kind: 'MARKED', points: 3, maxPoints: 5 });
    expect(after.version).toBe('v2');
    expect(after.needsHuman).toBe(false);
  });

  it('keeps the old version when the server returned none', () => {
    const facts = essayAwaiting();
    const built = build(facts, { score: '3' });
    if (!built.ok || built.submission === null) throw new Error('expected a submission');
    expect(applyAcknowledged(facts, built.submission, undefined).version).toBe('v1');
  });

  it('excuses', () => {
    const facts = essayAwaiting();
    const built = build(facts, { excused: true, excuseReason: 'Absent.' });
    if (!built.ok || built.submission === null) throw new Error('expected a submission');
    expect(markingStateOf(applyAcknowledged(facts, built.submission, 'v2'))).toEqual({
      kind: 'EXCUSED',
    });
  });

  it('resolves an accepted automatic mark WITHOUT writing a manual mark and without touching the raw score', () => {
    const facts = multiPenalised();
    const built = build(facts, { acceptAuto: true });
    if (!built.ok || built.submission === null) throw new Error('expected a submission');
    const after = applyAcknowledged(facts, built.submission, 'v2');
    expect(after.manual).toBeNull();
    expect(after.auto?.rawPoints).toBe(-2);
    expect(markingStateOf(after)).toEqual({
      kind: 'MARKED_AUTOMATICALLY',
      points: 0,
      maxPoints: 4,
    });
  });

  it('changes only the flag for a sealed response', () => {
    const facts = choiceWrong();
    const built = build(facts, { flagged: true });
    if (!built.ok || built.submission === null) throw new Error('expected a submission');
    const after = applyAcknowledged(facts, built.submission, undefined);
    expect(after.flagged).toBe(true);
    expect(markingStateOf(after)).toEqual(markingStateOf(facts));
  });
});
