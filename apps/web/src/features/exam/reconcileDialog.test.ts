/**
 * Tests for the 409 dialog.  (P7-T11)
 *
 * ## WHAT MATTERS HERE IS WHAT THE STUDENT CAN DISTINGUISH
 *
 * A dialog that asks a student to choose without showing them what they are choosing between is a coin flip with
 * extra steps. So most of these tests are about distinctions being VISIBLE: answered-with-nothing versus
 * unanswered, this device versus another, and a real conflict versus two copies of the same answer.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ReconcileRequired } from './answerStore';
import { displayAnswer, needsAChoice, reconcileDialog } from './reconcileDialog';

const RUNS = 200;

const reconcile = (over: Partial<ReconcileRequired> = {}): ReconcileRequired => ({
  questionId: 'q3',
  mine: { choiceIds: ['a'] },
  theirs: { choiceIds: ['a', 'c'] },
  myRevision: 3,
  theirRevision: 2,
  ...over,
});

describe('an answer is RENDERED, and never shown raw', () => {
  it('shows a string as itself and an empty one as EMPTY', () => {
    expect(displayAnswer('photosynthesis')).toBe('photosynthesis');
    expect(displayAnswer('   ')).toBe('Empty');
  });

  it('renders an OBJECT as `key: value` pairs, because raw JSON is not an answer to a student', () => {
    // A `multi_select` answer is `{choiceIds: [...]}`; showing that verbatim tells a student nothing about whether
    // their answer is right, which is the only thing they are being asked.
    expect(displayAnswer({ choiceIds: ['a', 'c'] })).toBe('choiceIds: 2 selected');
  });

  it('renders an object with an EMPTY-STRING key as something, rather than as nothing', () => {
    // Found by a property, not by reading: `Object.keys({'' : 0}).join(', ')` is the empty string, and an empty
    // render reads as a fault rather than as an answer.
    expect(displayAnswer({ '': 0 }).length).toBeGreaterThan(0);
  });

  it('renders two objects with the same keys and DIFFERENT values differently', () => {
    /**
     * The defect that made the dialog pointless for the most common conflict there is: summarising by keys alone
     * rendered both sides of a `multi_select` 409 as the identical string `choiceIds`.
     */
    expect(displayAnswer({ choiceIds: ['a'] })).not.toBe(displayAnswer({ choiceIds: ['a', 'c'] }));
  });

  it('counts an ARRAY rather than printing it', () => {
    expect(displayAnswer(['a', 'b'])).toBe('2 selected');
    expect(displayAnswer([])).toBe('Empty');
  });

  it('shows a number and a boolean as themselves', () => {
    expect(displayAnswer(5)).toBe('5');
    expect(displayAnswer(false)).toBe('false');
  });

  it('never returns an empty string, because a blank cell reads as a rendering fault', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => displayAnswer(value).length > 0),
      { numRuns: RUNS },
    );
  });

  it('distinguishes UNANSWERED from EMPTY, which are different facts', () => {
    /**
     * `undefined` means the question was never answered, and the grader reports a blank answer as `BLANK` rather
     * than as nothing. Rendering both as an empty box would make "I cleared it" and "they never answered"
     * indistinguishable, and the student would pick wrongly on a question where the difference is the whole mark.
     */
    expect(displayAnswer(undefined)).toBe('No answer');
    expect(displayAnswer('')).toBe('Empty');
    expect(displayAnswer(null)).toBe('Empty');
    expect(displayAnswer({})).toBe('Empty');
  });
});

describe('the dialog shows BOTH answers, which is the whole point of asking', () => {
  it('names both sides and both revisions', () => {
    // The common case is one student editing the same question on two devices, and "revision 3 (this device) /
    // revision 2 (another device)" is the entire explanation of what happened.
    const dialog = reconcileDialog(reconcile());
    expect(dialog?.mine.label).toBe('This device');
    expect(dialog?.theirs.label).toBe('Another device');
    expect(dialog?.mine.revision).toBe(3);
    expect(dialog?.theirs.revision).toBe(2);
  });

  it('shows the two answers DIFFERENTLY, so the choice is informed', () => {
    const dialog = reconcileDialog(reconcile());
    expect(dialog?.mine.display).not.toBe(dialog?.theirs.display);
  });

  it('says the choice cannot be undone, because it cannot', () => {
    const dialog = reconcileDialog(reconcile());
    expect(dialog?.mine.consequence).toContain('Discards');
    expect(dialog?.theirs.consequence).toContain('Discards');
  });

  it('names the CAUSE, because §9.3 says a 409 is also how a second device is detected', () => {
    // Leaving the student to guess produces a support ticket that says "it said my answer was wrong".
    expect(reconcileDialog(reconcile())?.explanation).toContain('more than one place');
  });

  it('is null when there is nothing to reconcile, rather than an empty dialog', () => {
    expect(reconcileDialog(null)).toBeNull();
  });

  it('labels which side is which by an explicit field, so a caller cannot swap them silently', () => {
    // `side: 'MINE' | 'THEIRS'` is not decoration: rendering this device's answer under "Another device" would be
    // the worst possible bug in this file, and it is invisible to a test that only checks the strings.
    const dialog = reconcileDialog(reconcile());
    expect(dialog?.mine.side).toBe('MINE');
    expect(dialog?.theirs.side).toBe('THEIRS');
  });
});

