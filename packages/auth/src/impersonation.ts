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

import type { Clock, Duration, Millis } from '@orrery/clock';

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

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE SERVER-SIGNED COOKIE.  (P14-T12, TM-03)
 *
 * ## WHY THE SIGNATURE IS THE WHOLE OF THE CONTROL, AND NOT A PART OF IT
 *
 * The read-only guarantee has exactly one enforcement point — `guardRequest`, above — and it can only act on a
 * `state` somebody produced. So the question "who produced this state?" has one answer that is worth anything at
 * all, and it is not a header, a query parameter, a row the client may have chosen the id of. **It is an HMAC over
 * the state, keyed by a server secret.** Without that HMAC, `guardRequest` is a switch anybody can flip: craft the
 * six fields yourself and the gate answers for them.
 *
 * ## AND THE FAILING DIRECTION IS THE ONE TO GET RIGHT
 *
 * A broken signature must degrade to **no impersonation**, not to a partial one. That is the direction the read-only
 * gate is safe in: an unverified cookie is refused, so the request is treated as the admin's own session rather than as
 * an untracked one, and the failure is a feature that stopped being enforced rather than a boundary that opened. The
 * opposite degradation — trusting the shape and ignoring the MAC — is a privilege escalation, because it hands an
 * attacker the ability to *choose* `byUserId`, and `byUserId` is what the audit trail records.
 *
 * ## WHAT THE SIGNATURE COVERS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * It covers **every field of `ImpersonationState`**, and nothing else in the repository:
 *
 *   · `byUserId` — so the audit row's actor cannot be chosen by the bearer of the cookie;
 *   · `targetUserId` — so the account being viewed cannot be swapped;
 *   · `startedAt` and `expiresAt` — so the window cannot be lengthened, shortened, or moved;
 *   · `reason` — the ticket number a teacher will later read, so it is evidence rather than decoration;
 *   · `byDisplayName` and `targetDisplayName` — the two names on the banner, which is a control in its own right
 *     (see `impersonationBanner`) and so cannot be text a client rewrote.
 *
 * **It does not cover the acting session.** See `guardImpersonatedRequest` for why that is a named gap rather than an
 * oversight, and for the optional field that closes it wherever the caller can supply one.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The cookie, and its attributes.
 *
 * `__Host-` for the same reason `SESSION_COOKIE` uses it (`session.ts:309-327`): the browser then enforces that the
 * cookie has no `Domain`, is `path=/` and is `Secure`, so a sibling subdomain cannot overwrite one that decides whether
 * an administrator may write. `httpOnly` is what keeps it out of reach of a script on the page.
 */
export const IMPERSONATION_COOKIE = {
  name: '__Host-orrery-impersonating',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
} as const;

/**
 * THE FLOOR ON THE SIGNING SECRET, and it is a floor rather than a presence check.
 *
 * A deployment with no secret, or with a one-word one, must not be able to mint impersonations — and a check that only
 * asked "is a secret configured" would pass a secret of `changeme`. Thirty-two bytes is the same rule `AUTH_SECRET` is
 * held to where the session cookie is signed, because it is the same secret doing the same job; see
 * `IMPERSONATION_SECRET_MIN_BYTES`'s only caller for why reusing one secret here is deliberate.
 */
export const IMPERSONATION_SECRET_MIN_BYTES = 32;

/**
 * DOMAIN SEPARATION, inside the signed material rather than beside it.
 *
 * The impersonation cookie is signed with the same server secret as the session token hash, because introducing a
 * second secret would mean a second thing for an operator to configure and a second thing to get wrong — and a pepper
 * that is silently absent is worse than no pepper at all. Reusing one key is only safe while the two purposes cannot be
 * confused, and the mechanism for that is a tag that differs per purpose, exactly as `evidence.ts` argues for
 * `orrery.evidence.v1`. A signature obtained for one purpose therefore does not verify for the other, because the
 * material it was computed over is not merely stored differently — it is a different message.
 */
const IMPERSONATION_TAG = 'orrery.impersonation.v1';

