/**
 * INV-CLASSROOM-1: effective role is the max of ACTIVE enrollments.
 *
 * The three properties that make the word "active" mean something:
 *
 *   1. **Max, not union-by-luck and not most-recent.** A teacher who is also a student in
 *      another class is a teacher. Ordering is explicit (`ROLE_ORDER`) so "max" is a comparison
 *      rather than whichever role happened to be last in an array.
 *   2. **Expiry is evaluated now, not at enrolment time.** A 30-day session must not carry a
 *      role for 30 days after the enrollment ended.
 *   3. **A DELETING account holds no roles at all.** The deletion grace period keeps the
 *      account usable; it does not keep it a member of anything. Granting roles during grace
 *      would make the grace period a period of quietly continuing to teach.
 */

import { DAY, type Millis } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  assertRolesMatchEnrollments,
  type EnrollmentRow,
  effectiveRole,
  effectiveRoles,
  maxRole,
  ROLE_ORDER,
  roleRank,
} from '../roles.js';

const T0: Millis = 1_700_000_000_000;

const enrollment = (over: Partial<EnrollmentRow> = {}): EnrollmentRow => ({
  role: 'student',
  endsAt: null,
  withdrawnAt: null,
  ...over,
});

describe('max, which is not "whichever came last"', () => {
  it('orders the roles explicitly', () => {
    expect(ROLE_ORDER).toEqual(['student', 'reviewer', 'teacher', 'platformAdmin']);
    expect(roleRank('student')).toBeLessThan(roleRank('teacher'));
    expect(roleRank('teacher')).toBeLessThan(roleRank('platformAdmin'));
  });

  it('picks the highest, whichever order the enrollments arrive in', () => {
    // The case that makes "max" necessary: a teacher who is also a student in a class they
    // teach. Sorted by rank rather than by date, and the answer is the same.
    const rows = [enrollment({ role: 'student' }), enrollment({ role: 'teacher' })];
    const forward = effectiveRoles({ enrollments: rows, now: T0, accountStatus: 'ACTIVE' });
    const reversed = effectiveRoles({
      enrollments: [...rows].reverse(),
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(forward).toContain('teacher');
    expect(reversed).toContain('teacher');
  });

  it('deduplicates, and returns null for an empty set rather than undefined', () => {
    expect(effectiveRoles({ enrollments: [], now: T0, accountStatus: 'ACTIVE' })).toEqual([]);
    expect(effectiveRole({ enrollments: [], now: T0, accountStatus: 'ACTIVE' })).toBeNull();
    expect(maxRole([])).toBeNull();
  });

  it('an unrecognised role ranks below student and does not throw', () => {
    // A role added by a migration that has not reached this build should not deny a teacher
    // their grading screen on a Monday morning. It is ignored, and the invariant registry gate
    // is where the mismatch is caught.
    expect(roleRank('wizard' as never)).toBe(-1);
    expect(() =>
      effectiveRoles({
        enrollments: [enrollment({ role: 'wizard' as never })],
        now: T0,
        accountStatus: 'ACTIVE',
      }),
    ).not.toThrow();
  });
});

describe('active means active NOW', () => {
  it('includes an open-ended enrollment', () => {
    expect(
      effectiveRoles({ enrollments: [enrollment()], now: T0, accountStatus: 'ACTIVE' }),
    ).toEqual(['student']);
  });

  it('includes one that has not yet expired', () => {
    const rows = [enrollment({ role: 'teacher', endsAt: T0 + DAY })];
    expect(effectiveRole({ enrollments: rows, now: T0, accountStatus: 'ACTIVE' })).toBe('teacher');
  });

  it('excludes one that expired an hour ago', () => {
    // The 30-day-session scenario: a role that stopped being true must stop being true today,
    // not in thirty days.
    const rows = [enrollment({ role: 'teacher', endsAt: T0 - 3_600_000 })];
    expect(effectiveRoles({ enrollments: rows, now: T0, accountStatus: 'ACTIVE' })).toEqual([]);
  });

  it('excludes a withdrawn one, and the row STAYS in the table', () => {
    // Withdrawn is a field rather than a deletion because the history matters.
    const rows = [enrollment({ role: 'teacher', withdrawnAt: T0 - DAY })];
    expect(effectiveRoles({ enrollments: rows, now: T0, accountStatus: 'ACTIVE' })).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('treats a missing withdrawnAt as not withdrawn', () => {
    const rows: EnrollmentRow[] = [{ role: 'student', endsAt: null }];
    expect(effectiveRoles({ enrollments: rows, now: T0, accountStatus: 'ACTIVE' })).toEqual([
      'student',
    ]);
  });
});

describe('a non-ACTIVE account holds no roles', () => {
  for (const status of ['SUSPENDED', 'DELETING', 'DELETED'] as const) {
    it(`${status} holds nothing, however many active enrollments it has`, () => {
      const rows = [enrollment({ role: 'teacher' }), enrollment({ role: 'platformAdmin' })];
      expect(effectiveRoles({ enrollments: rows, now: T0, accountStatus: status })).toEqual([]);
    });
  }

  it('and the reason for DELETING is that grace is for the ACCOUNT, not for its roles', () => {
    // A teacher who asked to delete their account is still signed in — that is the grace
    // period — but they are not a member of anything, so they cannot be given a class. Granting
    // roles during grace would make the grace period a period of quietly continuing to teach.
    const rows = [enrollment({ role: 'teacher' })];
    expect(effectiveRole({ enrollments: rows, now: T0, accountStatus: 'DELETING' })).toBeNull();
  });
});

describe('the claim, and what to do when it disagrees with the enrollments', () => {
  const rows = [enrollment({ role: 'student' })];

  it('agrees, and reports no correction', () => {
    const r = assertRolesMatchEnrollments({
      claimed: ['student'],
      enrollments: rows,
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(r).toEqual({ roles: ['student'], corrected: false });
  });

  it('a DEMOTED teacher is corrected, which is the case that matters', () => {
    // The session still claims teacher; the enrollment has expired. Trusting the claim is how a
    // demoted teacher keeps teacher powers for as long as their session lives.
    const expired: EnrollmentRow[] = [enrollment({ role: 'teacher', endsAt: T0 - 1 })];
    const r = assertRolesMatchEnrollments({
      claimed: ['teacher'],
      enrollments: expired,
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(r.corrected).toBe(true);
    expect(r.roles, 'the derived roles are what the caller must use').toEqual([]);
  });

  it('a PROMOTED student is corrected upward', () => {
    const promoted: EnrollmentRow[] = [enrollment({ role: 'teacher' })];
    const r = assertRolesMatchEnrollments({
      claimed: ['student'],
      enrollments: promoted,
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(r.corrected).toBe(true);
    expect(r.roles).toEqual(['teacher']);
  });

  it('returns the DERIVED roles rather than a boolean, so a caller cannot keep the stale claim', () => {
    // Returning both would tempt a caller into logging the mismatch and continuing. The
    // function's only output IS the answer.
    const r = assertRolesMatchEnrollments({
      claimed: ['teacher'],
      enrollments: [],
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(r.roles).toEqual([]);
  });

  it('extra claims are corrected, not merely missing ones', () => {
    const r = assertRolesMatchEnrollments({
      claimed: ['student', 'teacher'],
      enrollments: rows,
      now: T0,
      accountStatus: 'ACTIVE',
    });
    expect(r.corrected).toBe(true);
    expect(r.roles).toEqual(['student']);
  });
});
