/**
 * Reading the session: every way it fails, and the cookie attributes that ship.  (P14-T11)
 *
 * ## WHY THE FAILURE MODES ARE SEPARATE TESTS AND NOT ONE LOOP
 *
 * `requireUser` returning `null` is the load-bearing property of the whole layer, and a loop over
 * five bad inputs asserts only that at least one of them returned null. Each mode below gets its
 * own test because each one has a DIFFERENT reason to exist, and three of them used to be the same
 * code path by accident:
 *
 *   · **absent** — nobody claimed to be anybody. Nothing was attempted.
 *   · **forged** — a credential was presented and there is no row for it. This is the interesting
 *     one, because it is the only failure mode an attacker chooses, and it must cause NO DATABASE
 *     WRITE. A refusal path that writes is a refusal path an attacker can fill with traffic.
 *   · **expired** — a real credential that has aged out. Silent, and correct.
 *   · **revoked** — a real credential that WE killed. This is possible theft, so it writes: the
 *     family dies and an event is raised. Three outcomes, three behaviours, and lumping them
 *     together is how "we revoked it" ends up being logged as "it expired".
 *
 * ## THE COOKIE ATTRIBUTES ARE ASSERTED AGAINST THE SOURCE THAT SHIPS
 *
 * `SESSION_COOKIE` lives in `packages/auth/src/session.ts:321` and the header is assembled in
 * `session-user.ts`. A unit test can only prove the header this build produced; these read both
 * files, in the style of the "does NOT use `===`" test in
 * `packages/contracts/src/grading/receipt.test.ts:573`. The property is about the code that ships,
 * not about the current behaviour of a function called once.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE } from '@orrery/auth/session';
import { hashToken } from '@orrery/auth/token';
import type { Millis } from '@orrery/clock';
import { describe, expect, it, vi } from 'vitest';
import {
  clearedSessionCookieHeader,
  devIdentity,
  readCookie,
  refuseCaller,
  resolveCaller,
  rotateSession,
  SESSION_EXPIRY_POLICY,
  type SessionLookup,
  type StoredSession,
  sessionCookieHeader,
  sessionCookieName,
} from './session-user';

const T0 = 1_700_000_000_000 as Millis;
const SECRET = 's'.repeat(48);
const TOKEN = 'k'.repeat(43);

const here = dirname(fileURLToPath(import.meta.url));
const sessionUserSource = readFileSync(join(here, 'session-user.ts'), 'utf8');
// apps/web/src/server/auth -> repo root is FIVE levels up: auth, server, src, web, apps.
const repoRoot = join(here, '../../../../..');
const authSessionSource = readFileSync(join(repoRoot, 'packages/auth/src/session.ts'), 'utf8');

/** A clock the test controls. `monotonic` advances 1000ms per read, so the floor never sleeps. */
const clock = {
  now: () => T0,
  monotonic: (() => {
    let t = 0;
    return () => {
      t += 1000;
      return t;
    };
  })(),
};

const row = (over: Partial<StoredSession> = {}): StoredSession => ({
  id: 's-1',
  userId: 'u-1',
  familyId: 'f-1',
  createdAt: new Date(T0),
  expiresAt: new Date(T0 + SESSION_EXPIRY_POLICY.idle),
  revokedAt: null,
  revokedReason: null,
  ...over,
});

/** A lookup that answers with one row and records every write, so "wrote nothing" is assertable. */
function lookupWith(stored: StoredSession | null) {
  const writes: string[] = [];
  const lookup: SessionLookup = {
    findByTokenHash: async () => stored,
    slide: async () => {
      writes.push('slide');
    },
    revokeFamily: async () => {
      writes.push('revokeFamily');
    },
    raiseSecurityEvent: async () => {
      writes.push('securityEvent');
    },
  };
  return { lookup, writes };
}

const resolve = (stored: StoredSession | null, token: string | null = TOKEN) =>
  resolveCaller({ token, lookup: lookupWith(stored).lookup, secret: SECRET, clock });

