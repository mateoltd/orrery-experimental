import { describe, expect, it } from 'vitest';
import {
  decideFeedbackWrite,
  decideGradingWrite,
  FEEDBACK_MAX_CHARS,
  type FeedbackFacts,
  feedbackVisibleToStudent,
  type GradingAction,
  type MarkFacts,
} from './grading-policy.js';
import { validAutomaticRegrade } from './grading-regrade.js';

const facts: MarkFacts = {
  revision: 2,
  status: 'PENDING_REVIEW',
  released: false,
  releasing: false,
  points: 5,
  sealedAutomatic: false,
};
const score: GradingAction = { kind: 'SCORE', points: 3, feedback: 'Explained one force' };
describe('grading refusals', () => {
  it.each(['0', '1', '3', '02', '', 'NaN'])('refuses stale or non-canonical token %s', (token) => {
    expect(decideGradingWrite(facts, token, score)).toBe('CONFLICT');
  });
  it.each([NaN, Infinity, -1, 5.01, 1.001])(
    'does not round or accept invalid mark %s',
    (points) => {
      expect(decideGradingWrite(facts, '2', { ...score, points })).toBe('INVALID_SCORE');
    },
  );
  it.each([0, 1.01, 5])('allows bounded two-decimal mark %s', (points) => {
    expect(decideGradingWrite(facts, '2', { ...score, points })).toBeNull();
  });
  it('refuses sealed automatic overrides', () => {
    expect(decideGradingWrite({ ...facts, sealedAutomatic: true }, '2', score)).toBe(
      'SEALED_AUTOMATIC',
    );
  });
  it.each(['NOT_STARTED', 'IN_PROGRESS', 'FROZEN', 'VOIDED'])(
    'refuses marking state %s',
    (status) => {
      expect(decideGradingWrite({ ...facts, status }, '2', score)).toBe('NOT_REVIEWABLE');
    },
  );
  it.each(['SCORE', 'EXCUSE', 'FEEDBACK', 'VOID'] as const)('refuses %s after release', (kind) => {
    const action = { ...score, kind, reason: 'Reason', humanConfirmed: true } as GradingAction;
    expect(decideGradingWrite({ ...facts, released: true }, '2', action)).toBe(
      'RELEASED_REQUIRES_REGRADE',
    );
    expect(decideGradingWrite({ ...facts, releasing: true }, '2', action)).toBe(
      'RELEASE_IN_PROGRESS',
    );
  });
  it('requires a reason and a human verdict for void', () => {
    const action: GradingAction = {
      kind: 'VOID',
      reason: ' ',
      humanConfirmed: false,
      consideredAccessibilityContext: true,
    };
    expect(decideGradingWrite(facts, '2', action)).toBe('REASON_REQUIRED');
    expect(decideGradingWrite(facts, '2', { ...action, reason: 'Reviewed evidence' })).toBe(
      'HUMAN_VERDICT_REQUIRED',
    );
    expect(
      decideGradingWrite(facts, '2', {
        ...action,
        reason: 'Reviewed evidence',
        humanConfirmed: true,
      }),
    ).toBeNull();
  });
  it('requires an excuse reason', () => {
    expect(decideGradingWrite(facts, '2', { kind: 'EXCUSE', reason: ' ' })).toBe('REASON_REQUIRED');
  });
  it.each([false, true])(
    'student feedback gate with released membership %s',
    (releasedMembership) => {
      for (const visibility of ['TEACHER_ONLY', 'STUDENT_AFTER_RELEASE'])
        for (const isDraft of [false, true]) {
          expect(feedbackVisibleToStudent({ releasedMembership, visibility, isDraft })).toBe(
            releasedMembership && visibility === 'STUDENT_AFTER_RELEASE' && !isDraft,
          );
        }
    },
  );
  describe('feedback writes', () => {
    const open: FeedbackFacts = {
      status: 'GRADED',
      released: false,
      releasing: false,
      previous: null,
    };
    const shown = { body: 'Comment', visibility: 'STUDENT_AFTER_RELEASE', isDraft: false };
    const note = { ...shown, visibility: 'TEACHER_ONLY' };
    const draft = { ...shown, isDraft: true };
    it('before release every valid comment saves, and an empty draft is still a draft', () => {
      for (const next of [shown, note, draft, { ...draft, body: '' }])
        expect(decideFeedbackWrite(open, next)).toBeNull();
    });
    it.each([
      { ...shown, body: '  ' },
      { ...shown, visibility: 'EVERYONE' },
      { ...shown, body: 'x'.repeat(FEEDBACK_MAX_CHARS + 1) },
      { ...draft, body: 'x'.repeat(FEEDBACK_MAX_CHARS + 1) },
    ])('refuses invalid feedback %#', (next) => {
      expect(decideFeedbackWrite(open, next)).toBe('INVALID_FEEDBACK');
    });
    it.each(['NOT_STARTED', 'IN_PROGRESS', 'FROZEN', 'VOIDED'])(
      'refuses a paper in %s',
      (status) => {
        expect(decideFeedbackWrite({ ...open, status }, note)).toBe('NOT_REVIEWABLE');
      },
    );
    // Every (previous, next) pair, in both frozen states. A write is refused exactly when either side is readable.
    const states = [null, shown, note, draft];
    for (const [flag, reason] of [
      ['released', 'STUDENT_FEEDBACK_AFTER_RELEASE'],
      ['releasing', 'RELEASE_IN_PROGRESS'],
    ] as const)
      for (const previous of states)
        for (const next of [shown, note, draft]) {
          const moves = previous === shown || next === shown;
          it(`${flag}: ${JSON.stringify(previous && [previous.visibility, previous.isDraft])} -> ${next.visibility}/${String(next.isDraft)} is ${moves ? 'refused' : 'saved'}`, () => {
            expect(decideFeedbackWrite({ ...open, [flag]: true, previous }, next)).toBe(
              moves ? reason : null,
            );
          });
        }
    it('a released paper outranks a second batch still releasing', () => {
      expect(decideFeedbackWrite({ ...open, released: true, releasing: true }, shown)).toBe(
        'STUDENT_FEEDBACK_AFTER_RELEASE',
      );
    });
  });
  it('allows a negative raw result but refuses an invalid displayed result', () => {
    const mark = {
      points: 0,
      rawPoints: -2,
      correct: false,
      needsHuman: false,
      rationale: {},
      graderVersion: 'v2',
    };
    expect(validAutomaticRegrade(mark, 5)).toBe(true);
    expect(validAutomaticRegrade({ ...mark, points: -2 }, 5)).toBe(false);
    expect(validAutomaticRegrade({ ...mark, rawPoints: Infinity }, 5)).toBe(false);
    expect(validAutomaticRegrade({ ...mark, graderVersion: '' }, 5)).toBe(false);
  });
});
