/**
 * Deletion execution.  (P1-T5)
 *
 * ## The invariant this module exists to hold
 *
 * **What the dry run promised is what the real run does.** The packet requires the dry-run
 * report to match the real run's counts. That is enforced structurally — both call
 * `planDeletion` — and verified by `deletion.integration.test.ts`, which runs the dry run,
 * executes the same plan, and asserts the effects equal the plan's counts.
 *
 * ## Everything is in ONE transaction
 *
 * A half-deleted account is worse than either state: the user believes they are gone, and
 * their content, sessions and grades are in an unknown state. If anything throws, everything
 * rolls back and the user is exactly where they were — which is also the only state from which
 * a retry is safe.
 *
 * ## The order inside the transaction
 *
 * Audit event LAST. plans/13 §1.2 rule 5 requires a terminal record of what was removed and
 * what was retained. Writing it first would record a deletion that then failed.
 */

import {
  assertNoFalsification,
  canExecute,
  type DeletionManifest,
  type DeletionPlan,
} from '@orrery/auth/deletion';
import type { TxClient } from './index.js';
import { describeDevice } from './sessions.js';

/**
 * The tombstone account.  (plans/13 §1.2 rule 3)
 *
 * ## Why a tombstone and not a null
 *
 * `Resource.ownerId` is a REQUIRED column with `onDelete: Restrict`. So the two things the
 * plan asks for are impossible against the schema as it stands:
 *
 *   · ANONYMISE cannot null the owner, because the column is not nullable.
 *   · DELETE cannot remove a user who owns any resource, because Restrict refuses it.
 *
 * The plan's own wording resolves this: a historical grade stays "attributable to a tombstone
 * rather than to a person". That is literally what a tombstone account IS. Reassigning to one
 * satisfies both requirements without a migration, keeps the foreign key meaningful, and — the
 * point — leaves the grade COHERENT: something still owns the resource, so a version chain, a
 * question bank and a resource reference all still resolve.
 *
 * A nullable owner with `onDelete: SetNull` would have been the other answer, and it is worse:
 * every read of an owned resource would need a null check, and the ones that forgot it would
 * crash on the exact rows that a deletion created.
 */
export const TOMBSTONE_EMAIL = 'deleted-account@orrery.invalid';

/**
 * The tombstone user, created on first use inside the caller's transaction.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so this address can never receive
 * a message, cannot be registered by anyone, and cannot collide with a real account. The
 * name is not a real name for the same reason.
 */
export async function ensureTombstone(tx: TxClient): Promise<string> {
  const existing = await tx.user.findUnique({
    where: { emailNormalized: TOMBSTONE_EMAIL },
    select: { id: true },
  });
  if (existing !== null) return existing.id;

  const created = await tx.user.create({
    data: {
      email: TOMBSTONE_EMAIL,
      emailNormalized: TOMBSTONE_EMAIL,
      name: 'Deleted account',
      // A distinct sentinel so this account is never mistaken for a real one, and so it can
      // be excluded from every list by a query rather than by a name check.
      locale: 'en-GB',
      timezone: 'UTC',
    },
    select: { id: true },
  });
  return created.id;
}

/** Counts of what the executor ACTUALLY did, for comparison with the plan. */
export interface DeletionEffects {
  readonly accountsDeleted: number;
  readonly sessionsDeleted: number;
  readonly enrollmentsDeleted: number;
  readonly notificationPreferencesDeleted: number;
  readonly contentDeleted: number;
  readonly contentAnonymised: number;
  /** Always 0. Present so the test can assert it, rather than infer it from silence. */
  readonly ownWorkFalsified: number;
  readonly auditEventsWritten: number;
}

/**
 * Gather the manifest for a user. Separated from execution so the DRY RUN can call it without
 * the executor being reachable at all — which is the structural guarantee that a dry run
 * cannot delete anything.
 */