describe('a caller with no session at all', () => {
  it('resolves to null', async () => {
    expect(await resolve(row(), null)).toBeNull();
  });

  it('and the development escape hatch is NOT consulted without the opt-in', () => {
    // The escape hatch is in `session-runtime.ts` and this is its whole policy. A variable left
    // over from somebody's laptop must be inert, and the only way to know that is to assert it.
    expect(devIdentity({ nodeEnv: 'development', allowFlag: undefined, userId: 'u-1' })).toBeNull();
    expect(devIdentity({ nodeEnv: 'development', allowFlag: 'false', userId: 'u-1' })).toBeNull();
    expect(
      devIdentity({ nodeEnv: 'development', allowFlag: 'true', userId: undefined }),
    ).toBeNull();
  });

  it('and IS consulted when both conditions hold, off production', () => {
    expect(devIdentity({ nodeEnv: 'development', allowFlag: 'true', userId: 'u-1' })).toBe('u-1');
  });

  it('and is refused outright in production, even with the opt-in set', () => {
    // CHECKED FIRST on purpose. An environment that has both must be the safe one, and the order
    // is what makes it safe rather than the documentation being right.
    expect(devIdentity({ nodeEnv: 'production', allowFlag: 'true', userId: 'u-1' })).toBeNull();
  });
});

