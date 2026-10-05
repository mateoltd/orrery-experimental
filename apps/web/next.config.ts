import type { NextConfig } from 'next';

/**
 * ADR-0014: the sim bundle origin is a SEPARATE origin, and it is what makes INV-SIM-1
 * real rather than advisory. It needs a frame-ancestors allowance from the app, and the
 * app needs `frame-src` for it. Keeping them on one origin would make the sandbox a promise.
 */

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
  // NOTE: Content-Security-Policy is NOT set here. It requires a per-request nonce and is
  // therefore owned by src/middleware.ts. A static header here shipped the literal string
  // 'nonce-{NONCE}', which — with `strict-dynamic` present — makes browsers ignore 'self'
  // too, so the policy blocked every script including Next's own runtime. Two owners for
  // one header is one owner too many.
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

  /**
   * `@node-rs/argon2` IS A NATIVE MODULE, AND WEBPACK CANNOT BUNDLE IT.
   *
   * The package ships prebuilt `.node` binaries that are loaded with `require` at runtime. As
   * soon as a route handler reached `@orrery/auth/password` — which `/api/auth/sign-in` does, to
   * verify a credential — webpack tried to parse the ELF header as JavaScript and the build
   * failed with `Module parse failed: Unexpected character`. Marking the package external tells
   * Next to leave it as a runtime `require`, which is what a native addon needs: the binary is
   * resolved by Node against the platform, not copied into a bundle.
   *
   * This is not a workaround for a broken argon2. It is the difference between a KDF that runs and
   * a KDF that does not, and a silent failure here would be the worst kind: a login endpoint that
   * appears to work and does not verify anything.
   *
   * `serverExternalPackages` rather than `experimental.serverComponentsExternalPackages` because
   * Next 15.5 wants it top-level — the same move `typedRoutes` above records.
   */
  serverExternalPackages: ['@node-rs/argon2'],

  /**
   * …AND `serverExternalPackages` ALONE WAS NOT ENOUGH, WHICH IS WORTH RECORDING.
   *
   * With only the option above, the build still failed with the same ELF-header parse error. The
   * reason is the import TRACE: `@orrery/auth` is a workspace package outside this app's
   * directory, so `@node-rs/argon2` enters the graph through `packages/auth/dist/password.js`
   * rather than through this app's own `node_modules`, and the externality was not applied to that
   * path. Adding the request to `externals` directly, for the server bundle only, is what
   * actually fixed it.
   *
   * `isServer` rather than unconditional: a client bundle must still be able to see a browser
   * implementation if one is ever added, and externalising a native addon from the browser would
   * turn a build error into a runtime one.
   */
  webpack: (config, { isServer }) => {
    if (!isServer) return config;
    const externals = Array.isArray(config.externals) ? config.externals : [];
    config.externals = [
      ...externals,
      // A FUNCTION, not a string: webpack matches a string external against the request prefix, and
      // the request here is the package's resolved `index.js`, which the option above did not
      // catch. Matching on the package NAME catches every subpath and every platform binary.
      (
        { request }: { request?: string },
        callback: (error?: Error | null, result?: string) => void,
      ) => {
        if (typeof request === 'string' && /^@node-rs\/argon2/.test(request)) {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      },
    ];
    return config;
  },
};

export default nextConfig;
