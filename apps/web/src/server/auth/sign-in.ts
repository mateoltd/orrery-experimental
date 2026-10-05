/**
 * Credential sign-in.  (P14-T11, P1-T3, `docs/THREAT-MODEL.md` TM-01)
 *
 * ## THE ROUTE `transport.ts` HAS BEEN CALLING SINCE P1-T3 DID NOT EXIST
 *
 * `authTransport.signIn` posts to `/api/auth/sign-in` (`server/auth/transport.ts:48`). That path
 * had no handler, so the sign-in page could not succeed — it called a 404. A missing endpoint and
 * a refusing endpoint are very different things to the person in front of the form, and only one
 * of them is a security property.
 *
 * ## WHY THIS IS NOT `better-auth`
 *
 * `server/auth/config.ts` builds a Better Auth instance with Argon2id, the right cookie prefix
 * and a session-creation hook — and it cannot serve a route handler in this repository, because
 * wiring it needs a Prisma adapter package that is not a dependency and adding one is not this
 * task's decision to make. Everything Better Auth would have done here is done below with
 * `@orrery/auth`, which is also the only place this product's security claims rest:
 * `verifyLogin`, `assertMaySignIn`, `evaluateThrottle`, `newSession`, `evaluateToken`,
 * `SESSION_COOKIE`. The boundary `config.ts:8` states — *Better Auth verifies a token; it never
 * decides anything* — holds in this file too, and `assertMaySignIn` is imported rather than
 * reimplemented precisely because a second copy of "may this account sign in" is a second answer.
 *
 * ## THE ENUMERATION DEFENCE IS FOUR THINGS, AND THE MESSAGE IS THE LEAST LOAD-BEARING OF THEM
 *
 * `GENERIC_AUTH_FAILURE` on every failure is the obvious one, and it is nearly redundant:
 * `transport.ts:38` already collapses anything that is not a 200 into the same string, so a
 * server that leaked in its copy would leak nothing through this UI anyway. The three that
 * actually hold:
 *
 *   1. **One status code.** `signInFailure` is 401 for every kind. A 404 for "no such account" is
 *      the single most useful thing an attacker could be handed.
 *   2. **One body, byte for byte.** `signInFailure` returns a constant; `flow.test.ts` asserts the
 *      serialised responses are one value across all eight kinds.
 *   3. **One amount of work.** `verifyLogin` verifies against a DUMMY argon2id hash when there is
 *      no stored hash, so "no such user" costs the same ~40ms as "wrong password". Without it the
 *      login form is an account-enumeration oracle that returns helpful copy, and the copy is the
 *      part everybody remembers to fix.
 *   4. **One amount of WALL TIME.** This file's own contribution, and the one that survives the
 *      database round trips the dummy hash cannot cover. A response is held until
 *      `TIMING.minimumFailureDisplayMs` has elapsed — on SUCCESS as well, because a floor that
 *      covers only the failures manufactures the very channel it exists to close. `AuthPanel`
 *      applies the same floor in the browser for the same reason (`AuthPanel.tsx:78-90`).
 *
 * ## THE ORDER OF THE TWO CHECKS IS THE PART THAT IS EASY TO GET BACKWARDS
 *
 * The password is verified BEFORE the account's status is read. Reading the status first means an
 * unknown address never reaches argon2 and returns instantly, which is point 3 above by another
 * route, and it is a route the code below would otherwise have looked correct in.
 */

import { actorPresence, isSameActor } from '@orrery/auth/can';
import { type AccountState, LOGIN_FAILURES, type LoginFailure } from '@orrery/auth/lifecycle';
import { verifyLogin } from '@orrery/auth/password';
import { newSession } from '@orrery/auth/session';
import { type Attempt, throttleDedupeKey } from '@orrery/auth/throttle';
import { hashToken } from '@orrery/auth/token';
import type { Clock } from '@orrery/clock';
import { type AuthFailureKind, RESPONSES, signInFailure, TIMING } from '@/features/auth/flow';
import { type AuthAdapterDeps, assertMaySignIn } from './config';
import { SESSION_EXPIRY_POLICY, sessionCookieHeader } from './session-user';

