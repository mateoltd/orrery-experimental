/**
 * The roster page.  (P4-T6)
 *
 * ## `force-dynamic`, because this page is the database
 *
 * A roster rendered at build time is a roster from the day the site was deployed. The whole page
 * is a permission-gated read, so there is nothing to cache it against and nothing to revalidate.
 *
 * ## Where the session comes from
 *
 * `currentUser()` resolves the caller from the `__Host-` session cookie and returns `null` for every failure — absent,
 * forged, expired, revoked, or present while the account is suspended (`server/auth/session-user.ts`). This page used to
 * read `ORRERY_DEV_USER_ID` and fall back to a fixed all-zeroes UUID, which meant identity was a process-wide environment
 * variable and the page was readable by anybody who knew a user id (`docs/THREAT-MODEL.md` TM-01).
 *
 * **A MISSING SESSION RENDERS THE SAME `NoAccess` A FORBIDDEN ROSTER DOES, AND THAT IS THE POINT.** The two are the same
 * answer because the difference between them is a statement about whether the caller's session exists, and this page has
 * no business making one to a stranger. `rosterPageData` still refuses a caller the database says has no relationship to
 * the classroom, so the session is where the name comes from and the database is where every permission comes from.
 *
 * The development escape hatch is still available and is `ORRERY_ALLOW_DEV_IDENTITY=true` plus `ORRERY_DEV_USER_ID`; it is
 * refused outright when `NODE_ENV=production`, and it yields a caller whose `kind` is `'dev'` rather than `'session'`, so
 * the difference is visible in a type rather than only in a comment.
 */

import { getPrisma } from '@orrery/db';
import { resolveActorForRequest } from '@orrery/db/classrooms';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AccommodationRegister } from '@/features/roster/AccommodationRegister';
import { type RosterActions, RosterTable, type RosterUiRow } from '@/features/roster/RosterTable';
import { currentUser } from '@/server/auth/session-runtime';
import {
  changeRoleAction,
  removeMembersAction,
  restoreMembersAction,
  rosterPageData,
} from '@/server/roster';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Roster',
  robots: { index: false, follow: false },
};

interface PageProps {
  readonly params: Promise<{ classroomId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

export default async function RosterPage(props: PageProps) {
  const [{ classroomId }, query, user] = await Promise.all([
    props.params,
    props.searchParams,
    currentUser(),
  ]);

  // FAIL CLOSED, BEFORE ANY QUERY. There is no default identity to fall back to and no query to run without a name, so a
  // missing session costs one render and nothing else.
  if (user === null) return <NoAccess />;

  const data = await rosterPageData({
    classroomId,
    // The name comes from the session; every role, classroom and permission comes from the database, so a session that
    // claims roles it no longer holds is ignored rather than believed.
    userId: user.userId,
    search: one(query.search) ?? '',
    role: one(query.role),
    includeEnded: one(query.ended) === '1',
    cursor: one(query.cursor),
  });

  if (data.notFound) return <NoAccess />;

  const actions = serverActions(classroomId, user.userId);

  return (
    <main className="orrery-roster-page">
      <h1>Class roster</h1>
      <AccommodationRegister
        classroomId={classroomId}
        callerUserId={user.userId}
        canGrant={await teacherOfClassroom(classroomId, user.userId)}
      />
      {data.forbidden ? (
        <NoAccess />
      ) : (
        <RosterTable
          rows={data.rows}
          total={data.total}
          hasMore={data.hasMore}
          nextCursor={data.nextCursor}
          empty={data.empty}
          endedCount={data.endedCount}
          search={one(query.search) ?? ''}
          roleFilter={(one(query.role) as RosterUiRow['role'] | null) ?? null}
          showEnded={one(query.ended) === '1'}
          actions={actions}
        />
      )}
    </main>
  );
}

function NoAccess() {
  return (
    <p role="alert">
      You do not have access to this class. If you think you should, ask the teacher who owns it.
    </p>
  );
}

/**
 * The actions, bound to this classroom.
 *
 * They are functions returning a promise, which is the same shape as `RosterActions`, so the
 * component is unchanged whether it is driven by a form post, a server action, or a tRPC caller.
 * When tRPC lands (ADR-0005) this is the one function that becomes a delegate — and the component,
 * which is where the accessibility and the "name the person" behaviour live, does not.
 */
function serverActions(classroomId: string, userId: string): RosterActions {
  return {
    async changeRole(input) {
      const result = await changeRoleAction({
        userId,
        classroomId,
        enrollmentId: input.enrollmentId,
        role: input.role,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, reason: result.reason ?? 'That did not work.' };
    },
    async remove(input) {
      const result = await removeMembersAction({
        userId,
        classroomId,
        enrollmentIds: input.enrollmentIds,
      });
      return result.ok
        ? { ok: true, removed: result.count ?? input.enrollmentIds.length }
        : { ok: false, reason: result.reason ?? 'Nobody was removed.' };
    },
    async restore(input) {
      const result = await restoreMembersAction({
        userId,
        classroomId,
        enrollmentIds: input.enrollmentIds,
      });
      return result.ok
        ? { ok: true, restored: result.count ?? 0 }
        : { ok: false, reason: result.reason ?? 'Nobody was restored.' };
    },
    async setSearch(input) {
      // A PAGESET because this runs on the server and there is no client router yet. It is the
      // one piece of this page that will look dated the moment `useRouter` exists.
      redirectWith({ search: input.search });
    },
    async setRoleFilter(input) {
      redirectWith({ role: input.role ?? '' });
    },
    async clearSearch() {
      redirectWith({ search: '' });
    },
    async showEnded() {
      redirectWith({ ended: '1' });
    },
  };
}

function redirectWith(extra: Readonly<Record<string, string>>): never {
  const search = new URLSearchParams({ ...extra });
  const query = search.toString();
  redirect(query === '' ? '?' : `?${query}`);
}

/** Whether the caller may grant in this room. The actions re-check; this only hides the form. */
async function teacherOfClassroom(classroomId: string, userId: string): Promise<boolean> {
  const actor = await resolveActorForRequest(getPrisma(), userId);
  const role = actor?.classroomRoles[classroomId];
  return role === 'OWNER' || role === 'TEACHER';
}
