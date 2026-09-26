/**
 * TOTP second factor.  (P1-T9, D6)
 *
 * ## Why TOTP is permitted at all
 *
 * `plans/15` §1.1 accepts TOTP for one reason: WCAG 2.2 **3.3.8 Accessible Authentication**
 * permits a second factor that does not rely on a cognitive function test. TOTP is a number
 * from a device the user already has, so it does not require remembering anything, unlike a
 * security question — which is precisely why a cognitive test is refused rather than offered as
 * an alternative for users who find TOTP difficult.
 *
 * ## The bug this file is most likely to have
 *
 * **TOTP code REPLAY.** A valid code is valid for a whole 30-second window, so an attacker who
 * observes or phishes one has up to 30 seconds to use it, and — worse — the *legitimate* user
 * then cannot, because the code is spent. Naive implementations verify the code and nothing
 * else.
 *
 * `verifyTotp` therefore takes `lastUsedStep` and rejects any `step` less than or equal to it.
 * The counter must advance on EVERY successful verification, and must be persisted in the same
 * write as the session refresh — otherwise a crash between them reopens the window.
 *
 * This is RFC 6238's own advice (section 5.2) and almost every hand-rolled implementation omits
 * it.
 *
 * ## Recovery codes
 *
 * Generated once, shown once, hashed at rest, single use. A recovery code is a bearer
 * credential for a whole account, so the storage is the same as a password: a hash, and a
 * comparison that is constant-time.
 *
 * The design decision worth naming: a recovery code is consumed by a RECORDED event, not
 * silently. A teacher who has used three of ten codes needs to know that, and needs a
 * remaining count, or they find out when they are locked out mid-grading.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238: 30-second steps, 6 digits. */
