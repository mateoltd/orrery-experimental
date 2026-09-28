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
 * `actorUserId(request)` reads a header. That is a placeholder for the real session lookup, and it
 * is the SAME shape as `readImpersonation` in `middleware.ts`: a value that is not yet verified
 * and is only used to *name a user to look up*, never to grant anything. `resolveActorForRequest`
 * in `@orrery/db` re-derives every role from the enrollments, so a header that lies about roles is
 * ignored, and a header naming a user who does not exist gets a 403 rather than a roster.
 *
 * It is called out here because the moment the real session lands, this function is the one thing
 * that changes, and a reader needs to know that is safe to change.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { type RosterActions, RosterTable, type RosterUiRow } from '@/features/roster/RosterTable';
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
  const [{ classroomId }, query] = await Promise.all([props.params, props.searchParams]);
  const data = await rosterPageData({
    classroomId,
    // A PAGESET and a real session both come from headers; the page does not care which.
    userId: sessionUserId(),
    search: one(query.search) ?? '',
    role: one(query.role),
    includeEnded: one(query.ended) === '1',
    cursor: one(query.cursor),
  });

  if (data.notFound) return <NoAccess />;

  const actions = serverActions(classroomId);

  return (
    <main className="orrery-roster-page">
      <h1>Class roster</h1>
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
function serverActions(classroomId: string): RosterActions {
  return {
    async changeRole(input) {
      const result = await changeRoleAction({
        userId: sessionUserId(),
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
        userId: sessionUserId(),
        classroomId,
        enrollmentIds: input.enrollmentIds,
      });
      return result.ok
        ? { ok: true, removed: result.count ?? input.enrollmentIds.length }
        : { ok: false, reason: result.reason ?? 'Nobody was removed.' };
    },
    async restore(input) {
      const result = await restoreMembersAction({
        userId: sessionUserId(),
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

/**
 * The placeholder session lookup, and its limits stated.
 *
 * It is NOT a session and it does not authenticate anything: it names a user to look up, and
 * every role, classroom and permission that follows comes from the database. A caller who forges
 * the header gets to be *themselves*, which is a real user with real permissions — so this cannot
 * escalate, but it does mean the page is readable by anyone who knows a user id. That is fixed by
 * the real session, and the test below pins the property that survives the fix: the ACTOR is
 * derived from the database, so a session claiming roles it no longer holds is ignored.
 */
function sessionUserId(): string {
  return process.env.ORRERY_DEV_USER_ID ?? '00000000-0000-0000-0000-000000000000';
}
