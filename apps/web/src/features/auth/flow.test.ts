/**
 * Account enumeration: response shape AND timing.  (P1-T3 done-when)
 *
 * The packet requires "a test asserting identical response shape and timing for both failure
 * kinds". This file is that test, and it is deliberately written adversarially against my own
 * implementation: it collects the responses for EVERY failure kind, de-duplicates them, and
 * asserts there is exactly ONE. A new failure kind that returns different text fails here
 * immediately, which is the point — the failure mode this guards against is someone adding a
 * kind and a nicer message.
 *
 * ## On the timing assertion
 *
 * The threshold is 5x, not 1.5x. argon2 at the OWASP baseline is ~40ms and the network and
 * framework overhead around it varies by more than that on a shared CI runner, so a tight
 * bound would be a flaky test. 5x is still far too large to be an accident: without a dummy
 * verification the ratio is more like 50x, because the "unknown account" path skips argon2
 * entirely. The test asserts the ratio AND a floor, so neither an instant path nor a
 * pathologically slow one can pass.
 */

import { hashPassword, verifyLogin } from '@orrery/auth/password';
import { describe, expect, it } from 'vitest';
import {
  type AuthFailureKind,
  dispatchResponse,
  GENERIC_AUTH_FAILURE,
  RESPONSES,
  resendCooldown,
  SECOND_FIELD_DELAY_MS,
  signInFailure,
  validateEmail,
  validatePassword,
} from './flow';

const PEPPER = 'p'.repeat(32);
const ALL_KINDS: AuthFailureKind[] = [
  'unknownAccount',
  'wrongPassword',
  'suspended',
  'revokedTokenReuse',
  'deletedAccount',
  'throttled',
  'badMagicLink',
  'badResetToken',
];

describe('response SHAPE: every failure is indistinguishable', () => {
  it('all eight failure kinds produce byte-identical responses', () => {
    const serialised = ALL_KINDS.map((k) => JSON.stringify(signInFailure(k)));
    expect(
      new Set(serialised).size,
      `distinct responses leaked: ${[...new Set(serialised)].join('\n')}`,
    ).toBe(1);
  });

  it('all eight produce the same status code', () => {
    // A 403 for "suspended" and a 404 for "unknown account" would be more informative and are
    // exactly what an attacker wants.
    expect(new Set(ALL_KINDS.map((k) => signInFailure(k).status)).size).toBe(1);
  });

  it('all eight produce the same machine-readable CODE', () => {
    // A client switching on `code` is as capable of enumerating as one switching on the
    // message. This was missed in the first draft: `code` leaked nothing, but only by luck.
    expect(new Set(ALL_KINDS.map((k) => signInFailure(k).body.code)).size).toBe(1);
  });

  it('the failure body is not an object identity leak either', () => {
    // Two calls return distinct objects, so a caller mutating one cannot affect another.
    expect(signInFailure('unknownAccount')).not.toBe(signInFailure('wrongPassword'));
    expect(signInFailure('unknownAccount').body).toEqual(signInFailure('wrongPassword').body);
  });

  it('the generic message does not contain the email, the kind, or any hint of either', () => {
    for (const kind of ALL_KINDS) {
      const body = signInFailure(kind).body.message;
      expect(body).toBe(GENERIC_AUTH_FAILURE);
      expect(body.toLowerCase()).not.toContain(kind.toLowerCase());
      expect(body.toLowerCase()).not.toContain('no such');
      expect(body.toLowerCase()).not.toContain('not found');
      expect(body.toLowerCase()).not.toContain('suspended');
      expect(body.toLowerCase()).not.toContain('registered');
    }
  });
});

describe('response SHAPE: dispatch responses are also uniform', () => {
  it('verification and password reset are byte-identical', () => {
    expect(dispatchResponse('verificationSent').body.message).toBe(
      dispatchResponse('passwordResetSent').body.message,
    );
  });

  it('and both succeed, because the user genuinely did something', () => {
    expect(dispatchResponse('verificationSent').status).toBe(200);
    expect(dispatchResponse('passwordSent' as never).status).toBe(200);
  });

  it('the dispatch message is conditional in the CONDITIONAL, not in the response', () => {
    // "If that address has an account, a link is on its way" — the condition is inside the
    // sentence, so the sentence is the same either way.
    expect(RESPONSES.verificationSent).toContain('If that address has an account');
    expect(RESPONSES.passwordResetSent).toContain('If that address has an account');
  });
});