export const TOTP = {
  digits: 6,
  periodSeconds: 30,
  /**
   * How many steps of clock skew to tolerate, in each direction.
   *
   * One step either side. Phone clocks drift, and a teacher whose second factor fails because
   * their phone is 20 seconds fast will disable MFA entirely — which is worse than a slightly
   * wider window. Wider than ±1 is not accepted: it multiplies the attacker's valid-code
   * window, and the skew is a real, measurable problem rather than an unbounded one.
   */
  windowSteps: 1,
} as const;

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Crockford-ish base32, no padding, uppercase. Secrets are typed by hand often enough. */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += base32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += base32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = base32.indexOf(char);
    if (index === -1) throw new Error('not valid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** A 20-byte secret, base32. 160 bits is RFC 4226's recommendation. */
export function generateSecret(bytes: Uint8Array = new Uint8Array(randomBytes(20))): string {
  return encodeBase32(bytes);
}

/**
 * The time step for an instant: `floor(unixSeconds / 30)`.
 *
 * Exported because the replay defence is stated in terms of it, and a test that has to
 * reverse-engineer the counter to check replay protection is a test that quietly stops testing
 * it.
 */
export function stepFor(atMillis: number): number {
  return Math.floor(atMillis / 1000 / TOTP.periodSeconds);
}

function hotp(secret: Uint8Array, step: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(buffer).digest();
  // RFC 4226 dynamic truncation: the low nibble of the LAST byte is the offset, and the four
  // bytes from there are the truncated value with its top bit masked off.
  //
  // `readUInt32BE` rather than four indexed reads. The indexed version needed a `?? 0` on each
  // byte — unreachable fallbacks (a SHA-1 digest is 20 bytes and the offset is at most 15, so
  // offset+3 <= 18) that exist only to satisfy `noUncheckedIndexedAccess`, and that dragged the
  // branch coverage below 100%. `readUInt32BE` THROWS on an out-of-range offset, which is the
  // honest behaviour: if the assumption were ever violated we would find out immediately rather
  // than silently produce a wrong code.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP.digits).padStart(TOTP.digits, '0');
}

/**
 * The code for one step. Exported so tests can assert on real codes rather than on the
 * verifier's opinion of them — a verifier tested only against itself agrees with its own bugs.
 */
export function totpAt(secretBase32: string, atMillis: number): string {
  return hotp(decodeBase32(secretBase32), stepFor(atMillis));
}

export type TotpVerdict =
  | { ok: true; step: number }
  | { ok: false; reason: 'malformed' | 'wrong' | 'replayed' };

/**
 * Verify a submitted code, with REPLAY protection.
 *
 * `lastUsedStep` is the highest step this account has already spent. A code from that step or
 * an earlier one is `replayed`, which is a distinguishable and a more useful answer than
 * `wrong`: the user is not typing badly, the code is spent, and telling them "that code has
 * already been used, wait for the next one" saves a support call.
 *
 * A successful verification MUST persist `step` as the new `lastUsedStep`. That is the
 * caller's job, and `advanceLastUsedStep` is exported to make it a one-liner rather than
 * something each call site re-derives.
 */
export function verifyTotp(input: {
  secretBase32: string;
  code: string;
  atMillis: number;
  lastUsedStep: number;
}): TotpVerdict {
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'malformed' };

  let secret: Uint8Array;
  try {
    secret = decodeBase32(input.secretBase32);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const current = stepFor(input.atMillis);
  for (let offset = -TOTP.windowSteps; offset <= TOTP.windowSteps; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    // Constant-time over the CANDIDATE STEPS too: an early return on the first mismatch would
    // leak which offset matched, which tells an attacker how far their clock differs from
    // ours — a small leak, and free to close.
    if (constantTimeEquals(hotp(secret, step), code)) {
      if (step <= input.lastUsedStep) return { ok: false, reason: 'replayed' };
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'wrong' };
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Fixed length by construction (`padStart(digits)`), so this is a real comparison and not a
  // length leak. The guard is here so a future digit-count change cannot turn it into one.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The value to persist after a success. Monotonic, so a stale write cannot lower it. */
export function advanceLastUsedStep(current: number, verifiedStep: number): number {
  return Math.max(current, verifiedStep);
}

// ── Recovery codes ────────────────────────────────────────────────────────────

export const RECOVERY = {
  /** Ten. Printed on a page that will never render them again. */
  count: 10,
  /**
   * Two groups of four, so it can be read aloud or written down without transcription
   * errors. 32 bits of entropy per code is deliberate: these bypass the second factor
   * entirely, so each one deserves more than the 6 digits a TOTP shows.
   */
  groupsPerCode: 2,
  groupLength: 4,
} as const;

export type RecoveryCode = { readonly code: string; readonly hash: string };

export interface RecoverySet {
  /** Shown exactly once, never persisted in this form. */
  readonly plaintext: readonly string[];
  /** What is stored. */
  readonly hashes: readonly string[];
}

/**
 * Generate a recovery set.
 *
 * `plaintext` is returned so the caller can render it once. It is NEVER written to the
 * database, never logged, and never included in an audit event — an audit trail containing
 * live recovery codes is a credential store with a retention policy.
 */
export function generateRecoveryCodes(
  count = RECOVERY.count,
  /**
   * REQUIRED, not optional.
   *
   * The first version of this function defaulted the salt to `undefined`, which produced
   * `createHmac('sha256', undefined)` — a hash with no key. Every code it generated was then
   * unverifiable, because `consumeRecoveryCode` is called WITH the salt and could never
   * reproduce it. So a teacher would have been shown ten recovery codes, written them down, and
   * found that none worked.
   *
   * It is a required positional argument so that this cannot recur. The test suite caught it
   * because a generated code failed to verify, which is the only reason to distrust a generator
   * that appears to work.
   */
  salt: string,
): RecoverySet {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const groups = Array.from({ length: RECOVERY.groupsPerCode }, () =>
      randomBytes(2).toString('hex').slice(0, RECOVERY.groupLength).toUpperCase(),
    );
    const code = groups.join('-');
    plaintext.push(code);
    hashes.push(hashRecoveryCode(code, salt));
  }
  return { plaintext, hashes };
}

/**
 * Hash a recovery code for storage.
 *
 * SHA-256 with a per-deployment salt supplied by the caller. NOT bcrypt/argon2: these are
 * 32 bits of high-entropy random data, not a human-chosen password, so a slow KDF buys
 * nothing and costs a teacher several seconds on every recovery. The salt is what stops a
 * stolen table from being brute-forced across all 2^32 codes at once — which at 32 bits is
 * genuinely feasible, so the salt matters here in a way it would not for a real password.
 */
export function hashRecoveryCode(code: string, salt: string): string {
  return createHmac('sha256', salt).update(normaliseRecoveryCode(code)).digest('hex');
}

/**
 * Normalise before hashing or comparing.
 *
 * Strips the group separator as well as whitespace and case. A teacher who writes `ABCD1234`
 * instead of `ABCD-1234` has entered the right code, and telling them it is unknown is the
 * single most likely way a recovery code gets abandoned at the moment it is needed.
 */
export function normaliseRecoveryCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

export type RecoveryVerdict =
  | { ok: true; index: number }
  | { ok: false; reason: 'unknownCode' | 'noneRemaining' };

/**
 * Consume a recovery code.
 *
 * Returns the INDEX rather than a boolean, because the caller must delete exactly that row and
 * must not be able to delete the wrong one — a boolean plus a `findIndex` re-run is two
 * comparisons of a secret, and the second one could land differently.
 */
export function consumeRecoveryCode(input: {
  presented: string;
  storedHashes: readonly string[];
  salt: string;
}): RecoveryVerdict {
  if (input.storedHashes.length === 0) return { ok: false, reason: 'noneRemaining' };
  const presented = hashRecoveryCode(input.presented, input.salt);
  for (let i = 0; i < input.storedHashes.length; i += 1) {
    const stored = input.storedHashes[i];
    // Skip a hole rather than comparing `undefined`. A sparse array is not a state this code
    // creates, and comparing `undefined` to a hash would be a comparison against a value that
    // cannot match — safe, but it hides the shape of the data.
    if (stored === undefined) continue;
    if (constantTimeEquals(stored, presented)) return { ok: true, index: i };
  }
  return { ok: false, reason: 'unknownCode' };
}

/** How many codes remain, for the "3 of 10 left" panel. */
export function remainingRecoveryCodes(storedHashes: readonly string[]): number {
  return storedHashes.length;
}

/**
 * Whether a teacher may submit a grade.  (D6)
 *
 * ## The rule
 *
 * A teacher must have a VERIFIED second factor before their first grade submission, because a
 * compromised teacher account is the highest-value attack in this product: it can change every
 * mark in every class they teach.
 *
 * ## Why this is a separate function and not a matrix cell
 *
 * Because "has MFA enrolled" is not the same question as "has MFA verified right now", and the
 * matrix can only be given one answer. The matrix answers "may this teacher grade THIS
 * classroom"; this answers "may this teacher grade AT ALL, today".
 *
 * A teacher mid-grading session is allowed through: re-prompting for a TOTP on every grade
 * submission would make bulk grading impossible, and the threat model is a hijacked session,
 * not a bored teacher.
 */
/**
 * Two distinct reasons, not one.
 *
 * "You have not set up a second factor" and "enter your second factor" are different
 * instructions, and sending a teacher who has never enrolled to a code prompt is a dead end.
 * The UI cannot distinguish them from a single reason code, and a dead end during marking is
 * exactly when a teacher disables the feature.
 */
export function canSubmitGrade(input: {
  readonly roles: readonly string[];
  readonly mfaEnrolled: boolean;
  /** Verified in THIS session. */
  readonly mfaVerified: boolean;
  /** A recovery code was used in this session, which satisfies D6 for the session's life. */
  readonly usedRecoveryCode: boolean;
}): { allowed: boolean; reason?: 'needsEnrolment' | 'needsMfa' | 'notATeacher' } {
  if (!input.roles.includes('teacher')) return { allowed: false, reason: 'notATeacher' };
  // A recovery code satisfies the requirement for the REST OF THE SESSION. That is the whole
  // point of having them: the teacher who lost their phone can finish grading today and
  // re-enrol tomorrow, instead of being locked out of marks they are holding.
  if (input.mfaVerified || input.usedRecoveryCode) return { allowed: true };
  // NOT `if (input.mfaEnrolled) return { allowed: true }`. The first version had that line, and
  // it defeated the entire requirement: a teacher who had opened the enrolment screen and
  // walked away could grade, having proved nothing. Enrolment is a SETUP state; verification is
  // a PROOF. Conflating them is the mistake D6 exists to prevent, and it was made here.
  return {
    allowed: false,
    reason: input.mfaEnrolled ? 'needsMfa' : 'needsEnrolment',
  };
}