/** A hex SHA-256 digest. Anything else cannot be compared to one, so it is refused before the key does any work. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** base64url, without `Buffer`. This module is loaded by the edge runtime, where `Buffer` is not guaranteed. */
const toBase64Url = (text: string): string => {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** The inverse, and `null` for anything that is not base64url of UTF-8. Never throws: a cookie is untrusted input. */
const fromBase64Url = (text: string): string | null => {
  try {
    const restored = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(restored.padEnd(Math.ceil(restored.length / 4) * 4, '='));
    return strictDecoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
};

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/**
 * HMAC-SHA-256 over one message, injected `subtle` so the module needs no `node:crypto` import.
 *
 * `evidence.ts` states the rule this repeats: a module loaded by `apps/web` cannot import `node:crypto` at module
 * scope for a check only a server performs, because the import alone breaks the bundle. `globalThis.crypto.subtle` is
 * the one spelling that is present in the edge runtime and in Node, so the secret never has to cross a module boundary
 * as bytes.
 */
const hmacSha256 = async (message: string, secret: string): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message)));
};

/**
 * THE SIGNED MATERIAL: a JSON ARRAY of the tag and every field, in a fixed order.
 *
 * **An ARRAY, NOT A JOINED STRING, AND THE REASON IS A FIELD BOUNDARY.** The `reason` is free text a human types, so
 * it can contain any character at all — including the separator character a joined form would use. `JSON.stringify`
 * escapes every control character, so once encoded no field can contain the delimiter and the tuple decodes to exactly
 * one reading. This is `ADV-E3`'s argument, applied to a field the client can influence just as the tab id was.
 *
 * The order is fixed by construction rather than derived from `Object.keys`, because a signature is over the bytes that
 * were produced and a reader must reproduce the same eight in the same order without consulting an object layout.
 */
const signedMaterial = (state: ImpersonationState): string =>
  JSON.stringify([
    IMPERSONATION_TAG,
    state.byUserId,
    state.byDisplayName,
    state.targetUserId,
    state.targetDisplayName,
    state.startedAt,
    state.expiresAt,
    state.reason,
  ]);

/** Mint a cookie value: `<hex signature>.<base64url of exactly the bytes that were signed>`. */
export async function signImpersonationCookie(
  state: ImpersonationState,
  secret: string,
): Promise<string> {
  const material = signedMaterial(state);
  return `${await hmacSha256(material, secret)}.${toBase64Url(material)}`;
}

const isText = (value: unknown): value is string => typeof value === 'string';

/** A signed instant has to be an integer: a fractional `expiresAt` is a clock comparison nobody can reason about. */
const isMillis = (value: unknown): value is Millis =>
  typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Rebuild the state from the bytes that were signed, or `null`.
 *
 * **THE SIGNATURE IS CHECKED BEFORE THIS RUNS, AND THAT ORDER IS THE POINT.** This function validates the SHAPE of a
 * payload whose authenticity has already been established, not the authenticity of a payload — a reader that tried to
 * decide trust from the shape would be the "parse and hope" failure the whole mechanism exists to avoid. What it is for
 * is that a payload signed by a buggy or compromised signer is still not allowed to put a string where an instant goes.
 */
const parseSignedMaterial = (json: string): ImpersonationState | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 8) return null;

  const [
    tag,
    byUserId,
    byDisplayName,
    targetUserId,
    targetDisplayName,
    startedAt,
    expiresAt,
    reason,
  ] = parsed;
  if (tag !== IMPERSONATION_TAG) return null;
  if (
    !isText(byUserId) ||
    !isText(byDisplayName) ||
    !isText(targetUserId) ||
    !isText(targetDisplayName) ||
    !isMillis(startedAt) ||
    !isMillis(expiresAt) ||
    !isText(reason)
  ) {
    return null;
  }
  return {
    byUserId,
    byDisplayName,
    targetUserId,
    targetDisplayName,
    startedAt,
    expiresAt,
    reason,
  };
};

/**
 * WHY A VERDICT, AND WHY THESE REASONS.
 *
 * `evidence.ts` names the rule for `EvidenceSignatureVerdict`: "does not match" is the answer that sends a teacher
 * through a whole paper, and a verdict that collapses every failure to one reason is a verdict nobody can act on. The
 * same applies to whoever is on call for an impersonation cookie that stopped being honoured, so each of these is a
 * different incident with a different response.
 */
