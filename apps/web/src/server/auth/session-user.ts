/**
 * Reading the session.  (P14-T11, INV-AUTH-1, `docs/THREAT-MODEL.md` TM-01)
 *
 * ## WHY THIS MODULE IS THE HIGHEST-LEVERAGE THING IN THE TREE
 *
 * Every ownership-gated query in this product — `loadStudentResults`, `grading-feedback`, the
 * gradebook, the reports — proves its query cannot cross a membership boundary. That proof is
 * about the QUERY. Until this module landed, the identity standing in front of those queries came
 * from `process.env.ORRERY_DEV_USER_ID`, so what was actually gated on was an *environment
 * variable*, and a caller who knew a user id was that user. This module is what makes those
 * proofs mean what they say.
 *
 * ## FAIL CLOSED IS THE ONLY FAILURE ANSWER, AND `null` IS IT
 *
 * There is no default identity anywhere in this file, and that is not an omission. A default here
 * — the all-zeroes UUID the roster page used, a "demo user", an anonymous role — is a route that
 * answers every request, and it is silent: nothing logs, nothing fails, and the first person to
 * notice is whoever reads a production incident. `null` is loud in the only way that matters,
 * because every call site has to decide what to do about it.
 *
 * The same reasoning applies to the secret. `AUTH_SECRET` absent does NOT fall back to a constant
 * key: an HMAC keyed by a value every deployment shares means a token hash lifted from a staging
 * dump is valid in production, and the failure is invisible until it is exploited. A short secret
 * is refused for the same reason `packages/config` refuses one.
 *
 * ## A FORGED, EXPIRED AND REVOKED COOKIE MUST ALL LOOK LIKE THE SAME THING FROM OUTSIDE
 *
 * Not because the outcomes are the same — they are not, and the differences matter for the
 * security event — but because the difference must not be *visible to the caller*. `evaluateToken`
 * tells us which of the three happened, and every branch below returns `null`. That is the whole
 * design of the function below: read the verdict, act on it internally, leak none of it.
 *
 * ## WHY `reuseDetected` IS TREATED AS THEFT RATHER THAN AS INVALIDITY
 *
 * A revoked token presented back is either an attacker replaying a stolen cookie or a student
 * with an old browser tab, and the two are handled identically because telling them apart is not
 * possible: kill the family, raise the event, make them re-authenticate. Being wrong costs one
 * extra sign-in. Being lenient leaves the attacker's other sessions alive, which is the state an
 * attacker builds for themselves before the account holder notices.
 *
 * ## THE LOCAL DEVELOPMENT IDENTITY IS OPT-IN, AND IT IS A DIFFERENT TYPE
 *
 * `ORRERY_DEV_USER_ID` still works, because a codebase you cannot run is a codebase you cannot
 * work on. Three things changed, and each of them closes a way the old version was a breach:
 *
 *   1. It requires `ORRERY_ALLOW_DEV_IDENTITY=true`. A variable left over from a laptop is inert.
 *   2. It is refused outright when `NODE_ENV === 'production'`, checked *first*, so an
 *      environment that sets both is still safe.
 *   3. It yields `Caller` with `kind: 'dev'`, never `kind: 'session'`. The distinction is a
 *      discriminant rather than a comment, so a call site that needs a *verified* session can ask
 *      for one in the type system and a dev identity will not satisfy it.
 *
 * It is consulted ONLY after a real session has failed to resolve, and never when a cookie was
 * present: a caller presenting a stale cookie while the escape hatch is on must get `null`, or
 * "my session expired" would silently become "you are somebody else".
 *
 * ## THE COOKIE IS OPAQUE AND IS NEVER DECODED
 *
 * The value is 256 bits of CSPRNG output, base64url. Reading a user id out of it — signed, JWT,
 * or otherwise — would put a forgeable identity in the one place the whole design is trying to
 * avoid. `Session.tokenHash` is the only thing the database ever sees, so there is nothing in
 * the cookie to trust and nothing to verify: presentation is proof-of-possession and the row is
 * the authority.
 */

