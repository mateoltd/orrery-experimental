/**
 * The sim origin's Content-Security-Policy, exactly.  (`B6`, `P6-T6`)
 *
 * ## THE POLICY IS A FUNCTION, NOT A STRING, BECAUSE FOUR THINGS IN IT ARE EARNED
 *
 * Every origin in this policy is derived from the two configured origins rather than pasted in. A
 * pasted policy is a policy that will still say `app.example` after someone points `APP_URL` at a
 * staging host — and a CSP that names the wrong host is a CSP that blocks the product while appearing
 * to be configured.
 *
 * ## `B6`: THE FIRST DRAFT WAS WRONG IN FOUR INDEPENDENT WAYS AND WOULD HAVE PREVENTED EVERY SIM
 *
 * FROM LOADING. Each is corrected here and each has a test, because a comment about a security header
 * is not a control over one.
 *
 * 1. **`default-src 'none'` ALONE BLOCKED THE SIM'S OWN STYLESHEET.** Every manifest declares
 *    `styles: './style.css'`, so with only `default-src` every simulation rendered unstyled. Hence the
 *    explicit `style-src`.
 * 2. **`script-src 'self'` DOES NOT MATCH AN OPAQUE ORIGIN.** The frame has no `allow-same-origin`,
 *    so per CSP3 `'self'` resolves against an opaque origin and matches nothing — the BUNDLE was
 *    blocked too. Hence an explicit host.
 * 3. **NO `img-src`/`font-src`**, so any data-URI image or webfont was blocked. Both are present.
 * 4. **`Cross-Origin-Resource-Policy: same-origin` ALSO FAILS FOR AN OPAQUE-ORIGIN FRAME.** CORP
 *    belongs on the APP origin; the sim origin sends `cross-origin`. Getting this backwards makes the
 *    frame unloadable, which is the most confusing possible symptom of a header that looks correct.
 *
 * ## WHAT `INV-SIM-1` ACTUALLY GUARANTEES, STATED HONESTLY
 *
 * The plan's claim of "no network" is weakened here rather than restated: CSP does not cover WebRTC
 * ICE/STUN, `<a ping>`, or DNS prefetch. The guarantee we can make is **"no same-origin reach and no
 * CSP-permitted egress"**, and that is what this file implements and what `cspCovers()` asserts.
 */

export interface SimOrigins {
  /** The app origin, e.g. `https://app.example`. The frame is a child of THIS document. */
  readonly appOrigin: string;
  /** The dedicated static origin the bundle is served from, e.g. `https://sims.example`. */
  readonly simOrigin: string;
}

const stripTrailingSlash = (origin: string): string => origin.replace(/\/+$/u, '');

/**
 * The exact policy from `plans/03` §1, with every origin derived.
 *
 * No `unsafe-inline` anywhere, and no `unsafe-eval`: a sim is a third-party program inside a student's
 * exam, and either of those would hand it the ability to run code the host never wrote. `wasm-unsafe-eval`
 * is deliberately ABSENT too — `astronomy.orrery` (gold sim 24) needs WebGL, not `eval`, and if a future
 * sim genuinely requires WASM compilation the header changes in a reviewable commit.
 */
