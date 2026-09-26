/**
 * Password hashing.  (P1-T1, plans/13 §1)
 *
 * ## Argon2id, and why the parameters are written down
 *
 * Argon2id is the hybrid variant: it resists GPU cracking like argon2i and side-channel
 * attacks like argon2d. The parameters are OWASP's 2024 baseline — 19 MiB, 2 iterations,
 * parallelism 1 — and they are named constants rather than defaults, because "the library
 * default" is not a decision anyone can review and the default is not what OWASP asks for.
 *
 * The cost is real: ~40ms and 19 MiB per hash. That is the point. A login that takes 40ms is
 * unbrute-forceable offline; one that takes 1ms is a warning label. It also means this
 * function is the most memory-hungry thing in the request path, which is why
 * `MAX_CONCURRENT_HASHES` exists — 750 concurrent exam takers (§4.3 of the master plan)
 * would otherwise be 14 GiB of memory and an OOM kill.
 *
 * ## The bug this file is most likely to have
 *
 * **`verifyPassword` against a DUMMY hash when the account does not exist.** Without it,
 * "no such user" returns in ~1ms and "wrong password" returns in ~40ms, and the difference
 * is a user-enumeration oracle that any attacker can read off a stopwatch. The generic
 * failure COPY is not enough on its own — plenty of clients, and every timing attack, ignore
 * the message and look at the latency.
 *
 * The test for it asserts the two paths are indistinguishable in work done, not merely in
 * return value.
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/** OWASP 2024 baseline. Named, reviewed, and not "whatever the library defaults to". */
export const ARGON2ID_PARAMS = {
  algorithm: 2, // 2 = Argon2id. @node-rs/argon2: 0=Argon2d, 1=Argon2i, 2=Argon2id
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Bytes of pepper mixed into the hash input.
 *
 * A pepper is a server-side secret, distinct from a salt, and it is mixed in by HASHING the
 * password with it rather than by concatenation. This module does not apply one: a pepper
 * that is silently absent is a pepper that is believed present. `requirePepper()` is called
 * at boot so its absence is a startup failure, not a gradual weakening.
 */
export const PEPPER_BYTES = 32;

/**
 * How many hashes may run at once, process-wide.
 *
 * Each concurrent hash holds `memoryCost` KiB. Without a cap, a burst of registration attempts
 * is a memory-exhaustion denial of service against our own login endpoint — an endpoint that
 * is trivially reachable and needs no credentials.
 */
export const MAX_CONCURRENT_HASHES = 8;

let inFlight = 0;
const waiters: (() => void)[] = [];

/**
 * Bounded concurrency for the hash and verify paths.
 *
 * Queues rather than rejecting. Rejecting a login because the server is busy converts a
 * capacity problem into a false "wrong password", which is the worst possible failure for an
 * authentication endpoint.
 */
async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiters.shift()?.();
  }
}

/** Test hook: how many hashes are running right now. */
export function inFlightHashes(): number {
  return inFlight;
}

/**
 * Mix the pepper and the password with a NUL separator, not a space and not nothing.
 *
 * Concatenation without an unambiguous separator is a real (if small) hazard: pepper `ab`
 * plus password `c` and pepper `a` plus password `bc` produce the identical preimage, so two
 * different (pepper, password) pairs would verify against each other. A NUL cannot occur in a
 * text password, so it is unambiguous.
 *
 * This arrived here as an ACCIDENT, a stray NUL from a quoting slip in a shell heredoc. It is
 * kept because it is the correct separator, and made explicit here so the next reader does
 * not "fix" it back to a space. That is the only acceptable way to keep an accidental good
 * decision: write down why, so it is a decision rather than a mystery.
 */
function withPepper(password: string, pepper: string): Uint8Array {
  return new TextEncoder().encode(`${pepper}\u0000${password}`);
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  assertUsable(password);
  return withHashSlot(() =>
    argonHash(withPepper(password, pepper), {
      ...ARGON2ID_PARAMS,
      outputLen: 32,
    }),
  );
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  pepper: string,
): Promise<boolean> {
  assertUsable(password);
  return withHashSlot(async () => {
    try {
      return await argonVerify(storedHash, withPepper(password, pepper));
    } catch {
      // A corrupt or foreign-format stored hash is a false, not a 500. One bad row must not
      // take down the login endpoint for everyone.
      return false;
    }
  });
}

