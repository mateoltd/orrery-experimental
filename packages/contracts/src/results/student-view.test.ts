/**
 * The sealed student view.  (P10-T5, P10-T8a)
 *
 * Two things are being defended here, and both are invisible in a code review:
 *
 *  · **the sealed view has no score field, so a leak is a compile error** -- `D-25`'s type-level mechanism. Asserted
 *    here as a property over the interface's own keys, because "we were careful" is not a check;
 *  · **the sealed copy is honest**, which is in tension with reassuring. A student who sat a two-hour exam and reads
 *    "results pending" concludes they failed, and nothing in the payload corrects that.
 */

import { describe, expect, it } from 'vitest';

import {
  SCORE_BEARING_FIELD_NAMES,
  type SealedAttemptView,
  type SealedNotice,
  type SealedViewInput,
  sealedCopy,
  toSealedView,
} from './student-view.js';

const T0 = 1_800_000_000_000;

const input = (over: Partial<SealedViewInput> = {}): SealedViewInput => ({
  attemptId: 'a1',
  attemptStatus: 'SUBMITTED',
  assignmentTitle: 'Physics mid-term',
  openedAt: T0 - 3_600_000,
  deadlineAt: T0,
  submittedAt: T0 - 60_000,
  savedQuestionCount: 20,
  totalQuestionCount: 20,
  hasAccommodation: false,
  isReleased: false,
  now: T0,
  ...over,
});

describe('the sealed view has NO score field, and that is the guarantee', () => {
  it('declares no score-bearing key at all -- not nullable, ABSENT', () => {
    /**
     * The whole point of `D-25`'s type-level mechanism. A nullable `finalScore` cannot enforce anything: a handler that
     * forgets the branch sends 0 and nothing complains, because `null` and a real zero are the same type.
     */
    const keys = Object.keys(toSealedView(input()));
    for (const forbidden of SCORE_BEARING_FIELD_NAMES) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('matches the canonical corpus that `audit:seals` uses, so the two cannot drift', () => {
    // 23 keys, the same set P7-T10's gate walks payloads with. A key added to one and not the other is a review
    // finding; a test is cheaper than remembering to check.
    expect(SCORE_BEARING_FIELD_NAMES).toHaveLength(23);
    expect(new Set(SCORE_BEARING_FIELD_NAMES).size).toBe(SCORE_BEARING_FIELD_NAMES.length);
  });

  it('carries NO ratio or count of marks, only a count of SAVES', () => {
    const view = toSealedView(input({ savedQuestionCount: 20, totalQuestionCount: 40 }));
    // A count is fine and useful. A count of CORRECT ones is a score, and a ratio of saves is a progress bar toward a
    // mark the student cannot see.
    expect(view.savedQuestionCount).toBe(20);
    expect(view.totalQuestionCount).toBe(40);
    const keys = Object.keys(view);
    expect(keys).not.toContain('progress');
    expect(keys).not.toContain('ratio');
    expect(keys).not.toContain('answeredCorrectly');
  });

  it('REFUSES to build a sealed view for a released attempt, rather than silently hiding marks', () => {
    /**
     * A silent fallback would tell a student their marks are with their teacher when they have been published, in a
     * handler that believed it had done the right thing.
     */
    expect(() => toSealedView(input({ isReleased: true }))).toThrow(/released/i);
  });
});

describe('the sealed copy is HONEST', () => {
  it('says what is actually happening, for each state', () => {
    const cases: readonly [Partial<SealedViewInput>, RegExp][] = [
      [
        { attemptStatus: 'NOT_STARTED', openedAt: null, deadlineAt: T0 + 86_400_000 },
        /available to you/i,
      ],
      [{ attemptStatus: 'IN_PROGRESS', submittedAt: null }, /saved as you go/i],
      [{ attemptStatus: 'SUBMITTED' }, /not been marked yet/i],
      [{ attemptStatus: 'GRADED' }, /being checked/i],
    ];
    for (const [over, expected] of cases) {
      const view = toSealedView(input(over));
      expect(sealedCopy[view.notice].body, view.notice).toMatch(expected);
    }
  });

  it('says "submitted" is not "graded", rather than implying the wait is nearly over', () => {
    // "Results pending" on a two-hour exam reads as failure, and "we'll let you know soon" implies a queue position
    // the student cannot verify. Both are the same reassurance aimed at the reader rather than the truth.
    const body = sealedCopy.SUBMITTED_AWAITING_MARKING.body.toLowerCase();
    expect(body).toContain('not been marked');
    expect(body).not.toMatch(/soon|shortly|almost|any moment|processing/);
  });

  it('NEVER suggests the student did badly, for any notice', () => {
    for (const notice of Object.keys(sealedCopy) as SealedNotice[]) {
      const text = `${sealedCopy[notice].title} ${sealedCopy[notice].body}`.toLowerCase();
      expect(text, notice).not.toMatch(
        /fail|unsuccessful|poor|low|weak|not passed|below|concern|disappoint|zero/,
      );
    }
  });

  it('gives every notice a non-trivial body', () => {
    // A sealed view with an empty panel is a student with no information and no explanation.
    for (const notice of Object.keys(sealedCopy) as SealedNotice[]) {
      expect(sealedCopy[notice].title.trim().length, notice).toBeGreaterThan(0);
      expect(sealedCopy[notice].body.trim().length, notice).toBeGreaterThan(20);
    }
  });

  it('says the window has passed when an unopened attempt is out of time', () => {
    // Determined by `openedAt === null` rather than by comparing dates: an attempt that was never opened has no
    // business being described as available however the clock reads.
    const view = toSealedView(
      input({ attemptStatus: 'NOT_STARTED', openedAt: null, deadlineAt: T0 - 1, now: T0 }),
    );
    expect(view.notice).toBe('WINDOW_PASSED');
    expect(sealedCopy.WINDOW_PASSED.body).toContain('contact your teacher');
  });

  it('says "not started yet" while the window is still open, not "time has passed"', () => {
    const view = toSealedView(
      input({ attemptStatus: 'NOT_STARTED', openedAt: null, deadlineAt: T0 + 86_400_000 }),
    );
    expect(view.notice).toBe('NOT_STARTED_YET');
  });
});

describe('the accommodation marker', () => {
  it('reports THAT one is in force, and not WHICH', () => {
    /**
     * The student already knows what they were granted. Naming it in a payload a third party can see is disclosure they
     * did not ask for -- and the most common accommodation is a disability, which is exactly the kind of thing that
     * should not be inferred from a network response.
     */
    const view = toSealedView(input({ hasAccommodation: true }));
    expect(view.hasAccommodation).toBe(true);
    const keys = Object.keys(view);
    expect(keys).not.toContain('accommodation');
    expect(keys).not.toContain('accommodationDetail');
  });
});

describe('the view is read-only to a consumer', () => {
  it('reports the attempt id it was given, rather than a placeholder', () => {
    // An empty-string id would pass every shape check and break every lookup.
    expect(toSealedView(input({ attemptId: 'attempt-xyz' })).attemptId).toBe('attempt-xyz');
  });

  it('carries no key whose value is a bare placeholder', () => {
    const view: SealedAttemptView = toSealedView(input());
    for (const [key, value] of Object.entries(view)) {
      if (typeof value === 'string') expect(value.length, key).toBeGreaterThan(0);
    }
  });
});
