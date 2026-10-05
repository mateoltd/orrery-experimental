/**
 * The impersonation cookie, and the clock the window is measured against.  (P14-T12, TM-03, TM-04)
 *
 * ## WHY THIS FILE IS SEPARATE FROM `impersonation.test.ts`
 *
 * Because that file tests the POLICY — fifteen minutes, read-only, notify both readers — and this one tests the two
 * things that decide whether the policy is reachable at all: **who may assert the state, and whose clock the window is
 * measured against.** Both were unimplemented, so a file of policy tests could pass at 100% coverage with the gate
 * unreachable, which is the shape of defect `TM-03` names and the reason it was scored as having no state in which the
 * property could be observed.
 *
 * ## EVERY PROPERTY HERE HAS A TEST THAT FAILS WHEN THE PROPERTY IS REMOVED
 *
 * Which is checked by removing them, in this order: the HMAC, the server clock, the re-checked window, the
 * administrator binding, and the shape validation of signed bytes. The messages from those runs are in the task report;
 * a test that only ever passed was never evidence of anything.
 */

import { FrozenClock, MINUTE, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  guardImpersonatedRequest,
  guardRequest,
  IMPERSONATION_COOKIE,
  IMPERSONATION_LIMIT,
  IMPERSONATION_SECRET_MIN_BYTES,
  type ImpersonatedRequestInput,
  type ImpersonationCookieRefusal,
  type ImpersonationState,
  impersonationCookieOptions,
  inspectImpersonationCookie,
  readImpersonationCookie,
  signImpersonationCookie,
  startImpersonation,
  WRITE_DENIED_CODE,
} from '../impersonation.js';

const T0: Millis = 1_700_000_000_000;

/** 32 bytes, which is the floor and not a round number chosen to look secure. */
const SECRET = 'k'.repeat(IMPERSONATION_SECRET_MIN_BYTES);

const state = (over: Partial<ImpersonationState> = {}): ImpersonationState => ({
  byUserId: 'adm-1',
  byDisplayName: 'Sam Okafor',
  targetUserId: 's-1',
  targetDisplayName: 'Ada Lovelace',
  startedAt: T0,
  expiresAt: T0 + IMPERSONATION_LIMIT,
  reason: 'Ticket SUP-412',
  ...over,
});

/** A middleware-shaped call, so the test is about what a request path sends rather than about the function's shape. */
const gate = async (over: Partial<ImpersonatedRequestInput> = {}, rawCookie?: string) => {
  const input: ImpersonatedRequestInput = {
    method: 'POST',
    rawCookie,
    secret: SECRET,
    clock: new FrozenClock(T0 + MINUTE),
    ...over,
  };
  return guardImpersonatedRequest(input);
};

/** Mint a cookie the honest way, so every test that needs one is not also a test of the signer. */
const mint = async (over: Partial<ImpersonationState> = {}): Promise<string> =>
  signImpersonationCookie(state(over), SECRET);