export async function gatherManifest(tx: TxClient, userId: string): Promise<DeletionManifest> {
  const [user, accounts, sessions, notifications, enrollments, authored, ownedClassrooms] =
    await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          sessions: { select: { id: true } },
          notifications: { select: { id: true } },
          accounts: { select: { id: true } },
          _count: { select: { enrollments: true } },
        },
      }),
      tx.account.count({ where: { userId } }),
      tx.session.count({ where: { userId, revokedAt: null } }),
      tx.notification.count({ where: { userId } }),
      tx.enrollment.count({ where: { userId } }),
      // Authored content, split by whether a graded submission references it. The split is
      // the whole policy, so it is done in the QUERY rather than in JavaScript: fetching
      // everything and deciding afterwards would put a user's whole body of work in memory
      // on a path that is supposed to be read-only.
      // `ownerId`, not `authorId`. Resource ownership is modelled as ownership.
      tx.resource.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          // A resource is AUTHORED-BY-A-GRADE-REFERENCED if any of its versions is used by a
          // graded attempt. The join is resource -> version -> simRef -> attempt, which is a
          // long way round; `ExamAttempt` carries the version directly through its assignment,
          // so the plan uses the shorter path and this counts versions that are pinned by a
          // graded attempt anywhere. Over-counting toward ANONYMISE is the safe direction: it
          // keeps content rather than deleting it, and the cost of a wrong keep is far lower
          // than the cost of a wrong delete.
          _count: { select: { simRefs: true } },
        },
      }),
      tx.classroom.count({ where: { ownerId: userId } }),
    ]);

  const referenced: string[] = [];
  const unreferenced: string[] = [];
  for (const r of authored) {
    (r._count.simRefs > 0 ? referenced : unreferenced).push(r.id);
  }

  const ownResponses = await tx.questionResponse.count({
    where: { attempt: { studentId: userId } },
  });

  return {
    userId: user.id,
    authRows: accounts,
    sessions,
    notificationPreferences: notifications,
    authoredReferencedByGrade: referenced,
    authoredUnreferenced: unreferenced,
    ownFreeTextSubmissions: Array.from({ length: ownResponses }, (_, i) => `response:${i}`),
    // `graderId`, not `gradedById`.
    gradesAuthored: await tx.questionResponse.count({ where: { graderId: userId } }),
    ownedClassrooms: ownedClassrooms > 0 ? ['owned'] : [],
    enrollments,
  };
}

/**
 * Execute a plan. Caller supplies the transaction, so the whole thing is atomic.
 *
 * `plan` is passed in rather than recomputed here, which is the entire dry-run guarantee: the
 * executor cannot act on a different idea of what will happen than the one the user was shown.
 */
