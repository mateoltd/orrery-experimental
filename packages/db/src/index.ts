/**
 * `@orrery/db` — the ONLY module permitted to import Prisma.  (P0-T4, ADR-0008)
 *
 * ## The rule this module exists to enforce
 *
 * It exports **query functions**, never a client instance. A client instance exported from
 * a shared package is a client instance every consumer can open a transaction on, which
 * means authorisation decisions leak into places that have no business making them, and no
 * test can substitute a fixture.
 *
 * The ESLint rule `no-restricted-imports` in `eslint.config.js` bans `@prisma/client`
 * outside this path, and `packages/db` is the single exemption. That is enforced, not
 * documented.
 *
 * ## The client singleton
 *
 * Three deployment realities, handled explicitly:
 *
 *   1. **Next.js hot reload** re-evaluates modules. Without a global cache, dev leaks a
 *      connection pool per edit until Postgres refuses connections. The `globalThis` cache
 *      is the documented pattern and the only reason dev and prod behave the same.
 *   2. **The web app and the worker need different pool sizes.** A web replica serving 750
 *      exam takers and a worker running a 5,000-attempt release cannot share a pool sized
 *      for either.
 *   3. **The client is only constructed when something actually uses it.** Importing this
 *      module from a build script must not require a reachable database.
 *
 * ## Time
 *
 * Row defaults are stamped by **Postgres**, not by this module. `MISSED-4`: 123 columns are
 * database-stamped and the application stamps a different set with `@orrery/clock`, and
 * anything gating a deadline must read the database's value. `ExamAttempt.startedAt` is
 * therefore taken from a `RETURNING` clause, never from `systemClock.now()`.
 */

import { PrismaClient } from './prisma.js';

export type { PrismaClient };

export interface DbOptions {
  /**
   * Max connections in the pool. The default is deliberately small: a pool that is too
   * large is the most common cause of a database collapsing under load while reporting
   * low CPU, because every connection is a process Postgres is willing to spawn work for.
   */
  connectionLimit?: number;
  /** Log every query. Off in production; it is a firehose and it will bury a real error. */
  logQueries?: boolean;
  /** Datasource URL. Read from validated env, never from `process.env` directly. */
  url?: string;
}

const DEFAULTS = {
  connectionLimit: 10,
  logQueries: false,
} as const;

interface ClientGlobal {
  __orreryPrisma?: PrismaClient;
}

/**
 * The singleton. The `globalThis` key is namespaced so it cannot collide with another
 * library's cache, and the type is declared rather than cast at each use.
 */
export function getPrisma(options: DbOptions = {}): PrismaClient {
  const { connectionLimit, logQueries, url } = { ...DEFAULTS, ...options };
  const g = globalThis as unknown as ClientGlobal;

  if (!g.__orreryPrisma) {
    g.__orreryPrisma = new PrismaClient({
      log: logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
      datasources: url ? { db: { url } } : undefined,
    });
  }
  return g.__orreryPrisma;
}

/**
 * Run `fn` inside a transaction, and **guarantee** the audit event is written in the same
 * transaction as the change it describes.
 *
 * This is the single most important function in the data layer. `plans/00` §8 requires every
 * consequential mutation to write an `AuditEvent` in the same transaction — a grade change
 * whose audit row is written afterwards, or never, is a grade nobody can explain to a
 * student.
 *
 * Making it impossible to write a change without its audit event is worth more than a
 * convention, because conventions are what `D-31` and `D-35` found to be theatre.
 */
export async function withAudit<T>(
  fn: (tx: TxClient) => Promise<T>,
  audit: AuditEntry,
): Promise<T> {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx: TxClient) => {
    const result = await fn(tx);
    await tx.auditEvent.create({
      data: {
        actorId: audit.actorId ?? null,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        classroomId: audit.classroomId ?? null,
        ipHash: audit.ipHash ?? null,
        meta: (audit.meta ?? {}) as never,
      },
    });
    return result;
  });
}

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId: string;
  actorId?: string | null;
  classroomId?: string | null;
  ipHash?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * The transaction client. Typed loosely on purpose: the point of the module boundary is
 * that consumers never see a raw `PrismaClient`, so exposing the full generated type here
 * would give the boundary away.
 */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Health check for `/readyz`. Deliberately a trivial query with a timeout: readiness
 * decides whether this replica takes traffic, so it must fail fast and must not itself
 * become the outage.
 */
export async function ping(timeoutMs = 2_000): Promise<boolean> {
  const prisma = getPrisma();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    void timeoutMs;
  }
}

/**
 * Close the pool. Called on graceful shutdown so a deploy does not leave in-flight exam
 * requests holding connections while the old replica drains.
 */
export async function disconnect(): Promise<void> {
  const g = globalThis as unknown as ClientGlobal;
  if (g.__orreryPrisma) {
    await g.__orreryPrisma.$disconnect();
    g.__orreryPrisma = undefined;
  }
}