describe('the cookie is signed, and an unsigned one grants nothing', () => {
  it('a cookie this module signed is honoured', async () => {
    const verdict = await gate({}, await mint());
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.code).toBe(WRITE_DENIED_CODE);
  });

  it('THE PROPERTY: a cookie whose FIELDS were edited without the key is refused', async () => {
    // The whole reason the HMAC exists. Without it this cookie would hand an attacker the choice of `byUserId`, which
    // is the field the audit trail records, so the trail would be the attacker's to write.
    //
    // The payload is a REAL one, signed-material and all, and only the MAC is wrong. An earlier version of this test
    // used a payload that was not a payload at all, so it kept passing with the MAC check deleted — a test that proves
    // the wrong half of the mechanism is how a gate survives its own removal.
    const genuine = await mint();
    const forged = `${'b'.repeat(64)}${genuine.slice(genuine.indexOf('.'))}`;
    const verdict = await gate({}, forged);
    expect(verdict).toEqual({ allowed: true, impersonating: false });
    expect((await inspectImpersonationCookie(forged, SECRET, T0)).reason).toBe('BAD_SIGNATURE');
  });

  it('flipping ONE character of the signature is enough', async () => {
    // A tamper test that rewrites the whole cookie proves nothing; a forger edits a byte.
    const genuine = await mint();
    const separator = genuine.indexOf('.');
    const head = genuine.slice(0, separator);
    const flipped = (head[0] === 'a' ? 'b' : 'a') + head.slice(1);
    const reason = (
      await inspectImpersonationCookie(`${flipped}${genuine.slice(separator)}`, SECRET, T0)
    ).reason;
    expect(reason).toBe('BAD_SIGNATURE');
  });

  it('the same cookie under a DIFFERENT key is refused', async () => {
    // Domain separation is about purpose, but key separation is what stops a cookie minted for one deployment being
    // honoured by another — which is the reason `session-runtime.ts` refuses a short or absent AUTH_SECRET outright.
    const other = 'z'.repeat(IMPERSONATION_SECRET_MIN_BYTES);
    const reason = (await inspectImpersonationCookie(await mint(), other, T0)).reason;
    expect(reason).toBe('BAD_SIGNATURE');
  });

  it('the signature covers the REASON, because a ticket number is evidence', async () => {
    // A forged reason is a support engineer looking at a student's work with no ticket behind it, and the banner shows
    // the reason to whoever is standing nearby.
    const genuine = await mint();
    const material = genuine.slice(genuine.indexOf('.') + 1);
    const decoded = JSON.parse(Buffer.from(material, 'base64url').toString('utf8')) as unknown[];
    decoded[7] = 'Because I wanted to';
    const edited =
      genuine.slice(0, genuine.indexOf('.') + 1) +
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect((await inspectImpersonationCookie(edited, SECRET, T0)).reason).toBe('BAD_SIGNATURE');
  });

  it('the signature covers the WINDOW, because a lengthened one is a permanent back door', async () => {
    const genuine = await mint();
    const separator = genuine.indexOf('.');
    const decoded = JSON.parse(
      Buffer.from(genuine.slice(separator + 1), 'base64url').toString('utf8'),
    ) as unknown[];
    decoded[6] = T0 + IMPERSONATION_LIMIT * 100;
    const edited = `${genuine.slice(0, separator)}.${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}`;
    expect((await inspectImpersonationCookie(edited, SECRET, T0)).reason).toBe('BAD_SIGNATURE');
  });

  it('the signature covers BOTH display names, which is what the banner shows', async () => {
    const genuine = await mint();
    const separator = genuine.indexOf('.');
    const decoded = JSON.parse(
      Buffer.from(genuine.slice(separator + 1), 'base64url').toString('utf8'),
    ) as unknown[];
    decoded[4] = 'A Different Student';
    const edited = `${genuine.slice(0, separator)}.${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}`;
    expect((await inspectImpersonationCookie(edited, SECRET, T0)).reason).toBe('BAD_SIGNATURE');
  });
});

