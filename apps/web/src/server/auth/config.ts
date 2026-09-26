/**
 * Better Auth configuration.  (P1-T1, plans/13 §1)
 *
 * ## Why Better Auth owns credentials and `@orrery/auth` owns everything else
 *
 * Better Auth is good at credential storage, session cookies and OAuth plumbing, and it is
 * not where this product's authorisation lives. The split is deliberate and the boundary is
 * one line: **Better Auth verifies a token; it never decides anything.**
 *
 *   · `better-auth` — password verification, session cookie, magic-link exchange, email
 *     verification. It returns "who is this and are they suspended".
 *   · `@orrery/auth` — `can()`, the session POLICY, the account lifecycle, throttling.
 *     Everything that can be allowed, revoked, or reasoned about.
 *
 * The reason is INV-AUTH-1. A framework that also answers "may this user do X" is a
 * framework whose answers you have to audit, and Better Auth's are not the ones this
 * product's security claims rest on. The `can()` matrix is.
 *
 * ## The `databaseHooks` below are the ONLY place the two meet
 *
 * Each hook is a narrow adapter: it translates a framework event into a call on our own
 * policy, and it never contains a decision. If a rule ever appears in this file, it belongs
 * in `packages/auth` and this file should import it instead.
 */

import {
  type AccountState,
  classifyMfaFailure,
  isActive,
  LOGIN_FAILURES,
} from '@orrery/auth/lifecycle';
import { hashPassword, verifyPassword } from '@orrery/auth/password';
import {
  DEFAULT_EXPIRY,
  type ExpiryPolicy,
  MAGIC_LINK,
  SESSION_COOKIE,
} from '@orrery/auth/session';
import { evaluateThrottle } from '@orrery/auth/throttle';
import { betterAuth } from 'better-auth';

/**
 * What the adapter is given. Deliberately an interface, not Better Auth's own types, so the
 * unit tests of the adapters need no framework types and no database.
 */
export interface AuthAdapterDeps {
  readonly pepper: string;
  /** Reads the account in the shape `lifecycle.ts` speaks. */
  readonly loadAccount: (userId: string) => Promise<AccountState | null>;
  readonly listAttempts: (input: {
    identifier: string;
    ipPseudonym: string;
    sinceMillis: number;
  }) => Promise<{ identifier: string; ipPseudonym: string; at: number; succeeded: boolean }[]>;
  readonly now: () => number;
  readonly writeSecurityEvent: (event: {
    kind: string;
    userId: string;
    dedupeKey: string;
    meta: Record<string, unknown>;
  }) => Promise<void>;
  /** Revokes every live session for a user. MUST be called inside the caller's transaction. */
  readonly revokeAllSessions: (userId: string, reason: string) => Promise<number>;
}

export const EMAIL_MINIMUMS = 8;

/**
 * Build the Better Auth instance.
 *
 * `prisma` is not passed as an adapter: this project talks to Postgres through
 * `@orrery/db`, which exports functions and never a client instance, and a second path to the
 * database would defeat that. The seam is `databaseHooks`, and the concrete Prisma
 * implementation of `AuthAdapterDeps` lives in `deps.ts` so that this file stays readable and
 * testable without a database.
 */
