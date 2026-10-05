/**
 * Postgres behind the credential routes.  (P14-T11)
 *
 * ## WHY THE ROUTES ARE NOT ALLOWED TO TOUCH PRISMA
 *
 * `@orrery/db` exists so that exactly one package can open a transaction, and a route handler
 * that reaches past it is a route handler that can decide things. Every query here is a
 * projection of a column list, and none of them is a permission check: `findAccountByEmail`
 * answers "is there an account", not "may this caller sign in" — which is
 * `assertMaySignIn`'s job, called from `signIn`.
 *
 * ## THE SESSION INSERT IS THE ONLY PLACE A CREDENTIAL IS WRITTEN, AND IT IS NOT THE CREDENTIAL
 *
 * `insertSession` takes a `tokenHash`. There is deliberately no parameter through which the raw
 * token could arrive, so "the database stores the session token" is not a mistake somebody can
 * make here — it is a mistake the type does not permit. `token.ts` explains why the HMAC is the
 * right construction and what a bare SHA-256 would and would not have covered.
 *
 * ## THE ATTEMPT LOG IS A PROCESS-WIDE SINGLETON, AND THAT IS A KNOWN WEAKNESS
 *
 * See `inProcessAttemptLog` in `sign-in.ts` for why it is in memory and what that costs. It is
 * held on `globalThis` for the same reason `getPrisma()` is: Next.js re-evaluates modules on hot
 * reload, and a per-module-instance log would silently reset on every edit during development.
 * It is still per PROCESS and still per restart, which is the part that needs a table.
 */

import type { RevokeReason } from '@orrery/auth/session';
import type { Attempt } from '@orrery/auth/throttle';
import type { Clock } from '@orrery/clock';
import { createLogger } from '@orrery/config/logging';
import { getPrisma, type PrismaClient } from '@orrery/db';
import { revokeAllSessionsAndBumpEpoch } from '@orrery/db/sessions';
import type { ForgotStore } from './forgot';
import { type CredentialAccount, inProcessAttemptLog, type SignInStore } from './sign-in';

/**
 * The auth channel's logger.
 *
 * `createLogger` REDACTS by field name, which is the reason it is used rather than `console`:
 * a warning about a refused session is exactly the sort of line somebody later adds a
 * `identifier` to, and the redaction is what stops that becoming a column of every address anyone
 * has tried to sign in with.
 */
export const authLog = createLogger('auth');

type Db = PrismaClient;

/**
 * The attempt log for this process.
 *
 * The `globalThis` key is namespaced so it cannot collide with `getPrisma()`'s cache or with any
 * other module that wants a process-wide box.
 */
interface AttemptGlobal {
  __orrerySignInAttempts?: ReturnType<typeof inProcessAttemptLog>;
}

function sharedAttemptLog(): ReturnType<typeof inProcessAttemptLog> {
  const g = globalThis as unknown as AttemptGlobal;
  g.__orrerySignInAttempts ??= inProcessAttemptLog();
  return g.__orrerySignInAttempts;
}