export type ImpersonationCookieRefusal =
  /** No cookie at all. The ordinary request, and not an incident. */
  | 'NO_COOKIE'
  /** No usable signing secret, so nothing could be verified. The deployment is unconfigured. */
  | 'NO_SECRET'
  /** Not `<hex>.<base64url>`: a truncated write, a cookie from an older format, or a hand-edited value. */
  | 'MALFORMED'
  /** The HMAC does not match. The forgery case, and the only one that is an attack rather than a fault. */
  | 'BAD_SIGNATURE'
  /** Authentic, but not a shape this reader will act on: a signer bug or a compromised signer. */
  | 'BAD_PAYLOAD'
  /** The signed window is inverted, zero-length, or longer than the packet's cap. */
  | 'ILLEGAL_WINDOW'
  /** The window closed, measured on the server clock. */
  | 'EXPIRED'
  /** The cookie is valid but was presented by somebody other than the administrator it names. */
  | 'WRONG_ADMIN';

export type ImpersonationCookieVerdict =
  | { readonly ok: true; readonly state: ImpersonationState; readonly remainingMs: number }
  | { readonly ok: false; readonly reason: ImpersonationCookieRefusal };

/**
 * READ THE COOKIE, AND HONESTLY NOTHING ELSE.
 *
 * Returns `null` for every refusal, so a caller cannot accidentally treat one as a state. `readImpersonationCookie`
 * returns the REASON so that a log line can say which incident this was; the request path does not need it, and a
 * request path that branched on the reason would end up telling a client why its cookie failed.
 *
 * `actingUserId` narrows and never widens: when the caller knows who the session belongs to, a cookie naming a
 * different administrator is refused, so the cookie cannot be moved into another admin's browser. It is optional
 * because the only caller today is edge middleware, which cannot resolve a session without a database round trip it is
 * not built for; **that is a named gap and not a neutral one**, and it is closed the moment a caller can supply the id.
 */
export async function readImpersonationCookie(
  raw: string | undefined,
  secret: string | null,
  now: Millis,
  actingUserId?: string,
): Promise<ImpersonationState | null> {
  return (await inspectImpersonationCookie(raw, secret, now, actingUserId)).state;
}

/**
 * The same decision, with the reason kept. Split out so the reason has exactly one implementation — a second reader
 * that logged a different reason for the same refusal would make the log worthless for exactly the incident it exists
 * to explain.
 */
export async function inspectImpersonationCookie(
  raw: string | undefined,
  secret: string | null,
  now: Millis,
  actingUserId?: string,
): Promise<{
  readonly state: ImpersonationState | null;
  readonly reason: ImpersonationCookieRefusal | null;
}> {
  if (raw === undefined || raw === '') return { state: null, reason: 'NO_COOKIE' };
  // BEFORE THE BYTES ARE TOUCHED. An unconfigured deployment must not even parse, because a parse is work done on
  // behalf of whoever sent the cookie, and the answer here would be "no impersonation" regardless of what it said.
  if (secret === null || secret.length < IMPERSONATION_SECRET_MIN_BYTES) {
    return { state: null, reason: 'NO_SECRET' };
  }

  const separator = raw.indexOf('.');
  if (separator < 0) return { state: null, reason: 'MALFORMED' };
  const presented = raw.slice(0, separator);
  const encoded = raw.slice(separator + 1);
  if (!HEX_SHA256.test(presented)) return { state: null, reason: 'MALFORMED' };
  const material = fromBase64Url(encoded);
  if (material === null) return { state: null, reason: 'MALFORMED' };

  /**
   * CONSTANT TIME, ACCUMULATING THE DIFFERENCE AND BRANCHING ONCE.
   *
   * Copied from `verifyEvidenceBatch` (`evidence.ts:776-791`), which copied it from `verifyReceiptSignature` — the
   * third hand-written copy in this repository, named here so that a fourth reader knows to copy rather than invent.
   * `charCodeAt` rather than `Buffer` for the reason given above: this module is edge-loaded.
   */
  const expected = await hmacSha256(material, secret);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) return { state: null, reason: 'BAD_SIGNATURE' };

  const state = parseSignedMaterial(material);
  if (state === null) return { state: null, reason: 'BAD_PAYLOAD' };

  /**
   * THE HARD CAP IS RE-CHECKED HERE, AT THE POINT OF USE, AND NOT ONLY AT THE POINT OF ISSUE.
   *
   * `startImpersonation` already refuses to hand out more than `IMPERSONATION_LIMIT`. Re-deriving the bound from the
   * signed fields means a signer that was wrong — a future caller passing a longer window, a clock that made
   * `expiresAt` wrong, a key that leaked and was used to mint one — still cannot produce an impersonation that
   * outlives the packet's argument. A cap that is only enforced where the cap is set is enforced against nobody.
   */
  const window = state.expiresAt - state.startedAt;
  if (window <= 0 || window > IMPERSONATION_LIMIT) return { state: null, reason: 'ILLEGAL_WINDOW' };

  if (actingUserId !== undefined && state.byUserId !== actingUserId) {
    return { state: null, reason: 'WRONG_ADMIN' };
  }
  // The server clock, never anything the request said. See `guardImpersonatedRequest`.
  if (now >= state.expiresAt) return { state: null, reason: 'EXPIRED' };

  return { state, reason: null };
}