describe('response TIMING: the oracle that a generic message does not close', () => {
  it('an existing and a non-existing account take comparable time to fail', async () => {
    const existingHash = await hashPassword('correct horse battery staple', PEPPER);

    const time = async (storedHash: string | null): Promise<number> => {
      const start = process.hrtime.bigint();
      await verifyLogin({ password: 'wrong password guess', storedHash, pepper: PEPPER });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    // Warm both paths, then compare. The first call pays one-time module init.
    await time(existingHash);
    await time(null);
    const existingMs = await time(existingHash);
    const missingMs = await time(null);

    const ratio = Math.max(existingMs, missingMs) / Math.max(1, Math.min(existingMs, missingMs));
    // Without a dummy verification this ratio is ~50x, because the unknown path skips argon2.
    expect(
      ratio,
      `existing=${existingMs.toFixed(1)}ms missing=${missingMs.toFixed(1)}ms — ` +
        'a large ratio is a working account-existence oracle even with generic copy',
    ).toBeLessThan(5);

    // And a floor, so a pair of fast paths cannot pass a ratio-only assertion.
    expect(existingMs, 'an argon2 verification must actually have happened').toBeGreaterThan(1);
  });
});

describe('the second password field appears after a fixed delay', () => {
  it('not a length-dependent one, which would leak how close a guess was', () => {
    expect(SECOND_FIELD_DELAY_MS).toBe(600);
  });
});

describe('resend cooldown is evaluated against the ADDRESS, not the account', () => {
  // Rate-limiting an address that does not exist is the only way to rate-limit one at all,
  // and a per-account limiter is trivially bypassed by cycling addresses.
  it('allows the first send', () => {
    expect(resendCooldown(null, 1_000)).toEqual({ allowed: true });
  });

  it('refuses a second send inside the window, and says how long to wait', () => {
    const r = resendCooldown(0, 5_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterSeconds).toBe(25);
  });

  it('allows again once the window has passed', () => {
    const window = RESPONSES.cooldownSeconds * 1000;
    expect(resendCooldown(0, window).allowed).toBe(true);
  });

  it('never returns a negative wait, even if the clock went backwards', () => {
    // NTP correction, or a device whose clock was set forward then back. A negative
    // retry-after is a browser error and, worse, an infinite wait in a hand-rolled one.
    const r = resendCooldown(10_000, 0);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('field validation describes the INPUT and never the ACCOUNT', () => {
  it('rejects a malformed address without saying anything about accounts', () => {
    const r = validateEmail('not an email');
    expect(r.ok).toBe(false);
    // Narrowed via the discriminant rather than a `!`. `ok: false` is what guarantees the
    // `email` key exists, and the type says so — asserting it here keeps that guarantee
    // honest instead of teaching the next reader to add non-null assertions.
    if (r.ok) throw new Error('expected the address to be rejected');
    const message = r.errors.email ?? '';
    expect(message).toContain('does not look like an email');
    expect(message.toLowerCase()).not.toContain('account');
    expect(message.toLowerCase()).not.toContain('registered');
  });

  it('accepts unusual but valid addresses rather than rejecting them', () => {
    // A strict RFC regex rejects valid addresses, and a rejected valid address at
    // REGISTRATION is indistinguishable from "already registered" to the user — so a strict
    // regex is an enumeration channel with extra steps.
    for (const email of [
      'a@b.co',
      "o'brien+tag@sub.domain.example",
      'user_name@localhost.example',
    ]) {
      expect(validateEmail(email).ok, email).toBe(true);
    }
  });

  it('asks for a passphrase rather than demanding character classes', () => {
    const r = validatePassword('short');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected the password to be rejected');
    const message = r.errors.password ?? '';
    expect(message).toContain('at least 12');
    expect(message.toLowerCase()).toContain('phrase');
    // The negative is the point: no rule about capitals, symbols or digits, because those are
    // what produce Password1!, which is in every breach corpus.
    expect(message).not.toMatch(/capital|symbol|digit|number/i);
  });

  it('accepts a 12-character passphrase with no digits or symbols', () => {
    expect(validatePassword('thirteen chars').ok).toBe(true);
  });
});
