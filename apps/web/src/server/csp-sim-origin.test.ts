/**
 * `P14-T13` — the CSP's sim origin, and the variable-name defect that made it meaningless.
 *
 * **THE TEST THAT WOULD HAVE CAUGHT IT, AND DID NOT EXIST.** The obvious assertion is "the CSP contains the sim
 * origin", and that passed for as long as the defect did — because with `SIMS_ORIGIN` unset the CSP contained
 * `http://localhost:4400`, which *is* an origin, just not the reviewed one. **Asserting that an origin is present
 * cannot distinguish the right origin from a plausible wrong one**, so every test here asserts *which* value
 * supplied it, or that an untrusted origin is omitted rather than defaulted.
 */

import { describe, expect, it } from 'vitest';
import { mistypedSimOriginVariablePresent, resolveCspSimOrigin } from './csp-sim-origin';

const PROD = { NODE_ENV: 'production' } as const;
const DEV = { NODE_ENV: 'development' } as const;

describe('the validated variable is the one the CSP reads', () => {
  it("USES `SIM_ORIGIN`, and a value set only under the typo'd `SIMS_ORIGIN` is ignored entirely", () => {
    /**
     * THE DEFECT. `middleware.ts` read `SIMS_ORIGIN`; `packages/config` validates `SIM_ORIGIN`. Honouring both
     * would be worse than honouring neither, because a deployment that appears to work is the one that never gets
     * fixed -- so the typo'd name is deliberately NOT a second source of truth.
     */
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'https://sims.example' }).origin).toBe(
      'https://sims.example',
    );
    expect(
      resolveCspSimOrigin({
        ...PROD,
        SIMS_ORIGIN: 'https://attacker.example',
      } as never).origin,
    ).toBeNull();
  });

  it('reports the refusal reason when production has no configured origin', () => {
    expect(resolveCspSimOrigin(PROD)).toEqual({ origin: null, refusal: 'UNSET' });
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: '   ' }).refusal).toBe('UNSET');
  });

  it("detects the typo'd variable purely so the operator can be told why the CSP has no sim origin", () => {
    expect(mistypedSimOriginVariablePresent({ SIMS_ORIGIN: 'https://sims.example' })).toBe(true);
    expect(mistypedSimOriginVariablePresent({ SIM_ORIGIN: 'https://sims.example' })).toBe(false);
    expect(mistypedSimOriginVariablePresent({})).toBe(false);
  });
});

describe('an origin that cannot be trusted is OMITTED, not defaulted', () => {
  it('never falls back to a hardcoded localhost in production', () => {
    /**
     * THE WHOLE POINT OF THE FIX. The previous behaviour returned `http://localhost:4400` here, which is an origin
     * in the policy that nobody reviewed -- and a sandbox argument that names a hardcoded address is not a sandbox
     * argument.
     */
    const resolved = resolveCspSimOrigin(PROD);
    expect(resolved.origin).toBeNull();
    // `?? ''` rather than asserting on `null` directly: `toContain` rejects a nullish subject, and the
    // meaningful claim is "no origin reached the policy", which survives an empty string.
    expect(resolved.origin ?? '').not.toContain('localhost');
  });

  it('still defaults to localhost in DEVELOPMENT, and says why that is different', () => {
    /** A developer running `next dev` with no sim origin should get a working sandbox, not a broken page. */
    expect(resolveCspSimOrigin(DEV)).toEqual({
      origin: 'http://localhost:4400',
      refusal: null,
    });
  });

  it('refuses a sim origin sharing a host with the app, because then the sandbox means nothing', () => {
    expect(
      resolveCspSimOrigin({
        ...PROD,
        SIM_ORIGIN: 'https://app.example',
        APP_URL: 'https://app.example',
      }),
    ).toEqual({ origin: null, refusal: 'SAME_HOST_AS_APP' });
  });

  it('ignores the PORT when deciding same-host, so a different port is still the same origin-boundary breach', () => {
    /** `frame-src 'self'` is host-scoped, so `app.example:8443` vs `app.example:9999` is not a boundary. */
    expect(
      resolveCspSimOrigin({
        ...PROD,
        SIM_ORIGIN: 'https://app.example:9999',
        APP_URL: 'https://app.example:8443',
      }).refusal,
    ).toBe('SAME_HOST_AS_APP');
  });

  it('compares hosts case-insensitively', () => {
    expect(
      resolveCspSimOrigin({
        ...PROD,
        SIM_ORIGIN: 'https://SIMS.EXAMPLE',
        APP_URL: 'https://app.example',
      }).origin,
    ).toBe('https://sims.example');
  });

  it('refuses a non-HTTP scheme rather than trusting a prefix check', () => {
    /**
     * `startsWith('http')` would admit `javascript:`-adjacent confusion and would not catch a bare `javascript:`
     * at all. `new URL('javascript:alert(1)')` parses perfectly, so the parse alone is not the defence -- the
     * protocol ALLOW-LIST is.
     */
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'ftp://sims.example',
    ]) {
      const refusal = resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: bad }).refusal;
      expect(refusal, `${bad} must not reach a CSP source list`).toBe('NOT_HTTP');
    }
  });

  it('refuses an unparseable value', () => {
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'not a url' }).refusal).toBe('UNPARSEABLE');
  });
});

describe('the CSP gets the canonical origin, not the string the operator typed', () => {
  it('drops a trailing slash, so the policy cannot disagree with the browser about what the origin is', () => {
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'https://sims.example/' }).origin).toBe(
      'https://sims.example',
    );
  });

  it('drops an explicit default port, which a browser treats as the same origin', () => {
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'https://sims.example:443' }).origin).toBe(
      'https://sims.example',
    );
  });

  it('keeps a NON-default port, which is a genuinely different origin', () => {
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'https://sims.example:8443' }).origin).toBe(
      'https://sims.example:8443',
    );
  });

  it('works with no APP_URL at all, because an unset app origin is not a same-host breach', () => {
    expect(resolveCspSimOrigin({ ...PROD, SIM_ORIGIN: 'https://sims.example' }).origin).toBe(
      'https://sims.example',
    );
  });
});

describe('the shipped middleware cannot regress to the hardcoded fallback', () => {
  it('reads `SIM_ORIGIN` and contains no `SIMS_ORIGIN` fallback', async () => {
    /**
     * ASSERTED AGAINST THE SOURCE, because the property is about the code that ships rather than about the
     * current behaviour of the helper. A helper that is correct and a middleware that ignores it is the same
     * defect wearing a different hat.
     */
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'middleware.ts'),
      'utf8',
    );
    expect(source).toContain('resolveCspSimOrigin');
    /**
     * COMMENTS ARE STRIPPED FIRST, AND THAT IS THE POINT.
     *
     * The first version of this assertion was `not.toMatch(/localhost:4400/)` over the whole file, and it failed --
     * against the sentence in the middleware's own comment explaining that the hardcoded fallback was the bug.
     * An assertion that a reviewer satisfies by rewording a comment is not checking the code, and fixing it by
     * deleting the explanation would have been the wrong trade: the explanation is worth more than the assertion.
     */
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/localhost:4400/);
    expect(code).not.toContain('SIMS_ORIGIN');
    // And the value must come from the resolver, not from a literal in the edge function.
    expect(code).toMatch(/resolveCspSimOrigin\(/);
  });
});