export function prismaSignInStore(db: Db, clock: Clock): SignInStore {
  const attempts = sharedAttemptLog();
  return {
    /**
     * The credential account for an address.
     *
     * `password` is read through the `Account` relation filtered to rows that HAVE one, rather
     * than by guessing Better Auth's `providerId`. A guess would be a credential that silently
     * becomes un-checkable on a framework upgrade: the sign-in would return the generic failure
     * forever and nobody would know why. Filtering on `password IS NOT NULL` is correct for every
     * provider and cannot go stale that way.
     */
    async findAccountByEmail(emailNormalized: string): Promise<CredentialAccount | null> {
      const row = await db.user.findUnique({
        where: { emailNormalized },
        select: {
          id: true,
          status: true,
          deletingAt: true,
          suspendedAt: true,
          suspendedReason: true,
          accounts: {
            where: { password: { not: null } },
            select: { password: true },
            take: 1,
          },
        },
      });
      if (row === null) return null;
      return {
        userId: row.id,
        passwordHash: row.accounts[0]?.password ?? null,
        status: row.status,
        deletingAt: row.deletingAt === null ? null : row.deletingAt.getTime(),
        suspendedAt: row.suspendedAt === null ? null : row.suspendedAt.getTime(),
        suspendedReason: row.suspendedReason,
      };
    },

    async insertSession(row): Promise<void> {
      await db.$transaction(async (tx) => {
        await tx.session.create({
          data: {
            id: row.id,
            userId: row.userId,
            tokenHash: row.tokenHash,
            familyId: row.familyId,
            expiresAt: row.expiresAt,
          },
        });
        // `lastLoginAt` is written in the same transaction as the session, so "when did this
        // account last sign in" cannot disagree with "which sessions exist". A login timestamp
        // that survives a rolled-back session is a support answer that is wrong.
        await tx.user.update({
          where: { id: row.userId },
          data: { lastLoginAt: row.expiresAt },
        });
      });
    },

    listAttempts: (input) => attempts.list(input),
    recordAttempt: async (attempt: Attempt) => {
      attempts.record(attempt);
    },

    /**
     * ONE ROW THAT INCREMENTS, and it never throws.
     *
     * `SecurityEvent.dedupeKey` is UNIQUE, so a plain insert would fail on the second occurrence
     * of a sustained attack — which is exactly the case the row exists to count. `upsert` with an
     * increment is the shape the schema comment asks for.
     */
    async writeSecurityEvent(event): Promise<void> {
      try {
        await db.securityEvent.upsert({
          where: { dedupeKey: event.dedupeKey },
          create: {
            kind: event.kind,
            userId: event.userId,
            dedupeKey: event.dedupeKey,
            meta: event.meta,
          },
          update: { occurrences: { increment: 1 } },
        });
      } catch {
        // An audit write must not turn a REFUSAL into a 500. The refusal already happened and it
        // stands whether or not the row exists; swallowing is not in tension with that.
      }
    },

    /**
     * The lifecycle's own revoke, imported rather than re-implemented.
     *
     * `revokeAllSessionsAndBumpEpoch` is the function whose doc says the two statements must
     * never be separated, so reusing it is the only way this route gets that guarantee for free
     * rather than by remembering to write it again.
     */
    revokeAllSessions: (userId: string, reason: string) =>
      revokeAllSessionsAndBumpEpoch(db, {
        userId,
        reason: reason as RevokeReason,
        now: new Date(clock.now()),
      }).then((count) => count),
  };
}

export function prismaForgotStore(db: Db): ForgotStore {
  return {
    async findAccountIdByEmail(emailNormalized: string): Promise<string | null> {
      const row = await db.user.findUnique({
        where: { emailNormalized },
        select: { id: true },
      });
      return row?.id ?? null;
    },

    /**
     * THE ROW IS WRITTEN ON BOTH PATHS, AND ONLY ITS STATUS DIFFERS.
     *
     * `ON CONFLICT ("dedupeKey") DO NOTHING` rather than a read-then-write: two concurrent
     * requests for the same address inside the same bucket must produce one row without either of
     * them finding out whether the other got there first. The return value is discarded for the
     * same reason — see `ForgotStore.enqueue`.
     *
     * `payload` is an empty object on purpose: there is no reset token to put in it yet (see the
     * module header), and inventing a placeholder URL would put a link in somebody's inbox that
     * resets nothing.
     */
    async enqueue(input): Promise<void> {
      await db.$queryRaw<{ id: string }[]>`
        INSERT INTO "EmailOutbox" ("id", "toEmail", "template", "payload", "dedupeKey", "userId", "status", "scheduledAt", "createdAt")
        VALUES (gen_random_uuid()::text, ${input.toEmail}, 'PASSWORD_RESET',
                '{}'::jsonb, ${input.dedupeKey}, ${input.userId}, ${input.status}, ${input.now}, ${input.now})
        ON CONFLICT ("dedupeKey") DO NOTHING
        RETURNING "id"
      `;
    },
  };
}

/** `getPrisma()` re-exported so a route needs one import for its database. */
export { getPrisma };