describe('the signature is checked BEFORE the payload is parsed, and before the key does work', () => {
  it('a truncated cookie is MALFORMED rather than an exception', async () => {
    expect((await inspectImpersonationCookie('no-separator-here', SECRET, T0)).reason).toBe(
      'MALFORMED',
    );
  });

  it('a signature that is not a hex SHA-256 is refused without calling the key', async () => {
    // `verifyEvidenceBatch` makes the same argument for the same reason: a transport sending garbage must not be able
    // to make the server's key work on its behalf.
    const raw = `not-a-digest.${Buffer.from('[]', 'utf8').toString('base64url')}`;
    expect((await inspectImpersonationCookie(raw, SECRET, T0)).reason).toBe('MALFORMED');
  });

  it('a payload that is not base64url of UTF-8 is refused, and does not throw', async () => {
    expect((await inspectImpersonationCookie(`${'a'.repeat(64)}.$$$`, SECRET, T0)).reason).toBe(
      'MALFORMED',
    );
  });

  it('AUTHENTIC bytes that are not a payload are refused, so a signer bug is not trusted downstream', async () => {
    // Signed with the REAL key, so the signature verifies and the shape is the only thing left refusing it. A reader
    // that trusted the shape over the MAC — or that trusted the MAC and never looked at the shape — is what this is for.
    const wrongArity = await signMaterial(['orrery.impersonation.v1', 'adm-1']);
    expect((await inspectImpersonationCookie(wrongArity, SECRET, T0)).reason).toBe('BAD_PAYLOAD');
  });

  it('and authentic bytes that are not even JSON are refused rather than throwing', async () => {
    // The refusal is the point: `JSON.parse` on signed bytes a signer produced is the one place in this module that can
    // throw, and a handler that threw on a cookie would turn a broken cookie into a 500 for every request that carries one.
    const notJson = await signRaw('}{ this is not json');
    expect((await inspectImpersonationCookie(notJson, SECRET, T0)).reason).toBe('BAD_PAYLOAD');
  });

  it('and authentic bytes that are JSON but not an array are refused', async () => {
    expect(
      (await inspectImpersonationCookie(await signRaw('{"byUserId":"adm-1"}'), SECRET, T0)).reason,
    ).toBe('BAD_PAYLOAD');
  });

  it('and a foreign tag inside authentic bytes is refused too', async () => {
    const retagged = await signMaterial([
      'orrery.session.v1',
      'adm-1',
      'Sam',
      's-1',
      'Ada',
      T0,
      T0 + IMPERSONATION_LIMIT,
      'x',
    ]);
    expect((await inspectImpersonationCookie(retagged, SECRET, T0)).reason).toBe('BAD_PAYLOAD');
  });
});

describe('every signed field is validated, because a signed nonsense is still nonsense', () => {
  const VALID: unknown[] = [
    'orrery.impersonation.v1',
    'adm-1',
    'Sam Okafor',
    's-1',
    'Ada Lovelace',
    T0,
    T0 + IMPERSONATION_LIMIT,
    'Ticket SUP-412',
  ];

  // Table-driven because the alternative is eight near-identical tests, and a near-identical test is one somebody
  // skips. The index and what it holds are the specification; the loop is the assertion.
  const CASES: readonly { readonly index: number; readonly bad: unknown; readonly what: string }[] =
    [
      { index: 1, bad: 42, what: 'byUserId is a number' },
      { index: 2, bad: null, what: 'byDisplayName is null' },
      { index: 3, bad: {}, what: 'targetUserId is an object' },
      { index: 4, bad: [], what: 'targetDisplayName is an array' },
      { index: 5, bad: '1700000000000', what: 'startedAt is a string' },
      { index: 6, bad: T0 + 0.5, what: 'expiresAt is fractional' },
      { index: 7, bad: 7, what: 'reason is a number' },
    ];

  for (const testCase of CASES) {
    it(`refuses a signed payload where ${testCase.what}`, async () => {
      const material = [...VALID];
      material[testCase.index] = testCase.bad;
      expect(
        (await inspectImpersonationCookie(await signMaterial(material), SECRET, T0)).reason,
      ).toBe('BAD_PAYLOAD');
    });
  }
});

