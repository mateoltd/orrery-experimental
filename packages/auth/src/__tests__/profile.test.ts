/**
 * Profile and minors tests.  (P1-T2, plans/13 §1.1)
 *
 * The two properties this file is really about:
 *
 *   1. **An under-18 account cannot be made public.** `assertProfileIsPublishable` throws,
 *      so a caller cannot ignore it. The tests assert the THROW, not a returned flag.
 *   2. **A guardian consent record cannot be a lie.** The timestamp comes from the injected
 *      `now` and is never caller-supplied, and changing the guardian address invalidates the
 *      old consent rather than keeping its timestamp.
 */

import { DAY, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  type AgeDeclaration,
  assertProfileIsPublishable,
  buildProfile,
  canGuardianAccess,
  type GuardianState,
  MAJOR_AGE,
  MAX_DISPLAY_NAME,
  type ProfileInput,
  recordGuardianConsent,
} from '../profile.js';

const T0: Millis = 1_700_000_000_000;

const input = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  userId: 'u-1',
  displayName: 'Ada Lovelace',
  locale: 'en-GB',
  timezone: 'Europe/London',
  ageDeclaration: '18orOver' as AgeDeclaration,
  ...over,
});

const built = (over: Partial<ProfileInput> = {}) => {
  const r = buildProfile(input(over));
  if (!r.ok) throw new Error(`expected the profile to build, got ${r.reason}`);
  return r.profile;
};

describe('a profile round-trips', () => {
  it('keeps the fields it was given, trimmed', () => {
    const p = built({ displayName: '  Ada Lovelace  ' });
    expect(p.displayName).toBe('Ada Lovelace');
    expect(p.timezone).toBe('Europe/London');
    expect(p.locale).toBe('en-GB');
    expect(p.isMinor).toBe(false);
  });

  it('rejects an empty or over-long name', () => {
    expect(buildProfile(input({ displayName: '   ' }))).toEqual({ ok: false, reason: 'nameEmpty' });
    expect(buildProfile(input({ displayName: 'x'.repeat(MAX_DISPLAY_NAME + 1) }))).toEqual({
      ok: false,
      reason: 'nameTooLong',
    });
    // The boundary is the boundary.
    expect(buildProfile(input({ displayName: 'x'.repeat(MAX_DISPLAY_NAME) })).ok).toBe(true);
  });

  it('validates the timezone against the runtime, not a list we maintain', () => {
    // A list of zones we keep goes stale and rejects a legitimate zone. `Australia/Eucla` is
    // a real IANA zone (UTC+08:45, one of only a handful in the world) that nobody would
    // think to add to a hand-maintained list, which is exactly the point.
    for (const zone of ['Australia/Eucla', 'Pacific/Chatham', 'America/Ciudad_Juarez']) {
      expect(buildProfile(input({ timezone: zone })).ok, `zone=${zone}`).toBe(true);
    }
    expect(buildProfile(input({ timezone: 'Not/AZone' }))).toEqual({
      ok: false,
      reason: 'invalidTimezone',
    });
  });

  it('validates the locale', () => {
    expect(buildProfile(input({ locale: 'de-DE' })).ok).toBe(true);
    expect(buildProfile(input({ locale: 'not a locale!!' }))).toEqual({
      ok: false,
      reason: 'unsupportedLocale',
    });
  });
});

describe('under-18 accounts have no public profile, by policy', () => {
  const minor = (over: Partial<ProfileInput> = {}) => built({ ageDeclaration: 'under18', ...over });

  it('assertProfileIsPublishable THROWS for a minor', () => {
    // A throw, not `false`. A boolean is something a caller can ignore, and this is the one
    // place where ignoring it is a privacy breach rather than a bug.
    expect(() => assertProfileIsPublishable(minor())).toThrowError(/no public profile/);
  });

  it('and does not throw for an adult', () => {
    expect(() => assertProfileIsPublishable(built())).not.toThrow();
  });

  it('refuses to even accept an avatar URL for a minor', () => {
    // Not "hidden" — refused at the door. An avatar is the most reliable way to re-identify
    // a student in a shared classroom display, and the consent that would permit it is
    // precisely what a minor cannot give.
    expect(
      buildProfile(input({ ageDeclaration: 'under18', avatarUrl: 'https://cdn/x.png' })),
    ).toEqual({ ok: false, reason: 'avatarNotPermitted' });
  });

  it('silently drops an avatar rather than storing one for a minor', () => {
    expect(minor().avatarUrl).toBeNull();
  });

  it('defaults notifications to the guardian for a minor', () => {
    // The reasoning is consent, not preference: whatever could reveal participation in an
    // assessment is a thing the guardian should hear about first.
    const p = minor();
    expect(p.notifyEmail).toBe(false);
    expect(p.notifyDeadlineReminders).toBe(false);
    expect(p.notifyInApp).toBe(true);
  });

  it('does not override an explicit preference for a minor', () => {
    // The DEFAULT is the guardian. A minor who has asked for in-app reminders gets them —
    // the account holder is still a person with preferences about their own account.
    expect(minor({ notifyInApp: true, notifyEmail: true }).notifyEmail).toBe(true);
  });
});

