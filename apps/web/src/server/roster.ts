/**
 * Server-side actions for the roster page.  (P4-T6)
 *
 * ## The page is a THIN WIRING of a db service, and this module is the seam
 *
 * `RosterTable` is presentational and takes an `actions` object, which is the established pattern
 * (`ResourceLibrary`, `SessionList`). This module is what the page injects, and it does three
 * things and refuses to do a fourth:
 *
 *   1. resolves the ACTOR from the database rather than from the session's claim;
 *   2. calls the same `permit`-backed db functions the rest of the system calls, so a permission
 *      decision is made once, in one place, for every caller;
 *   3. turns a `RosterDenied` into the right HTTP status, because 403 and 404 are not
 *      interchangeable — a 403 on a classroom the actor has no relationship with confirms the id
 *      is real, and a directory of guessed ids is a directory of the system.
 *
 * It does not implement a permission check of its own. There is no `if (actor.roles.includes(...))`
 * anywhere in this file, deliberately: the matrix is in `@orrery/auth` and the classroom scoping
 * is in `@orrery/db`, and a second copy of either would be a second thing to forget to update.
 */

import { getPrisma } from '@orrery/db';
import { changeMemberRole, endMembership, resolveActorForRequest } from '@orrery/db/classrooms';
import type { RosterUiRow } from '@/features/roster/RosterTable';
import { isoDate } from './format';

export interface RosterPageRequest {
  readonly classroomId: string;
  readonly userId: string;
  readonly search: string;
  readonly role: string | null;
  readonly includeEnded: boolean;
  readonly cursor: string | null;
}

export interface RosterPageData {
  readonly rows: readonly RosterUiRow[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly empty: RosterUiEmptyRow | null;
  readonly endedCount: number | null;
  readonly notFound: boolean;
  readonly forbidden: boolean;
}

type RosterUiEmptyRow = NonNullable<
  Awaited<ReturnType<typeof import('@orrery/db/roster-page').listRoster>>['empty']
>;

const ROLES = new Set(['OWNER', 'TEACHER', 'REVIEWER', 'STUDENT']);

/**
 * Read the page.
 *
 * A `RosterDenied` is NOT thrown at the caller: the page renders a message and a 403/404 status
 * rather than an error boundary, because "you do not have access to this class" is an ordinary
 * answer to a navigation, not a crash.
 */
export async function rosterPageData(request: RosterPageRequest): Promise<RosterPageData> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, request.userId);
  if (actor === null) {
    return {
      rows: [],
      total: 0,
      hasMore: false,
      nextCursor: null,
      empty: null,
      endedCount: null,
      notFound: false,
      forbidden: true,
    };
  }

  const { listRoster, RosterDenied } = await import('@orrery/db/roster-page');
  try {
    const page = await listRoster(db, actor, {
      classroomId: request.classroomId,
      search: request.search,
      role: ROLES.has(request.role ?? '') ? (request.role as never) : null,
      includeEnded: request.includeEnded,
      cursor: request.cursor,
    });
    return {
      rows: page.items.map(toUiRow),
      total: page.total,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      empty: page.empty,
      endedCount: page.endedCount,
      notFound: false,
      forbidden: false,
    };
  } catch (error) {
    if (error instanceof RosterDenied) {
      return {
        rows: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
        empty: null,
        endedCount: null,
        notFound: error.httpStatus === 404,
        forbidden: error.httpStatus === 403,
      };
    }
    throw error;
  }
}

/**
 * Dates are FORMATTED HERE, not in the component.
 *
 * The component gets a label rather than a `Date`, because a component that formats a date formats
 * it in the browser's locale and the browser's timezone, and a teacher in Auckland and a teacher in
 * Cardiff then disagree about when a student joined. The server has one answer.
 */
function toUiRow(row: {
  enrollmentId: string;
  userId: string;
  displayName: string;
  accountName: string;
  hasDisplayNameOverride: boolean;
  email: string;
  role: 'OWNER' | 'TEACHER' | 'REVIEWER' | 'STUDENT';
  status: 'ACTIVE' | 'ENDED';
  joinedAt: Date;
  isPlaceholder: boolean;
  summary: {
    assignmentsPublished: number;
    attempts: number;
    completed: number;
    inProgress: number;
    releasedGrades: number;
    latestReleasedLabel: string | null;
    accommodations: number;
    lastActivityAt: Date | null;
  };
}): RosterUiRow {
  return {
    enrollmentId: row.enrollmentId,
    userId: row.userId,
    displayName: row.displayName,
    accountName: row.accountName,
    hasDisplayNameOverride: row.hasDisplayNameOverride,
    email: row.email,
    role: row.role,
    status: row.status,
    joinedAtLabel: isoDate(row.joinedAt),
    isPlaceholder: row.isPlaceholder,
    summary: {
      assignmentsPublished: row.summary.assignmentsPublished,
      attempts: row.summary.attempts,
      completed: row.summary.completed,
      inProgress: row.summary.inProgress,
      releasedGrades: row.summary.releasedGrades,
      latestReleasedLabel: row.summary.latestReleasedLabel,
      accommodations: row.summary.accommodations,
      lastActivityLabel:
        row.summary.lastActivityAt === null ? null : isoDate(row.summary.lastActivityAt),
    },
  };
}

export interface RosterActionResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly count?: number;
}