describe('THE 15-MINUTE CAP IS RE-CHECKED WHERE THE WINDOW IS USED', () => {
  it('refuses a window LONGER than the packet allows, even with a valid signature', async () => {
    // Signed with the real key, so this is only reachable by a signer that is wrong or a secret that leaked. Checking
    // the bound where the cap is SET would do nothing about either.
    const greedy = await mint({ expiresAt: T0 + IMPERSONATION_LIMIT + MINUTE });
    expect((await inspectImpersonationCookie(greedy, SECRET, T0)).reason).toBe('ILLEGAL_WINDOW');
  });

  it('refuses an inverted window', async () => {
    const inverted = await mint({ expiresAt: T0 - 1 });
    expect((await inspectImpersonationCookie(inverted, SECRET, T0)).reason).toBe('ILLEGAL_WINDOW');
  });

  it('refuses a zero-length window', async () => {
    const zero = await mint({ expiresAt: T0 });
    expect((await inspectImpersonationCookie(zero, SECRET, T0)).reason).toBe('ILLEGAL_WINDOW');
  });

  it('accepts a SHORTER window, because a five-minute support look is a legitimate caller', async () => {
    // The check is a ceiling, not an equality. An equality would be stronger and would also refuse the next person who
    // wanted a shorter window, which is how a control becomes the thing it was protecting people from.
    const brief = await mint({ expiresAt: T0 + 5 * MINUTE });
    expect(await readImpersonationCookie(brief, SECRET, T0)).not.toBeNull();
  });
});

describe('the cookie is bound to the administrator it names, wherever the caller knows who they are', () => {
  it('refuses a valid cookie presented by a DIFFERENT administrator', async () => {
    const verdict = await gate({ actingUserId: 'adm-2' }, await mint());
    expect(verdict.impersonating).toBe(false);
    const reason = (await inspectImpersonationCookie(await mint(), SECRET, T0, 'adm-2')).reason;
    expect(reason).toBe('WRONG_ADMIN');
  });

  it('honours it for the administrator it names', async () => {
    expect((await inspectImpersonationCookie(await mint(), SECRET, T0, 'adm-1')).reason).toBeNull();
  });

  it('AND THE GAP IS NAMED: without a session id the binding is simply absent, not satisfied', async () => {
    // The only caller today is edge middleware, which cannot resolve a session. This test states what that costs
    // rather than leaving it to be discovered, and the assertion is the honest one: the cookie is still honoured,
    // because the alternative — refusing every impersonation — would leave the gate inert again.
    expect(await readImpersonationCookie(await mint(), SECRET, T0)).not.toBeNull();
  });
});

describe('an unconfigured deployment refuses, and never substitutes a key', () => {
  it('no secret means no impersonation', async () => {
    expect((await inspectImpersonationCookie(await mint(), null, T0)).reason).toBe('NO_SECRET');
  });

  it('a secret under the floor is refused too, because `changeme` is a configured secret', async () => {
    // A presence check would pass a one-word secret, and a pepper that is silently weak is the exact failure
    // `password.ts` records a `requirePepper()` boot check as existing to prevent.
    expect((await inspectImpersonationCookie(await mint(), 'short', T0)).reason).toBe('NO_SECRET');
  });

  it('and the request path degrades to the admin being an admin, which is where an inert gate already was', async () => {
    const verdict = await gate({ secret: null }, await mint());
    expect(verdict).toEqual({ allowed: true, impersonating: false });
  });
});

describe('NO COOKIE IS THE ORDINARY REQUEST, and the gate must not fire on it', () => {
  it('absent, and empty, both mean no impersonation rather than an error', async () => {
    expect((await inspectImpersonationCookie(undefined, SECRET, T0)).reason).toBe('NO_COOKIE');
    expect((await inspectImpersonationCookie('', SECRET, T0)).reason).toBe('NO_COOKIE');
    // If this ever refused, every teacher in the school would be unable to mark.
    expect(await gate()).toEqual({ allowed: true, impersonating: false });
  });
});

