import { randomUUID } from 'node:crypto';
import { generateToken, generateTokenBytes } from '@orrery/auth/token';
import { systemClock } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import { signInFailure } from '@/features/auth/flow';
import { authLog, prismaSignInStore } from '@/server/auth/credential-store';
import { respondUniformly, type SignInDeps, signIn } from '@/server/auth/sign-in';

/**
 * `POST /api/auth/sign-in`.  (P14-T11)
 *
 * ## THE PATH `transport.ts` HAS ALWAYS CALLED
 *
 * `authTransport.signIn` posts here (`server/auth/transport.ts:48`) and this route did not exist,
 * so the sign-in page could not succeed — it called a 404. Every security property of this
 * endpoint is written down in `server/auth/sign-in.ts` and none of it lives here; this file binds
 * the injected dependencies to the process and turns an outcome into an HTTP response.
 *
 * ## WHY THE ENUMERATION DEFENCE IS NOT HERE
 *
 * Because the most reliable way to make a login form enumerate accounts is to branch on something
 * in the handler. Every failure returns `signInFailure(kind)` — one status code, one body, all
 * eight kinds — and every response, SUCCESS INCLUDED, is held to the same wall-clock floor. A
 * floor that covered only the failures would manufacture the channel it exists to close.
 * `server/auth/sign-in.ts` argues those; `sign-in.test.ts` proves them.
 *
 * ## NO IDENTITY IS ACCEPTED FROM THE BODY
 *
 * The body carries an address and a password and nothing else. A `userId`, `role` or `sessionId`
 * in the body is ignored rather than rejected, because there is no field to read — which is a
 * stronger statement than a validation rule refusing one.
 *
 * ## A MISSING `AUTH_SECRET` IS A REFUSAL, NOT A WEAKER SIGN-IN
 *
 * `secret` keys the `Session.tokenHash` HMAC and `pepper` is mixed into every password hash. With
 * both empty, argon2 still verifies (against hashes made with an empty pepper) and the session is
 * still issued (HMAC'd with an empty key) — so the endpoint would WORK, which is exactly why it
 * must not: a key every deployment shares turns a staging dump into a production session. So an
 * absent or short secret refuses every sign-in and says so in the log, not in the response.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Matches `packages/config`'s boot-time rule and `session-user.ts`'s runtime rule. */
const MIN_SECRET_BYTES = 32;

export async function POST(request: Request): Promise<Response> {
  const deps = buildDeps(request.headers);

  // BEFORE the body is read, and with the generic failure rather than a 503. A configuration
  // error that produced a distinguishable response would turn a boot misconfiguration into an
  // enumeration oracle in its own right.
  if (deps === null) {
    authLog.error(
      'AUTH_SECRET is absent or shorter than 32 bytes; every sign-in is being refused. ' +
        'Set it before serving traffic — do not default it.',
    );
    const failure = signInFailure('wrongPassword');
    return Response.json(failure.body, { status: failure.status, headers: NO_STORE });
  }

  const body = await readBody(request);
  if (body === null) {
    // NOT the generic failure, and the difference is worth defending: a body that is not a JSON
    // object contains no address, so there is nothing about any ACCOUNT to disclose, and a 400
    // tells the caller their client is broken. `transport.ts:38` collapses it to the generic
    // string regardless, which is the right place for that decision.
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: NO_STORE },
    );
  }

  // An absent password is passed through as the empty string rather than short-circuited, so
  // "no password field" and "wrong password" cost the same argon2 verification. Short-circuiting
  // here would be a four-character enumeration oracle.
  const password = typeof body.password === 'string' ? body.password : '';
  const email = typeof body.email === 'string' ? body.email : '';

  return respondUniformly(deps, signIn(deps, { email, password }));
}

/** `null` when the process has no usable secret, which every caller must treat as "refuse". */
function buildDeps(headers: Headers): SignInDeps | null {
  const secret = process.env.AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_BYTES) return null;
  return {
    store: prismaSignInStore(getPrisma(), systemClock),
    // Two ROLES, one variable today: `config.ts:79` passes `deps.pepper` as Better Auth's
    // `secret` too. They are passed separately because collapsing them is how a future rotation of
    // one silently rotates the other and signs every student out at once.
    secret,
    pepper: secret,
    clock: systemClock,
    // A PSEUDONYM supplied by the edge, never a raw address (`config.ts:190-194`). THE HAZARD IS
    // STATED HERE RATHER THAN LEFT: nothing in this process prevents a client from setting this
    // header, so until the edge strips it the per-IP signals in `evaluateThrottle` are advisory
    // only — which is the role `throttle.ts:26-32` already assigns them. The per-IDENTIFIER limit,
    // which is the one that protects an account, is keyed on the address and cannot be bypassed
    // this way.
    ipPseudonym: edgeIpPseudonym(headers),
    mintToken: () => generateToken(generateTokenBytes()),
    mintId: () => randomUUID(),
  };
}

/** Read the edge's pseudonym, degrading to a value that fills counters rather than bypassing them. */
function edgeIpPseudonym(headers: Headers): string {
  return headers.get('x-ip-pseudonym') ?? 'unknown';
}

/** A body that is not a JSON object is a 400 rather than an exception. */
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};
