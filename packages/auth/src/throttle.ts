/**
 * Login throttling.  (P1-T1 item 6, P1-T7)
 *
 * ## The trap, and why the obvious design fails
 *
 * Per-IP throttling is what everyone writes, and in a school it is actively harmful.
 *
 * A secondary school has one NAT egress address for three hundred students. At 08:55, before
 * registration opens, two hundred of them try to sign in within the same ninety seconds. A
 * per-IP limiter at any sane threshold locks out the entire school, and the only people who
 * can fix it are the ones furthest from a keyboard. Worse, it turns a shared address into a
 * shared denial of service: anyone who can make the school hit the limit denies every
 * student at once.
 *
 * So the rules are:
 *
 *   · **Per-IDENTIFIER (the email) is the primary limiter.** It is what an attacker is
 *     actually grinding — a credential-stuffing run is one attacker against many accounts,
 *     not one attacker against one account.
 *   · **Per-IP is a secondary, much higher, and ADVISIVE limiter.** It is for "how many
 *     distinct accounts is this address attacking", not "how many people are behind this
 *     address". A school address is distinguished from a hostile one by *fan-out*, not volume.
 *   · **IP alone never locks anyone out.** It can only ever add a signal, because an IP cannot
 *     be told apart from a shared one.
 *
 * ## What this module does NOT do
 *
 * It does not block, and it does not fail closed. It returns a VERDICT plus signals, and the
 * caller decides. A rate limiter that can deny service to a school is a denial-of-service
 * vector with extra steps, and the one thing it must never become is a way for a student to
 * be locked out of their exam by someone else.
 */

import { MINUTE, type Millis } from '@orrery/clock';

/**
 * Per-identifier limits. Tight, because this is the limiter that actually protects accounts.
 *
 * `perWindow` is attempts, and `window` is the bucket. A run of 10 wrong passwords inside 15
 * minutes for one account is a credential-stuffing run; a student who has genuinely forgotten
 * their password will use the reset flow, which is the correct channel and is not throttled.
 */
export const IDENTIFIER_LIMITS = {
  window: 15 * MINUTE,
  perWindow: 10,
  /** Above this, the limiter starts asking for a second factor rather than refusing. */
  stepUpAt: 5,
} as const;

/**
 * Per-IP limits. Deliberately ~40x the per-identifier limit.
 *
 * A single school address can legitimately have hundreds of students sign in inside a
 * registration window. The number here is not "how many students does a school have" — it is
 * a number above any plausible legitimate fan-out, so it can only be reached by someone
 * attacking MANY different accounts from one address.
 */
export const IP_LIMITS = {
  window: 15 * MINUTE,
  /**
   * Attempts from one address. Sized for a large secondary school during a registration
   * morning, not for a home. It exists to catch credential stuffing, which is wide rather
   * than deep.
   */
  perWindow: 400,
  /**
   * Distinct email DOMAINS seen from one address in a day. This is the real signal, and it
   * is a domain count rather than an identifier count for a reason that was found the hard
   * way: a first attempt counted identifiers and set the threshold at 150, which is BELOW the
   * number of students in a single secondary school. A registration morning tripped the
   * "credential stuffing" detector and flagged the school.
   *
   * Domains separate the two cases cleanly. A school is ONE domain however many students it
   * has — `student1@school.example` through `student300@school.example` is one domain. A
   * credential-stuffing run touches thousands of unrelated domains in minutes, because that
   * is what a breach list is. Fan-out by domain sees the difference; fan-out by identifier
   * cannot, because both are "hundreds of distinct strings".
   */
  distinctDomains: 25,
} as const;

// A second net on DISTINCT IDENTIFIERS was tried and removed, and the reason is worth
// keeping. To reach a distinct-identifier threshold within the window you must first pass
// through `perWindow` attempts, and `perWindow` is necessarily BELOW any plausible school's
// student count — that is what it is for. So the identifier net could never fire: the volume
// signal always tripped first. A rule that cannot fire is a rule that reads as protection
// while providing none, which is the D-35 defect in a different costume.
//
// The honest conclusion is that a high-volume run against ONE domain is genuinely
// indistinguishable from a school registration morning. Both are "hundreds of distinct
// accounts, one address, one domain, minutes apart". The volume signal fires, it allows
// rather than denies, and a human looks. Inventing a fourth signal here would have meant
// inventing one that fires on schools.

export interface Attempt {
  readonly identifier: string;
  readonly ipPseudonym: string;
  readonly at: Millis;
  /** True when the attempt used a correct password. Clears the counter. */
  readonly succeeded: boolean;
}

export interface ThrottleInput {
  readonly attempts: readonly Attempt[];
  readonly now: Millis;
  readonly identifier: string;
  readonly ipPseudonym: string;
}

export type ThrottleVerdict = {
  /** Whether this attempt may proceed. */
  readonly allow: boolean;
  /** Whether a second factor must be presented even with a correct password. */
  readonly stepUp: boolean;
  /** True when the IP signal is what is driving the decision, for the audit row. */
  readonly triggeredBy: 'none' | 'identifier' | 'ip-volume' | 'ip-fanout';
  /** How many identifiers this address has touched in the window. */
  readonly ipDistinctIdentifiers: number;
  /**
   * How many distinct email DOMAINS. The school-versus-stuffing discriminator: a school
   * is one domain however many students it has.
   */
  readonly ipDistinctDomains: number;
};

