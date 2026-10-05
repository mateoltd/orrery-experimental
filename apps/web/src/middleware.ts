import { guardRequest, type ImpersonationState } from '@orrery/auth/impersonation';
import { type NextRequest, NextResponse } from 'next/server';
import { resolveCspSimOrigin, type SimOriginEnv } from './server/csp-sim-origin';

/**
 * Per-request CSP nonce.
 *
 * ## Why this file exists
 *
 * `next.config.ts` shipped the literal string `nonce-{NONCE}` in the CSP. That is a broken
 * policy, and it is broken in the worst possible direction:
 *
 *   · `'nonce-{NONCE}'` is not a valid nonce, so no script carries it.
 *   · Because `strict-dynamic` is present, a CSP3 browser **ignores the host-source
 *     expressions** — so `'self'` is discarded too.
 *   · The result is a policy that blocks *every* script on the page, including Next's own
 *     runtime hydration.
 *
 * Found by RUNNING the container and reading the response headers. No build, no test and
 * no review had caught it, because the header was syntactically valid and only wrong at
 * runtime. It is the same shape as every other gate that was vacuous until something
 * actually exercised it (`D-31`, `D-35`, and the bundle gate that never measured a build).
 *
 * ## The correct shape
 *
 * A nonce is only meaningful if it is fresh per response and present on the scripts it
 * authorises. So: generate here, put it in the header, and expose it to the app through
 * the request so `<Script nonce={…}>` can echo it. A static header cannot do this, which is
 * why the policy lives in two places and both must be kept in step.
 */

/**
 * Read the impersonation state from the server-signed cookie.
 *
 * Returns null unless the cookie is PRESENT AND VALID. A tampered or absent cookie is "no
 * impersonation", which means the request is treated as the admin's own — the safe direction,
 * because a broken cookie degrades to a normal session rather than to an untracked one.
 */
function readImpersonation(req: NextRequest): ImpersonationState | null {
  const raw = req.cookies.get(IMPERSONATION_COOKIE)?.value;
  if (!raw) return null;
  // TODO(signed-cookie): verify the signature. Deliberately returns null until it does, so an
  // unsigned cookie cannot GRANT an impersonation. Refusing to parse unverified input is the
  // only safe behaviour; the alternative — parse and hope — is a privilege escalation.
  return null;
}

/** Matches SESSION_COOKIE's prefix rule; `__Host-` means the browser enforces the scope. */
const IMPERSONATION_COOKIE = '__Host-orrery-impersonating';

/** Routes that must not be treated as document requests. */
const isDocument = (req: NextRequest): boolean => {
  // `Sec-Fetch-Dest: document` is the reliable signal for a top-level navigation. It is not
  // sent by every client, so fall back to the method.
  const dest = req.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  return req.method === 'GET';
};

export function middleware(req: NextRequest) {
  /**
   * The impersonation gate runs FIRST, before the CSP, before the route table, before
   * `can()`.  (P1-T10)
   *
   * The ordering is the design rather than an accident. A check that ran after authorisation
   * could be satisfied by a role the impersonated user holds; a check that runs before it
   * cannot be satisfied at all. And it lives in middleware rather than in each route because a
   * per-route check is a check that eventually gets forgotten, and the route it is forgotten
   * on is the one nobody wrote a test for.
   *
   * The state is read from a cookie the SERVER signs. It is not read from a header the client
   * sets: a header would be a flag the impersonating browser controls, which is the opposite of
   * the guarantee.
   */
  const impersonation = readImpersonation(req);
  const verdict = guardRequest({
    method: req.method,
    state: impersonation,
    now: Date.parse(req.headers.get('x-now') ?? '') || 0,
  });
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: { code: verdict.code, message: verdict.message } },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!isDocument(req)) return NextResponse.next();

  // `crypto.randomUUID` is available in the edge runtime. 122 bits of entropy, base64'd
  // below — comfortably more than a CSP nonce needs.
  const nonce = btoa(crypto.randomUUID());

  /**
   * THE VALIDATED VARIABLE, AND IT IS `SIM_ORIGIN`.  (`P14-T13`)
   *
   * This read `SIMS_ORIGIN` — one letter different from the name `packages/config` validates — so the CSP has been
   * allowing a hardcoded `localhost:4400` in production and never the reviewed origin. See `server/csp-sim-origin.ts`.
   */
  const isDev = process.env.NODE_ENV !== 'production';
  const simOrigin = resolveCspSimOrigin(process.env as SimOriginEnv);
  /**
   * OMITTED, NOT DEFAULTED, WHEN IT CANNOT BE TRUSTED. A missing configuration must cost a feature rather than a
   * boundary, so an untrusted origin leaves `frame-src`/`connect-src` with `'self'` alone and the sandbox simply
   * does not load.
   */
  const simsOrigin = simOrigin.origin === null ? '' : ` ${simOrigin.origin}`;
  if (simOrigin.refusal !== null && process.env.NODE_ENV === 'production') {
    // Loud in production, silent in development, and it never reveals the value.
    console.warn(`[csp] SIM_ORIGIN refused (${simOrigin.refusal}); simulation frames are blocked`);
  }

  const csp = [
    "default-src 'self'",
    // `strict-dynamic` makes the nonce the ONLY thing that authorises a script in a modern
    // browser. `'self'` stays for older browsers that do not implement it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Tailwind and KaTeX inject inline styles; a style nonce is not worth the complexity.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The sim origin, and ONLY the sim origin. This is what stops a sandboxed sim frame —
    // or an injected script — from calling our API with a student's cookies.
    `frame-src 'self'${simsOrigin}`,
    `connect-src 'self'${simsOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(req.headers);
  // The app reads this to place `nonce` on its own <script> tags. Header names are
  // lower-cased by the Headers API, so the app must read it lower-case too.
  requestHeaders.set('x-csp-nonce', nonce);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  // Skip static assets. A nonce on a CSS file is pointless and costs a UUID per request.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};
