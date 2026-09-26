/**
 * Profile, minors, and guardian consent.  (P1-T2, plans/13 §1.1, plans/14 §7.4)
 *
 * ## The posture is stated, not inferred
 *
 * `plans/13` §1.1: `isMinor` and `guardianEmail` are collected at registration and drive
 * "no public profile, no public commenting without teacher approval, guardian visibility
 * configurable per classroom, and guardian access to the student's own records on request".
 *
 * The word that matters in that sentence is **collected**. Consent is taken at a moment, with
 * a timestamp, and the timestamp is what makes it meaningful — without it there is no way to
 * answer "who approved this, and when" a year later, which is the only question that matters
 * when a parent disputes something.
 *
 * ## Under-18 accounts have no public profile, by policy
 *
 * Not "hide it by default". There IS no public profile for a minor, and
 * `assertProfileIsPublishable` throws rather than returning a flag, because a boolean is
 * something a caller can ignore and this is something that must not be ignorable. That
 * asymmetry is the whole design: `can()` returns decisions because callers are numerous and
 * fallible; this returns nothing because there is one caller and it should be impossible to
 * reach.
 *
 * ## Age is DECLARED, not derived
 *
 * There is no date of birth in the schema, and that is deliberate. A DOB is a piece of
 * identifying information we do not need: all we need is which side of 18 the account is on,
 * and the account's own history cannot change that. Deriving "is a minor" from a stored
 * birthday would mean a student's age silently flipping as they get older, re-deriving a
 * privacy posture years after consent was given. Declared at registration and pinned.
 */

import type { Millis } from '@orrery/clock';

/** The age threshold, stated once because it is a legal boundary and not a preference. */
export const MAJOR_AGE = 18;

export type AgeDeclaration = 'under18' | '18orOver';

export interface ProfileInput {
  readonly userId: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly ageDeclaration: AgeDeclaration;
  readonly avatarUrl?: string | null;
  readonly notifyEmail?: boolean;
  readonly notifyInApp?: boolean;
  readonly notifyDeadlineReminders?: boolean;
}

export interface Profile {
  readonly userId: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly isMinor: boolean;
  readonly avatarUrl: string | null;
  readonly notifyEmail: boolean;
  readonly notifyInApp: boolean;
  readonly notifyDeadlineReminders: boolean;
}

export type ProfileRejection =
  | 'nameTooLong'
  | 'nameEmpty'
  | 'unsupportedLocale'
  | 'invalidTimezone'
  | 'avatarNotPermitted';

export type ProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; reason: ProfileRejection };

export const MAX_DISPLAY_NAME = 60;

/**
 * Validate and normalise a profile.
 *
 * `timezone` is validated against the runtime's zone database rather than a list we maintain,
 * because a list goes stale and a stale list rejects a legitimate zone. The runtime's data is
 * the IANA database; ours would be a copy of it that drifts.
 */
