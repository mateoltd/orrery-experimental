/**
 * Impersonation.  (P1-T10)
 *
 * ## The one thing this must get right
 *
 * **An impersonated write is indistinguishable from a compromised admin session.** From the
 * database's point of view, a row changed while an admin was impersonating a teacher is a row
 * an admin changed. There is no column that says who really did it, and adding one would be
 * worse — it would create the illusion that impersonated writes are safe.
 *
 * So impersonation is READ-ONLY, and the read-only-ness is enforced by a gate that runs before
 * authorisation, not by remembering at each call site. A per-route check is a check that
 * eventually gets forgotten, and the route it is forgotten on is the one nobody wrote a test for.
 *
 * ## Why 15 minutes, hard
 *
 * "Hard-capped" means the cap is not advisory. An impersonation that can be extended is a
 * permanent one, and a permanent impersonation is a back door with a UI. The cap is checked
 * from the START time, not from a sliding window, so a session cannot be kept alive by activity.
 *
 * ## Why the impersonated user is notified
 *
 * Not because it is friendly. Because the alternative is that support staff can enter a
 * student's account and look at their work, and the student has no way to know that ever
 * happened. The notification goes to the INBOX as well as the audit stream, because those are
 * two different readers: one is a person, the other is a review process, and a signal that
 * reaches only one of them is a signal that is lost the moment that reader is busy.
 */

import type { Duration, Millis } from '@orrery/clock';

/** RFC 9110 methods, classified by whether they are safe. */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS', 'TRACE'] as const;
export type SafeMethod = (typeof SAFE_METHODS)[number];

/**
 * The header stamped on every request made under an impersonation.
 *
 * Named `x-impersonating` because that is the packet's requirement, but the important part is
 * that it is on EVERY request including the safe ones: a request that bypasses the marker is a
 * request the audit trail cannot explain.
 */
export const IMPERSONATION_HEADER = 'x-impersonating';

/** The audit action. One string, so it can be alerted on without parsing prose. */
export const IMPERSONATION_AUDIT_ACTION = 'auth.impersonation.started';

export type HttpMethod = string;

/**
 * Whether a method may be performed under an impersonation.
 *
 * Anything not in the SAFE list is a mutation. That default matters: a new method, or a custom
 * verb, is treated as a write rather than as an unknown. A permissive default here would make
 * the read-only guarantee depend on a list somebody remembers to update.
 */
export function isSafeMethod(method: HttpMethod): boolean {
  return (SAFE_METHODS as readonly string[]).includes(method.toUpperCase());
}

export const WRITE_DENIED_CODE = 'IMPERSONATION_READ_ONLY';

export type StartImpersonationVerdict =
  | { ok: true; until: Millis }
  | { ok: false; reason: 'notAnAdmin' | 'sameUser' | 'targetSuspended' | 'tooManyActive' };

/** The packet's cap. Not a default — the only value. */
export const IMPERSONATION_LIMIT: Duration = 15 * 60_000;

/**
 * Concurrent impersonations per admin. One.
 *
 * Two at once means an admin can be holding an impersonation into one account while a support
 * colleague assumes control of the other, and neither of them can tell whose session they are
 * looking at. The banner makes that visible; this makes it impossible.
 */
export const MAX_CONCURRENT = 1;

export function startImpersonation(input: {
  readonly actorId: string;
  readonly actorRoles: readonly string[];
  readonly targetUserId: string;
  readonly targetIsActive: boolean;
  /** Impersonations this actor already holds, unexpired. */
  readonly alreadyActive: number;
  readonly now: Millis;
}): StartImpersonationVerdict {
  if (!input.actorRoles.includes('platformAdmin')) return { ok: false, reason: 'notAnAdmin' };
  // Impersonating yourself is a no-op that would consume the only slot, and in a demo or a
  // test fixture it is how a "read-only" session ends up looking like a normal one.
  if (input.actorId === input.targetUserId) return { ok: false, reason: 'sameUser' };
  if (!input.targetIsActive) return { ok: false, reason: 'targetSuspended' };
  if (input.alreadyActive >= MAX_CONCURRENT) return { ok: false, reason: 'tooManyActive' };
  return { ok: true, until: input.now + IMPERSONATION_LIMIT };
}

export interface ImpersonationState {
  /** The admin doing the impersonating. Kept for the audit trail and the banner. */
  readonly byUserId: string;
  readonly byDisplayName: string;
  readonly targetUserId: string;
  readonly targetDisplayName: string;
  readonly startedAt: Millis;
  /** Fixed at start. NOT sliding — see the file header. */
  readonly expiresAt: Millis;
  /** Why. A support ticket, a review task, a bug report. "Because I wanted to" is not one. */
  readonly reason: string;
}

export type ImpersonationCheck =
  | { active: false }
  | { active: true; state: ImpersonationState; remainingMs: number; canExtend: false };

/**
 * Whether the impersonation is still live.
 *
 * Returns `canExtend: false` as a literal type rather than a runtime boolean, because the type
 * is what stops a caller writing `if (canExtend) { ... }` and having it compile.
 */
/**
 * `canExtend` as a LITERAL-typed constant rather than an inline `false` in a return.
 *
 * Two reasons, and the second is the reason. First, `if (result.canExtend)` does not compile
 * when the type is `false`, so the "you may extend this" branch cannot be written at all — a
 * boolean would compile and be false at runtime, which is one refactor away from a bug. Second,
 * v8's branch counter reports an inline literal in a returned object literal as an UNCOVERED
 * BRANCH, because there is no way to execute "not false". As a const initialiser it is a plain
 * value and the coverage report is honest about what it is measuring.
 */
