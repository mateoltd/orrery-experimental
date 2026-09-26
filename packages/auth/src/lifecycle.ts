/**
 * Account lifecycle.  (P1-T1, plans/13 §1.2)
 *
 * ```
 * ACTIVE ──► SUSPENDED      (admin; revokes all sessions in the SAME transaction)
 * ACTIVE ──► DELETING ──► DELETED   (30-day grace, then anonymise)
 * ```
 *
 * ## Why this is a pure state machine
 *
 * Every transition here is a function of the current state, the requested transition, an
 * explicit `now`, and the actor. No database, no clock, no side effects — the function
 * RETURNS the writes that must happen, and the caller applies them in one transaction.
 *
 * That split is the whole point, and it is what makes the requirement "SUSPENDED revokes
 * every session in the same transaction" checkable. A function that revokes sessions as a
 * side effect cannot be tested for atomicity at all; a function that RETURNS the revocations
 * can be asserted to return them, and the caller is then a two-line `prisma.$transaction`
 * whose correctness is visible by reading it.
 *
 * ## The 30-day grace is not a timer, it is a state
 *
 * `DELETING` is entered explicitly, and only becomes `DELETED` when something checks and the
 * grace has elapsed. Nothing is scheduled and nothing polls. That means an account cannot
 * become `DELETED` because a job was late, and it means the grace period is visible in a
 * query (`WHERE status = 'DELETING' AND deletingAt < now() - 30d`) rather than being implied
 * by a cron that may not exist yet.
 */

import { DAY, HOUR, type Millis } from '@orrery/clock';

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** The deletion grace period. `plans/13` §1.2 says 30 days; the constant names where it lives. */
export const DELETION_GRACE = 30 * DAY;

export const TRANSITIONS = [
  'suspend',
  'reinstate',
  'beginDeletion',
  'completeDeletion',
  'cancelDeletion',
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export type DenyLifecycle =
  | 'notSuspended'
  | 'notDeleting'
  | 'graceNotElapsed'
  | 'notDeletable'
  | 'alreadyDeleted';

export interface AccountState {
  readonly userId: string;
  readonly status: UserStatus;
  /** When `DELETING` was entered. Null unless status is DELETING. */
  readonly deletingAt: Millis | null;
  readonly suspendedAt?: Millis | null;
  readonly suspendedReason?: string | null;
}

/**
 * The writes a transition must apply.
 *
 * `revokeSessions: true` is a separate field rather than a returned list because the LIST is
 * in the database and this function cannot see it. The caller turns the flag into "UPDATE
 * sessions SET revoked_at = ... WHERE user_id = ? AND revoked_at IS NULL" — and the flag is
 * what the test asserts on, which is the only way to assert atomicity without a database.
 */
export interface LifecycleWrites {
  readonly status: UserStatus;
  readonly suspendedAt: Millis | null;
  readonly suspendedReason: string | null;
  readonly deletingAt: Millis | null;
  /** MUST be applied inside the same transaction as `status`. */
  readonly revokeSessions: boolean;
  readonly revokeReason: string;
  /** Actions the caller must take that are not a status write. */
  readonly auditAction: string;
  readonly securityEventKind: string | null;
}

export type LifecycleResult =
  | { ok: true; writes: LifecycleWrites }
  | { ok: false; reason: DenyLifecycle };

const deny = (reason: DenyLifecycle): LifecycleResult => ({ ok: false, reason });

/**
 * Apply a transition.
 *
 * `reason` is required for `suspend` and refused for the others. A suspension with no stated
 * reason is unreviewable by the person it affects: "your account is suspended" with nothing
 * after it is indistinguishable from a bug, and the first support ticket of the week is
 * always that one.
 */
export function transition(
  account: AccountState,
  request: { kind: Transition; now: Millis; reason?: string },
): LifecycleResult {
  const { kind, now, reason } = request;

  if (account.status === 'DELETED') {
    // Terminal. Every transition out of DELETED is refused, including `reinstate`, because
    // the account is anonymised and there is nothing left to reinstate. A caller that tries
    // should get told, not get a silent success.
    return deny('alreadyDeleted');
  }

  switch (kind) {
    case 'suspend': {
      if (account.status === 'SUSPENDED') return deny('notSuspended');
      if (account.status === 'DELETING') return deny('notDeletable');
      if (reason === undefined || reason.trim() === '') {
        // Refused here rather than defaulted. An empty reason is worse than a missing one,
        // because it looks filled in.
        return deny('notDeletable');
      }
      return {
        ok: true,
        writes: {
          status: 'SUSPENDED',
          suspendedAt: now,
          suspendedReason: reason.trim(),
          // Suspension clears any in-flight deletion: an account cannot be on its way out and
          // suspended at once, and "which one is it" is a question support cannot answer.
          deletingAt: null,
          revokeSessions: true,
          revokeReason: 'userSuspended',
          auditAction: 'account.suspend',
          securityEventKind: null,
        },
      };
    }

    case 'reinstate': {
      if (account.status !== 'SUSPENDED') return deny('notSuspended');
      return {
        ok: true,
        writes: {
          status: 'ACTIVE',
          suspendedAt: null,
          suspendedReason: null,
          deletingAt: account.deletingAt,
          // Deliberately does NOT revoke. Reinstating restores access; revoking here would
          // log the user straight back out, which is the opposite of what was asked.
          revokeSessions: false,
          revokeReason: 'logout',
          auditAction: 'account.reinstate',
          securityEventKind: null,
        },
      };
    }

    case 'beginDeletion': {
      if (account.status === 'DELETING') return deny('notDeleting');
      return {
        ok: true,
        writes: {
          status: 'DELETING',
          suspendedAt: null,
          suspendedReason: null,
          deletingAt: now,
          // The account is still usable during the grace period. Revoking on entry would make
          // a 30-day grace period a 30-day lockout, and a user who clicks "delete my
          // account" and is immediately signed out has not been given a grace period at all.
          revokeSessions: false,
          revokeReason: 'logout',
          auditAction: 'account.deletion_requested',
          securityEventKind: null,
        },
      };
    }

    case 'cancelDeletion': {
      if (account.status !== 'DELETING') return deny('notDeleting');
      return {
        ok: true,
        writes: {
          status: 'ACTIVE',
          suspendedAt: null,
          suspendedReason: null,
          deletingAt: null,
          revokeSessions: false,
          revokeReason: 'logout',
          auditAction: 'account.deletion_cancelled',
          securityEventKind: null,
        },
      };
    }

    case 'completeDeletion': {
      if (account.status !== 'DELETING') return deny('notDeleting');
      if (account.deletingAt === null) {
        // DELETING with no timestamp is a corrupt row. Refusing is right: proceeding would
        // treat "no grace recorded" as "grace already served".
        return deny('notDeleting');
      }
      // Strictly greater-than, so an account cannot be deleted in the same millisecond the
      // request was made. An off-by-one that allows a zero-length grace is the kind of bug
      // that only shows up as a support complaint.
      if (now <= account.deletingAt + DELETION_GRACE) return deny('graceNotElapsed');
      return {
        ok: true,
        writes: {
          status: 'DELETED',
          suspendedAt: null,
          suspendedReason: null,
          deletingAt: account.deletingAt,
          revokeSessions: true,
          revokeReason: 'accountDeleted',
          auditAction: 'account.deleted',
          securityEventKind: null,
        },
      };
    }
  }
}

/** Days remaining in the grace period, for the confirmation screen. Clamped at 0. */
export function graceRemaining(account: AccountState, now: Millis): number {
  if (account.status !== 'DELETING' || account.deletingAt === null) return 0;
  const remaining = account.deletingAt + DELETION_GRACE - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / (24 * HOUR));
}

