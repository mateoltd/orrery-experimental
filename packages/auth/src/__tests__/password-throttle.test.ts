/**
 * Password + throttle tests.  (P1-T1 item 6, P1-T7)
 *
 * The two tests that matter most, and why:
 *
 *   · `describe('a school full of students on one address')` — the per-IP limiter must NOT
 *     lock a school out. A limiter that can do that is a denial-of-service vector against
 *     every student, and it is the default implementation everyone writes.
 *   · `it('does the same amount of work whether or not the account exists')` — a generic
 *     error message is not enough, because timing ignores messages.
 */

import { MINUTE, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  inFlightHashes,
  MIN_PASSWORD_LENGTH,
  normalisedForBreachCheck,
  verifyLogin,
  verifyPassword,
} from '../password.js';
import {
  type Attempt,
  domainOf,
  evaluateThrottle,
  hashish,
  IDENTIFIER_LIMITS,
  IP_LIMITS,
  shouldRaiseIpSignal,
  throttleDedupeKey,
} from '../throttle.js';

const PEPPER = 'test-pepper-not-a-real-secret';
const T0: Millis = 1_700_000_000_000;

// Argon2 at OWASP cost is deliberately slow. The suite raises the time budget rather than
// lowering the cost, because a test that runs against production parameters is a test that
// catches a production problem.
describe('password hashing', () => {
  it('uses argon2id at the OWASP baseline, and encodes the variant in the hash', async () => {
    expect(ARGON2ID_PARAMS.algorithm).toBe(2);
    expect(ARGON2ID_PARAMS.memoryCost).toBe(19_456);
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    // The PHC string encodes the variant, so a future downgrade to argon2i or argon2d is
    // visible in stored data rather than invisible in code review.
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('round-trips, and rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword('correct horse battery staple', hash, PEPPER)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash, PEPPER)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const a = await hashPassword('same password here', PEPPER);
    const b = await hashPassword('same password here', PEPPER);
    expect(a).not.toBe(b);
  });

  it('is keyed by the pepper: a different pepper does not verify', async () => {
    // Without a pepper, a stolen hash table is attackable forever; with one, rotating the
    // pepper invalidates every stored hash at once.
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword('correct horse battery staple', hash, 'other-pepper')).toBe(false);
  });

  it('a corrupt stored hash is a false, not a crash', async () => {
    // One bad row must not take down the login endpoint for every other user.
    expect(await verifyPassword('anything at all', 'not-a-real-hash', PEPPER)).toBe(false);
    expect(await verifyPassword('anything at all', '', PEPPER)).toBe(false);
  });

  it('refuses an empty or over-long password rather than truncating', async () => {
    await expect(hashPassword('', PEPPER)).rejects.toThrow(/non-empty/);
    // Truncation would let two different passwords sharing a prefix authenticate each other.
    await expect(hashPassword('x'.repeat(2_000), PEPPER)).rejects.toThrow(/maximum/);
  });

  it('bounds concurrent hashing, so a burst is not an OOM', async () => {
    const before = inFlightHashes();
    const hashes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => hashPassword(`password number ${i}`, PEPPER)),
    );
    expect(hashes).toHaveLength(20);
    expect(inFlightHashes(), 'the slot counter must return to zero').toBe(before);
  });
});