describe('an UNANSWERED side is marked as such, not rendered as an empty box', () => {
  it('flags `mine` unanswered when it is undefined', () => {
    const dialog = reconcileDialog(reconcile({ mine: undefined }));
    expect(dialog?.mine.unanswered).toBe(true);
    expect(dialog?.mine.display).toBe('No answer');
    expect(dialog?.theirs.unanswered).toBe(false);
  });

  it('flags `theirs` unanswered when it is undefined', () => {
    const dialog = reconcileDialog(reconcile({ theirs: undefined }));
    expect(dialog?.theirs.unanswered).toBe(true);
    expect(dialog?.theirs.display).toBe('No answer');
  });

  it('flags BOTH when neither device answered, which is still a revision conflict', () => {
    const dialog = reconcileDialog(reconcile({ mine: undefined, theirs: undefined }));
    expect(dialog?.mine.unanswered).toBe(true);
    expect(dialog?.theirs.unanswered).toBe(true);
    // Two copies of the same absence is not a conflict the student needs to resolve.
    expect(dialog?.identical).toBe(true);
  });
});

describe('TWO COPIES OF THE SAME ANSWER IS NOT A CONFLICT', () => {
  it('reports them as identical', () => {
    const dialog = reconcileDialog(reconcile({ theirs: { choiceIds: ['a'] } }));
    expect(dialog?.identical).toBe(true);
  });

  it('does not ASK, so a caller may dismiss it without re-queueing a write that says nothing', () => {
    /**
     * Calling `KEEP_MINE` on an identical pair would bump the revision and re-send a write that changes nothing --
     * and `KEEP_MINE` generates a NEW idempotency key, so the server would store a second revision of an unchanged
     * answer and the audit chain would record an edit nobody made.
     */
    expect(needsAChoice(reconcileDialog(reconcile({ theirs: { choiceIds: ['a'] } })))).toBe(false);
    expect(needsAChoice(reconcileDialog(reconcile()))).toBe(true);
    expect(needsAChoice(null)).toBe(false);
  });

  it('treats an absent answer and an empty one as DIFFERENT, because they are', () => {
    // `undefined` versus `{choiceIds: []}`: one is unanswered, the other is a cleared multi-select. Same rendering
    // (`Empty` for the second, `No answer` for the first) and a real difference in what the student did.
    expect(displayAnswer(undefined)).not.toBe(displayAnswer({ choiceIds: [] }));
  });
});

describe('properties over the dialog', () => {
  it('always names both sides, for any pair of answers', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (mine, theirs) => {
        const dialog = reconcileDialog(reconcile({ mine, theirs }));
        if (dialog === null) return false;
        // Both labels and both button labels exist whatever the answers are, because a dialog missing one side is
        // not a choice.
        return (
          dialog.mine.label.length > 0 &&
          dialog.theirs.label.length > 0 &&
          dialog.mine.buttonLabel.length > 0 &&
          dialog.theirs.buttonLabel.length > 0 &&
          dialog.mine.display.length > 0 &&
          dialog.theirs.display.length > 0
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('never claims a choice is needed when the two displays are the same', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const dialog = reconcileDialog(reconcile({ mine: value, theirs: value }));
        return dialog !== null && needsAChoice(dialog) === false;
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps `unanswered` consistent with the rendered text, for any answer', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const dialog = reconcileDialog(reconcile({ mine: value }));
        // The flag and the words cannot drift: `unanswered` is what a renderer styles differently, and a flag
        // disagreeing with its own text is a bug nobody sees until a student is told they did not answer.
        return dialog !== null && dialog.mine.unanswered === (value === undefined);
      }),
      { numRuns: RUNS },
    );
  });
});