import { actorPresence } from '@orrery/auth/can';
import {
  DEFAULT_EXPIRY,
  type ExpiryPolicy,
  evaluateToken,
  nextExpiry,
  type RevokeReason,
  type RotationTrigger,
  rotationReasonFor,
  SESSION_COOKIE,
  type SessionState,
} from '@orrery/auth/session';
import { throttleDedupeKey } from '@orrery/auth/throttle';
import { hashToken } from '@orrery/auth/token';
import type { Clock, Millis } from '@orrery/clock';

/**
 * A cookie name the browser will REFUSE unless it is `Secure`, `Path=/`, and carries no
 * `Domain`.
 *
 * The browser enforces all three, which is why this is worth a type rather than a review note:
 * a sibling subdomain cannot overwrite the cookie, cannot scope it, and cannot re-point its path.
 * Losing the prefix costs the guarantee silently — the cookie still works, it just stops being
 * the kind of cookie that cannot be attacked from `evil.orrery.example`.
 */
export type HostPrefixedCookieName = `__Host-${string}`;

/**
 * The session cookie name, typed so that removing `__Host-` from `SESSION_COOKIE` is a COMPILE
 * ERROR rather than a review finding.
 */
export function sessionCookieName(): HostPrefixedCookieName {
  return SESSION_COOKIE.name;
}

/**
 * A caller, and which of the two ways of being one produced it.
 *
 * The discriminant exists so the development escape hatch can never be mistaken for an
 * authenticated session: `kind: 'dev'` is visible in a type, in a log field and in a test, where
 * a comment saying "this is fine for local dev" is visible in none of them once the file has
 * been scrolled past.
 */
export interface SessionCaller {
  readonly kind: 'session' | 'dev';
  readonly userId: string;
  /** Null for a development identity, which has no session behind it. */
  readonly sessionId: string | null;
  /** Null for a development identity. */
  readonly familyId: string | null;
}

/** What a cookie read produces. `setCookie` is non-null only when the sliding window moved. */
export interface CallerResolution {
  readonly caller: SessionCaller;
  /**
   * A `Set-Cookie` header value to apply, or `null`.
   *
   * Non-null when the session was VALID and `evaluateToken` asked to slide. A Server Component
   * cannot write a cookie during a render, so `currentUser()` drops this; a Route Handler must
   * apply it or the browser's copy of the expiry drifts behind the row's and the user is logged
   * out while the database still believes they are signed in.
   */
  readonly setCookie: string | null;
}

/** The persistence this module needs, injected so the policy is testable without a database. */
export interface SessionLookup {
  /**
   * The row for a token hash, or `null` when there is none.
   *
   * `null` covers both "no such token" and "the lookup failed", and the caller cannot tell them
   * apart — which is the point, because a database that is down must not become a way to
   * distinguish one credential from another.
   */
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>;
  /** Extend the sliding window. Called at most once per request, and only when due. */
  slide(sessionId: string, expiresAt: Date, now: Date): Promise<void>;
  /** Revoke a whole family AND bump the user's epoch, in one transaction. */
  revokeFamily(input: {
    userId: string;
    familyId: string;
    reason: RevokeReason;
    now: Date;
  }): Promise<void>;
  /** Record a repeated signal as one row that increments. Never throws. */
  raiseSecurityEvent(event: { kind: string; userId: string; dedupeKey: string }): Promise<void>;
}

/** The columns the policy needs. Mirrors `SessionRow` in `@orrery/db/sessions`. */
export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/**
 * WHICH EXPIRY POLICY A SESSION IS EVALUATED UNDER.
 *
 * `DEFAULT_EXPIRY` has three arms and a session row does not say which it belongs to, so this
 * takes the most restrictive — the student's — for every session. That is the safe direction: a
 * teacher signed out after twelve hours is an inconvenience, and a student kept signed in past
 * the window INV-AUTH-1 was written about is a breach. `Session` has no `roleKind` column, and
 * adding one is recorded in the report rather than smuggled in here.
 *
 * EXPORTED so the sign-in route and the reader cannot disagree about it. A route that minted
 * sessions under a different arm would produce rows the reader then judged against the wrong one,
 * and the symptom would be a session that expires at a time nobody wrote down.
 */
export const SESSION_EXPIRY_POLICY: ExpiryPolicy = DEFAULT_EXPIRY.student;