/**
 * A mutation, with the same three steps every time.
 *
 * The `permit` check is NOT repeated here — `changeMemberRole` and `endMembership` both call it
 * themselves, and a second check in this module would be a second thing to get wrong. What this
 * module adds is the ACTOR RESOLUTION, which is the part a UI route can forget: a session may
 * claim a role it no longer holds, and only the database knows.
 */
async function asActor(
  userId: string,
  run: (
    actor: Awaited<ReturnType<typeof resolveActorForRequest>>,
  ) => Promise<{ ok: boolean; reason: string; count: number }>,
): Promise<RosterActionResult> {
  const db = getPrisma();
  const actor = await resolveActorForRequest(db, userId);
  if (actor === null) return { ok: false, reason: 'Your session is not valid any more.' };
  const result = await run(actor);
  return result.ok
    ? { ok: true, count: result.count }
    : { ok: false, reason: result.reason, count: result.count };
}

export async function changeRoleAction(input: {
  userId: string;
  classroomId: string;
  enrollmentId: string;
  role: RosterUiRow['role'];
}): Promise<RosterActionResult> {
  return asActor(input.userId, async (actor) => {
    if (actor === null) return { ok: false, reason: 'no session', count: 0 };
    const result = await changeMemberRole(getPrisma(), {
      classroomId: input.classroomId,
      userId: await userIdForEnrollment(input.enrollmentId),
      role: input.role,
      actor,
    });
    return result.ok
      ? { ok: true, reason: '', count: 1 }
      : { ok: false, reason: explain(result.httpStatus, result.reason), count: 0 };
  });
}

export async function removeMembersAction(input: {
  userId: string;
  classroomId: string;
  enrollmentIds: readonly string[];
}): Promise<RosterActionResult> {
  return asActor(input.userId, async (actor) => {
    if (actor === null) return { ok: false, reason: 'no session', count: 0 };
    let removed = 0;
    for (const enrollmentId of input.enrollmentIds) {
      const result = await endMembership(getPrisma(), {
        classroomId: input.classroomId,
        userId: await userIdForEnrollment(enrollmentId),
        actor,
        reason: 'removed from the roster page',
      });
      // A PARTIAL bulk removal reports how many actually went. Saying "Removed 12" when four were
      // refused is the kind of small lie that makes a teacher stop trusting the page.
      if (result.ok) removed += 1;
    }
    return removed > 0
      ? { ok: true, reason: '', count: removed }
      : { ok: false, reason: 'Nobody was removed.', count: 0 };
  });
}

/**
 * Undo, and it is a REAL undo.
 *
 * `endMembership` refuses to touch a student's own records, so restoring is `addMember` with the
 * same role — the two are inverses by construction, not by a snapshot. The join date is NOT
 * restored to its original value: `addMember` sets a new one, because the student is joining
 * again now. The row keeps its history, which is the thing a teacher actually needs to be able to
 * explain later.
 */
export async function restoreMembersAction(input: {
  userId: string;
  classroomId: string;
  enrollmentIds: readonly string[];
}): Promise<RosterActionResult> {
  return asActor(input.userId, async (actor) => {
    if (actor === null) return { ok: false, reason: 'no session', count: 0 };
    const { addMember } = await import('@orrery/db/classrooms');
    let restored = 0;
    for (const enrollmentId of input.enrollmentIds) {
      const target = await enrollmentFor(enrollmentId);
      if (target === null) continue;
      const result = await addMember(getPrisma(), {
        classroomId: input.classroomId,
        userId: target.userId,
        role: target.role as 'STUDENT' | 'TEACHER' | 'REVIEWER',
        actor,
        note: 'undone from the roster page',
      });
      if (result.ok) restored += 1;
    }
    return restored > 0
      ? { ok: true, reason: '', count: restored }
      : { ok: false, reason: 'Nobody was restored.', count: 0 };
  });
}

async function enrollmentFor(
  enrollmentId: string,
): Promise<{ userId: string; role: string } | null> {
  const row = await getPrisma().enrollment.findUnique({
    where: { id: enrollmentId },
    select: { userId: true, role: true },
  });
  return row === null ? null : { userId: row.userId, role: String(row.role) };
}

async function userIdForEnrollment(enrollmentId: string): Promise<string> {
  const target = await enrollmentFor(enrollmentId);
  if (target === null) throw new Error('no such membership');
  return target.userId;
}

/**
 * Turn a db reason into something a teacher can act on, and nothing they can enumerate with.
 *
 * The reasons are an internal vocabulary: `wrongClassroom`, `notVisible`, and so on, and two of
 * them are answers to the question "does this classroom exist" — which is why the generic case
 * says nothing at all. But one reason is a genuine instruction rather than a code, and hiding it
 * would be hiding the fix: `changeMemberRole` refuses `OWNER` with a sentence explaining that
 * ownership is transferred rather than assigned, and a teacher who picked Owner deserves to read
 * it. So that one passes through and the rest do not.
 */
function explain(status: 403 | 404 | 409, reason: string): string {
  if (status === 404) return 'That student is no longer in this class.';
  if (status === 409) return 'That change conflicts with something else. Reload and try again.';
  if (reason.startsWith('use transferClassroomOwnership')) {
    return 'Ownership is transferred, not assigned. Transfer this class to make that change.';
  }
  return 'You cannot make that change.';
}