/** The columns credential sign-in needs. A projection, not a `User`. */
export interface CredentialAccount {
  readonly userId: string;
  /**
   * The argon2id hash, or `null` when there is none.
   *
   * `null` is a first-class value rather than an error: an account provisioned by an invitation
   * or a magic link has no password, and "there is no password to check" has to cost the same as
   * "there is a password and it is wrong".
   */
  readonly passwordHash: string | null;
  readonly status: AccountState['status'];
  readonly deletingAt: number | null;
  readonly suspendedAt: number | null;
  readonly suspendedReason: string | null;
}

export interface SignInStore {
  /** The account for a NORMALISED address, or `null`. */
  findAccountByEmail(emailNormalized: string): Promise<CredentialAccount | null>;
  /**
   * Insert the session row.
   *
   * The raw token is not an argument, so there is no version of this call that can write it. A
   * credential that reaches the database is a credential that reaches whoever dumps it.
   */
  insertSession(row: {
    id: string;
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<void>;
  listAttempts(input: {
    identifier: string;
    ipPseudonym: string;
    sinceMillis: number;
  }): Promise<Attempt[]>;
  /** One row that increments. Never throws: an audit write must not turn a refusal into a 500. */
  writeSecurityEvent(event: {
    kind: string;
    userId: string;
    dedupeKey: string;
    /**
     * Strings only. `SecurityEvent.meta` is read by a human in a review queue, and a JSON column
     * that accepts arbitrary nesting is a column that eventually receives a token; a value that
     * will not type-check as a JSON scalar cannot be one by accident.
     */
    meta: Record<string, string>;
  }): Promise<void>;
  /** Every live session for a user, killed with their epoch in one transaction. */
  revokeAllSessions(userId: string, reason: string): Promise<number>;
  /**
   * Append to the attempt log the throttle reads.
   *
   * Recorded on BOTH outcomes, which is deliberate and comes from `throttle.ts:157`: a success
   * still counts toward the per-IP signals, because a school registration morning is hundreds of
   * successful logins from one address and that is exactly the shape the limiter must not punish.
   * A success also CLEARS the per-identifier counter (`throttle.ts:142`), so a student who fumbles
   * twice and then gets it right is not asked for a second factor for a fortnight.
   */
  recordAttempt(attempt: Attempt): Promise<void>;
}

export interface SignInDeps {
  readonly store: SignInStore;
  /** The HMAC key for `Session.tokenHash`. Also the Better Auth secret, per `config.ts:79`. */
  readonly secret: string;
  /** The pepper mixed into every password hash. See `@orrery/auth/password`. */
  readonly pepper: string;
  readonly clock: Clock;
  /** An edge-supplied IP PSEUDONYM, never a raw address. See `config.ts:190-194`. */
  readonly ipPseudonym: string;
  /** Mint the session token. Injected so a test never depends on CSPRNG output. */
  readonly mintToken: () => string;
  /** Mint a session and family id. Same reason. */
  readonly mintId: () => string;
}

export type SignInOutcome =
  | { readonly ok: true; readonly setCookie: string }
  | { readonly ok: false; readonly failure: AuthFailureKind };

/**
 * The endpoint, as a function of its dependencies.
 *
 * Returns an OUTCOME rather than a `Response` so the two things worth asserting — whether it was
 * refused, and what cookie came back — can be checked directly, and so `respondUniformly` can put
 * the latency floor around every path without the route knowing which paths exist.
 */
export async function signIn(
  deps: SignInDeps,
  input: { readonly email: string; readonly password: string },
): Promise<SignInOutcome> {
  const now = deps.clock.now();
  const identifier = normaliseEmail(input.email);

  // ONE LOOKUP, THEN ONE ARGON2ID VERIFICATION, IN THAT ORDER. See the file header.
  const account = await deps.store.findAccountByEmail(identifier);
  const passwordOk = await verifyCredentials(
    input.password,
    account?.passwordHash ?? null,
    deps.pepper,
  );

  if (!passwordOk || account === null) {
    return refuse(deps, {
      failure: account === null ? 'unknownAccount' : 'wrongPassword',
      identifier,
      userId: account?.userId ?? null,
    });
  }

  const decision = await assertMaySignIn(adapterDeps(deps, account), account.userId, {
    identifier,
    ipPseudonym: deps.ipPseudonym,
  });
  if (!decision.allowed) {
    // INV-AUTH-1, applied from the one place that learns about it. A suspended account must not
    // keep a session, and this is the only request where a suspended account's business is
    // described rather than merely refused, so this is where the flag in `LOGIN_FAILURES` is
    // honoured. The `LOGIN_FAILURES` entry decides whether it happens; nothing here decides on
    // its own, which is what stops a future kind from quietly skipping it.
    if (LOGIN_FAILURES[decision.failure].revokeSessions) {
      await deps.store.revokeAllSessions(
        account.userId,
        LOGIN_FAILURES[decision.failure].revokeReason,
      );
    }
    return refuse(deps, {
      failure: toAuthFailureKind(decision.failure),
      identifier,
      userId: account.userId,
    });
  }

  const token = deps.mintToken();
  const session = newSession({
    userId: account.userId,
    sessionId: deps.mintId(),
    familyId: deps.mintId(),
    now,
    policy: SESSION_EXPIRY_POLICY,
  });

  await deps.store.insertSession({
    id: session.sessionId,
    userId: account.userId,
    // THE RAW TOKEN IS NOT STORED AND NOT LOGGED. `tokenHash` is an HMAC keyed by `secret`, so a
    // dump of the `Session` table yields nothing a browser would accept.
    tokenHash: await hashToken(token, deps.secret),
    familyId: session.familyId,
    expiresAt: new Date(session.expiresAt),
  });

  await deps.store.recordAttempt({
    identifier,
    ipPseudonym: deps.ipPseudonym,
    at: now,
    succeeded: true,
  });

  return { ok: true, setCookie: sessionCookieHeader({ token, expiresAt: session.expiresAt, now }) };
}

/**
 * The `AuthAdapterDeps` that `assertMaySignIn` already speaks.
 *
 * Written here rather than in `./config` because `config.ts` builds a Better Auth instance and
 * this path does not use one; the DECISION is shared, which is the half that must not fork.
 */
function adapterDeps(deps: SignInDeps, account: CredentialAccount): AuthAdapterDeps {
  return {
    pepper: deps.pepper,
    // `isSameActor` rather than `userId === account.userId`. The authz-ownership gate flags a bare
    // comparison of an actor id to an owner id outside `packages/auth`, and it is right: every
    // such comparison is a question about IDENTITY and a codebase with one per call site has a
    // hundred slightly different answers. `isSameActor` is the one implementation, and it is
    // null-safe on both sides — a bare `===` reports `null === null` as the actor's own row.
    loadAccount: async (userId: string): Promise<AccountState | null> =>
      isSameActor(userId, account.userId)
        ? {
            userId,
            status: account.status,
            deletingAt: account.deletingAt,
            suspendedAt: account.suspendedAt,
            suspendedReason: account.suspendedReason,
          }
        : null,
    listAttempts: (input) => deps.store.listAttempts(input),
    now: () => deps.clock.now(),
    writeSecurityEvent: (event) =>
      deps.store.writeSecurityEvent({
        kind: event.kind,
        userId: event.userId,
        dedupeKey: event.dedupeKey,
        // `AuthAdapterDeps` types `meta` as `Record<string, unknown>` and the store's column
        // accepts scalars only. Narrowing HERE rather than widening the store is the direction
        // that keeps a JSON column in a human review queue from becoming a place a nested object
        // — or a token — can reach.
        meta: Object.fromEntries(Object.entries(event.meta).map(([k, v]) => [k, String(v)])),
      }),
    revokeAllSessions: (userId, reason) => deps.store.revokeAllSessions(userId, reason),
  };
}

/**
 * THE PREIMAGE USED WHEN THERE IS NO PASSWORD TO VERIFY.
 *
 * A constant, and deliberately paired with `storedHash: null` rather than with a real account's
 * hash: the verification then cannot succeed even in the impossible case that somebody created an
 * account whose password is this exact string.
 */
const DUMMY_PREIMAGE = 'orrery:no-password-supplied';

/**
 * Verify a password, and CONVERT `assertUsable`'s THROW into a refusal.
 *
 * ## WHY THE TRY/CATCH IS HERE, AND WHAT IT PREVENTED
 *
 * `assertUsable` (`password.ts:189`) throws on an empty password and on one over 1024 bytes. That
 * is the right guard — a zero-length or truncated preimage is a credential-shape problem rather
 * than a wrong password, and silently truncating it would let two passwords sharing a prefix
 * authenticate each other. It was still fatal here, and this function exists because a test caught
 * it: the route maps an absent `password` field to `''`, `verifyLogin` threw, and the exception
 * became an unhandled 500. **A 500 is a status code an attacker reads**, so an empty password was
 * a two-request enumeration oracle, discovered by asserting that "no password field" and "wrong
 * password" are indistinguishable.
 *
 * Catching rather than pre-checking is the deliberate choice: `assertUsable`'s limits would then
 * exist in two places, and a future edit to one would silently reopen this. The catch is scoped to
 * exactly the refusal above, and the fallback still runs a REAL argon2id verification against a
 * hash nobody holds the preimage for — so the cost is the same as every other refusal, which is
 * the property the timing assertion in `sign-in.test.ts` exists to protect.
 */
async function verifyCredentials(
  password: string,
  storedHash: string | null,
  pepper: string,
): Promise<boolean> {
  try {
    return await verifyLogin({ password, storedHash, pepper });
  } catch {
    return verifyLogin({ password: DUMMY_PREIMAGE, storedHash: null, pepper });
  }
}

/**
 * Refuse, uniformly, and leave the evidence behind.
 *
 * The audit trail and the HTTP response are separated on purpose: the contract is that the caller
 * returns the same generic message AND writes the same audit row, and this function can tell the
 * failure kinds apart internally precisely because it must not be able to say so externally.
 */
async function refuse(
  deps: SignInDeps,
  input: { failure: AuthFailureKind; identifier: string; userId: string | null },
): Promise<SignInOutcome> {
  await deps.store.recordAttempt({
    identifier: input.identifier,
    ipPseudonym: deps.ipPseudonym,
    at: deps.clock.now(),
    succeeded: false,
  });

  const policy = loginPolicyFor(input.failure);
  // `SecurityEvent.userId` is NOT NULL and foreign-keyed, so an attempt against an address that
  // has no account has nobody to attribute it to. That is a limitation of the TABLE, and saying so
  // is better than inventing a user id to satisfy the column: a credential-stuffing run against
  // addresses that do not exist is invisible here, and the per-identifier throttle is what
  // protects the accounts that do.
  // `actorPresence` rather than `input.userId !== null`. The gate flags this shape too, and the
  // kernel already has the one answer to "is anybody here" — which also treats a blank id as
  // absent rather than as a real one.
  const presence = actorPresence(input.userId);
  if (policy !== undefined && policy.securityEvent !== null && presence.ok) {
    await deps.store.writeSecurityEvent({
      kind: policy.securityEvent,
      userId: presence.actorId,
      // Bucketed and hashed, per `throttleDedupeKey`: a sustained run produces ONE row that
      // increments rather than one row per guess, and the identifier does not become a column
      // that reads out every address anybody has tried.
      dedupeKey: throttleDedupeKey({
        kind: policy.securityEvent,
        identifier: input.identifier,
        ipPseudonym: deps.ipPseudonym,
        at: deps.clock.now(),
      }),
      meta: { failure: input.failure },
    });
  }
  return { ok: false, failure: input.failure };
}

/**
 * `assertMaySignIn` can return `repeatedMfaFailure` BY TYPE and never BY VALUE — its switch only
 * produces `wrongPassword`, `unknownAccount` or `suspended` — and `AuthFailureKind` does not name
 * it, because a client-side response union has no use for a counter this endpoint does not keep.
 *
 * The remap is SEMANTICALLY INERT and that is the point rather than a workaround: `signInFailure`
 * returns byte-identical responses for every kind, so reporting a repeated MFA failure as a wrong
 * password changes nothing an attacker or a user can observe. Mapping it explicitly is better than
 * widening `AuthFailureKind` with a kind no credential endpoint can produce, which would put a lie
 * in the client's contract.
 */
function toAuthFailureKind(failure: LoginFailure): AuthFailureKind {
  return failure === 'repeatedMfaFailure' ? 'wrongPassword' : failure;
}

/**
 * The `LOGIN_FAILURES` entry for a kind, or `undefined` for the kinds that have no entry.
 *
 * `AuthFailureKind` is deliberately WIDER than `LoginFailure` — it also names `deletedAccount`,
 * `throttled`, `badMagicLink` and `badResetToken`, which are answers other endpoints give. So
 * the lookup is a total function returning `undefined` rather than an assertion, and a refusal
 * with no policy simply writes no security event instead of throwing on a route that is trying to
 * refuse somebody.
 */
function loginPolicyFor(kind: AuthFailureKind): (typeof LOGIN_FAILURES)[LoginFailure] | undefined {
  return Object.hasOwn(LOGIN_FAILURES, kind) ? LOGIN_FAILURES[kind as LoginFailure] : undefined;
}

/**
 * Lower-case and trim, which is what `User.emailNormalized` is documented to hold.
 *
 * A lookup by the address exactly as typed would miss `Student@School.Example` against
 * `student@school.example`, so the attempt would be recorded against a domain nobody uses and the
 * throttle counter would be evaded by changing the case of every guess.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * HOLD EVERY RESPONSE FOR THE SAME MINIMUM TIME, AND RENDER IT.
 *
 * THE ONLY THING THIS DOES THAT THE BODY CANNOT. A database round trip that happens to be slow on
 * one path and not the other is a timing oracle with no copy attached to it, and no amount of
 * identical JSON closes it.
 */
export async function respondUniformly(
  deps: SignInDeps,
  work: Promise<SignInOutcome>,
): Promise<Response> {
  const startedAt = deps.clock.monotonic();
  const outcome = await work;
  const remaining = TIMING.minimumFailureDisplayMs - (deps.clock.monotonic() - startedAt);
  if (remaining > 0) {
    // `monotonic()` is the STOPWATCH half of `Clock`, which is the correct tool for a duration.
    // INV-TIME-1 bans reading the host clock for business time; it does not ban measuring one,
    // and a clock that will not advance would make this floor untestable — which is worse than
    // not having the floor, because an untestable control is one nobody re-checks.
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  if (outcome.ok) {
    return Response.json(
      { ok: true, message: RESPONSES.signedIn, code: 'AUTH_OK' },
      { status: 200, headers: { 'Cache-Control': 'no-store', 'Set-Cookie': outcome.setCookie } },
    );
  }
  const failure = signInFailure(outcome.failure);
  return Response.json(failure.body, {
    status: failure.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * An attempt log, and the in-memory one this repository can offer today.
 *
 * ## WHY IT IS IN MEMORY, AND WHAT THAT COSTS
 *
 * There is no `LoginAttempt` table in the schema. `SecurityEvent` cannot stand in for one: its
 * `userId` is NOT NULL and foreign-keyed, so it cannot record an attempt against an address that
 * has no account — which is exactly the attempt that matters most for enumeration.
 *
 * So the throttle reads a bounded in-process log. That is a real limitation, stated rather than
 * buried: a credential-stuffing run spread across N replicas gets N times the budget, and a
 * restart clears the counters. The per-IDENTIFIER counter is the one that protects an account,
 * so it is the one that must move to durable storage first; the accompanying report carries the
 * SQL. What is NOT acceptable is forgetting that this is what is running, which is why the
 * function is named for what it is rather than being inlined at the call site.
 *
 * BOUNDED, because an unbounded log fed by an unauthenticated endpoint is itself a memory
 * exhaustion denial of service against our own login route.
 */
export interface AttemptLog {
  list(input: { identifier: string; ipPseudonym: string; sinceMillis: number }): Promise<Attempt[]>;
  record(attempt: Attempt): void;
}

export function inProcessAttemptLog(capacity = 5_000): AttemptLog {
  const log: Attempt[] = [];
  return {
    async list({ identifier, ipPseudonym, sinceMillis }) {
      return log.filter(
        (a) =>
          a.at >= sinceMillis && (a.identifier === identifier || a.ipPseudonym === ipPseudonym),
      );
    },
    record(attempt) {
      log.push(attempt);
      if (log.length > capacity) log.splice(0, log.length - capacity);
    },
  };
}