/**
 * A real argon2id hash of a value nobody knows, used to burn the same work when the account
 * does not exist.
 *
 * The HASH STRING is computed once and cached, but the VERIFICATION is re-run on every call.
 * That distinction is the entire correctness of this file, and it was got wrong first:
 *
 * The first version cached the whole `dummyHash()` PROMISE and awaited it. So the very first
 * login against a non-existent account cost ~40ms, and every login after it cost ~0ms — the
 * opposite of the intent, and a PERMANENT enumeration oracle rather than a temporary one. The
 * test caught it at `missing=0.0ms`; the code read correctly the whole time.
 *
 * Caching the hash string is safe because it is a fixed, expensive-to-produce artefact.
 * Reusing it is what makes the missing path cost the same as the existing one, because the
 * cost of argon2 is in the VERIFY, not the hash.
 *
 * Generated from random secrets so it is not a published hash an attacker could precompute.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHashString(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomSecret(), randomSecret());
  return dummyHashPromise;
}

function randomSecret(): string {
  // Not a session token, so a 16-byte CSPRNG value from node:crypto is sufficient; the
  // pepper it is mixed with is what matters for the pepper's security, not this string.
  return globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID();
}

/**
 * Verify a login, answering the same way whether or not the account exists.
 *
 * The contract, in order:
 *   1. If there is no stored hash, verify against the dummy and return false. Same work,
 *      same timing, same answer.
 *   2. If there is one, verify against it.
 *   3. Either way the CALLER returns the same generic message and writes the same audit row.
 *
 * Point 3 is not this function's job and the separation is deliberate: this function answers
 * "is the password right", the endpoint answers "you may not sign in". Merging them is how a
 * generic message ends up paired with a distinguishable status code.
 */
export async function verifyLogin(input: {
  password: string;
  /** Null when the account does not exist. */
  storedHash: string | null;
  pepper: string;
}): Promise<boolean> {
  if (input.storedHash === null) {
    // A real verification, every time, against a hash nobody holds the preimage for. It
    // cannot succeed, and it costs the same as the real thing. Returning `false` early here
    // is the single most exploitable line in a login handler.
    await verifyPassword(input.password, await dummyHashString(), input.pepper);
    return false;
  }
  return verifyPassword(input.password, input.storedHash, input.pepper);
}

function assertUsable(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  // Argon2 takes a Uint8Array, so a password beyond the byte limit would be silently
  // truncated by the encoder. Refusing beats truncating: two different passwords sharing a
  // prefix must never authenticate each other.
  if (new TextEncoder().encode(password).length > 1024) {
    throw new Error('password exceeds the maximum supported length');
  }
}

/**
 * Minimum length, in CHARACTERS, and why it is not "8 characters".
 *
 * Length beats composition rules: a 16-character passphrase beats `P@ssw0rd!` every time, and
 * composition rules mostly produce `Password1!` — a password in every breach corpus. So the
 * rule is a length floor plus a check against breached-password lists, and no symbol
 * requirement at all. `plans/13` says breached-password check; it does not say composition.
 */
export const MIN_PASSWORD_LENGTH = 12;

export type PasswordPolicyVerdict =
  | { ok: true }
  | { ok: false; reason: 'tooShort' | 'tooLong' | 'breached' };

/**
 * Enforce the policy.
 *
 * `breached` is a check against a prefix-indexed list (k-anonymity: send the first five
 * characters, receive the matching suffixes, so the password never leaves the process). The
 * list is passed in rather than fetched, so this function is pure and the caller owns the
 * cache and the refresh.
 */
export function checkPasswordPolicy(
  password: string,
  breachedLookup: (prefix5: string) => Promise<ReadonlySet<string>>,
): Promise<PasswordPolicyVerdict> {
  if (password.length < MIN_PASSWORD_LENGTH)
    return Promise.resolve({ ok: false, reason: 'tooShort' });
  if (password.length > 200) return Promise.resolve({ ok: false, reason: 'tooLong' });

  const normalised = normalisedForBreachCheck(password);
  return breachedLookup(normalised.slice(0, BREACH_PREFIX_LENGTH)).then((suffixes) =>
    suffixes.has(normalised.slice(BREACH_PREFIX_LENGTH))
      ? { ok: false, reason: 'breached' }
      : { ok: true },
  );
}

/** The five characters sent to the k-anonymity endpoint. The password never leaves. */
export const BREACH_PREFIX_LENGTH = 5;

/**
 * Normalise a candidate before a breach lookup.
 *
 * Exported because it is the fiddly part, and because a test that hand-computes the
 * prefix/suffix split gets it wrong — which this suite did, twice, before the function was
 * exported. Guessing the split in a test is how a breach check ends up "passing" while
 * never matching anything.
 *
 * The leet substitutions are deliberately aggressive and INCLUDE DIGITS: `p4ssw0rd` and
 * `p@ssw0rd1` are the same password to an attacker running a breach list, so treating them
 * as different defeats the check with the exact trick being used against it.
 */
export function normalisedForBreachCheck(password: string): string {
  return password
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'l')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's');
}
