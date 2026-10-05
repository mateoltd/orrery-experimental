/**
 * THE ONE ORIGIN THE CSP IS ALLOWED TO TRUST, RESOLVED — AND REFUSED WHEN IT CANNOT BE TRUSTED.  (`P14-T13`)
 *
 * ## THE DEFECT THIS EXISTS TO FIX
 *
 * `middleware.ts` read **`SIMS_ORIGIN`**. `packages/config` validates **`SIM_ORIGIN`** — it *requires* it, and it
 * refuses one sharing a host with `APP_URL`, which is the whole sandbox argument (`env.test.ts:96-114`).
 *
 * **The two names differ by one letter, so the CSP was never using the validated value.** It used
 * `SIMS_ORIGIN` — which nothing validates and no compose file sets — and otherwise fell back to a hardcoded
 * `http://localhost:4400`. So in every real configuration the CSP allowed a hardcoded localhost instead of the
 * reviewed simulation origin: sims break against production, and the one origin the sandbox argument rests on was
 * never the one in the policy.
 *
 * This is the exact class of defect a property asserted in a comment cannot catch, and it was found by a threat
 * model rather than by a test — which is worth noting, because the obvious test ("does the CSP contain the sim
 * origin?") passed for years while proving nothing about *which* variable supplied it.
 *
 * ## WHY IT FAILS CLOSED
 *
 * Two tempting alternatives, both rejected:
 *
 * · **Keep a fallback.** A default that is wrong in production either widens the sandbox or breaks it, and the
 *   symptom is a broken page rather than a loud failure.
 * · **Fall back to `APP_URL`'s host.** That defeats the separation the variable exists to express.
 *
 * So an origin that cannot be trusted is **omitted** from `frame-src`/`connect-src`. Sandbox blocks the simulation
 * frame; the API is still `'self'`-restricted; **nothing about the rest of the policy loosens.** A missing
 * configuration should cost a feature, not a boundary.
 */

export interface SimOriginEnv {
  readonly NODE_ENV?: string | undefined;
  readonly SIM_ORIGIN?: string | undefined;
  readonly APP_URL?: string | undefined;
}

/** Why a candidate origin was refused. Every case names the variable, because the bug WAS a variable name. */
export type SimOriginRefusal =
  | 'UNSET'
  | 'NOT_ABSOLUTE'
  | 'NOT_HTTP'
  | 'SAME_HOST_AS_APP'
  | 'UNPARSEABLE';

export interface SimOriginResolution {
  /**
   * `null` means "omit it from the CSP". It is deliberately NOT a default and NOT a sentinel string, because a
   * default here is a policy decision made by a fallback rather than by a person.
   */
  readonly origin: string | null;
  readonly refusal: SimOriginRefusal | null;
}

/** The development default, and it is ONLY ever the development default. */
const DEV_SIM_ORIGIN = 'http://localhost:4400';

/**
 * `new URL` accepts `javascript:`, `data:` and `file:`, none of which may appear in a CSP source list. Comparing the
 * PARSED protocol against an allow-list is what makes this safe; a `startsWith('http')` check would admit
 * `http-evil:`-style confusions and would not catch a bare `javascript:` at all.
 */
const isHttp = (protocol: string): boolean => protocol === 'http:' || protocol === 'https:';

/**
 * REFUSE A SIM ORIGIN THAT SHARES A HOST WITH THE APP.
 *
 * This mirrors `parseEnv`'s rule rather than reinventing it, and it is the check that makes the sandbox mean
 * anything: if a framed simulation shares the app's origin, then `frame-src 'self'` already permits it and the
 * distinction between app and simulation — the whole reason `SIM_ORIGIN` is required at all — disappears.
 *
 * `hostname` and not `host`, so `app.example:8443` and `app.example:9999` are correctly recognised as one host. The
 * port is not part of the boundary.
 */
const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const resolveCspSimOrigin = (env: SimOriginEnv): SimOriginResolution => {
  const isDev = env.NODE_ENV !== 'production';
  const raw = env.SIM_ORIGIN?.trim();

  if (raw === undefined || raw === '') {
    if (isDev) return { origin: DEV_SIM_ORIGIN, refusal: null };
    // Production with no configured origin: omit it. This is the fail-closed branch, and it is the whole point.
    return { origin: null, refusal: 'UNSET' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { origin: null, refusal: 'UNPARSEABLE' };
  }

  if (!isHttp(parsed.protocol)) return { origin: null, refusal: 'NOT_HTTP' };
  if (parsed.hostname === '') return { origin: null, refusal: 'NOT_ABSOLUTE' };

  const appHost = env.APP_URL === undefined ? null : hostOf(env.APP_URL);
  if (appHost !== null && appHost === parsed.hostname.toLowerCase()) {
    return { origin: null, refusal: 'SAME_HOST_AS_APP' };
  }

  /**
   * THE CANONICAL FORM, NOT THE STRING THE OPERATOR TYPED.
   *
   * `SIM_ORIGIN=https://sims.example:443` and `SIM_ORIGIN=https://sims.example` are the same origin to a browser
   * but different strings here, so a trailing slash or an explicit default port would produce a source the
   * browser treats as distinct from the one the operator intended. Passing the operator's literal string through
   * would make the CSP's idea of the origin differ from the browser's, which is the same class of bug as the
   * variable name.
   */
  return { origin: parsed.origin, refusal: null };
};

/**
 * THE OLD NAME, DETECTED ONLY SO THE OPERATOR CAN BE TOLD WHY THEY GOT NO SIM ORIGIN.
 *
 * `SIMS_ORIGIN` is **not** honoured — doing so would reintroduce exactly the defect above, and "we accept the typo'd
 * name as well" is how a typo'd name outlives its fix, because a deployment that works stops being the one that has
 * to be fixed.
 *
 * It is detected purely so the caller can explain itself. An operator who set `SIMS_ORIGIN` and finds no sim origin
 * in the CSP should be told the variable name rather than left to guess, which is the difference between a
 * five-minute fix and an afternoon of reading CSP headers.
 */
export const mistypedSimOriginVariablePresent = (
  env: Readonly<Record<string, unknown>>,
): boolean => {
  /**
   * BRACKETED DELIBERATELY, AND THE LINTER WANTS IT DOT NOTATION.  (`P14-T13`)
   *
   * `useLiteralKeys` is right about ordinary properties and wrong here: a dot access to a name that is a TYPO of
   * another one is exactly what this whole task is about, and bracket access marks it as a string key rather than as
   * part of the interface. **A disable comment is the honest fix** -- the alternative is to rename the key into the
   * type's shape, which would have this function reading a member the resolver does not define.
   */
  // biome-ignore lint/complexity/useLiteralKeys: a typo'd variable name is a string key here, not an interface member.
  const value = env['SIMS_ORIGIN'];
  return typeof value === 'string' && value.trim() !== '';
};