describe('THE CLOCK IS THE SERVER CLOCK, AND THAT IS THE WHOLE OF TM-04', () => {
  it('a window that has closed on the server clock is EXPIRED, and writes are permitted again', async () => {
    const cookie = await mint();
    const after = T0 + IMPERSONATION_LIMIT;
    expect((await inspectImpersonationCookie(cookie, SECRET, after)).reason).toBe('EXPIRED');
    expect(await gate({ clock: new FrozenClock(after) }, cookie)).toEqual({
      allowed: true,
      impersonating: false,
    });
  });

  it('THE RED-BEFORE-FIX TEST: a client claiming a far-future `x-now` buys NOTHING', async () => {
    // `apps/web/src/middleware.ts` read `Date.parse(req.headers.get('x-now'))` and handed it to `guardRequest`. Because
    // the comparison is `now >= expiresAt`, a LARGER claimed instant made the window look CLOSED — so the header did not
    // widen the window, it ENDED it, and the write gate stopped firing while the real 15 minutes were still running.
    // **The failure is open, and that is why TM-03's "fail-safe" description does not survive the wiring.** The first
    // assertion below is the RED, recorded against the EXISTING exported function with no new symbol involved: it read
    // `expected false to be true`.
    const FAR_FUTURE = Date.parse('2999-01-01T00:00:00.000Z');
    expect(guardRequest({ method: 'POST', state: state(), now: FAR_FUTURE }).allowed).toBe(true);

    // And the gate built here has nowhere to put the header, so the same request is refused.
    const verdict = await guardImpersonatedRequest({
      method: 'POST',
      rawCookie: await mint(),
      secret: SECRET,
      clock: new FrozenClock(T0 + MINUTE),
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(verdict.code).toBe(WRITE_DENIED_CODE);
  });

  it('and the same for every `x-now` a client could send, through a middleware-shaped adapter', async () => {
    const cookie = await mint();
    // What a request path does: read the header, and hand the gate what it needs. The adapter is here rather than in the
    // module because the claim is about WIRING, and the wiring is the part `TM-04` says was wrong.
    //
    // **THE HEADER IS PUT ON THE OBJECT ANYWAY, through a cast, and the verdict does not move.** An earlier version of
    // this test parsed the header and threw the value away, which passed against a gate that had been mutated to read
    // `x-now` off the input — the property was untested because the test never put the value anywhere it could be read.
    // A caller that smuggled it in has to cast to do so, and the cast is what makes the absence of the parameter the
    // mechanism rather than an accident of this test.
    const middlewareWouldCall = async (xNow: string | null) => {
      const request = {
        method: 'POST',
        rawCookie: cookie,
        secret: SECRET,
        clock: new FrozenClock(T0 + MINUTE),
        // **THREE SPELLINGS, because a caller reintroducing the header would not be careful about which one.** The raw
        // header string, the header's own hyphenated name, and the parsed instant middleware actually passed today.
        ...({ xNow, 'x-now': xNow, now: xNow === null ? 0 : Date.parse(xNow) } as Record<
          string,
          unknown
        >),
      } as unknown as ImpersonatedRequestInput;
      return guardImpersonatedRequest(request);
    };

    for (const xNow of ['2999-01-01T00:00:00.000Z', '0', '-1', 'not-a-date', null]) {
      const verdict = await middlewareWouldCall(xNow);
      expect(verdict.allowed, `x-now=${String(xNow)}`).toBe(false);
      if (verdict.allowed) throw new Error('expected a refusal');
      expect(verdict.code).toBe(WRITE_DENIED_CODE);
    }
  });

  it('THE SHAPE IS THE CONTROL: `ImpersonatedRequestInput` has no instant in it', async () => {
    // A type-level check rather than a comment. If somebody re-adds a `now` — because a caller asked for one — this
    // list stops being the whole set of keys and the assertion stops compiling.
    const declared: readonly (keyof ImpersonatedRequestInput)[] = [
      'method',
      'rawCookie',
      'secret',
      'clock',
      'actingUserId',
    ];
    const exhaustive = <K extends string>(keys: readonly K[], _all: Record<K, true>): void => {
      expect(keys).toHaveLength(5);
    };
    const shape: Record<(typeof declared)[number], true> = {
      method: true,
      rawCookie: true,
      secret: true,
      clock: true,
      actingUserId: true,
    };
    exhaustive(declared, shape);
  });

  it('a read-only method is still permitted while impersonating, because the gate is about WRITES', async () => {
    const cookie = await mint();
    const verdict = await gate({ method: 'GET' }, cookie);
    expect(verdict).toEqual({
      allowed: true,
      impersonating: true,
      state: state(),
      remainingMs: IMPERSONATION_LIMIT - MINUTE,
    });
  });
});

describe('the cookie attributes are declared once, beside the reader', () => {
  it('are `__Host-`, httpOnly and Secure, so a sibling subdomain cannot replace the gate switch', () => {
    expect(IMPERSONATION_COOKIE.name).toBe('__Host-orrery-impersonating');
    expect(IMPERSONATION_COOKIE.httpOnly).toBe(true);
    expect(IMPERSONATION_COOKIE.secure).toBe(true);
    expect(IMPERSONATION_COOKIE.path).toBe('/');
  });

  it('`maxAge` is the remaining window, never longer', () => {
    expect(impersonationCookieOptions(state(), T0).maxAge).toBe(IMPERSONATION_LIMIT / 1_000);
    // Clamped rather than negative: a caller that computed this after the window closed would otherwise emit a cookie
    // that expires in the past, which browsers honour by deleting it — an accident that reads as "the feature works".
    expect(impersonationCookieOptions(state(), T0 + IMPERSONATION_LIMIT + MINUTE).maxAge).toBe(0);
  });
});

describe('every refusal has a NAME, because a log line that collapses them is not a log line', () => {
  it('the reasons are distinct and none of them is a verdict anybody has to interpret', () => {
    // `evidence.ts` states the rule for `EvidenceSignatureVerdict` and this is the same argument for the same reason:
    // "does not match" is the answer that sends somebody through a whole investigation.
    const reasons: readonly ImpersonationCookieRefusal[] = [
      'NO_COOKIE',
      'NO_SECRET',
      'MALFORMED',
      'BAD_SIGNATURE',
      'BAD_PAYLOAD',
      'ILLEGAL_WINDOW',
      'EXPIRED',
      'WRONG_ADMIN',
    ];
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('the signer and the policy agree, so a real impersonation is one a real admin could have started', () => {
  it('the cookie this module issues is the window `startImpersonation` actually granted', async () => {
    // The unit that ties the two together. A cookie minted from a hand-written state could verify perfectly and name a
    // window no caller was ever allowed to grant.
    const verdict = startImpersonation({
      actorId: 'adm-1',
      actorRoles: ['platformAdmin'],
      targetUserId: 's-1',
      targetIsActive: true,
      alreadyActive: 0,
      now: T0,
    });
    if (!verdict.ok) throw new Error('expected a grant');
    const cookie = await signImpersonationCookie(
      {
        ...state(),
        startedAt: T0,
        expiresAt: verdict.until,
      },
      SECRET,
    );
    expect(await readImpersonationCookie(cookie, SECRET, T0)).not.toBeNull();
  });
});

/** Sign arbitrary bytes with the real key, so a payload test is testing the SHAPE and not the MAC. */
const signMaterial = async (material: readonly unknown[]): Promise<string> =>
  signRaw(JSON.stringify(material));

/**
 * HMAC a raw string exactly as the module does, so a test can present AUTHENTIC bytes that are not a valid payload.
 *
 * Written out rather than exported from the module because a verifier nothing can produce a forgery for is not a
 * verifier — this is the only way to reach the shape checks without breaking the signature, which is precisely the case
 * they exist for.
 */
const signRaw = async (material: string): Promise<string> => {
  const encoded = Buffer.from(material, 'utf8').toString('base64url');
  const signature = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    new TextEncoder().encode(material),
  );
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex}.${encoded}`;
};