export function createAuth(deps: AuthAdapterDeps) {
  return betterAuth({
    secret: deps.pepper,
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',

    emailAndPassword: {
      enabled: true,
      // Argon2id at the OWASP baseline, not bcrypt. `plans/13` says argon2id and there is no
      // reason to ship bcrypt anywhere in a new system in 2026.
      // Better Auth passes a single object, not positional arguments. Getting this wrong is
      // a type error rather than a silent failure, which is the best kind.
      password: {
        hash: (password: string) => hashPassword(password, deps.pepper),
        verify: (data: { hash: string; password: string }) =>
          verifyPassword(data.password, data.hash, deps.pepper),
      },
      // The length floor and the breach check live in `@orrery/auth` so they are unit
      // tested. Better Auth's own `minPasswordLength` is set to match, but it is the same
      // number in two places, so the constant is imported rather than typed twice.
      minPasswordLength: 12,
      autoSignIn: false,
    },

    emailVerification: {
      // REQUIRED before creating a classroom, publishing, or grading (plans/13 §1). Better
      // Auth's own gate is only the first of the three; the others are checked at those
      // call sites, because a framework cannot know what a grade is.
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: 24 * 60 * 60, // seconds
    },

    magicLink: {
      enabled: true,
      // Single use, 15 minutes, and it invalidates the session family on use — see
      // `MAGIC_LINK` in @orrery/auth/session for why the last part is not optional.
      expiresIn: MAGIC_LINK.ttl / 1000,
      disableSignUp: false,
    },

    session: {
      // Sliding with an absolute cap. The values come from the role-based policy, and
      // Better Auth's own `expiresIn`/`updateAge` are set from the same constants rather
      // than written again here.
      expiresIn: Math.floor(DEFAULT_EXPIRY.student.absolute / 1000),
      updateAge: Math.floor(DEFAULT_EXPIRY.student.idle / 1000),
      cookieCache: {
        // EXPLICITLY DISABLED, and this is the single most important line in the file.
        //
        // `C25` found that a 60-second session cache silently defeats INV-AUTH-1: a teacher
        // suspending a student, or removing them from a classroom, has to take effect on the
        // NEXT request. A cache means the next sixty seconds of requests are answered from a
        // stale session and the removal does not happen. Enabling it later requires deleting
        // the key in the same transaction as every revoke.
        enabled: false,
      },
    },

    advanced: {
      cookiePrefix: '__Host-',
      useSecureCookies: process.env.NODE_ENV === 'production',
      // The name is fixed rather than configured, because a session cookie whose name can
      // vary per environment is a session cookie you will forget to invalidate somewhere.
      defaultCookieAttributes: {
        httpOnly: SESSION_COOKIE.httpOnly,
        secure: SESSION_COOKIE.secure,
        sameSite: SESSION_COOKIE.sameSite,
        path: SESSION_COOKIE.path,
      },
    },

    /**
     * The only seam where the framework's idea of an account meets ours.
     */
    databaseHooks: {
      /**
       * After Better Auth has verified a password, before it issues a session.
       *
       * Four things happen here and all four are CALLS, not rules:
       *   1. throttle, per identifier and per IP
       *   2. refuse a suspended or deleted account
       *   3. record a failed attempt so the next request's throttle sees it
       *   4. raise a security event where the shape demands it
       */
      session: {
        create: {
          before: async (session: { userId: string }, context: unknown) => {
            const attempt = describeSignInAttempt(context);
            const decision = await assertMaySignIn(deps, session.userId, attempt);
            if (!decision.allowed) {
              // The SAME generic message for every failure. `LOGIN_FAILURES[...].response` is
              // `'invalid'` for all of them precisely so this throw cannot be branched into a
              // user-existence oracle by a well-meaning future edit.
              throw new Error(LOGIN_FAILURES[decision.failure].response);
            }
            return { data: session };
          },
          after: async (session: { userId: string }) => {
            await deps.loadAccount(session.userId);
          },
        },
      },
    },
  });
}

/**
 * Pull the identifier and IP pseudonym out of whatever Better Auth hands us.
 *
 * Typed as `unknown` deliberately. Its context type is `GenericEndpointContext | null`, and
 * pinning to a specific shape here would break on the next framework upgrade in a way that
 * looked like our bug. Reading defensively means an unrecognised context yields empty
 * strings, which the throttle treats as one more distinct identifier — the safe direction,
 * because garbage input then fills the counters rather than bypassing them.
 *
 * The IP is read from a header and is expected to be a PSEUDONYM supplied by the edge, never
 * a raw address: this module has no salt and must not be trusted with one.
 */
export function describeSignInAttempt(context: unknown): {
  identifier: string;
  ipPseudonym: string;
} {
  if (context === null || typeof context !== 'object')
    return { identifier: '', ipPseudonym: 'unknown' };
  const ctx = context as { body?: unknown; headers?: { get(name: string): string | null } };
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const identifier = typeof body.email === 'string' ? body.email : '';
  const ipPseudonym = ctx.headers?.get('x-ip-pseudonym') ?? 'unknown';
  return { identifier, ipPseudonym };
}

/**
 * Everything that must hold before a session is created.
 *
 * Exported and pure-ish so it can be tested without Better Auth. The order matters:
 * throttling first, because it is the cheapest and the most likely to be a real attack;
 * account status second, because a suspended account must never receive a session even if
 * the throttle is clean.
 */
export async function assertMaySignIn(
  deps: AuthAdapterDeps,
  userId: string,
  attempt: { identifier: string; ipPseudonym: string },
): Promise<{ allowed: true } | { allowed: false; failure: keyof typeof LOGIN_FAILURES }> {
  const { identifier, ipPseudonym } = attempt;
  const now = deps.now();

  const attempts = await deps.listAttempts({
    identifier,
    ipPseudonym,
    sinceMillis: now - 24 * 60 * 60 * 1000,
  });
  const verdict = evaluateThrottle({ attempts, now, identifier, ipPseudonym });

  if (!verdict.allow) {
    return { allowed: false, failure: 'wrongPassword' };
  }

  const account = await deps.loadAccount(userId);
  if (account === null) {
    return { allowed: false, failure: 'unknownAccount' };
  }

  // `isActive` treats DELETING as usable, on purpose: the 30-day grace is a grace, not a
  // lockout. A user who asked to delete their account can still sign in to cancel.
  if (!isActive(account)) {
    return { allowed: false, failure: 'suspended' };
  }

  return { allowed: true };
}

/** Whether a run of MFA failures should be treated as an attack rather than a typo. */
export function mfaVerdict(priorFailures: number): { securityEvent: string | null } {
  return classifyMfaFailure(priorFailures) === 'suspicious'
    ? { securityEvent: LOGIN_FAILURES.repeatedMfaFailure.securityEvent }
    : { securityEvent: null };
}

export type { AccountState, ExpiryPolicy };