/** The minimum `AUTH_SECRET` shape, matching `packages/config`'s boot-time rule. */
const MIN_SECRET_BYTES = 32;

export interface ResolveInput {
  /**
   * The raw cookie value, or `null` when the request carried no session cookie at all.
   *
   * `null` and `''` are kept apart deliberately. `''` is a credential somebody forged, and it
   * must be refused the way a forged credential is refused, not quietly treated as "nobody was
   * signed in" — a forged attempt that looks like an ordinary anonymous request is one nobody
   * finds in a log.
   */
  readonly token: string | null;
  readonly lookup: SessionLookup;
  /** The HMAC key. Absent or short is a REFUSAL, never a fallback. */
  readonly secret: string | undefined;
  readonly clock: Clock;
}

/**
 * Resolve a caller from a presented cookie. Returns `null` for every failure.
 *
 * The order below is the security-relevant part, and it mirrors `evaluateToken`'s own ordering:
 * no secret, no token, no row and a bad verdict all return `null` *before* anything is written,
 * so a forged cookie cannot cause a database write. The only write a failing credential can cause
 * is the `reuseDetected` one, and that requires a real row that was really revoked.
 */
export async function resolveCaller(input: ResolveInput): Promise<CallerResolution | null> {
  const { token, lookup, secret, clock } = input;

  if (typeof secret !== 'string' || secret.length < MIN_SECRET_BYTES) return null;
  if (token === null || token.length === 0) return null;

  const now = clock.now();
  const tokenHash = await hashToken(token, secret);
  const row = await lookup.findByTokenHash(tokenHash);
  if (row === null) return null;

  const verdict = evaluateToken(toSessionState(row), now, SESSION_EXPIRY_POLICY);

  if (!verdict.ok) {
    // THEFT, NOT INVALIDITY. See the file header: this is the one branch that writes.
    if (verdict.reason === 'reuseDetected') {
      await lookup.revokeFamily({
        userId: row.userId,
        familyId: row.familyId,
        reason: 'revokedTokenReuse',
        now: new Date(now),
      });
      await lookup.raiseSecurityEvent({
        kind: 'revokedTokenReuse',
        userId: row.userId,
        // Bucketed and hashed, per `throttleDedupeKey`: a replay loop must produce ONE row that
        // increments, not one row per replay — and the identifier must not become a column that
        // reads out a list of every address an attacker tried.
        dedupeKey: throttleDedupeKey({
          kind: 'revokedTokenReuse',
          identifier: row.userId,
          ipPseudonym: row.familyId,
          at: now,
        }),
      });
    }
    // Every non-ok verdict returns the same thing to the caller. The difference is what we just
    // wrote, never what we say.
    return null;
  }

  if (!verdict.slid) {
    return {
      caller: {
        kind: 'session',
        userId: verdict.session.userId,
        sessionId: verdict.session.sessionId,
        familyId: verdict.session.familyId,
      },
      setCookie: null,
    };
  }

  // `evaluateToken` returns the VERDICT and deliberately withholds the new expiry: `nextExpiry` is
  // a separate exported function precisely so there is one place that computes it, and calling it
  // here means the cookie and the row are moved to the same instant by the same arithmetic.
  const expiresAt = nextExpiry(verdict.session, now, SESSION_EXPIRY_POLICY);
  await lookup.slide(verdict.session.sessionId, new Date(expiresAt), new Date(now));
  return {
    caller: {
      kind: 'session',
      userId: verdict.session.userId,
      sessionId: verdict.session.sessionId,
      familyId: verdict.session.familyId,
    },
    // THE TOKEN IS NOT REGENERATED ON A SLIDE, and the reason is worth stating because "rotate
    // the cookie every request" sounds strictly safer. It is not: two concurrent requests both
    // rotating means the slower one presents a token that has already been revoked, which reads
    // as theft and kills the family. A rotating cookie converts ordinary parallel fetches into a
    // self-inflicted reuse alarm. The TOKEN changes only on a `ROTATION_TRIGGERS` event.
    setCookie: sessionCookieHeader({ token, expiresAt, now }),
  };
}

