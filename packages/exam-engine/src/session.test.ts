/**
 * Session issuance, handshake and preflight -- the tests that matter.  (P8-T3)
 *
 * INV-RELEASE-2 is the reason this file is mostly about payloads. The plan does not ask for "no score field"; it asks
 * for no score to be INFERABLE before release, and enumerates the ways that happens: a field, a count of correct
 * answers, a toast, a status code, a payload SIZE, a cache header, an analytics event. Only the first and the fifth are
 * visible in a unit test, so the payload builders are asserted against `findScoreBearingKeys` -- the same 23-key corpus
 * `audit:seals` uses -- rather than by reading the object literal and deciding it looks clean.
 */

import { profileFor } from '@orrery/contracts/policy';
import { findScoreBearingKeys } from '@orrery/interop';
import { describe, expect, it } from 'vitest';

import {
  buildSyncPayload,
  checkSession,
  evaluatePreflight,
  type PreflightReport,
  type SessionFacts,
} from './session.js';

const T0 = 1_800_000_000_000;

const policy = profileFor('EXAM');

const cleanReport: PreflightReport = {
  browser: { storage: true, pageLifecycle: true, broadcastChannel: true },
  network: { rttMs: 40, effectiveType: '4g', saveData: false },
  a11y: { reducedMotion: false, forcedColors: false, screenReaderGuess: null },
};

const session = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: 's1',
  attemptId: 'a1',
  tabId: 'tab-1',
  expiresAt: T0 + 3_600_000,
  revokedAt: null,
  revokedReason: null,
  ...over,
});

describe('INV-RELEASE-2: the sync payload is score-free', () => {
  const payload = () =>
    buildSyncPayload({
      sessionId: 's1',
      attemptId: 'a1',
      attemptStatus: 'IN_PROGRESS',
      now: T0,
      startedAt: T0 - 60_000,
      deadlineAt: T0 + 3_600_000,
      gracePeriodSec: 60,
      policy,
      escalationState: 'NONE',
      questionDeadlines: [{ questionId: 'q1', deadlineAt: T0 + 60_000, state: 'OPEN' }],
      saveStateByQuestion: { q1: 'SAVED' },
    });

  it('carries no score-bearing key anywhere in it', () => {
    expect(findScoreBearingKeys(payload())).toEqual([]);
  });

  it('says whether an answer was SAVED without saying whether it was RIGHT', () => {
    const body = payload();
    expect(body.saveStateByQuestion).toEqual({ q1: 'SAVED' });
    // The whole distinction: durability is the student's business, correctness is not knowable yet.
    expect(JSON.stringify(body)).not.toContain('correct');
    expect(JSON.stringify(body)).not.toContain('score');
  });

  it('reports no COUNT of correct answers', () => {
    // A count is inferable even with no per-question field, which is why the plan lists it separately.
    expect(JSON.stringify(payload())).not.toMatch(
      /"correctCount"|"numCorrect"|"answeredCorrectly"/,
    );
  });

  it('carries `serverNow` from the CALLER, never read from the host clock', () => {
    // INV-TIME-1, and it is what makes the builder testable at an exact instant.
    expect(payload().serverNow).toBe(T0);
  });

  it('repeats the frozen policy on every sync, so the client can verify it has not changed', () => {
    expect(payload().policy).toEqual(policy);
  });

  it('copies its inputs rather than aliasing them', () => {
    // An aliased object lets a caller mutate the payload after it is built, which is how a "frozen" snapshot stops
    // being frozen without anybody writing to it.
    const input = payload();
    const deadlines = input.questionDeadlines as QuestionDeadlineLike[];
    expect(Array.isArray(deadlines)).toBe(true);
    expect(input.saveStateByQuestion).not.toBe(undefined);
    const mutable = { q1: 'SAVED' };
    const built = buildSyncPayload({
      sessionId: 's1',
      attemptId: 'a1',
      attemptStatus: 'IN_PROGRESS',
      now: T0,
      startedAt: T0,
      deadlineAt: null,
      gracePeriodSec: 0,
      policy,
      escalationState: 'NONE',
      questionDeadlines: [{ questionId: 'q1', deadlineAt: null, state: 'OPEN' }],
      saveStateByQuestion: mutable,
    });
    mutable.q1 = 'PENDING';
    expect((built.saveStateByQuestion as Record<string, string>).q1).toBe('SAVED');
  });
});

interface QuestionDeadlineLike {
  readonly questionId: string;
}

