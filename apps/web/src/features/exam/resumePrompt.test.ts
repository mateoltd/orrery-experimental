/**
 * Tests for the resume prompt.  (P7-T14)
 *
 * ## THE ORDERING IS THE TEST
 *
 * Three cases can apply at once, and getting the order wrong misinforms the student in a way they cannot detect.
 * So the ordering is asserted directly, with all three conditions true at once, rather than one case at a time.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Durability } from './answerStore';
import { NOT_CLEAN, resumePrompt } from './resumePrompt';

/**
 * TYPED AS `Arbitrary<Durability>` RATHER THAN `constantFrom('CLEAN', 'PENDING', ...)`.
 *
 * `constantFrom` widens to `string`, which then fails to assign to `Pick<AttemptState, 'durability'>`. The cast at
 * each call site would have hidden the real problem -- that the generator could produce a value the reducer's
 * state can never hold -- behind `as Durability` at twenty places instead of one.
 */
const arbDurability: fc.Arbitrary<Durability> = fc.constantFrom(
  'CLEAN',
  'PENDING',
  'OFFLINE',
  'ABANDONED',
);

const AT = 1_000_000;
const RUNS = 200;

const clean = { queued: [], durability: 'CLEAN' as const, deadlineAt: AT + 3_600_000 };
const now = { clientNow: AT, offset: 0 };

describe('a clean return says nothing, because a prompt with no news is an interruption', () => {
  it('returns null when nothing needs saying', () => {
    expect(resumePrompt(clean, now)).toBeNull();
  });

  it('returns null with a queued write of zero length AND a clean durability', () => {
    expect(resumePrompt({ ...clean, queued: [] }, now)).toBeNull();
  });
});

describe('UNSAVED is BLOCKING, because continuing means writing onto a paper whose last answers may be missing', () => {
  it('says so when the queue holds a write', () => {
    const prompt = resumePrompt(
      {
        ...clean,
        queued: [
          { seq: 1, questionId: 'q1', answer: 'x', revision: 1, idempotencyKey: 'k', issuedAt: AT },
        ],
      },
      now,
    );
    expect(prompt?.kind).toBe('UNSAVED');
    expect(prompt?.blocking).toBe(true);
    expect(prompt?.detail).toContain('saved on this device');
  });

  it('says so when OFFLINE with an EMPTY queue', () => {
    /**
     * The case that makes `queued.length === 0` insufficient on its own: the connection dropped and nothing had
     * been written since, so the queue is genuinely empty and the student still does not know their paper reached
     * the server.
     */
    expect(resumePrompt({ ...clean, durability: 'OFFLINE' }, now)?.kind).toBe('UNSAVED');
  });

  it('keeps saying it when ABANDONED, even if the queue later emptied', () => {
    /**
     * `ABANDONED` means the student's belief was formed under a warning. Quietly replacing "may not have been
     * recorded" with "all answers saved" is worse than the original uncertainty, because they would stop checking.
     */
    const prompt = resumePrompt({ ...clean, queued: [], durability: 'ABANDONED' }, now);
    expect(prompt?.kind).toBe('UNSAVED');
    expect(prompt?.detail).toContain('cannot confirm');
  });

  it('reports PENDING as unsaved too', () => {
    // A write acknowledged by the browser but not yet by the server is still not saved, and `PENDING` is the
    // state a student sits in while every autosave round-trips.
    expect(resumePrompt({ ...clean, durability: 'PENDING' }, now)?.kind).toBe('UNSAVED');
  });

  it('pluralises correctly, because "1 answers" reads as a bug to a student', () => {
    const one = resumePrompt(
      {
        ...clean,
        queued: [
          { seq: 1, questionId: 'q1', answer: 'x', revision: 1, idempotencyKey: 'k', issuedAt: AT },
        ],
      },
      now,
    );
    const two = resumePrompt(
      {
        ...clean,
        queued: [
          {
            seq: 1,
            questionId: 'q1',
            answer: 'x',
            revision: 1,
            idempotencyKey: 'k1',
            issuedAt: AT,
          },
          {
            seq: 2,
            questionId: 'q2',
            answer: 'y',
            revision: 1,
            idempotencyKey: 'k2',
            issuedAt: AT,
          },
        ],
      },
      now,
    );
    expect(one?.detail).toContain('1 answer ');
    expect(two?.detail).toContain('2 answers ');
  });
});

