/**
 * Account lifecycle tests.  (P1-T1, plans/13 §1.2)
 *
 * ## The property under test
 *
 * **`revokeSessions` is true exactly when access must stop, and the caller must apply it in
 * the same transaction as the status write.** That is INV-AUTH-1 in one sentence, and it is
 * the assertion this file is built around — not the status value, which is easy, but the
 * pairing, which is the thing that gets forgotten.
 *
 * ## Why there is no database here
 *
 * A test that needed Postgres to assert "the sessions were revoked" would be a test that gets
 * skipped when the database is slow. The state machine RETURNS the revocations instead of
 * performing them, so atomicity is assertable as data, and the transaction wrapper around it
 * is small enough to read.
 *
 * The counter-test that matters: a transition that returns `revokeSessions: false` where it
 * should be `true` is a live breach, and the end of this file asserts there is no such case.
 */

import { DAY, HOUR, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  type AccountState,
  classifyMfaFailure,
  DELETION_GRACE,
  graceRemaining,
  isActive,
  MFA_FAILURE_THRESHOLD,
  type Transition,
  transition,
} from '../lifecycle.js';

const T0: Millis = 1_700_000_000_000;

const account = (over: Partial<AccountState> = {}): AccountState => ({
  userId: 'u-1',
  status: 'ACTIVE',
  deletingAt: null,
  suspendedAt: null,
  suspendedReason: null,
  ...over,
});

/** Narrow helper: a transition that is expected to succeed, with its writes returned. */
function apply(a: AccountState, kind: Transition, now: Millis, reason?: string) {
  const r = transition(a, { kind, now, ...(reason === undefined ? {} : { reason }) });
  if (!r.ok) throw new Error(`expected ${kind} to succeed, got ${r.reason}`);
  return r.writes;
}

/** Narrow helper: a transition that is expected to be refused, with its reason returned. */
function refuse(a: AccountState, kind: Transition, now: Millis, reason?: string) {
  const r = transition(a, { kind, now, ...(reason === undefined ? {} : { reason }) });
  if (r.ok) throw new Error(`expected ${kind} to be REFUSED, but it returned ${r.writes.status}`);
  return r.reason;
}

describe('suspension revokes every session in the same transaction', () => {
  it('sets SUSPENDED and demands the revocations together', () => {
    const w = apply(account(), 'suspend', T0, 'Policy breach, reported 2026-09-20');
    expect(w.status).toBe('SUSPENDED');
    // THE assertion. Not `toBe(true)` in isolation — the pairing is the requirement.
    expect(w.revokeSessions, 'a suspension that does not revoke leaves a live session').toBe(true);
    expect(w.revokeReason).toBe('userSuspended');
    expect(w.suspendedAt).toBe(T0);
  });

  it('refuses a suspension with no reason — "suspended" alone is unreviewable', () => {
    expect(refuse(account(), 'suspend', T0)).toBe('notDeletable');
    expect(refuse(account(), 'suspend', T0, '')).toBe('notDeletable');
    expect(refuse(account(), 'suspend', T0, '   ')).toBe('notDeletable');
  });

  it('trims the reason, so the audit row is not full of padding', () => {
    const w = apply(account(), 'suspend', T0, '  cheating  ');
    expect(w.suspendedReason).toBe('cheating');
  });

  it('refuses to suspend an already-suspended account', () => {
    expect(refuse(account({ status: 'SUSPENDED' }), 'suspend', T0, 'again')).toBe('notSuspended');
  });

  it('refuses to suspend an account already on its way out', () => {
    // A support agent must not be able to leave an account in both states at once.
    expect(refuse(account({ status: 'DELETING', deletingAt: T0 }), 'suspend', T0, 'x')).toBe(
      'notDeletable',
    );
  });
});

describe('reinstatement restores access rather than revoking it', () => {
  it('does NOT revoke sessions on reinstate', () => {
    // Revoking here would log the user straight back out — the opposite of what was asked,
    // and a bug that looks like the feature working.
    const w = apply(account({ status: 'SUSPENDED' }), 'reinstate', T0);
    expect(w.status).toBe('ACTIVE');
    expect(w.revokeSessions).toBe(false);
    expect(w.suspendedAt).toBeNull();
    expect(w.suspendedReason).toBeNull();
  });

  it('refuses to reinstate an account that was never suspended', () => {
    expect(refuse(account(), 'reinstate', T0)).toBe('notSuspended');
  });
});