describe('checkSession', () => {
  it('accepts a live session on an open attempt', () => {
    expect(checkSession(session(), 'IN_PROGRESS', T0)).toEqual({ ok: true });
  });

  it('rejects an unknown session', () => {
    const verdict = checkSession(null, 'IN_PROGRESS', T0);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('SESSION_UNKNOWN');
  });

  it('checks EXPIRY BEFORE REVOCATION', () => {
    /**
     * Both mean "cannot be used", and the order decides what a teacher sees. An expired session is the ordinary end of
     * a sitting; a revoked one is a decision somebody made. Checking revocation first files every finished exam under
     * "revoked", which makes the revocation list useless exactly when it is needed.
     */
    const verdict = checkSession(
      session({ expiresAt: T0 - 1, revokedAt: T0 - 100, revokedReason: 'ended by teacher' }),
      'IN_PROGRESS',
      T0,
    );
    expect(verdict.ok === false && verdict.reason).toBe('SESSION_EXPIRED');
  });

  it("reports a REVOKED session with the teacher's own reason", () => {
    const verdict = checkSession(
      session({ revokedAt: T0 - 100, revokedReason: 'second device detected' }),
      'IN_PROGRESS',
      T0,
    );
    expect(verdict.ok === false && verdict.reason).toBe('SESSION_REVOKED');
    // "Revoked" with no reason is indistinguishable from a system fault, to the student and to the teacher.
    expect(verdict.ok === false && verdict.message).toBe('second device detected');
  });

  it('treats an expired-at-this-instant session as expired', () => {
    // Boundary: `>=`, so a session cannot be used at the exact millisecond it expires.
    expect(checkSession(session({ expiresAt: T0 }), 'IN_PROGRESS', T0).ok).toBe(false);
    expect(checkSession(session({ expiresAt: T0 + 1 }), 'IN_PROGRESS', T0).ok).toBe(true);
  });

  it('refuses a live session on a CLOSED attempt, and names the attempt state', () => {
    const verdict = checkSession(session(), 'SUBMITTED', T0);
    expect(verdict.ok === false && verdict.reason).toBe('ATTEMPT_CLOSED');
    expect(verdict.ok === false && verdict.message).toContain('SUBMITTED');
  });
});

describe('evaluatePreflight', () => {
  it('is OK on a capable, unremarkable client', () => {
    const verdict = evaluatePreflight(cleanReport);
    expect(verdict.status).toBe('OK');
    expect(verdict.relaxations).toEqual([]);
  });

  it('RECOMMENDS a relaxation when storage is missing, rather than ignoring it', () => {
    // Unsent writes could be lost. Surfacing it is what lets P8-T12 decide something about it.
    const verdict = evaluatePreflight({
      ...cleanReport,
      browser: { ...cleanReport.browser, storage: false },
    });
    expect(verdict.status).toBe('RELAXED');
    expect(verdict.relaxations).toContain('NO_STORAGE');
  });

  it('never relaxes on a screen reader GUESS, and records it as a note instead', () => {
    /**
     * No browser reports a screen reader reliably. A false negative relaxes a policy for a student who did not need
     * it; a false positive tightens one for a student who did. Either way the student is worse off than with no guess.
     */
    const verdict = evaluatePreflight({
      ...cleanReport,
      a11y: { ...cleanReport.a11y, screenReaderGuess: 'NVDA' },
    });
    expect(verdict.status).toBe('OK');
    expect(verdict.relaxations).toEqual([]);
    expect(verdict.notes.join(' ')).toContain('NVDA');
  });

  it('gives every relaxation a NOTE, because an unexplained one cannot be challenged', () => {
    const verdict = evaluatePreflight({
      browser: { storage: false, pageLifecycle: false, broadcastChannel: false },
      network: { rttMs: 900, effectiveType: '2g', saveData: true },
      a11y: { reducedMotion: true, forcedColors: true, screenReaderGuess: null },
    });
    expect(verdict.relaxations).toHaveLength(7);
    // A relaxation with no explanation is one a student cannot question and a teacher cannot justify.
    expect(verdict.notes).toHaveLength(7);
    for (const note of verdict.notes) expect(note.trim().length).toBeGreaterThan(10);
  });

  it('NEVER blocks a student, because that decision has a human in it', () => {
    // A client deciding to block out of a capability probe is exactly what `plans/15` warns about. `BLOCKED` exists in
    // the type for P8-T12 to reach from the server side.
    const worst: PreflightReport = {
      browser: { storage: false, pageLifecycle: false, broadcastChannel: false },
      network: { rttMs: 5_000, effectiveType: 'slow-2g', saveData: true },
      a11y: { reducedMotion: true, forcedColors: true, screenReaderGuess: 'JAWS' },
    };
    expect(evaluatePreflight(worst).status).toBe('RELAXED');
  });

  it('treats a merely slow connection as degraded rather than broken', () => {
    const slow = evaluatePreflight({
      ...cleanReport,
      network: { rttMs: 401, effectiveType: '3g', saveData: false },
    });
    const borderline = evaluatePreflight({
      ...cleanReport,
      network: { rttMs: 400, effectiveType: '3g', saveData: false },
    });
    expect(slow.relaxations).toContain('DEGRADED_NETWORK');
    expect(borderline.relaxations).not.toContain('DEGRADED_NETWORK');
  });
});