describe('TIME_PASSED outranks UNSAVED, and saying "unsaved" to a closed paper is useless', () => {
  it('reports TIME_PASSED when the deadline has gone, even with unsaved answers', () => {
    const prompt = resumePrompt(
      {
        queued: [
          { seq: 1, questionId: 'q1', answer: 'x', revision: 1, idempotencyKey: 'k', issuedAt: AT },
        ],
        durability: 'OFFLINE',
        deadlineAt: AT - 1,
      },
      now,
    );
    expect(prompt?.kind).toBe('TIME_PASSED');
    expect(prompt?.detail).toContain('closed while you were away');
  });

  it('is NOT blocking, because there is nothing to continue into', () => {
    // A dialog a student must dismiss before a closed paper opens is a dialog with no purpose.
    const prompt = resumePrompt({ ...clean, deadlineAt: AT - 1 }, now);
    expect(prompt?.blocking).toBe(false);
  });

  it('uses the CORRECTED now, so a drifted client clock cannot reopen a closed paper', () => {
    /**
     * THE WHOLE POINT OF THE SERVER CLOCK. A student whose device clock is a minute slow would, reading their own
     * clock, see time remaining on a paper that closed a minute ago -- and would keep typing into it.
     */
    const closed = { ...clean, deadlineAt: AT - 1 };
    // No `?.kind`: optional chaining a NULL result yields `undefined`, and asserting `toBeNull()` on that
    // fails for the wrong reason -- the prompt is absent, which is what `toBeNull()` on the result itself says.
    expect(resumePrompt(closed, { clientNow: AT - 60_000, offset: 0 })).toBeNull();
    expect(resumePrompt(closed, { clientNow: AT, offset: 60_000 })?.kind).toBe('TIME_PASSED');
  });

  it('treats the deadline as INCLUSIVE at the instant itself', () => {
    expect(resumePrompt({ ...clean, deadlineAt: AT }, now)).toBeNull();
    expect(resumePrompt({ ...clean, deadlineAt: AT - 1 }, now)?.kind).toBe('TIME_PASSED');
  });

  it('does not close an UNTIMED attempt, whatever the clock says', () => {
    const untimed = { ...clean, deadlineAt: null };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        (clientNow) => resumePrompt(untimed, { clientNow: AT + clientNow, offset: 0 }) === null,
      ),
      { numRuns: RUNS },
    );
  });
});

describe('every non-clean durability is covered by the prompt', () => {
  it('lists exactly the durabilities that must not read as "all answers saved"', () => {
    expect([...NOT_CLEAN].sort()).toEqual(['ABANDONED', 'OFFLINE', 'PENDING']);
  });

  it('prompts for every one of them, with an empty queue', () => {
    for (const durability of NOT_CLEAN) {
      expect(
        resumePrompt({ queued: [], durability, deadlineAt: AT + 3_600_000 }, now)?.kind,
        durability,
      ).toBe('UNSAVED');
    }
    // And `CLEAN` is the only one that does not.
    expect(resumePrompt({ ...clean, durability: 'CLEAN' }, now)).toBeNull();
  });
});

describe('properties over the prompt', () => {
  it('is a FUNCTION of its inputs, so the resume screen is a rendering of a pure value', () => {
    fc.assert(
      fc.property(fc.nat(), arbDurability, fc.nat(), (seq, durability, deadlineAt) => {
        const state = {
          queued: [
            { seq, questionId: 'q1', answer: 'x', revision: 1, idempotencyKey: 'k', issuedAt: AT },
          ],
          durability,
          deadlineAt,
        };
        const input = { clientNow: AT, offset: 0 };
        // Two CALLS, hoisted. Written as one expression compared with itself it is a self-compare, which
        // `noSelfCompare` flags -- correctly, since that shape is nearly always a slip where the second call was
        // meant to use different input.
        const first = resumePrompt(state, input);
        const second = resumePrompt(state, input);
        return JSON.stringify(first) === JSON.stringify(second);
      }),
      { numRuns: RUNS },
    );
  });

  it('never returns an EMPTY heading or detail, because a blank cell reads as a fault', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        arbDurability,
        fc.integer({ min: -10, max: 10 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        (seq, durability, drift, offset) => {
          const prompt = resumePrompt(
            {
              queued: [
                {
                  seq,
                  questionId: 'q1',
                  answer: 'x',
                  revision: 1,
                  idempotencyKey: 'k',
                  issuedAt: AT,
                },
              ],
              durability,
              deadlineAt: AT + drift,
            },
            { clientNow: AT, offset },
          );
          if (prompt === null) return true;
          return prompt.heading.length > 3 && prompt.detail.length > 10;
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('only reports UNSAVED as BLOCKING, never TIME_PASSED', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        arbDurability,
        fc.integer({ min: -100_000, max: 100_000 }),
        (seq, durability, drift) => {
          const prompt = resumePrompt(
            {
              queued: [
                {
                  seq,
                  questionId: 'q1',
                  answer: 'x',
                  revision: 1,
                  idempotencyKey: 'k',
                  issuedAt: AT,
                },
              ],
              durability,
              deadlineAt: AT + drift,
            },
            { clientNow: AT, offset: 0 },
          );
          return (
            prompt === null || (prompt.kind === 'TIME_PASSED' ? !prompt.blocking : prompt.blocking)
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});