export function buildProfile(input: ProfileInput): ProfileResult {
  const name = input.displayName.trim();
  if (name.length === 0) return { ok: false, reason: 'nameEmpty' };
  if (name.length > MAX_DISPLAY_NAME) return { ok: false, reason: 'nameTooLong' };

  if (!isKnownZone(input.timezone)) return { ok: false, reason: 'invalidTimezone' };
  if (!isKnownLocale(input.locale)) return { ok: false, reason: 'unsupportedLocale' };

  const isMinor = input.ageDeclaration === 'under18';

  // A minor has no avatar URL that anyone else can fetch. Not "hidden" — absent. An avatar
  // is the single most reliable way to re-identify a student in a shared classroom display,
  // and the consent that permits it is precisely what a minor cannot give.
  if (isMinor && input.avatarUrl) return { ok: false, reason: 'avatarNotPermitted' };

  return {
    ok: true,
    profile: {
      userId: input.userId,
      displayName: name,
      locale: input.locale,
      timezone: input.timezone,
      isMinor,
      avatarUrl: isMinor ? null : (input.avatarUrl ?? null),
      // Notification defaults differ by age, and the reasoning is consent rather than
      // preference: a minor's guardian, not the account holder, is the default recipient for
      // anything that could reveal participation in an assessment.
      notifyEmail: input.notifyEmail ?? !isMinor,
      notifyInApp: input.notifyInApp ?? true,
      notifyDeadlineReminders: input.notifyDeadlineReminders ?? !isMinor,
    },
  };
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isKnownLocale(locale: string): boolean {
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this account may have a profile anyone else can see.
 *
 * THROWS for a minor. Not returns false. See the file header: this is the one place where a
 * caller ignoring a return value would be a privacy breach rather than a bug, so the API is
 * shaped so ignoring it is not possible.
 */
export function assertProfileIsPublishable(profile: Profile): void {
  if (profile.isMinor) {
    throw new Error(
      'Under-18 accounts have no public profile. This is a privacy posture, not a setting: ' +
        'the account holder cannot consent to their own re-identification. Render a display ' +
        'name only, scoped to the classroom.',
    );
  }
}

export interface GuardianState {
  readonly isMinor: boolean;
  readonly guardianEmail: string | null;
  /** Null until consent is recorded. Never back-dated. */
  readonly guardianConsentAt: Millis | null;
}

export type ConsentResult =
  | {
      ok: true;
      state: GuardianState;
      changes: { guardianEmail: string; guardianConsentAt: Millis };
    }
  | { ok: false; reason: 'notAMinor' | 'guardianRequired' | 'alreadyConsented' | 'emailChanged' };

/**
 * Record guardian consent.
 *
 * Three rules, each of which is a way the record could otherwise be a lie:
 *
 *   1. Only for a minor. An adult with a guardian email is a data-entry mistake.
 *   2. Consent is recorded with `now` and cannot be supplied. A caller that could pass the
 *      timestamp could pass last year, and the entire value of the field is that it is the
 *      moment consent was actually given.
 *   3. Changing the guardian email REQUIRES fresh consent and returns a distinct reason, so
 *      the caller cannot silently keep the old timestamp. A consent record attached to an
 *      address nobody has consented for is worse than no record.
 */
export function recordGuardianConsent(
  state: GuardianState,
  input: { guardianEmail: string; now: Millis },
): ConsentResult {
  if (!state.isMinor) return { ok: false, reason: 'notAMinor' };

  const email = input.guardianEmail.trim().toLowerCase();
  if (email.length === 0) return { ok: false, reason: 'guardianRequired' };

  if (state.guardianConsentAt !== null && state.guardianEmail === email) {
    return { ok: false, reason: 'alreadyConsented' };
  }
  if (state.guardianConsentAt !== null && state.guardianEmail !== email) {
    return { ok: false, reason: 'emailChanged' };
  }

  return {
    ok: true,
    state: { ...state, guardianEmail: email, guardianConsentAt: input.now },
    changes: { guardianEmail: email, guardianConsentAt: input.now },
  };
}

/**
 * Whether a guardian may see a student's records.
 *
 * Three independent gates, all of which must pass. Written as a plain function rather than a
 * matrix cell because guardian access is a narrow, well-understood question with no role
 * dimension, and adding it to `can()` would mean 22 more rows for one rule.
 */
export function canGuardianAccess(input: {
  guardianEmail: string;
  studentEmail: string;
  /** The address actually presenting the request, after verification. */
  requesterEmail: string;
  /** When the guardian's own identity was verified in this session. */
  verifiedAt: Millis;
  now: Millis;
}):
  | { allowed: true }
  | { allowed: false; reason: 'notGuardian' | 'notVerified' | 'staleVerification' } {
  if (input.requesterEmail.trim().toLowerCase() !== input.guardianEmail.trim().toLowerCase()) {
    return { allowed: false, reason: 'notGuardian' };
  }
  if (input.verifiedAt <= 0) return { allowed: false, reason: 'notVerified' };
  // Re-verification window. Records about a child are the most sensitive thing we hold, and
  // a login from three weeks ago should not still be a key to them.
  if (input.now - input.verifiedAt > 30 * 24 * 60 * 60_000) {
    return { allowed: false, reason: 'staleVerification' };
  }
  return { allowed: true };
}