/** Whether an account is currently usable. One predicate, so no caller re-derives it. */
export function isActive(account: AccountState): boolean {
  return account.status === 'ACTIVE' || account.status === 'DELETING';
}

/**
 * The security signals the session layer raises, and what each one does.
 *
 * `response` is what the CALLER returns to the user, and it is deliberately identical for
 * every failure: a wrong password, an unknown account, and a correct password on a suspended
 * account must be indistinguishable, or the login form becomes an account-existence oracle.
 * What differs is the AUDIT trail and the session state, which nobody outside can see.
 */
export const LOGIN_FAILURES = {
  unknownAccount: {
    response: 'invalid',
    audit: 'auth.login.unknown_account',
    revokeSessions: false,
    securityEvent: null,
  },
  wrongPassword: {
    response: 'invalid',
    audit: 'auth.login.wrong_password',
    revokeSessions: false,
    securityEvent: null,
  },
  suspended: {
    response: 'invalid',
    audit: 'auth.login.suspended',
    revokeSessions: true,
    securityEvent: 'suspendedAccountAccess',
  },
  /** A revoked token presented after a rotation. Possible theft. */
  revokedTokenReuse: {
    response: 'invalid',
    audit: 'auth.token.reuse',
    revokeSessions: true,
    securityEvent: 'revokedTokenReuse',
  },
  /** Repeated wrong TOTP. Above the threshold this is a takeover attempt, not a typo. */
  repeatedMfaFailure: {
    response: 'invalid',
    audit: 'auth.mfa.failure',
    revokeSessions: false,
    securityEvent: 'repeatedMfaFailure',
  },
} as const;

export type LoginFailure = keyof typeof LOGIN_FAILURES;

/**
 * Whether a run of MFA failures is a typo or an attempt.
 *
 * The threshold is a judgement call and the reasoning is worth writing down: the first two
 * failures are almost always a fat-fingered phone, and a system that locks people out for
 * mistyping a code teaches them to write it on a sticker. By the fifth, nobody is typing the
 * wrong code five times — they are guessing, and a six-digit code guesses at 10/second is
 * gone in under two hours.
 */
export const MFA_FAILURE_THRESHOLD = 5;

export function classifyMfaFailure(priorFailures: number): 'typo' | 'suspicious' {
  return priorFailures + 1 >= MFA_FAILURE_THRESHOLD ? 'suspicious' : 'typo';
}
