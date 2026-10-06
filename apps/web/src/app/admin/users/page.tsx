import {
  listUsersForAdmin,
  startImpersonationAction,
  stopImpersonationAction,
  suspendUserAction,
  unsuspendUserAction,
} from '@/server/admin';
import { currentUser } from '@/server/auth/session-runtime';

export const dynamic = 'force-dynamic';

export const metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: 'User administration',
};

async function suspend(form: FormData): Promise<void> {
  'use server';
  const user = await currentUser();
  if (user === null) return;
  const target = form.get('target');
  const reason = form.get('reason');
  if (typeof target !== 'string' || typeof reason !== 'string') return;
  await suspendUserAction({ callerUserId: user.userId, targetUserId: target, reason });
}

async function impersonate(form: FormData): Promise<void> {
  'use server';
  const user = await currentUser();
  if (user === null) return;
  const target = form.get('target');
  const reason = form.get('reason');
  if (typeof target !== 'string' || typeof reason !== 'string') return;
  await startImpersonationAction({ callerUserId: user.userId, targetUserId: target, reason });
}

async function stopImpersonating(): Promise<void> {
  'use server';
  await stopImpersonationAction();
}

async function unsuspend(form: FormData): Promise<void> {
  'use server';
  const user = await currentUser();
  if (user === null) return;
  const target = form.get('target');
  if (typeof target !== 'string') return;
  await unsuspendUserAction({ callerUserId: user.userId, targetUserId: target });
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactNode> {
  const [query, user] = await Promise.all([searchParams, currentUser()]);

  // FAIL CLOSED, BEFORE ANY QUERY -- and the gate is the kernel's roles, re-resolved per request,
  // never a flag the session carries. `listUsersForAdmin` re-checks anyway; defense in depth is not
  // paranoia here, it is the shape of every other admin-adjacent surface in this codebase.
  if (user === null) return <p>Sign in as a platform administrator.</p>;
  const search = typeof query.q === 'string' ? query.q : '';
  const rows = await listUsersForAdmin({ callerUserId: user.userId, query: search });
  if (rows.length === 0) {
    // Ambiguous on purpose: an empty list means "not an admin OR no matches", and distinguishing
    // the two would tell an unauthenticated caller which one they are.
    return (
      <main>
        <h1>User administration</h1>
        <p>No users found.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>User administration</h1>
      <form method="get">
        <label>
          Search users
          <input type="search" name="q" defaultValue={search} />
        </label>
        <button type="submit">Search</button>
      </form>
      <table>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.email}</td>
              <td>{row.name}</td>
              <td>
                {row.suspendedAt === null
                  ? 'Active'
                  : `Suspended since ${row.suspendedAt}${row.suspendedReason === null ? '' : ` -- ${row.suspendedReason}`}`}
              </td>
              <td>
                <form action={impersonate}>
                  <input type="hidden" name="target" value={row.id} />
                  <label>
                    Reason
                    <input type="text" name="reason" required minLength={3} />
                  </label>
                  <button type="submit">Impersonate</button>
                </form>
                <form action={stopImpersonating}>
                  <button type="submit">Stop impersonating</button>
                </form>
                {row.suspendedAt === null ? (
                  <form action={suspend}>
                    <input type="hidden" name="target" value={row.id} />
                    <label>
                      Reason
                      <input type="text" name="reason" required minLength={3} />
                    </label>
                    <button type="submit">Suspend</button>
                  </form>
                ) : (
                  <form action={unsuspend}>
                    <input type="hidden" name="target" value={row.id} />
                    <button type="submit">Unsuspend</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
