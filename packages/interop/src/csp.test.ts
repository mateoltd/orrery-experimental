/**
 * The sim-origin CSP, checked against `B6` directive by directive.  (P6-T6)
 *
 * ## WHY THIS FILE IS FOUR SEPARATE TESTS AND NOT ONE
 *
 * `B6` records that the first draft of this policy was "wrong in three independent ways and **would
 * have prevented every simulation from loading**". Each correction is a test, because:
 *
 *  - the failure mode for all four is an EMPTY BOX, which looks like a rendering bug;
 *  - a reviewer changing one directive needs to know it is load-bearing;
 *  - a single `expect(policy).toContain(...)` over a whole string would pass for the wrong reason, which
 *    is how the `default-src` error survived a draft in the first place.
 */
import { describe, expect, it } from 'vitest';
import {
  appOriginHeaders,
  CAPABILITY_DENIALS,
  checkCsp,
  simOriginCsp,
  simOriginHeaders,
  simOriginPermissionsPolicy,
} from './csp.js';

const ORIGINS = { appOrigin: 'https://app.example', simOrigin: 'https://sims.example' } as const;
const POLICY = simOriginCsp(ORIGINS);

const directive = (name: string): string | undefined =>
  POLICY.split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

describe('B6 correction 1: default-src none blocked the sim STYLESHEET', () => {
  it('style-src names the sim origin, because every manifest declares `styles`', () => {
    expect(directive('style-src')).toBe('style-src https://sims.example');
    // Without it, `default-src 'none'` catches the stylesheet and every sim renders unstyled — and
    // because the bundle still runs, the page looks alive.
    expect(directive('style-src')).not.toBe("style-src 'none'");
  });

  it('font-src and img-src are present too, so a data-URI image or a webfont is not blocked', () => {
    expect(directive('img-src')).toBe('img-src https://sims.example data:');
    expect(directive('font-src')).toBe('font-src https://sims.example');
  });
});

describe('B6 correction 2: script-src self does not match an opaque origin', () => {
  it('script-src names an EXPLICIT host, not self', () => {
    // Per CSP3, `'self'` resolves against the frame's OPAQUE origin — which has no host — and matches
    // nothing. So `script-src 'self'` blocks the BUNDLE, and the symptom is an empty box with a CSP
    // error in a console the student never opens.
    expect(directive('script-src')).toBe('script-src https://sims.example');
    expect(directive('script-src')).not.toContain("'self'");
  });

  it("'self' would be wrong for every frame we mount, and the check says so", () => {
    const broken = simOriginCsp({
      appOrigin: ORIGINS.appOrigin,
      simOrigin: ORIGINS.simOrigin,
    }).replace('script-src https://sims.example', "script-src 'self'");
    expect(checkCsp(broken, ORIGINS).some((p) => p.directive === 'script-src' && !p.ok)).toBe(true);
  });
});

describe('B6 correction 3 and the rest of the policy', () => {
  it('default-src is none, and connect-src is none', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
    // `connect-src 'none'` is the load-bearing half of "no network": a sim cannot `fetch()` even its
    // own origin, so there is nowhere for a state to be exfiltrated to.
    expect(directive('connect-src')).toBe("connect-src 'none'");
  });

  it('form-action and base-uri are none', () => {
    expect(directive('form-action')).toBe("form-action 'none'");
    // `base-uri 'none'` because a `<base>` tag lets a sim rewrite every relative URL in its own
    // document, which is a quiet way to escape the intended script origin.
    expect(directive('base-uri')).toBe("base-uri 'none'");
  });

  it('frame-ancestors names the APP origin, and only the app origin', () => {
    expect(directive('frame-ancestors')).toBe('frame-ancestors https://app.example');
  });

  it('no unsafe-inline and no unsafe-eval ANYWHERE, because a sim is untrusted code', () => {
    expect(POLICY).not.toMatch(/unsafe-inline/u);
    expect(POLICY).not.toMatch(/unsafe-eval/u);
    // And the checker is not satisfied by a policy that merely lacks them in the usual place.
    const bad = POLICY.replace(
      'script-src https://sims.example',
      "script-src https://sims.example 'unsafe-eval'",
    );
    const problems = checkCsp(bad, ORIGINS);
    expect(problems.some((p) => p.problem.includes('permits eval'))).toBe(true);
  });

  it('the sim origin is NOT trusted for scripts from the app origin', () => {
    // A script-src listing the app origin would let a sim bundle the app's own scripts and read them
    // through the frame. The check refuses it whatever else is right.
    const bad = POLICY.replace(
      'script-src https://sims.example',
      'script-src https://sims.example https://app.example',
    );
    expect(checkCsp(bad, ORIGINS).some((p) => p.problem.includes('trusts the app origin'))).toBe(
      true,
    );
  });

  it('the whole policy passes its own checker', () => {
    expect(checkCsp(POLICY, ORIGINS)).toEqual([]);
  });
});