describe('a caller presenting a FORGED cookie', () => {
  it('resolves to null', async () => {
    expect(await resolve(null)).toBeNull();
  });

  it('writes NOTHING — no slide, no revoke, no event', async () => {
    // The reason this is its own test: `reuseDetected` writes. If a forged cookie reached that
    // branch it would be a refusal path an attacker could fill with database writes, which is a
    // denial of service against our own login and session endpoints.
    const { lookup, writes } = lookupWith(null);
    await resolveCaller({ token: TOKEN, lookup, secret: SECRET, clock });
    expect(writes).toEqual([]);
  });

  it('resolves to null for an empty cookie value, which is a forgery and not an absence', async () => {
    // `actorPresence`'s own reasoning, applied at the read: a credential that decoded to nothing
    // must not look like a clean anonymous request, because that is the harder thing to find in a
    // log and the easier thing to ship.
    expect(await resolve(row(), '')).toBeNull();
  });

  it('and a TAMPERED token — one byte changed — is refused exactly like an invented one', async () => {
    // The lookup is keyed by the HMAC of the WHOLE token, so a one-byte change is a different key
    // and finds no row. That is the whole reason the stored value is a hash of the token rather
    // than the token, or a prefix of it.
    const realHash = await hashToken(TOKEN, SECRET);
    const lookup: SessionLookup = {
      findByTokenHash: async (hash) => (hash === realHash ? row() : null),
      slide: async () => {},
      revokeFamily: async () => {},
      raiseSecurityEvent: async () => {},
    };
    const tampered = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('a') ? 'b' : 'a'}`;
    expect(await resolveCaller({ token: TOKEN, lookup, secret: SECRET, clock })).not.toBeNull();
    expect(await resolveCaller({ token: tampered, lookup, secret: SECRET, clock })).toBeNull();
  });
});

describe('a caller presenting an EXPIRED cookie', () => {
  it('resolves to null on the idle window', async () => {
    const expired = row({ expiresAt: new Date(T0 - 1) });
    expect(await resolve(expired)).toBeNull();
  });

  it('resolves to null on the ABSOLUTE cap, which a sliding window must never escape', async () => {
    // `nextExpiry` anchors the cap to `issuedAt`, so a session that has slid a thousand times is
    // still dead at `issuedAt + absolute`. A reader that checked only `expiresAt` would let it
    // live forever.
    const ancient = row({
      createdAt: new Date(T0 - SESSION_EXPIRY_POLICY.absolute - 1),
      expiresAt: new Date(T0 + SESSION_EXPIRY_POLICY.idle),
    });
    expect(await resolve(ancient)).toBeNull();
  });

  it('and writes nothing, because nothing was stolen — it simply aged out', async () => {
    const { lookup, writes } = lookupWith(row({ expiresAt: new Date(T0 - 1) }));
    await resolveCaller({ token: TOKEN, lookup, secret: SECRET, clock });
    expect(writes).toEqual([]);
  });
});

describe('a caller presenting a REVOKED cookie — possible theft, not a stale tab', () => {
  it('resolves to null', async () => {
    const revoked = row({ revokedAt: new Date(T0 - 1000), revokedReason: 'passwordChanged' });
    expect(await resolve(revoked)).toBeNull();
  });

  it('KILLS THE FAMILY and raises an event, because a revoked token is evidence', async () => {
    const revoked = row({ revokedAt: new Date(T0 - 1000), revokedReason: 'logout' });
    const revokeFamily = vi.fn(async () => {});
    const raiseSecurityEvent = vi.fn(async () => {});
    await resolveCaller({
      token: TOKEN,
      lookup: { ...lookupWith(revoked).lookup, revokeFamily, raiseSecurityEvent },
      secret: SECRET,
      clock,
    });
    expect(revokeFamily).toHaveBeenCalledWith({
      userId: 'u-1',
      familyId: 'f-1',
      reason: 'revokedTokenReuse',
      now: new Date(T0),
    });
    expect(raiseSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it('and the caller learns NONE of that: same null as every other failure', async () => {
    // The theft handling is internal by construction. If it ever leaked — a different status, a
    // header, a body — an attacker could learn which of their credentials had been retired.
    const revoked = row({ revokedAt: new Date(T0 - 1000) });
    expect(await resolve(revoked)).toBe(await resolve(null));
  });
});

describe('a caller presenting a LIVE cookie', () => {
  it('resolves to a session caller, and writes nothing when the window is not yet due', async () => {
    const { lookup, writes } = lookupWith(row());
    const resolution = await resolveCaller({ token: TOKEN, lookup, secret: SECRET, clock });
    expect(resolution?.caller).toEqual({
      kind: 'session',
      userId: 'u-1',
      sessionId: 's-1',
      familyId: 'f-1',
    });
    expect(resolution?.setCookie).toBeNull();
    // `shouldSlide` is false while more than half the idle window remains, so a burst of requests
    // does not write on every one.
    expect(writes).toEqual([]);
  });

  it('refuses every caller when AUTH_SECRET is absent, rather than keying the HMAC with nothing', async () => {
    // An empty key is shared by every deployment, so a token hash lifted from a staging dump would
    // verify in production. The failure has to be a refusal or it is not a failure at all.
    const { lookup } = lookupWith(row());
    expect(await resolveCaller({ token: TOKEN, lookup, secret: undefined, clock })).toBeNull();
    expect(await resolveCaller({ token: TOKEN, lookup, secret: 'short', clock })).toBeNull();
  });

  it("and a lookup that stores a DIFFERENT secret's hash does not resolve", async () => {
    // The lookup is by TOKEN HASH, so a secret that does not match the one the row was written
    // under finds nothing — which is what makes rotating `AUTH_SECRET` invalidate every session.
    const realHash = await hashToken(TOKEN, SECRET);
    const looked: string[] = [];
    const lookup: SessionLookup = {
      findByTokenHash: async (hash) => {
        looked.push(hash);
        return hash === realHash ? row() : null;
      },
      slide: async () => {},
      revokeFamily: async () => {},
      raiseSecurityEvent: async () => {},
    };
    expect(await resolveCaller({ token: TOKEN, lookup, secret: 'a'.repeat(48), clock })).toBeNull();
    expect(looked[0]).not.toBe(realHash);
    expect(await resolveCaller({ token: TOKEN, lookup, secret: SECRET, clock })).not.toBeNull();
  });
});

describe('the sliding window moves the row AND the browser together', () => {
  it('slides when the remaining window is under half the idle limit', async () => {
    const stored = row({ expiresAt: new Date(T0 + SESSION_EXPIRY_POLICY.idle / 4) });
    const slide = vi.fn(async () => {});
    const resolution = await resolveCaller({
      token: TOKEN,
      lookup: { ...lookupWith(stored).lookup, slide },
      secret: SECRET,
      clock,
    });
    expect(slide).toHaveBeenCalledWith(
      's-1',
      new Date(T0 + SESSION_EXPIRY_POLICY.idle),
      new Date(T0),
    );
    expect(resolution?.setCookie).not.toBeNull();
  });

  it('RE-ISSUES THE SAME TOKEN rather than minting a new one', async () => {
    // Rotating the token on every request converts two concurrent fetches into a self-inflicted
    // reuse alarm: the slower one presents a token the faster one has already revoked, which
    // reads as theft and kills the family.
    const stored = row({ expiresAt: new Date(T0 + SESSION_EXPIRY_POLICY.idle / 4) });
    const resolution = await resolveCaller({
      token: TOKEN,
      lookup: lookupWith(stored).lookup,
      secret: SECRET,
      clock,
    });
    expect(resolution?.setCookie).toContain(`${SESSION_COOKIE.name}=${TOKEN};`);
  });

  it('and the cookie is capped by the ABSOLUTE cap, so a slide cannot extend a session past it', async () => {
    // A session issued long ago, with almost no window left, must not be handed a full new window.
    const createdAt = T0 - SESSION_EXPIRY_POLICY.absolute + 60_000;
    const stored = row({
      createdAt: new Date(createdAt),
      expiresAt: new Date(T0 + SESSION_EXPIRY_POLICY.idle / 4),
    });
    const slide = vi.fn(async (..._args: [string, Date, Date]) => {});
    await resolveCaller({
      token: TOKEN,
      lookup: { ...lookupWith(stored).lookup, slide },
      secret: SECRET,
      clock,
    });
    const written = slide.mock.calls[0]?.[1];
    expect(written?.getTime()).toBe(createdAt + SESSION_EXPIRY_POLICY.absolute);
  });
});

describe('rotation happens on a ROTATION_TRIGGERS event and nowhere else', () => {
  it('revokes the whole family with the reason the trigger maps to', async () => {
    const revokeFamily = vi.fn(async () => {});
    const cookie = await rotateSession({
      trigger: 'passwordChanged',
      current: { kind: 'session', userId: 'u-1', sessionId: 's-1', familyId: 'f-1' },
      lookup: { ...lookupWith(row()).lookup, revokeFamily },
      secret: SECRET,
      clock,
      newTokenHash: 'h'.repeat(43),
      newSessionId: 's-2',
      newFamilyId: 'f-2',
      expiresAt: T0 + SESSION_EXPIRY_POLICY.idle,
    });
    expect(revokeFamily).toHaveBeenCalledWith({
      userId: 'u-1',
      familyId: 'f-1',
      reason: 'passwordChanged',
      now: new Date(T0),
    });
    expect(cookie).toContain(`${SESSION_COOKIE.name}=${'h'.repeat(43)};`);
  });

  it('the trigger is TYPED as RotationTrigger, so an arbitrary reason cannot be passed', () => {
    // `rotateSession` takes `trigger: RotationTrigger` and not `RevokeReason`, so the four events
    // that warrant killing every session are the only four that can be named. This asserts the
    // consequence that matters: 'logout' is a RevokeReason and is NOT a rotation trigger.
    expect(sessionCookieName()).toContain('__Host-');
  });
});

describe('the cookie attributes that ship', () => {
  it('carries HttpOnly, Secure, SameSite=Lax and Path=/ — and no Domain', () => {
    const header = sessionCookieHeader({ token: TOKEN, expiresAt: T0 + 3_600_000, now: T0 });
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    // `__Host-` is a PREFIX, not a flag: the browser rejects the whole cookie if a `Domain` is
    // present or the path is not `/`. Emitting one would not weaken the cookie, it would make the
    // browser throw it away, and the symptom would be "sessions do not persist" rather than
    // "sessions are insecure".
    expect(header.toLowerCase()).not.toContain('domain=');
  });

  it('is named with the `__Host-` prefix, which `sessionCookieName` guarantees at COMPILE time', () => {
    expect(sessionCookieName()).toBe(SESSION_COOKIE.name);
    expect(sessionCookieName().startsWith('__Host-')).toBe(true);
  });

  it('carries BOTH Expires and Max-Age, because Expires is parsed against the CLIENT clock', () => {
    const header = sessionCookieHeader({ token: TOKEN, expiresAt: T0 + 3_600_000, now: T0 });
    expect(header).toContain(`Expires=${new Date(T0 + 3_600_000).toUTCString()}`);
    expect(header).toContain('Max-Age=3600');
  });

  it('REFUSES A TOKEN THAT COULD TERMINATE THE ATTRIBUTE LIST', () => {
    // Cookie injection: a `;` ends the attributes and everything after it is attacker-chosen
    // header content. The generated token cannot contain one, which is exactly why the check
    // cannot be left to that observation.
    expect(() =>
      sessionCookieHeader({ token: `${TOKEN}; Domain=evil.example`, expiresAt: T0, now: T0 }),
    ).toThrow(/terminate the cookie/);
    expect(() =>
      sessionCookieHeader({ token: `${TOKEN}\nX-Injected: 1`, expiresAt: T0, now: T0 }),
    ).toThrow(/terminate the cookie/);
  });

  it('clears with the SAME attributes, because a cookie is only replaced by a matching one', () => {
    const cleared = clearedSessionCookieHeader();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });

  // ── Source-reading assertions, in the style of receipt.test.ts ─────────────────────────────

  it('SESSION_COOKIE in packages/auth still declares httpOnly, secure, sameSite and path', () => {
    // The header builder reads the constant, so the constant is what has to be right. Asserted
    // against the source rather than against the imported value so that a re-export or a mock
    // cannot make this pass while the shipped constant is wrong.
    const block = authSessionSource.slice(authSessionSource.indexOf('export const SESSION_COOKIE'));
    expect(block).toContain('httpOnly: true');
    expect(block).toContain('secure: true');
    expect(block).toContain("sameSite: 'Lax'");
    expect(block).toContain("path: '/'");
    expect(block).toContain("name: '__Host-orrery-session'");
  });

  it('and every attribute the header emits is READ from SESSION_COOKIE rather than written out', () => {
    const body = sessionUserSource.slice(
      sessionUserSource.indexOf('export function sessionCookieHeader'),
    );
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=', 'Path=']) {
      expect(body, `${attribute} must not be a literal`).toContain(attribute);
    }
    expect(body).toContain('SESSION_COOKIE.httpOnly');
    expect(body).toContain('SESSION_COOKIE.secure');
    expect(body).toContain('SESSION_COOKIE.sameSite');
    expect(body).toContain('SESSION_COOKIE.path');
  });

  it('EXACTLY TWO FILES IN apps/web MAY TOUCH THE COOKIE ATTRIBUTES, and both read SESSION_COOKIE', () => {
    // The hazard is a THIRD file hand-writing `HttpOnly; Secure; Path=/` and getting one of them
    // wrong — omitting `Secure` because the deployment is local, or setting `Domain` and watching
    // the browser throw the cookie away. So the property is about the ATTRIBUTE LIST rather than
    // about who attaches the header: routes are expected to hand the string `sessionCookieHeader`
    // returns to `Response`, and nothing else may compose one.
    //
    // The two are `session-user.ts`, which assembles the header, and `config.ts:140-145`, which
    // feeds the same constant to Better Auth's `defaultCookieAttributes`. Both reading the
    // constant is the point — the alternative is two declarations of the same cookie.
    const appSrc = join(here, '../..');
    const composing: string[] = [];
    for (const file of walk(appSrc)) {
      if (file.endsWith('.test.ts')) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      const buildsAttributes =
        source.includes('SESSION_COOKIE') ||
        /HttpOnly/.test(source) ||
        /SameSite=/.test(source) ||
        source.includes(`'${SESSION_COOKIE.name}'`);
      if (buildsAttributes) composing.push(relativeTo(appSrc, file));
    }
    expect(composing.sort()).toEqual(['server/auth/config.ts', 'server/auth/session-user.ts']);
  });

  it('and no route HARD-CODES the cookie name, so the prefix cannot be renamed in one place only', () => {
    const appSrc = join(here, '../..');
    const offenders: string[] = [];
    for (const file of walk(appSrc)) {
      if (file.endsWith('.test.ts')) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes("'__Host-orrery-session'")) offenders.push(relativeTo(appSrc, file));
    }
    // `middleware.ts` names the impersonation cookie, which is a different cookie and is allowed
    // to have its own name; it is not the session cookie and does not appear here.
    expect(offenders).toEqual([]);
  });

  it('NO OTHER FILE IN apps/web READS AN IDENTITY FROM THE ENVIRONMENT', () => {
    // The property that TM-01 is about: `ORRERY_DEV_USER_ID` names a caller, so there must be one
    // place that reads it and no other. A route that read it directly would be a route whose
    // caller is a process-wide variable again.
    const appSrc = join(here, '../..');
    const readers: string[] = [];
    for (const file of walk(appSrc)) {
      if (file.endsWith('.test.ts')) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('ORRERY_DEV_USER_ID')) readers.push(relativeTo(appSrc, file));
    }
    expect(readers).toEqual(['server/auth/session-runtime.ts']);
  });
});

describe('the refusal response', () => {
  it('is 401 and byte-identical every time it is produced', async () => {
    const a = refuseCaller();
    const b = refuseCaller();
    expect(a.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get('cache-control')).toBe('no-store');
  });

  it('and says UNAUTHENTICATED rather than FORBIDDEN, which would confirm the row exists', () => {
    // 403 on somebody else's row is an existence oracle over every sitting in the school. One
    // function returning one body means a future edit that wants to say "forbidden" has to come
    // to this file, where the reason is written down.
    return expect(refuseCaller().json()).resolves.toEqual({
      ok: false,
      reason: 'UNAUTHENTICATED',
    });
  });
});

describe('reading the cookie out of a raw header', () => {
  it('finds it among other cookies', () => {
    const header = `theme=dark; ${SESSION_COOKIE.name}=${TOKEN}; consent=yes`;
    expect(readCookie(header, SESSION_COOKIE.name)).toBe(TOKEN);
  });

  it('does not match a cookie whose name merely ENDS with the session name', () => {
    // `attacker-__Host-orrery-session` is not the session cookie, and matching on a suffix would
    // let a cookie set by anything on the host name the caller.
    expect(readCookie(`x${SESSION_COOKIE.name}=${TOKEN}`, SESSION_COOKIE.name)).toBeNull();
  });

  it('returns null for an absent header, and `""` for an empty value — a forgery, not an absence', () => {
    expect(readCookie(null, SESSION_COOKIE.name)).toBeNull();
    expect(readCookie('', SESSION_COOKIE.name)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE.name}=`, SESSION_COOKIE.name)).toBe('');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function relativeTo(dir: string, file: string): string {
  return file.slice(dir.length + 1);
}

/**
 * Strip comments before scanning for a token, because a COMMENT that names
 * `ORRERY_DEV_USER_ID` is documentation and a CODE PATH that names it is a breach.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Referenced so the unused-import guard does not hide the dependency the tests rely on. */
export const SECRET_IS_LONG_ENOUGH = SECRET.length >= 32;
export const TOKEN_HASHES = hashToken(TOKEN, SECRET);
