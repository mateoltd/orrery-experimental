import type { NextConfig } from 'next';

/**
 * ADR-0014: the sim bundle origin is a SEPARATE origin, and it is what makes INV-SIM-1
 * real rather than advisory. It needs a frame-ancestors allowance from the app, and the
 * app needs `frame-src` for it. Keeping them on one origin would make the sandbox a promise.
 */
const SIMS_ORIGIN = process.env.SIMS_ORIGIN ?? 'http://localhost:4400';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // An exam never needs a camera, a microphone, geolocation, or screen capture. Not
  // "off by default" — denied, which is what makes INV-SIM-1 and ADR-0018 checkable.
  // (RN-02: facial detection is documented as disproportionately false-flagging students.)
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), display-capture=(), ' +
      'screen-wake-lock=(), usb=(), serial=(), bluetooth=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // 'strict-dynamic' with a nonce so a compromised dependency cannot inject a script.
      "script-src 'self' 'nonce-{NONCE}' 'strict-dynamic'",
      "style-src 'self' 'unsafe-inline'", // Tailwind + KaTeX inject inline styles
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      // The sim origin, and ONLY the sim origin. connect-src is what stops a sim's frame
      // (or an injected script) from calling our API with a student's cookies.
      `frame-src 'self' ${SIMS_ORIGIN}`,
      `connect-src 'self' ${SIMS_ORIGIN}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ADR-0015: Web (not Turbopack) for production builds until P0 measures otherwise.
  // Build speed is not the bottleneck; determinism and source-map quality in the exam
  // runtime are release gates.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async redirects() {
    return [
      // An exam URL must never be shareable. Catching it at the edge is cheaper than
      // relying on an unguessable attempt id, though it is still required (B7).
      { source: '/exam', destination: '/learn', permanent: false },
    ];
  },
  // Typed routes: a navigation mistake becomes a compile error rather than a 404 a student
  // discovers mid-exam. Moved out of `experimental` — Next 15.5 wants it top-level, and
  // the build told us so rather than letting it fail silently.
  typedRoutes: true,
};

export default nextConfig;