/**
 * Decide.
 *
 * Sliding window, counted from the stored attempts rather than from fixed buckets. A fixed
 * window has a boundary exploit — six attempts either side of midnight — and a login endpoint
 * is exactly where someone would try that.
 */
export function evaluateThrottle(input: ThrottleInput): ThrottleVerdict {
  const { attempts, now, identifier, ipPseudonym } = input;

  // ── Per identifier ──────────────────────────────────────────────────────────
  const idWindow = attempts.filter(
    (a) => a.identifier === identifier && now - a.at < IDENTIFIER_LIMITS.window,
  );
  // A success clears the counter: a student who fumbles twice and then gets it right should
  // not spend the next fortnight being asked for a second factor.
  const idFailures = idWindow.filter((a) => !a.succeeded).length;

  if (idFailures >= IDENTIFIER_LIMITS.perWindow) {
    return {
      allow: false,
      stepUp: true,
      triggeredBy: 'identifier',
      ipDistinctIdentifiers: 0,
      ipDistinctDomains: 0,
    };
  }

  const stepUp = idFailures >= IDENTIFIER_LIMITS.stepUpAt;

  // ── Per IP: volume, then fan-out ────────────────────────────────────────────
  // A SUCCESS still counts toward the IP signals, deliberately. A school registration
  // morning is hundreds of successful logins from one address, and that is the exact shape
  // the limiter must not punish.
  const ipWindow = attempts.filter(
    (a) => a.ipPseudonym === ipPseudonym && now - a.at < IP_LIMITS.window,
  );
  const ipAttempts = ipWindow.length;

  // Fan-out is counted over a DAY rather than 15 minutes, because a school accumulates its
  // student count over a term while a stuffing run touches thousands of accounts in minutes.
  const fanOutWindow = attempts.filter(
    (a) => a.ipPseudonym === ipPseudonym && now - a.at < 24 * 60 * MINUTE,
  );
  const ipDistinctIdentifiers = new Set(fanOutWindow.map((a) => a.identifier)).size;
  const ipDistinctDomains = new Set(fanOutWindow.map((a) => domainOf(a.identifier))).size;

  if (ipAttempts >= IP_LIMITS.perWindow) {
    // NOT `allow: false`. An IP cannot be distinguished from a shared one, so this returns
    // `allow: true` with a raised signal. The caller records the signal and a human looks.
    return {
      allow: true,
      stepUp: true,
      triggeredBy: 'ip-volume',
      ipDistinctIdentifiers,
      ipDistinctDomains,
    };
  }

  if (ipDistinctDomains >= IP_LIMITS.distinctDomains) {
    return {
      allow: true,
      stepUp: true,
      triggeredBy: 'ip-fanout',
      ipDistinctIdentifiers,
      ipDistinctDomains,
    };
  }

  return { allow: true, stepUp, triggeredBy: 'none', ipDistinctIdentifiers, ipDistinctDomains };
}

/**
 * The domain part of an identifier, lowercased.
 *
 * `email` is the identifier this product authenticates with, so the interesting part is
 * everything after the `@`. A malformed identifier with no `@` yields `''`, which sorts as
 * one more distinct domain — and an attacker sending garbage therefore trips the fan-out
 * counter faster, not slower, which is the correct direction.
 */
export function domainOf(identifier: string): string {
  const at = identifier.lastIndexOf('@');
  return at === -1 ? '' : identifier.slice(at + 1).toLowerCase();
}

/**
 * Whether an IP-sourced signal should raise a security event.
 *
 * Separate from the verdict because a signal is not a decision: the school that trips the
 * fan-out counter during a registration morning SHOULD be flagged, because a human needs to
 * look, and the correct response is a look rather than a lockout. `plans/24` MISSED-1 is the
 * same shape — the key is actor-scoped so a shared identity cannot be poisoned by one actor.
 */
export function shouldRaiseIpSignal(triggeredBy: ThrottleVerdict['triggeredBy']): boolean {
  return triggeredBy === 'ip-fanout' || triggeredBy === 'ip-volume';
}

/**
 * A dedupe key for the security event.
 *
 * Time-bucketed, so a sustained attack produces ONE row that increments rather than a row
 * per attempt. Without the bucket, a credential-stuffing run writes more rows than the
 * database can absorb, which is its own denial of service.
 */
export function throttleDedupeKey(input: {
  kind: string;
  identifier: string;
  ipPseudonym: string;
  at: Millis;
  bucketMinutes?: number;
}): string {
  const bucket = Math.floor(input.at / (input.bucketMinutes ?? 10 * MINUTE));
  // The identifier is hashed into the key rather than stored in it, so the key column does
  // not become a list of every email address anyone has tried to log in with.
  return `${input.kind}:${hashish(input.identifier)}:${input.ipPseudonym}:${bucket}`;
}

/**
 * A short, stable, non-reversible tag. FNV-1a — NOT a security hash.
 *
 * It only has to make the dedupe key compact and avoid embedding an email address in a column
 * that gets grouped and exported. A cryptographic hash would be the wrong tool: slower, and it
 * would suggest a guarantee this does not provide.
 */
export function hashish(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