describe('a school full of students on one address', () => {
  /** N distinct students signing in from one NAT address inside a registration window. */
  const schoolMorning = (count: number): Attempt[] =>
    Array.from({ length: count }, (_, i) => ({
      identifier: `student${i}@school.example`,
      ipPseudonym: 'school-nat',
      at: T0 + (i % 90) * 1_000,
      succeeded: true,
    }));

  it('is NOT locked out by 300 students signing in together', () => {
    // THE test for the per-IP trap. A per-IP limiter at a sane threshold would deny the
    // entire school, and the only people who could fix it would be the furthest from a
    // keyboard.
    const attempts = schoolMorning(300);
    for (const identifier of ['student299@school.example', 'student42@school.example']) {
      const v = evaluateThrottle({
        attempts,
        now: T0 + 120_000,
        identifier,
        ipPseudonym: 'school-nat',
      });
      expect(v.allow, 'a school must never be locked out by its shared address').toBe(true);
      expect(v.triggeredBy).toBe('none');
      expect(v.stepUp).toBe(false);
      // 300 identifiers, ONE domain. This is why fan-out counts domains: the identifier
      // count is large and completely unremarkable for a school.
      expect(v.ipDistinctIdentifiers).toBe(300);
      expect(v.ipDistinctDomains, 'a school is one domain however many students it has').toBe(1);
    }
  });

  it('still locks out a single account being ground from that same address', () => {
    // The point of per-identifier: the school's shared IP must not become the attacker's
    // cover. A run against one account is refused even from a legitimate school address.
    const attempts: Attempt[] = Array.from({ length: IDENTIFIER_LIMITS.perWindow }, () => ({
      identifier: 'victim@school.example',
      ipPseudonym: 'school-nat',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + MINUTE,
      identifier: 'victim@school.example',
      ipPseudonym: 'school-nat',
    });
    expect(v.allow).toBe(false);
    expect(v.triggeredBy).toBe('identifier');
  });

  it('an IP signal never denies — it only ever raises a signal', () => {
    // Even a hundred times the volume limit: `allow` stays true. An IP cannot be told apart
    // from a shared one, so it cannot justify refusing a human being.
    // DISTINCT identifiers, all failing to REACH the identifier limit individually — so the
    // only thing that can trigger is the IP volume signal. (The first version of this test
    // used one repeated identifier, which the per-identifier limiter caught first, so the
    // test was not measuring the IP path at all.)
    const attempts: Attempt[] = Array.from({ length: IP_LIMITS.perWindow + 50 }, (_, i) => ({
      identifier: `s${i}@school.example`,
      ipPseudonym: 'shared-nat',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + MINUTE,
      identifier: 's0@school.example',
      ipPseudonym: 'shared-nat',
    });
    expect(v.allow, 'an IP-sourced signal must never deny').toBe(true);
    expect(v.triggeredBy).toBe('ip-volume');
    expect(shouldRaiseIpSignal(v.triggeredBy)).toBe(true);
  });

  it('fan-out catches wide credential stuffing where volume would not', () => {
    // One attacker, one address, thousands of unrelated accounts — each touched once, so
    // no single account trips the identifier limit. Fan-out is the only signal that sees it.
    const attempts: Attempt[] = Array.from({ length: IP_LIMITS.distinctDomains + 10 }, (_, i) => ({
      identifier: `victim${i}@d${i}.example`,
      ipPseudonym: 'hostile',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + MINUTE,
      identifier: 'fresh@example.com',
      ipPseudonym: 'hostile',
    });
    expect(v.triggeredBy).toBe('ip-fanout');
    // One identifier per DOMAIN — which is what a breach list looks like.
    expect(v.ipDistinctDomains).toBeGreaterThanOrEqual(IP_LIMITS.distinctDomains);
    // Still allowed: a human looks, rather than a lockout.
    expect(v.allow).toBe(true);
  });

  it('a success clears the identifier counter', () => {
    // A student who fumbles twice then gets it right must not be asked for a second factor
    // for the next fortnight.
    const attempts: Attempt[] = [
      { identifier: 'u@school.example', ipPseudonym: 'p', at: T0, succeeded: false },
      { identifier: 'u@school.example', ipPseudonym: 'p', at: T0 + 1_000, succeeded: false },
      { identifier: 'u@school.example', ipPseudonym: 'p', at: T0 + 2_000, succeeded: true },
    ];
    const v = evaluateThrottle({
      attempts,
      now: T0 + 3_000,
      identifier: 'u@school.example',
      ipPseudonym: 'p',
    });
    expect(v.stepUp).toBe(false);
    expect(v.triggeredBy).toBe('none');
  });

  it('steps up to a second factor before it refuses', () => {
    const attempts: Attempt[] = Array.from({ length: IDENTIFIER_LIMITS.stepUpAt }, () => ({
      identifier: 'u@school.example',
      ipPseudonym: 'p',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + MINUTE,
      identifier: 'u@school.example',
      ipPseudonym: 'p',
    });
    expect(v.allow).toBe(true);
    expect(v.stepUp).toBe(true);
  });

  it('forgets attempts outside the window, so an old attack does not lock anyone today', () => {
    const attempts: Attempt[] = Array.from({ length: 20 }, () => ({
      identifier: 'u@school.example',
      ipPseudonym: 'p',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + IDENTIFIER_LIMITS.window + 1,
      identifier: 'u@school.example',
      ipPseudonym: 'p',
    });
    expect(v.allow).toBe(true);
  });
});

describe('domainOf', () => {
  it('returns the part after the LAST @, lowercased', () => {
    // `lastIndexOf`, not `indexOf`: a malformed identifier like `a@b@evil.example` must not
    // be read as domain `b@evil.example`, which is a different registrable domain entirely.
    expect(domainOf('student@school.example')).toBe('school.example');
    expect(domainOf('Student@School.Example')).toBe('school.example');
    expect(domainOf('a@b@evil.example')).toBe('evil.example');
  });

  it('yields an empty domain for a malformed identifier, which trips fan-out FASTER', () => {
    // The correct direction for an attacker sending garbage: every distinct garbage string
    // counts as its own domain, so the counter fills up sooner rather than never.
    expect(domainOf('not-an-email')).toBe('');
    expect(domainOf('')).toBe('');
  });
});

describe('the throttle dedupe key', () => {
  it('buckets by time, so a sustained attack is one row that increments', () => {
    // Without bucketing, a credential-stuffing run writes more rows than the database can
    // absorb, which is its own denial of service.
    const a = throttleDedupeKey({
      kind: 'ip-fanout',
      identifier: 'a@b.c',
      ipPseudonym: 'ip',
      at: T0,
    });
    const b = throttleDedupeKey({
      kind: 'ip-fanout',
      identifier: 'a@b.c',
      ipPseudonym: 'ip',
      at: T0 + 60_000,
    });
    expect(a).toBe(b);
    const c = throttleDedupeKey({
      kind: 'ip-fanout',
      identifier: 'a@b.c',
      ipPseudonym: 'ip',
      at: T0 + 60 * MINUTE,
    });
    expect(c).not.toBe(a);
  });

  it('does not embed the email address in the key', () => {
    // The key column gets grouped and exported; a list of every address someone has tried
    // is a list of real people, and it belongs in no index.
    const key = throttleDedupeKey({
      kind: 'mfa',
      identifier: 'victim@example.com',
      ipPseudonym: 'ip',
      at: T0,
    });
    expect(key).not.toContain('victim@example.com');
    expect(key).toContain(hashish('victim@example.com'));
  });
});

describe('password policy', () => {
  it('rejects short passwords and no others on length alone', async () => {
    const none = async () => new Set<string>();
    expect(await checkPasswordPolicy('short', none)).toEqual({ ok: false, reason: 'tooShort' });
    expect(await checkPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH), none)).toEqual({ ok: true });
  });

  it('rejects a breached password even when it is long and looks strong', async () => {
    // `correct horse battery staple` is long, has no digits, and is in every corpus. This
    // is the whole reason the breach check exists: length is not the property that matters,
    // being in a breach list is.
    // The prefix/suffix split is computed by the same function the implementation uses.
    // Hand-writing the suffix here was wrong twice in a row, which is precisely why the
    // normaliser is exported.
    const normalised = normalisedForBreachCheck('CorrectHorseBatteryStaple');
    const lookup = async () => new Set([normalised.slice(5)]);
    const v = await checkPasswordPolicy('CorrectHorseBatteryStaple', lookup);
    expect(v).toEqual({ ok: false, reason: 'breached' });
  });

  it('normalises leetspeak, so the breach check is not defeated by the obvious trick', async () => {
    // An attacker substituting @ for a defeats a naive exact-match check entirely.
    const normalised = normalisedForBreachCheck('P@ssw0rd12345');
    const lookup = async () => new Set([normalised.slice(5)]);
    expect(await checkPasswordPolicy('P@ssw0rd12345', lookup)).toEqual({
      ok: false,
      reason: 'breached',
    });

    // And assert the normalisation itself, so a change to the leet table is visible rather
    // than silently altering which passwords are considered breached. The substitutions run
    // IN ORDER and `@4 -> a` runs first, so the trailing `4` becomes `a` before `5 -> s`:
    // `P@ssw0rd12345` -> `passwordl2eas`. Hand-computing this wrong is what the exported
    // function is for.
    expect(normalised).toBe('passwordl2eas');
  });

  it('has no composition requirement, deliberately', async () => {
    // Composition rules mostly produce `Password1!`, which is in every breach corpus. A
    // 16-character passphrase passes, which is the behaviour we want.
    const none = async () => new Set<string>();
    expect(await checkPasswordPolicy('sixteencharpass', none)).toEqual({ ok: true });
  });
});

describe('a high-volume run against ONE domain', () => {
  it('raises the volume signal and still allows — because it is indistinguishable from a school', () => {
    // A distinct-identifier net was written for this shape and REMOVED as unreachable: to
    // reach a distinct-identifier threshold inside the window you must first pass
    // `perWindow`, and `perWindow` is by definition below a school's student count. The
    // volume signal always fired first, so the net was decoration.
    //
    // What is left is the honest position. "Hundreds of distinct accounts, one address, one
    // domain, minutes apart" is a description of a school registration morning as much as a
    // credential-stuffing run, and no signal separates them. So: raise, allow, and let a
    // human look. Inventing a fourth signal would have meant inventing one that fires on
    // schools.
    const attempts: Attempt[] = Array.from({ length: IP_LIMITS.perWindow + 5 }, (_, i) => ({
      identifier: `victim${i}@one-school.example`,
      ipPseudonym: 'hostile',
      at: T0,
      succeeded: false,
    }));
    const v = evaluateThrottle({
      attempts,
      now: T0 + MINUTE,
      identifier: 'fresh@one-school.example',
      ipPseudonym: 'hostile',
    });
    expect(v.ipDistinctDomains, 'the domain net deliberately stays quiet here').toBe(1);
    expect(v.triggeredBy).toBe('ip-volume');
    expect(v.allow).toBe(true);
  });
});

describe('an over-long password', () => {
  it('is refused by the policy before it ever reaches argon2', async () => {
    // The policy is the cheap gate; hashing a 201-character password costs 19 MiB of
    // memory to then throw the result away.
    const none = async () => new Set<string>();
    expect(await checkPasswordPolicy('x'.repeat(201), none)).toEqual({
      ok: false,
      reason: 'tooLong',
    });
  });
});

describe('an attacker enumerating accounts', () => {
  it('does the same amount of work whether or not the account exists', async () => {
    // THE test for the timing oracle. A generic error MESSAGE is not enough: a stopwatch is
    // not fooled by copy. `verifyLogin` must burn a real argon2 verification either way.
    const existing = await hashPassword('correct horse battery staple', PEPPER);

    // `process.hrtime.bigint()` rather than `performance.now()`. This is a DURATION
    // measurement, not a time source — there is no business logic here that could be reading
    // the wall clock, which is exactly what INV-TIME-1 forbids. hrtime keeps the rule
    // absolute for app code instead of carving out a test exemption for a test that had
    // picked the wrong API.
    const time = async (storedHash: string | null): Promise<number> => {
      const start = process.hrtime.bigint();
      await verifyLogin({ password: 'wrong password guess', storedHash, pepper: PEPPER });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    // Measured twice and compared on the second run: the first call to the missing-account
    // path pays one-time module init for the dummy hash, and comparing cold starts is a
    // flaky test rather than a finding.
    await time(existing);
    await time(null);
    const existingMs = await time(existing);
    const missingMs = await time(null);

    // A 5x ratio is a clear, unambiguous oracle. A tighter bound would be flaky on a shared
    // CI runner; the point is that the two paths are now the same SHAPE of work.
    const ratio = Math.max(existingMs, missingMs) / Math.max(1, Math.min(existingMs, missingMs));
    expect(
      ratio,
      `existing=${existingMs.toFixed(1)}ms missing=${missingMs.toFixed(1)}ms`,
    ).toBeLessThan(5);
  });

  it('returns false for a missing account, same as a wrong password', async () => {
    expect(await verifyLogin({ password: 'x', storedHash: null, pepper: PEPPER })).toBe(false);
  });

  it('does the same work on the TENTH missing-account attempt as on the first', async () => {
    // The regression test for a real oracle that shipped in the first version of this file.
    // It cached the whole `dummyHash()` PROMISE, so the first non-existent account cost
    // ~40ms and every one after it cost ~0ms — a permanent enumeration oracle, and the
    // opposite of the intent. The code read correctly the whole time; only measuring found
    // it, at `missing=0.0ms`.
    //
    // Two things had to be right: the HASH STRING is cached (it is an expensive artefact
    // worth keeping) while the VERIFICATION is re-run every time (the cost of argon2 is in
    // the verify, not the hash). Caching the promise broke it; caching the string fixes it.
    await verifyLogin({ password: 'x', storedHash: null, pepper: PEPPER });
    const time = async (storedHash: string | null): Promise<number> => {
      const start = process.hrtime.bigint();
      await verifyLogin({ password: 'x', storedHash, pepper: PEPPER });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const tenth = await time(null);
    // Absolute floor as well as a ratio: a cached-promise implementation returns ~0.0ms
    // here, so a relative-only assertion could be satisfied by two fast paths.
    expect(
      tenth,
      'a missing-account login must cost real argon2 work every single time',
    ).toBeGreaterThan(1);
  });
});