describe('B6 correction 4: CORP is on the APP origin, and the two origins DISAGREE on purpose', () => {
  it('the sim origin sends cross-origin, because same-origin makes the frame unloadable', () => {
    // The most confusing possible symptom of a header that looks correct: an empty frame.
    expect(simOriginHeaders(ORIGINS)['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  it('the app origin sends same-origin, because that is where it protects anything', () => {
    expect(appOriginHeaders()['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('the sim origin header set carries the REAL CSP, not a placeholder', () => {
    // The first version of `simOriginHeaders` carried the literal string
    // 'none-of-this-is-set-here', which a server spreading the object would have shipped.
    const headers = simOriginHeaders(ORIGINS);
    expect(headers['Content-Security-Policy']).toBe(POLICY);
    expect(headers['Permissions-Policy']).toBe(simOriginPermissionsPolicy());
    // And the content-hashed bundles really are immutable for a year, which is why the build hashes
    // filenames.
    expect(headers['Cache-Control']).toMatch(/immutable/u);
  });

  it('the app origin sets COOP, or a framed page can navigate the student away from the exam', () => {
    expect(appOriginHeaders()['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });
});

describe('Permissions-Policy', () => {
  it('denies every capability explicitly, rather than relying on a browser default', () => {
    const policy = simOriginPermissionsPolicy();
    for (const denied of [
      'camera',
      'microphone',
      'geolocation',
      'display-capture',
      'payment',
      'usb',
    ]) {
      expect(policy, `${denied} is not denied`).toContain(`${denied}=()`);
    }
  });

  it('denies NOTHING with `*`, which would grant every capability including future ones', () => {
    expect(simOriginPermissionsPolicy()).not.toMatch(/=\(\*\)/u);
    expect(simOriginPermissionsPolicy()).not.toMatch(/self/u);
  });
});

describe('the capability table the conformance suite walks', () => {
  it('names all four promises and the MECHANISM for each', () => {
    // A table rather than prose, because the conformance suite enumerates it — and because a reader
    // removing a control needs to see what it was holding up.
    expect(CAPABILITY_DENIALS).toHaveLength(4);
    for (const denial of CAPABILITY_DENIALS) {
      expect(denial.capability.length).toBeGreaterThan(10);
      expect(denial.enforcedBy.length).toBeGreaterThan(20);
    }
  });

  it('the DOM one is enforced by the opaque origin, which is the SANDBOX not the CSP', () => {
    // Worth being precise about: `default-src 'none'` does NOT stop a sim reading our DOM. The
    // sandbox attribute does. Attributing it to the CSP would make a future reader weaken the sandbox.
    const dom = CAPABILITY_DENIALS.find((d) => d.capability.includes('DOM'));
    expect(dom?.enforcedBy).toMatch(/OPAQUE origin/u);
    expect(dom?.enforcedBy).not.toMatch(/Content-Security-Policy/u);
  });
});

describe('deriving origins rather than pasting them', () => {
  it('a staging sim origin produces a staging policy, because nobody re-pastes headers', () => {
    const staging = simOriginCsp({
      appOrigin: 'https://staging.app.example',
      simOrigin: 'https://staging.sims.example',
    });
    expect(staging).toContain('script-src https://staging.sims.example');
    expect(staging).toContain('frame-ancestors https://staging.app.example');
    // A pasted policy would still say `app.example` here, and would block the product while appearing
    // to be configured.
    expect(staging).not.toContain('script-src https://sims.example\n');
  });

  it('a TRAILING SLASH does not double up, which produces a policy that silently does not match', () => {
    const sloppy = simOriginCsp({
      appOrigin: 'https://app.example/',
      simOrigin: 'https://sims.example/',
    });
    expect(sloppy).toBe(POLICY);
    expect(sloppy).not.toMatch(/example\/\//u);
  });

  it('the same-origin case still works, because a local dev server has no second origin', () => {
    const local = simOriginCsp({
      appOrigin: 'http://localhost:3000',
      simOrigin: 'http://localhost:3001',
    });
    expect(local).toContain('script-src http://localhost:3001');
    expect(
      checkCsp(local, { appOrigin: 'http://localhost:3000', simOrigin: 'http://localhost:3001' }),
    ).toEqual([]);
  });
});