const CANNOT_EXTEND = false as const;

export function checkImpersonation(
  state: ImpersonationState | null,
  now: Millis,
): ImpersonationCheck {
  if (state === null) return { active: false };
  if (now >= state.expiresAt) return { active: false };
  return { active: true, state, remainingMs: state.expiresAt - now, canExtend: CANNOT_EXTEND };
}

export type RequestVerdict =
  | { allowed: true; impersonating: false }
  | { allowed: true; impersonating: true; state: ImpersonationState; remainingMs: number }
  | { allowed: false; code: typeof WRITE_DENIED_CODE; message: string };

/**
 * The gate. Runs BEFORE `can()`, and its verdict does not depend on the actor's roles.
 *
 * That ordering is the design. A check that ran after authorisation could be satisfied by a
 * role the impersonated user holds; a check that runs before it cannot be satisfied at all.
 */
export function guardRequest(input: {
  readonly method: HttpMethod;
  readonly state: ImpersonationState | null;
  readonly now: Millis;
}): RequestVerdict {
  const live = checkImpersonation(input.state, input.now);
  if (!live.active) return { allowed: true, impersonating: false };

  if (!isSafeMethod(input.method)) {
    return {
      allowed: false,
      code: WRITE_DENIED_CODE,
      // The message names the real reason. A generic "permission denied" here is what makes
      // support staff conclude the account is broken.
      message:
        'You are viewing this account as an administrator. Viewing is read-only — you cannot ' +
        'change anything while signed in as someone else. Make the change in your own account.',
    };
  }

  return {
    allowed: true,
    impersonating: true,
    state: live.state,
    remainingMs: live.remainingMs,
  };
}

/**
 * The banner.
 *
 * `dismissible: false` is a TYPE, not a runtime flag someone can pass `true` to. A banner with
 * a dismiss button is a banner that gets dismissed — and the person who needs to know they are
 * looking at someone else's grades is the person least likely to want another element on screen.
 *
 * `role="alert"` plus `aria-live` so it is announced when the impersonation starts, which for a
 * screen-reader user is the ONLY way they would otherwise know.
 */
export interface ImpersonationBanner {
  readonly heading: string;
  readonly body: string;
  readonly dismissible: false;
  readonly role: 'alert';
  readonly ariaLive: 'assertive';
  /** Rendered as a visible element AND as the accessible name of a landmark. */
  readonly landmarkLabel: string;
}

export function impersonationBanner(state: ImpersonationState, now: Millis): ImpersonationBanner {
  const minutes = Math.max(1, Math.ceil((state.expiresAt - now) / 60_000));
  return {
    heading: 'You are viewing this account as an administrator',
    // The REASON is on the banner, not only in the audit log. Two reasons: the admin should be
    // reminded what they are looking at, and anyone glancing over their shoulder — a teacher,
    // a student, a visitor — should be able to see that this is authorised and why. A banner
    // that says only "you are an administrator" invites exactly the conversation it should
    // make unnecessary.
    body:
      `Signed in as ${state.targetDisplayName}, on behalf of ${state.byDisplayName}. ` +
      `Everything you see here is the same as they see, and you cannot change anything. ` +
      `Reason: ${state.reason}. ` +
      `This ends in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    dismissible: false,
    role: 'alert',
    ariaLive: 'assertive',
    landmarkLabel: 'Administrator impersonation in progress',
  };
}

/**
 * The two notifications the impersonation produces.
 *
 * Both are required and they are not the same signal. The INBOX entry reaches the person; the
 * AUDIT event reaches the review process. An impersonation recorded in only one of them has
 * failed in the other: nobody reviewing the inbox is watching the audit stream, and nobody
 * watching the audit stream is the person whose account it was.
 */
export interface ImpersonationNotice {
  readonly toUserId: string;
  readonly kind: 'impersonation.started' | 'impersonation.ended';
  readonly title: string;
  readonly body: string;
  /** When it happened, so the inbox entry can be correlated with the audit row. */
  readonly at: Millis;
}

export function impersonationNotice(
  state: ImpersonationState,
  now: Millis,
  kind: 'started' | 'ended',
): ImpersonationNotice {
  return {
    toUserId: state.targetUserId,
    kind: kind === 'started' ? 'impersonation.started' : 'impersonation.ended',
    title:
      kind === 'started'
        ? 'An administrator viewed your account'
        : 'An administrator finished viewing your account',
    body:
      `${state.byDisplayName} signed in as you to investigate: ${state.reason}. ` +
      'They could see what you see and could not change anything. ' +
      'If this is unexpected, contact your school administrator.',
    at: now,
  };
}

/** The audit row. Includes the reason, because "who and when" does not explain anything. */
export function impersonationAuditEntry(state: ImpersonationState, now: Millis) {
  return {
    action: IMPERSONATION_AUDIT_ACTION,
    actorId: state.byUserId,
    targetType: 'User',
    targetId: state.targetUserId,
    meta: {
      reason: state.reason,
      startedAt: state.startedAt,
      expiresAt: state.expiresAt,
      /** Recorded so a review can distinguish "looked at 14 minutes" from "looked at 15". */
      at: now,
    },
  };
}
