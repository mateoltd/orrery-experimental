/**
 * Where telemetry is kept, for how long, and who may read it.  (P14-T14, `14` §7)
 *
 * ## WHY THESE TESTS EXIST WHEN THE CONSTANTS LOOK OBVIOUS
 *
 * Because a retention table nobody reads is a promise, and `TM-11`'s whole finding is that `apps/worker` throws
 * `not implemented — P14-T6` while two documents describe the sweep as "a real cron job and not a promise". The
 * *decision* is implemented and tested here; the *action* is not, and the test that proves the decision is correct is
 * what makes the missing action a visible gap rather than a silent one.
 */

import type { Actor } from '@orrery/auth/can';
import { DAY, HOUR, MINUTE } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import {
  mayReadAttemptTelemetry,
  retentionDecision,
  TELEMETRY_CLOCK_SKEW_WINDOW,
  TELEMETRY_LATE_ARRIVAL_WINDOW,
  TELEMETRY_RETENTION_DAYS,
  TELEMETRY_RETENTION_MS,
} from './retention.js';

const T0 = 1_800_000_000_000;

const teacher = (over: Partial<Actor> = {}): Actor => ({
  id: 't-1',
  roles: ['teacher'],
  mfaVerified: true,
  suspended: false,
  ...over,
});

const inRoom = (classroomId: string, role: string): Record<string, string> => ({
  [classroomId]: role,
});

describe('400 DAYS, AND THE ARITHMETIC IS A FUNCTION OF TWO INSTANTS', () => {
  it('the number is the one `14` §7.2 states, and it is not a default', () => {
    expect(TELEMETRY_RETENTION_DAYS).toBe(400);
    expect(TELEMETRY_RETENTION_MS).toBe(400 * DAY);
  });

  it('keeps a row on the last day and deletes it on the next millisecond', () => {
    // `TELEMETRY_RETENTION_MS` is measured from the SERVER's `receivedAt`, so the boundary is exact rather than
    // "some time on the 400th day". A sweep that ran once a day would otherwise have a day of discretion nobody stated.
    expect(retentionDecision(T0, T0)).toBe('KEEP');
    expect(retentionDecision(T0, T0 + TELEMETRY_RETENTION_MS)).toBe('KEEP');
    expect(retentionDecision(T0, T0 + TELEMETRY_RETENTION_MS + 1)).toBe('AGGREGATE_AND_DELETE');
  });

  it('and a row stamped in the future is kept rather than deleted, because a skewed RECEIPT is not an old row', () => {
    // The retention clock is measured against our own stamp. A row whose `receivedAt` is somehow ahead of the clock
    // must not be read as infinitely old, which is the failure a `now - receivedAt` with no lower bound would have.
    expect(retentionDecision(T0 + DAY, T0)).toBe('KEEP');
  });
});

describe('THE OTHER TWO WINDOWS COME FROM `plans/09` §7 AND ARE NOT INVENTED HERE', () => {
  it('±5 minutes of client skew, and a 2-hour ceiling on a signed claim', () => {
    expect(TELEMETRY_CLOCK_SKEW_WINDOW).toBe(5 * MINUTE);
    expect(TELEMETRY_LATE_ARRIVAL_WINDOW).toBe(2 * HOUR);
  });
});

describe('WHO MAY READ IT: THE KERNEL IS ASKED, NOT A SECOND LIST', () => {
  it("a teacher IN the classroom may read their own class's evidence", () => {
    const decision = mayReadAttemptTelemetry({
      actor: teacher(),
      classroomId: 'cl-1',
      attemptId: 'at-1',
      context: {
        actorClassroomIds: new Set(['cl-1']),
        actorClassroomRoles: inRoom('cl-1', 'TEACHER'),
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it('THE PROPERTY: the same teacher in a DIFFERENT classroom is refused', () => {
    // A teacher in class B must not read class A's proctoring record, and the decision has to come from the matrix so
    // that the classroom scoping is the one `plans/12` §4 describes rather than one re-implemented here.
    const decision = mayReadAttemptTelemetry({
      actor: teacher(),
      classroomId: 'cl-1',
      attemptId: 'at-1',
      context: {
        actorClassroomIds: new Set(['cl-2']),
        actorClassroomRoles: inRoom('cl-2', 'TEACHER'),
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('and a STUDENT may not read the evidence about their own sitting', () => {
    // This is the answer to "is this a PII store?" for reads: a student's telemetry is about them, is retained for 400
    // days, is read by staff, and is NOT handed back through this predicate. `14` §7.3's access and export right is the
    // mechanism, and it goes through a background job and a signed expiring link.
    const decision = mayReadAttemptTelemetry({
      actor: teacher({ id: 'st-1', roles: ['student'] }),
      classroomId: 'cl-1',
      attemptId: 'at-1',
      context: {
        actorClassroomIds: new Set(['cl-1']),
        actorClassroomRoles: inRoom('cl-1', 'STUDENT'),
      },
    });
    expect(decision.allowed).toBe(false);
  });

  it('and a null actor is refused before anything else is read', () => {
    const decision = mayReadAttemptTelemetry({
      actor: null,
      classroomId: 'cl-1',
      attemptId: 'at-1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'noActor' });
  });

  it('AND THE LIMIT IS STATED: `can()` IS ASKED ABOUT THE CLASSROOM, NOT ABOUT SUSPENSION', () => {
    // `integrityEvidenceRules.viewEvidence` is `classroomScoped(...)` (`matrix.ts:916-923`), and `classroomScoped` does
    // not consult `actor.suspended` — unlike `matrix.ts:502`, `1307`, `1499`, `1568`, `1613` and `1636`, which all do.
    // So this predicate alone will NOT stop a suspended teacher who still holds a session. **That is a matrix gap and not
    // this package's**, and it is reported rather than asserted here: the enforcement that matters is at the session
    // layer (`requireUser`), which P14-T11 owns. Asserting either way in this file would be claiming a property of the
    // authorisation kernel from a package that does not own it.
    const decision = mayReadAttemptTelemetry({
      actor: teacher({ suspended: true }),
      classroomId: 'cl-1',
      attemptId: 'at-1',
      context: {
        actorClassroomIds: new Set(['cl-1']),
        actorClassroomRoles: inRoom('cl-1', 'TEACHER'),
      },
    });
    // The classroom decision is what this module promises, and it is the SAME decision a live teacher gets.
    expect(decision).toEqual(
      mayReadAttemptTelemetry({
        actor: teacher(),
        classroomId: 'cl-1',
        attemptId: 'at-1',
        context: {
          actorClassroomIds: new Set(['cl-1']),
          actorClassroomRoles: inRoom('cl-1', 'TEACHER'),
        },
      }),
    );
  });
});
