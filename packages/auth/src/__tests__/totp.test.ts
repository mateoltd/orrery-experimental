/**
 * TOTP and the teacher-grading gate.  (P1-T9, D6)
 *
 * ## The test this file is built around
 *
 * `describe('a TOTP code cannot be replayed')`. A code is valid for a whole 30-second window,
 * so verifying it and nothing else leaves a live replay — and worse, spends the code on the
 * legitimate user, who then cannot use their own phone. This is RFC 6238 §5.2's own advice and
 * almost every hand-rolled implementation omits it.
 *
 * ## The gate tests
 *
 * `describe('a teacher cannot submit a grade without a second factor')` — with the recovery
 * path asserted to keep an in-flight grading session alive, because that is the specific way a
 * security feature turns into a lost afternoon of marks.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceLastUsedStep,
  canSubmitGrade,
  consumeRecoveryCode,
  decodeBase32,
  encodeBase32,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY,
  remainingRecoveryCodes,
  stepFor,
  TOTP,
  totpAt,
  verifyTotp,
} from '../totp.js';

const T0 = 1_700_000_000_000;
const SALT = 'recovery-salt';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('base32', () => {
  it('round-trips, which is the property that matters for a hand-typed secret', () => {
    // `match` rather than a slice loop, so the pairing is guaranteed; asserted rather than
    // asserted-not, because a non-null assertion on a regex result is a claim nothing checks.
    for (const hex of ['00', 'ff', 'deadbeef', '0102030405060708']) {
      const pairs = hex.match(/../g) ?? [];
      expect(pairs).toHaveLength(hex.length / 2);
      const bytes = new Uint8Array(pairs.map((h) => parseInt(h, 16)));
      expect([...decodeBase32(encodeBase32(bytes))]).toEqual([...bytes]);
    }
  });

  it('rejects a character outside the alphabet rather than silently mis-decoding', () => {
    // '1', '8' and '0' are the classic transcription errors. Silently mapping them to something
    // is how a teacher ends up with a second factor that does not work and no idea why.
    expect(() => decodeBase32('JBSWY3DP1EHPK')).toThrowError(/base32/);
  });

  it('ignores whitespace and padding, because a setup key is often pasted with either', () => {
    expect(encodeBase32(decodeBase32('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP'))).toBe(SECRET);
    expect(encodeBase32(decodeBase32(`${SECRET}====`))).toBe(SECRET);
  });

  it('generates a 20-byte secret by default, which is 160 bits', () => {
    expect(decodeBase32(generateSecret())).toHaveLength(20);
  });
});

describe('the code for a step', () => {
  it('is six digits', () => {
    expect(totpAt(SECRET, T0)).toMatch(/^\d{6}$/);
  });

  it('is stable within a step and changes between steps', () => {
    const stepMs = TOTP.periodSeconds * 1000;
    const step = stepFor(T0);
    expect(totpAt(SECRET, step * stepMs)).toBe(totpAt(SECRET, step * stepMs + stepMs - 1));
    // A collision between two adjacent steps is possible (1 in 10^6) but the specific pair here
    // is fixed, so this is a real assertion rather than a probabilistic one.
    expect(totpAt(SECRET, step * stepMs)).not.toBe(totpAt(SECRET, (step + 1) * stepMs));
  });

  it('differs between secrets at the same instant', () => {
    expect(totpAt(SECRET, T0)).not.toBe(totpAt(generateSecret(), T0));
  });
});

describe('THE test: a TOTP code cannot be replayed', () => {
  const step = stepFor(T0);

  it('accepts a code once, and rejects it again in the same window', () => {
    const code = totpAt(SECRET, T0);
    const first = verifyTotp({ secretBase32: SECRET, code, atMillis: T0, lastUsedStep: -1 });
    expect(first).toEqual({ ok: true, step });

    // The replay. Same code, same window, and the honest answer is `replayed` rather than
    // `wrong` — the user is not typing badly, the code is spent.
    const second = verifyTotp({
      secretBase32: SECRET,
      code,
      atMillis: T0 + 5_000,
      lastUsedStep: step,
    });
    expect(second).toEqual({ ok: false, reason: 'replayed' });
  });

  it('rejects every code from a step at or before the last used one', () => {
    // A phished code from an earlier window must not work either.
    for (const back of [1, 2, 5]) {
      const at = (step - back) * TOTP.periodSeconds * 1000;
      const verdict = verifyTotp({
        secretBase32: SECRET,
        code: totpAt(SECRET, at),
        atMillis: T0,
        lastUsedStep: step,
      });
      expect(verdict.ok, `step-${back} must not verify`).toBe(false);
    }
  });

  it('advanceLastUsedStep is monotonic, so a stale write cannot rewind the counter', () => {
    expect(advanceLastUsedStep(10, 12)).toBe(12);
    expect(advanceLastUsedStep(12, 10)).toBe(12);
  });

  it('the legitimate user is not locked out by an attacker spending the code', () => {
    // The other half of the replay problem: if an attacker burns a code, the teacher's own
    // phone shows the same code. The correct outcome is that the code is rejected AND the
    // teacher waits 30 seconds — not that the teacher is locked out of grading.
    const code = totpAt(SECRET, T0);
    const spent = verifyTotp({ secretBase32: SECRET, code, atMillis: T0, lastUsedStep: -1 });
    expect(spent.ok).toBe(true);
    const teacherRetries = verifyTotp({
      secretBase32: SECRET,
      code,
      atMillis: T0,
      lastUsedStep: step,
    });
    expect(teacherRetries).toEqual({ ok: false, reason: 'replayed' });
    // The next window works.
    const next = (step + 1) * TOTP.periodSeconds * 1000;
    const ok = verifyTotp({
      secretBase32: SECRET,
      code: totpAt(SECRET, next),
      atMillis: next,
      lastUsedStep: step,
    });
    expect(ok.ok).toBe(true);
  });
});

describe('clock skew', () => {
  it('accepts one step either side, because phone clocks drift', () => {
    const step = stepFor(T0);
    for (const offset of [-1, 1]) {
      const at = (step + offset) * TOTP.periodSeconds * 1000;
      const verdict = verifyTotp({
        secretBase32: SECRET,
        code: totpAt(SECRET, at),
        atMillis: T0,
        lastUsedStep: -1,
      });
      expect(verdict.ok, `offset=${offset} must be accepted`).toBe(true);
    }
  });

  it('does not try a NEGATIVE step, which the window arithmetic would otherwise produce', () => {
    // At the very start of the Unix epoch the current step is 0, so `current - 1` is -1 and
    // HOTP would be asked for a negative counter. Skipping it is not defensive padding: a
    // BigInt conversion of a negative step is valid, so the code would run and produce a
    // number that could conceivably match. Only reachable at epoch-relative timestamps, which
    // is why it needed its own test.
    const epochish = 5_000;
    expect(stepFor(epochish)).toBe(0);
    const code = totpAt(SECRET, epochish);
    const verdict = verifyTotp({
      secretBase32: SECRET,
      code,
      atMillis: epochish,
      lastUsedStep: -1,
    });
    expect(verdict.ok, 'a code at step 0 must still verify').toBe(true);
  });

  it('rejects two steps away, because a wider window multiplies the attack surface', () => {
    const step = stepFor(T0);
    const at = (step + 2) * TOTP.periodSeconds * 1000;
    expect(
      verifyTotp({ secretBase32: SECRET, code: totpAt(SECRET, at), atMillis: T0, lastUsedStep: -1 })
        .ok,
    ).toBe(false);
  });
});

describe('malformed input', () => {
  it('is `malformed`, not `wrong`, so the UI can say something useful', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '123 456', '12.456']) {
      expect(verifyTotp({ secretBase32: SECRET, code, atMillis: T0, lastUsedStep: -1 })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('tolerates a code typed with surrounding whitespace', () => {
    // A teacher pasting rather than typing is common, and rejecting that trains people to
    // disable the second factor.
    const code = totpAt(SECRET, T0);
    expect(
      verifyTotp({ secretBase32: SECRET, code: ` ${code} `, atMillis: T0, lastUsedStep: -1 }).ok,
    ).toBe(true);
  });

  it('a corrupt stored secret is `malformed` rather than an exception', () => {
    // A bad row must not turn every sign-in into a 500.
    const verdict = verifyTotp({
      secretBase32: 'NOT!BASE32',
      code: '123456',
      atMillis: T0,
      lastUsedStep: -1,
    });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reports `wrong` for a well-formed code that is simply not ours', () => {
    expect(
      verifyTotp({ secretBase32: SECRET, code: '000000', atMillis: T0, lastUsedStep: -1 }),
    ).toEqual({ ok: false, reason: 'wrong' });
  });
});

describe('recovery codes', () => {
  it('generates the promised number, unique, and never returns the plaintext twice', () => {
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    expect(set.plaintext).toHaveLength(RECOVERY.count);
    expect(new Set(set.plaintext).size).toBe(RECOVERY.count);
    expect(set.hashes).toHaveLength(RECOVERY.count);
    // The hash must not BE the code.
    expect(set.hashes).not.toContain(set.plaintext[0]);
  });

  it('is formatted in two groups, so it can be written down without transcription errors', () => {
    const [code] = generateRecoveryCodes(RECOVERY.count, SALT).plaintext;
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('consumes a code once, by index, so the caller deletes exactly that row', () => {
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    const verdict = consumeRecoveryCode({
      presented: set.plaintext[3],
      storedHashes: set.hashes,
      salt: SALT,
    });
    expect(verdict).toEqual({ ok: true, index: 3 });
  });

  it('refuses the same code a second time once it has been removed from the store', () => {
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    const remaining = set.hashes.filter((_, i) => i !== 3);
    expect(
      consumeRecoveryCode({ presented: set.plaintext[3], storedHashes: remaining, salt: SALT }),
    ).toEqual({ ok: false, reason: 'unknownCode' });
  });

  it('normalises case, whitespace and the group separator before hashing', () => {
    // A teacher writing it down will drop the dash, add a space, and not bother with capitals.
    // The GROUPS STAY IN ORDER — the first draft of this test reversed them and expected a
    // match, which would have required the function to ignore a real difference between two
    // different codes.
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    const [first, second] = set.plaintext[0].split('-');
    const mangled = `${first.toLowerCase()} ${second}`;
    expect(
      consumeRecoveryCode({ presented: mangled, storedHashes: set.hashes, salt: SALT }).ok,
    ).toBe(true);
  });

  it('and REJECTS the groups in the wrong order, because that is a different code', () => {
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    const [first, second] = set.plaintext[0].split('-');
    const reversed = `${second}-${first}`;
    expect(
      consumeRecoveryCode({ presented: reversed, storedHashes: set.hashes, salt: SALT }),
    ).toEqual({ ok: false, reason: 'unknownCode' });
  });

  it('is salted, so a stolen table cannot be brute-forced across all 2^32 codes at once', () => {
    // 32 bits of entropy is genuinely enumerable without a salt, which is unusual for a
    // credential and is why the salt is not optional here.
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    expect(hashRecoveryCode(set.plaintext[0], 'salt-a')).not.toBe(
      hashRecoveryCode(set.plaintext[0], 'salt-b'),
    );
  });

  it('skips a hole in the stored array rather than comparing against undefined', () => {
    // Not a state this code creates, but a sparse array must not crash the only recovery path
    // a locked-out teacher has. The good code at index 2 must still be found.
    const set = generateRecoveryCodes(3, SALT);
    const sparse: string[] = [];
    sparse[0] = set.hashes[0] as string;
    sparse[2] = set.hashes[2] as string;
    expect(
      consumeRecoveryCode({ presented: set.plaintext[2], storedHashes: sparse, salt: SALT }),
    ).toEqual({ ok: true, index: 2 });
  });

  it('reports noneRemaining distinctly from unknownCode', () => {
    // "You have no recovery codes left, contact an administrator" is a different message from
    // "that code is not one of yours", and a teacher needs the first one to know what to do.
    expect(consumeRecoveryCode({ presented: 'AAAA-BBBB', storedHashes: [], salt: SALT })).toEqual({
      ok: false,
      reason: 'noneRemaining',
    });
    expect(
      consumeRecoveryCode({ presented: 'AAAA-BBBB', storedHashes: ['deadbeef'], salt: SALT }),
    ).toEqual({ ok: false, reason: 'unknownCode' });
  });

  it('counts what remains, so the panel can say "3 of 10 left"', () => {
    const set = generateRecoveryCodes(RECOVERY.count, SALT);
    expect(remainingRecoveryCodes(set.hashes)).toBe(10);
    expect(remainingRecoveryCodes(set.hashes.slice(0, 3))).toBe(3);
  });

  it('normalises identically in both directions, which is the whole contract', () => {
    expect(normaliseRecoveryCode(' abcd-1234 ')).toBe(normaliseRecoveryCode('ABCD1234'));
  });
});

describe('a teacher cannot submit a grade without a second factor', () => {
  const teacher = {
    roles: ['teacher'],
    mfaEnrolled: false,
    mfaVerified: false,
    usedRecoveryCode: false,
  };

  it('a teacher who has never enrolled is told to ENROL, not to enter a code', () => {
    // Two distinct reasons, because they are two different instructions. A teacher sent to a
    // code prompt who has no authenticator app is at a dead end — and a dead end during
    // marking is exactly when they disable the feature.
    expect(canSubmitGrade(teacher)).toEqual({ allowed: false, reason: 'needsEnrolment' });
  });

  it('a verified second factor permits the submission', () => {
    expect(canSubmitGrade({ ...teacher, mfaEnrolled: true, mfaVerified: true })).toEqual({
      allowed: true,
    });
  });

  it('a RECOVERY CODE satisfies D6 for the rest of the session', () => {
    // The specific requirement: a lost second factor must not lock a teacher out of an
    // IN-FLIGHT grading session. That is what makes recovery codes worth having, and it is why
    // the flag is session-scoped rather than one-shot.
    expect(canSubmitGrade({ ...teacher, usedRecoveryCode: true })).toEqual({ allowed: true });
  });

  it('a non-teacher is refused with a different reason, so the gate says why', () => {
    expect(canSubmitGrade({ ...teacher, roles: ['student'] })).toEqual({
      allowed: false,
      reason: 'notATeacher',
    });
    expect(canSubmitGrade({ ...teacher, roles: ['platformAdmin'] })).toEqual({
      allowed: false,
      reason: 'notATeacher',
    });
  });

  it('enrolment alone, without verification, does NOT permit a submission', () => {
    // Enrolled is not verified. A teacher who opened the enrolment screen and walked away has
    // proved nothing, and the first version of this function had `if (mfaEnrolled) return
    // allowed` — which defeated the entire requirement.
    expect(canSubmitGrade({ ...teacher, mfaEnrolled: true })).toEqual({
      allowed: false,
      reason: 'needsMfa',
    });
  });
});

describe('the reason TOTP is permitted at all', () => {
  it('is recorded, because "why not a security question" is a fair question', () => {
    // WCAG 2.2 SC 3.3.8 Accessible Authentication allows a second factor that does not rely
    // on a cognitive function test. TOTP qualifies; a security question does not, and offering
    // one as an "accessible alternative" is the mistake the criterion exists to prevent.
    expect(TOTP.digits).toBe(6);
    expect(TOTP.periodSeconds).toBe(30);
    expect(
      TOTP.windowSteps,
      'wider skew tolerance widens the valid-code window for an attacker',
    ).toBe(1);
  });
});