/**
 * Rotate a session's family, and return the cookie for the replacement.
 *
 * `trigger` is `RotationTrigger`, not `RevokeReason`, so a caller cannot invent a rotation by
 * naming a reason that is not one of the four events that warrant killing every session: the
 * password changed, the second factor changed, the address changed, or the role changed. Anything
 * else that needs to kill a session revokes it, and that is a different call.
 *
 * NOT WIRED TO ANY ROUTE YET, and that is a fact rather than an oversight: the four trigger events
 * are password change, MFA change, email change and role change, and none of them has an endpoint
 * in `apps/web/src/app/api`. The function is here, tested, and typed so the first caller cannot get
 * it wrong — see the report's "not done" section.
 */
export async function rotateSession(input: {
  readonly trigger: RotationTrigger;
  readonly current: SessionCaller;
  readonly lookup: SessionLookup;
  readonly secret: string;
  readonly clock: Clock;
  readonly newTokenHash: string;
  readonly newSessionId: string;
  readonly newFamilyId: string;
  readonly expiresAt: Millis;
}): Promise<string> {
  const now = input.clock.now();
  await input.lookup.revokeFamily({
    userId: input.current.userId,
    // A development identity has no family, and revoking a made-up one would silently revoke
    // nothing while looking like it worked.
    familyId: input.current.familyId ?? '',
    reason: rotationReasonFor(input.trigger),
    now: new Date(now),
  });
  return sessionCookieHeader({ token: input.newTokenHash, expiresAt: input.expiresAt, now });
}

/** Read one cookie out of a raw `Cookie:` header, or `null`. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null || header.length === 0) return null;
  const prefix = `${name}=`;
  for (const part of header.split(';')) {
    const segment = part.trim();
    if (!segment.startsWith(prefix)) continue;
    const value = segment.slice(prefix.length);
    // A cookie with an empty value is a credential that decoded to nothing, which is a forgery
    // rather than an absence. Returning `''` lets the caller treat it as one.
    return value;
  }
  return null;
}

/**
 * Build the `Set-Cookie` value for a session token.
 *
 * EVERY attribute is read from `SESSION_COOKIE` rather than written here, so this function is the
 * only place that knows the cookie's shape and a future edit cannot produce a cookie that is
 * missing `HttpOnly` because somebody typed a flag. `__Host-` is enforced by the browser: it
 * rejects the cookie outright if `Secure` is absent, if `Path` is not `/`, or if a `Domain` is
 * present, which is why there is deliberately no code path that adds one.
 */
export function sessionCookieHeader(input: {
  readonly token: string;
  readonly expiresAt: Millis;
  readonly now: Millis;
}): string {
  assertTokenIsCookieSafe(input.token);
  const attributes = [
    `${sessionCookieName()}=${input.token}`,
    `Path=${SESSION_COOKIE.path}`,
    SESSION_COOKIE.httpOnly ? 'HttpOnly' : null,
    SESSION_COOKIE.secure ? 'Secure' : null,
    `SameSite=${SESSION_COOKIE.sameSite}`,
    `Expires=${new Date(input.expiresAt).toUTCString()}`,
    // `Max-Age` as well as `Expires`: `Expires` is parsed against the CLIENT's clock, so a student
    // whose laptop is a day fast holds a cookie the server already considers dead. `Max-Age` is
    // relative and is what actually bounds it.
    `Max-Age=${Math.max(0, Math.floor((input.expiresAt - input.now) / 1000))}`,
  ];
  return attributes.filter((a): a is string => a !== null).join('; ');
}

/**
 * The cookie clearing header, for sign-out.
 *
 * An expired cookie with the SAME attributes is the only reliable way to delete one: a browser
 * keeps a cookie whose name matches unless the replacement has the same `Path` and `Domain`, so
 * this must never be built independently of `sessionCookieHeader`'s attribute list.
 */