/** What a caller of the gate may supply. Declared so the gate's own signature cannot drift away from this list. */
export interface ImpersonatedRequestInput {
  readonly method: HttpMethod;
  /** The raw cookie value, or `undefined` when the browser sent no such cookie. */
  readonly rawCookie: string | undefined;
  /**
   * The signing secret, or `null` when none is configured.
   *
   * `null` is a refusal and never a default. A constant fallback key would mean every deployment in the world shares
   * one, so a cookie lifted from a staging browser would be honoured in production and nothing would look wrong until it
   * was exploited.
   */
  readonly secret: string | null;
  /**
   * **THERE IS NO `now` HERE, AND ITS ABSENCE IS THE CONTROL.**
   *
   * The instant the window is measured against is read from the injected `clock`, which on a server is the host clock
   * and in a test is a `FrozenClock`. A parameter that a request could name is a parameter this repository has already
   * got wrong once: `apps/web/src/middleware.ts` read `Date.parse(req.headers.get('x-now'))` and passed it here, which
   * let the bearer of a cookie decide when its own read-only window ended — and because the comparison is
   * `now >= expiresAt`, a `x-now` in the far future made the window look CLOSED and every write was permitted. A
   * client clock in this position fails **open**, which is the direction that turns a read-only guarantee into no
   * guarantee at all. With no such parameter, the wiring that had that defect does not compile.
   */
  readonly clock: Clock;
  /** The user the current session belongs to, when the caller knows. Narrows; see `inspectImpersonationCookie`. */
  readonly actingUserId?: string;
}

/**
 * THE GATE AS A REQUEST PATH CALLS IT: the cookie, the secret, and a clock — and nothing else.
 *
 * This is the entry point that makes TM-03's gate reachable, and it is deliberately shaped so that the two ways the
 * gate was inert cannot come back as wiring mistakes:
 *
 *   · **the state comes from a verified cookie**, so an unsigned or edited one grants nothing;
 *   · **the time comes from an injected clock**, so nothing the request carries can move the window.
 *
 * Every refusal degrades to `{ allowed: true, impersonating: false }` — the admin's own session, ungated — which is
 * the same behaviour the inert gate had and the direction this repository argues for at every other boundary: a
 * feature that stopped being enforced is recoverable, a boundary that opened is not. Nothing here is more permissive
 * than refusing.
 */
export async function guardImpersonatedRequest(
  input: ImpersonatedRequestInput,
): Promise<RequestVerdict> {
  // ONE reading of the clock, used for both questions. Two readings of the same clock a microsecond apart would mean
  // the cookie could verify as live and the window could close between the two, which is a race with no attacker in it.
  const now = input.clock.now();
  const cookie = await inspectImpersonationCookie(
    input.rawCookie,
    input.secret,
    now,
    input.actingUserId,
  );
  return guardRequest({ method: input.method, state: cookie.state, now });
}

/**
 * Cookie attributes for setting one, so no call site invents them.
 *
 * `maxAge` is clamped to the window rather than to the cookie's own lifetime: a cookie that outlives its impersonation
 * keeps being presented on every request, and each presentation is work done to discover it has expired. It is a
 * tidiness measure rather than a security one — `inspectImpersonationCookie` refuses an expired cookie whatever the
 * browser did with it — and it is here because an attribute set invented at a call site is an attribute set nobody
 * reviews.
 */
export function impersonationCookieOptions(
  state: ImpersonationState,
  now: Millis,
): typeof IMPERSONATION_COOKIE & { readonly maxAge: number } {
  return {
    ...IMPERSONATION_COOKIE,
    maxAge: Math.max(0, Math.floor((state.expiresAt - now) / 1_000)),
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
