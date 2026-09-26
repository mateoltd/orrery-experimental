import { type NextRequest, NextResponse } from 'next/server';

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

/** Routes that must not be treated as document requests. */
const isDocument = (req: NextRequest): boolean => {
  // `Sec-Fetch-Dest: document` is the reliable signal for a top-level navigation. It is not
  // sent by every client, so fall back to the method.
  const dest = req.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  return req.method === 'GET';
};

export function middleware(req: NextRequest) {
  if (!isDocument(req)) return NextResponse.next();

  // `crypto.randomUUID` is available in the edge runtime. 122 bits of entropy, base64'd
  // below — comfortably more than a CSP nonce needs.
  const nonce = btoa(crypto.randomUUID());

  const simsOrigin = process.env.SIMS_ORIGIN ?? 'http://localhost:4400';
  const isDev = process.env.NODE_ENV !== 'production';

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
    `frame-src 'self' ${simsOrigin}`,
    `connect-src 'self' ${simsOrigin}`,
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