export function simOriginCsp(origins: SimOrigins): string {
  const sim = stripTrailingSlash(origins.simOrigin);
  const app = stripTrailingSlash(origins.appOrigin);
  return [
    "default-src 'none'",
    `script-src ${sim}`,
    `style-src ${sim}`,
    `img-src ${sim} data:`,
    `font-src ${sim}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // The frame may only be embedded BY the app origin. A sim origin that could be framed by anybody
    // would let a phishing page mount our sim inside a page that looks like ours.
    `frame-ancestors ${app}`,
  ].join('; ');
}

/**
 * `Permissions-Policy` for the sim origin. Every capability off, explicitly.
 *
 * Explicit rather than relying on a default: a browser adding a feature should find it denied here
 * rather than granted to every simulation retroactively.
 */
export function simOriginPermissionsPolicy(): string {
  return [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'display-capture=()',
    // Not in the plan's list, and worth adding: a sim that can open windows is a sim that can run a
    // convincing login form on our origin's behalf.
    'payment=()',
    'usb=()',
    'serial=()',
    'bluetooth=()',
    'hid=()',
  ].join(', ');
}

/**
 * The app origin's headers. CORP lives HERE, and this is correction 4.
 *
 * `Cross-Origin-Resource-Policy: same-origin` on the APP origin says "do not load my documents into a
 * frame that is not same-origin" — which is a no-op for our own sim frames, because they are cross-origin
 * by construction. What it actually buys is protection against an unknown site framing US.
 *
 * `Cross-Origin-Opener-Policy: same-origin` goes with it: without it, `window.opener` lets a framed
 * page navigate our tab, which defeats the exam-path rule that a student's session cannot be steered.
 */
export function appOriginHeaders(): Readonly<Record<string, string>> {
  return {
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * The sim origin's own headers: CORP `cross-origin`, which is the opposite of the app's, on purpose.
 *
 * The CSP and Permissions-Policy are here TOO rather than only being available: a static origin's
 * server config should be able to spread this object and be correct, and the first version of this
 * function carried a placeholder string for the CSP -- a header that would have shipped, silently
 * overriding whatever the server actually sent.
 */
export function simOriginHeaders(origins: SimOrigins): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': simOriginCsp(origins),
    'Permissions-Policy': simOriginPermissionsPolicy(),
    // Correction 4. `same-origin` here would make the frame unloadable, and the symptom — an empty
    // box — looks like a rendering bug rather than a header problem.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    // The bundle is content-hashed and immutable for a year, which is the whole reason the build
    // hashes filenames.
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
}

/** The directives `B6` requires, as a machine-checkable list rather than as a sentence. */
export const REQUIRED_DIRECTIVES = [
  "default-src 'none'",
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'frame-ancestors',
] as const;

export interface CspCheck {
  readonly ok: boolean;
  readonly directive: string;
  readonly problem: string;
}

/**
 * Check a policy against what `B6` requires. Exported so a test — and a future header review — reads
 * the requirement rather than the implementation.
 */
export function checkCsp(policy: string, origins: SimOrigins): CspCheck[] {
  const problems: CspCheck[] = [];
  const sim = stripTrailingSlash(origins.simOrigin);
  const app = stripTrailingSlash(origins.appOrigin);
  const directives = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    directives.set(name, trimmed);
  }

  const require_ = (directive: string, expected?: string): void => {
    const actual = directives.get(directive);
    if (actual === undefined) {
      problems.push({ ok: false, directive, problem: `${directive} is missing` });
      return;
    }
    if (expected !== undefined && actual !== expected) {
      problems.push({ ok: false, directive, problem: `${actual} should be ${expected}` });
    }
  };

  require_('default-src', "default-src 'none'");
  require_('script-src', `script-src ${sim}`);
  require_('style-src', `style-src ${sim}`);
  require_('img-src', `img-src ${sim} data:`);
  require_('font-src', `font-src ${sim}`);
  require_('connect-src', "connect-src 'none'");
  require_('form-action', "form-action 'none'");
  require_('base-uri', "base-uri 'none'");
  require_('frame-ancestors', `frame-ancestors ${app}`);

  // `unsafe-inline` and `unsafe-eval` anywhere are a refusal regardless of which directive carries
  // them, because a sim is untrusted code running inside a student's exam.
  for (const [name, value] of directives) {
    if (value.includes('unsafe-inline')) {
      problems.push({
        ok: false,
        directive: name,
        problem: `${value} permits inline script or style`,
      });
    }
    if (value.includes('unsafe-eval')) {
      problems.push({ ok: false, directive: name, problem: `${value} permits eval` });
    }
    // And the sim origin must not be able to name the APP origin: that would let a sim bundle the
    // app's own scripts and read them through the frame.
    if (name.startsWith('script-src') && value.includes(app)) {
      problems.push({
        ok: false,
        directive: name,
        problem: `${value} trusts the app origin for scripts`,
      });
    }
  }

  return problems;
}

/**
 * The four capabilities `plans/10` §2.1 promises a sim cannot reach, and how each is enforced.
 *
 * Deliberately a table rather than prose, because the conformance suite walks it: each entry names the
 * mechanism, so a future reader can tell which control they would be weakening if they removed it.
 */
export interface CapabilityDenial {
  readonly capability: string;
  readonly enforcedBy: string;
}

export const CAPABILITY_DENIALS: readonly CapabilityDenial[] = [
  {
    capability: 'read the app DOM',
    enforcedBy: 'the frame is a unique OPAQUE origin: `sandbox` without `allow-same-origin`',
  },
  {
    capability: "read the app's cookies, localStorage or IndexedDB",
    enforcedBy: 'the opaque origin — and `localStorage` throws inside it, which the suite asserts',
  },
  {
    capability: 'fetch the app with the student credentials',
    enforcedBy: "connect-src 'none' on the sim origin, and the frame being cross-origin",
  },
  {
    capability: 'navigate, open windows, or read the clipboard',
    enforcedBy:
      'no `allow-top-navigation`, no `allow-popups`, no `allow-modals`; and the sim-side `PROHIBITED_APIS` list makes an attempt a `sim:error`',
  },
];