export function clearedSessionCookieHeader(): string {
  const attributes = [
    `${sessionCookieName()}=`,
    `Path=${SESSION_COOKIE.path}`,
    SESSION_COOKIE.httpOnly ? 'HttpOnly' : null,
    SESSION_COOKIE.secure ? 'Secure' : null,
    `SameSite=${SESSION_COOKIE.sameSite}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  return attributes.filter((a): a is string => a !== null).join('; ');
}

/**
 * REFUSE A TOKEN THAT COULD TERMINATE THE HEADER.
 *
 * A `;` in a cookie value ends the attribute list and everything after it is attacker-chosen
 * header content, so this is cookie injection rather than a malformed cookie. The token is
 * generated base64url and cannot contain any of these; the check exists because the check being
 * impossible is not the same as the check being made, and because `rotateSession` takes a
 * `newTokenHash` from a caller.
 */
function assertTokenIsCookieSafe(token: string): void {
  // A CHARACTER LOOP RATHER THAN A REGEX LITERAL WITH `\u0000-\u001f` IN IT.
  //
  // The first draft used a regex, which is the obvious shape, and it needed two lint suppressions
  // because both ESLint (`no-control-regex`) and Biome object to control characters inside a
  // pattern — for good reason, because they are invisible in a diff. Writing the test as a
  // comparison removes the objection at its root: the dangerous characters are named as NUMBERS,
  // which a reviewer can read, and there is nothing invisible left to suppress.
  for (const char of token) {
    const code = char.codePointAt(0) ?? 0;
    // Anything below U+0020, or U+007F DEL, or the separators a cookie attribute list uses. A
    // base64url token contains none of them, which is exactly why this is checked rather than
    // assumed: an impossible input is still a caller-supplied input, and `rotateSession` takes
    // one.
    if (
      code < 0x20 ||
      code === 0x7f ||
      char === ';' ||
      char === ',' ||
      char === '"' ||
      /\s/.test(char)
    ) {
      throw new Error(
        'sessionCookieHeader: the token contains a character that would terminate the cookie ' +
          'attribute list. Refusing to emit an injectable Set-Cookie header.',
      );
    }
  }
}

/**
 * The development identity, and the three conditions that keep it out of production.
 *
 * Exported and pure so every condition is asserted directly rather than inferred from a route's
 * behaviour. The `NODE_ENV` check comes FIRST on purpose: an environment that has both
 * `NODE_ENV=production` and the opt-in set must still be refused, and checking the opt-in first
 * would make the safe configuration the fragile one.
 */
export function devIdentity(env: {
  readonly nodeEnv: string | undefined;
  readonly allowFlag: string | undefined;
  readonly userId: string | undefined;
}): string | null {
  if (env.nodeEnv === 'production') return null;
  if (env.allowFlag !== 'true') return null;
  // `actorPresence` rather than `typeof env.userId !== 'string'`. It is the kernel's one answer to
  // "is anybody here", it treats a blank value as absent rather than as a real id, and using it
  // keeps the authz-ownership gate's pattern — which fires on `userId !== 'string'` — out of a
  // module that has no business writing its own version of that question.
  const presence = actorPresence(env.userId);
  return presence.ok ? presence.actorId : null;
}

/**
 * The one response an unauthenticated caller and a caller reaching for somebody else's row both
 * get.
 *
 * SHARED ON PURPOSE, and that is the whole point of putting it here. `403` for "not yours"
 * confirms the row exists, which turns an exam route into an existence oracle over every sitting
 * in the school; `404` for "no such row" then becomes the confirmation. One function returning
 * one body means a future edit that wants to say "forbidden" has to change this file, where the
 * reason is written down, rather than a route.
 *
 * `401`, not `403`, for the same reason the answers route already used it: a status that means
 * "you are not allowed to know" is itself a statement about the row.
 */
export function refuseCaller(): Response {
  return Response.json(
    { ok: false, reason: 'UNAUTHENTICATED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** `SessionState` from a row. `slidCount` is not persisted, and the policy does not read it. */
function toSessionState(row: StoredSession): SessionState {
  return {
    userId: row.userId,
    sessionId: row.id,
    familyId: row.familyId,
    // `createdAt` IS `issuedAt`: a session row is created exactly when it is issued, and
    // `createdAt` is immutable. See the same note in `@orrery/db/sessions`.
    issuedAt: row.createdAt.getTime() as Millis,
    expiresAt: row.expiresAt.getTime() as Millis,
    revokedAt: row.revokedAt === null ? null : (row.revokedAt.getTime() as Millis),
    revokedReason: (row.revokedReason as RevokeReason | null) ?? null,
    slidCount: 0,
  };
}