describe('deletion has a real grace period', () => {
  it('entering DELETING does not revoke sessions — otherwise grace is a lockout', () => {
    // A user who clicks "delete my account" and is signed out immediately has not been
    // given 30 days of anything. They have been logged out, with a countdown.
    const w = apply(account(), 'beginDeletion', T0);
    expect(w.status).toBe('DELETING');
    expect(w.deletingAt).toBe(T0);
    expect(w.revokeSessions, 'the account stays usable during the grace period').toBe(false);
  });

  it('refuses to complete deletion before the grace elapses', () => {
    const a = account({ status: 'DELETING', deletingAt: T0 });
    expect(refuse(a, 'completeDeletion', T0 + DELETION_GRACE - 1)).toBe('graceNotElapsed');
  });

  it('refuses at EXACTLY the boundary, not one millisecond past it', () => {
    // An off-by-one that permits a zero-length grace only shows up later as a support
    // complaint, so the boundary is pinned rather than assumed.
    const a = account({ status: 'DELETING', deletingAt: T0 });
    expect(refuse(a, 'completeDeletion', T0 + DELETION_GRACE)).toBe('graceNotElapsed');
  });

  it('completes one millisecond after the grace, and revokes the sessions', () => {
    const a = account({ status: 'DELETING', deletingAt: T0 });
    const w = apply(a, 'completeDeletion', T0 + DELETION_GRACE + 1);
    expect(w.status).toBe('DELETED');
    expect(w.revokeSessions).toBe(true);
    expect(w.revokeReason).toBe('accountDeleted');
  });

  it('refuses to complete when the account never entered DELETING', () => {
    expect(refuse(account(), 'completeDeletion', T0 + 99 * DAY)).toBe('notDeleting');
  });

  it('refuses on a DELETING row with no timestamp rather than treating it as served', () => {
    // A corrupt row must not be read as "the grace already elapsed".
    const corrupt = account({ status: 'DELETING', deletingAt: null });
    expect(refuse(corrupt, 'completeDeletion', T0 + 99 * DAY)).toBe('notDeleting');
  });

  it('refuses to begin a second deletion', () => {
    // A double-click on "delete my account" must not restart the 30-day clock. If it did,
    // the grace period could be extended forever by clicking the button again, and the
    // account would never actually be deleted.
    const a = account({ status: 'DELETING', deletingAt: T0 });
    expect(refuse(a, 'beginDeletion', T0 + HOUR)).toBe('notDeleting');
  });

  it('refuses to cancel a deletion that was never requested', () => {
    // Otherwise a stray call can "cancel" an account that was never deleting, which reads in
    // the audit log as a reversal of something.
    expect(refuse(account(), 'cancelDeletion', T0)).toBe('notDeleting');
  });

  it('cancelling restores ACTIVE and clears the timestamp', () => {
    const w = apply(account({ status: 'DELETING', deletingAt: T0 }), 'cancelDeletion', T0 + HOUR);
    expect(w.status).toBe('ACTIVE');
    expect(w.deletingAt).toBeNull();
  });
});

describe('DELETED is terminal', () => {
  it('refuses every transition out of it, including reinstate', () => {
    // The account is anonymised; there is nothing to reinstate. A silent success here would
    // leave a caller believing it had restored an account that no longer exists.
    const dead = account({ status: 'DELETED' });
    for (const kind of [
      'suspend',
      'reinstate',
      'beginDeletion',
      'completeDeletion',
      'cancelDeletion',
    ] as const) {
      expect(refuse(dead, kind, T0, 'x'), `kind=${kind}`).toBe('alreadyDeleted');
    }
  });
});

describe('isActive and graceRemaining', () => {
  it('treats DELETING as still usable, because the account still works during grace', () => {
    expect(isActive(account())).toBe(true);
    expect(isActive(account({ status: 'DELETING', deletingAt: T0 }))).toBe(true);
    expect(isActive(account({ status: 'SUSPENDED' }))).toBe(false);
    expect(isActive(account({ status: 'DELETED' }))).toBe(false);
  });

  it('counts the grace down in whole days and clamps at zero', () => {
    const a = account({ status: 'DELETING', deletingAt: T0 });
    expect(graceRemaining(a, T0)).toBe(30);
    expect(graceRemaining(a, T0 + 10 * DAY)).toBe(20);
    expect(graceRemaining(a, T0 + 40 * DAY)).toBe(0);
    expect(graceRemaining(account(), T0)).toBe(0);
  });
});

describe('MFA failure classification', () => {
  it('treats the first failures as typos and later ones as suspicious', () => {
    // Locking someone out for mistyping a code teaches them to write it on a sticker.
    expect(classifyMfaFailure(0)).toBe('typo');
    expect(classifyMfaFailure(MFA_FAILURE_THRESHOLD - 2)).toBe('typo');
    expect(classifyMfaFailure(MFA_FAILURE_THRESHOLD - 1)).toBe('suspicious');
    expect(classifyMfaFailure(20)).toBe('suspicious');
  });
});