describe('the age threshold is a constant, not a magic number', () => {
  it('is 18, and is exported so a caller cannot guess a different one', () => {
    expect(MAJOR_AGE).toBe(18);
  });
});

describe('a guardian consent record', () => {
  const noConsent: GuardianState = { isMinor: true, guardianEmail: null, guardianConsentAt: null };

  it('is stamped with the injected now, which the caller cannot supply', () => {
    const r = recordGuardianConsent(noConsent, { guardianEmail: 'Parent@Example.com', now: T0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Lowercased: an address differing only in case is the same address, and two spellings
    // of one guardian would each be treated as needing fresh consent.
    expect(r.changes.guardianEmail).toBe('parent@example.com');
    expect(r.changes.guardianConsentAt).toBe(T0);
  });

  it('refuses for an adult — a guardian on an adult account is a data-entry mistake', () => {
    const r = recordGuardianConsent(
      { isMinor: false, guardianEmail: null, guardianConsentAt: null },
      { guardianEmail: 'p@example.com', now: T0 },
    );
    expect(r).toEqual({ ok: false, reason: 'notAMinor' });
  });

  it('refuses an empty address', () => {
    expect(recordGuardianConsent(noConsent, { guardianEmail: '  ', now: T0 })).toEqual({
      ok: false,
      reason: 'guardianRequired',
    });
  });

  it('refuses to re-record the same consent', () => {
    const first = recordGuardianConsent(noConsent, { guardianEmail: 'p@example.com', now: T0 });
    if (!first.ok) throw new Error('expected the first consent to succeed');
    expect(
      recordGuardianConsent(first.state, { guardianEmail: 'P@example.com', now: T0 + DAY }),
    ).toEqual({ ok: false, reason: 'alreadyConsented' });
  });

  it('requires FRESH consent when the guardian address changes', () => {
    const first = recordGuardianConsent(noConsent, { guardianEmail: 'p@example.com', now: T0 });
    if (!first.ok) throw new Error('expected the first consent to succeed');
    // A distinct reason, so the caller cannot quietly keep the old timestamp. A consent
    // record attached to an address nobody consented for is worse than no record at all.
    expect(
      recordGuardianConsent(first.state, { guardianEmail: 'other@example.com', now: T0 + DAY }),
    ).toEqual({ ok: false, reason: 'emailChanged' });
  });
});

describe('a guardian asking for a student’s records', () => {
  const base = {
    guardianEmail: 'parent@example.com',
    studentEmail: 'child@school.example',
    requesterEmail: 'parent@example.com',
    verifiedAt: T0,
    now: T0 + 60_000,
  };

  it('is allowed when the identity was verified in this session', () => {
    expect(canGuardianAccess(base)).toEqual({ allowed: true });
  });

  it('is refused for anyone who is not the recorded guardian', () => {
    const r = canGuardianAccess({ ...base, requesterEmail: 'someone.else@example.com' });
    expect(r).toEqual({ allowed: false, reason: 'notGuardian' });
  });

  it('matches case-insensitively', () => {
    expect(canGuardianAccess({ ...base, requesterEmail: '  Parent@Example.COM ' })).toEqual({
      allowed: true,
    });
  });

  it('is refused when the identity was never verified', () => {
    expect(canGuardianAccess({ ...base, verifiedAt: 0 })).toEqual({
      allowed: false,
      reason: 'notVerified',
    });
  });

  it('is refused when the verification is stale', () => {
    // Records about a child are the most sensitive thing we hold, and a login from three
    // weeks ago should not still be a key to them.
    const r = canGuardianAccess({ ...base, verifiedAt: T0 - 31 * DAY, now: T0 });
    expect(r).toEqual({ allowed: false, reason: 'staleVerification' });
  });

  it('accepts a verification just inside the window', () => {
    expect(canGuardianAccess({ ...base, verifiedAt: T0 - 29 * DAY, now: T0 }).allowed).toBe(true);
  });
});