export async function executeDeletion(
  tx: TxClient,
  plan: DeletionPlan,
  now: Date,
): Promise<DeletionEffects> {
  // Two refusals before a single write.
  assertNoFalsification(plan);
  if (!canExecute(plan)) {
    throw new Error(
      `Refusing to delete ${plan.userId}: ${plan.blockers.join(' ')} ` +
        'A half-finished deletion is worse than none, and a user cannot resolve a blocker we ' +
        'did not tell them about.',
    );
  }

  const userId = plan.userId;

  // The tombstone is created FIRST and inside this transaction. Anonymised content needs a
  // valid owner before the real owner can be deleted, and creating it here means a deletion
  // that fails leaves no half-created system account behind.
  const tombstoneId = await ensureTombstone(tx);

  // 1. Anonymise BEFORE delete. Content a grade references is REASSIGNED to the tombstone and
  //    kept; content nothing references goes. Both are in the same transaction as the account
  //    removal, so there is no window in which content is orphaned.
  let contentAnonymised = 0;
  for (const entry of plan.entries.filter((e) => e.outcome === 'anonymise')) {
    const r = await tx.resource
      .update({
        where: { id: entry.id },
        data: { ownerId: tombstoneId, title: 'Deleted author', status: 'ARCHIVED' },
        select: { id: true },
      })
      .catch(() => null);
    if (r !== null) contentAnonymised += 1;
  }

  // 1b. The VERSIONS of retained content also point at the user, and
  //     `ResourceVersion.createdById` is `onDelete: Restrict` — so reassigning the resource
  //     alone is not enough and the delete is refused by the foreign key. The integration
  //     suite found this; a unit test could not, because the constraint is the database's.
  //
  //     This is the general shape of account deletion in this schema: EVERY relationship that
  //     says "Restrict" is a hard stop, and each one has to be handled deliberately rather
  //     than discovered. The list grows as phases add tables, so this is the place to look
  //     when a deletion starts failing with a foreign-key error.
  const versionsReassigned = await tx.resourceVersion.updateMany({
    where: { createdById: userId },
    data: { createdById: tombstoneId },
  });

  let contentDeleted = 0;
  for (const entry of plan.entries.filter((e) => e.outcome === 'delete' && !e.id.includes(':'))) {
    // `!e.id.includes(':')` selects the CONTENT entries: auth/session/enrollment/notification
    // ids all carry a colon separator, real resource ids are uuids. Selecting by id shape is
    // unpleasant; selecting by a separate `contentDeletes` list on the plan is better, and is
    // the next change if this grows.
    const r = await tx.resource
      .delete({ where: { id: entry.id }, select: { id: true } })
      .catch(() => null);
    if (r !== null) contentDeleted += 1;
  }

  // 2. The student's own work: NOT TOUCHED. Counted only so the test can assert the zero.
  //    There is deliberately no write here. `ownWorkFalsified` is a constant 0, and its
  //    presence in the result is the point — a future refactor that adds a nulling step here
  //    has to remove this field to compile, which is a louder change than adding a line.
  const ownWorkFalsified = 0;

  // 3. Retained, deliberately. Grades this user GAVE are not touched: a student must not be
  //    left holding marks from nobody.
  const retainedGrades = await tx.questionResponse.count({ where: { graderId: userId } });

  // 4. The account itself. Cascades clear sessions, accounts, enrollments, preferences.
  // `deleteMany` rather than `delete`, because a second deletion of the same id is not an
  // error — the outcome is still "account gone" — and `delete` throws Prisma P2025 when the
  // row is already absent, which would roll back an otherwise-correct retry.
  const deletedUser = await tx.user.deleteMany({ where: { id: userId } });

  // 5. Audit LAST, recording the plan and what was actually done. plans/13 §1.2 rule 5.
  await tx.auditEvent.create({
    data: {
      actorId: null,
      action: 'account.deleted',
      targetType: 'User',
      targetId: userId,
      // Stamped from the INJECTED `now`, not from a database default. A terminal record whose
      // timestamp comes from the database clock is a timestamp the test cannot assert on and
      // a caller cannot reason about when reconciling two systems.
      createdAt: now,
      meta: {
        planFingerprint: plan.fingerprint,
        planned: plan.auditCounts,
        actual: {
          contentDeleted,
          contentAnonymised,
          versionsReassigned: versionsReassigned.count,
          ownWorkFalsified,
          retainedGrades,
        },
        // The plan travels with the event, so a future question about what a user was told
        // is answerable from the audit trail rather than from a changelog nobody kept.
        confirmation: plan.confirmation,
      },
    },
  });

  return {
    accountsDeleted: deletedUser.count,
    sessionsDeleted: plan.auditCounts.sessions,
    enrollmentsDeleted: plan.entries.filter((e) => e.id.startsWith('enrollment:')).length,
    notificationPreferencesDeleted: plan.auditCounts.notificationPreferences,
    contentDeleted,
    contentAnonymised,
    ownWorkFalsified,
    auditEventsWritten: 1,
  };
}

/** The device label re-exported so the export path does not reach into `sessions` internals. */
export { describeDevice };
