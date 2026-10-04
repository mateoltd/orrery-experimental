/**
 * The `ReleaseBatch` state machine, the membership freeze, and the pre-release gate.  (P10-T1, P10-T3)
 *
 * ## WHAT WAS ALREADY HERE
 *
 * The model, the member table and the five statuses have existed since `0001_init`, and `release.ts` (P7-T10) already
 * computes scores and flips a batch to `RELEASED` in one transaction. What did not exist is anything connecting the
 * five statuses. Measured against the database before this task: `RELEASED` could be updated back to `DRAFT`, a member
 * from another classroom could be inserted into a `RELEASED` batch, and `releaseBatch` released a `CANCELED` one.
 *
 * ## WHERE THE RULES LIVE, AND WHY THERE ARE TWO COPIES
 *
 * The transitions and the freeze are enforced by TRIGGERS (migration `0014`), because a rule that lives only in this
 * file binds only the callers of this file -- and the two writers that existed before it both wrote `status` with a
 * bare `update`. The database is the one place every writer passes through.
 *
 * `RELEASE_BATCH_TRANSITIONS` below is the same table in TypeScript. It is not the enforcement; it is what lets a
 * refusal be a returned value with a reason instead of a thrown trigger error, and what a UI reads to decide which
 * buttons exist. `release-batch.integration.test.ts` attempts all 25 pairs against the database and compares each
 * outcome with this table, so the two copies cannot drift without a red test.
 *
 * ## THE GATE IS `planRelease`, NOT A SECOND OPINION
 *
 * `plans/07` §6.3: "release is blocked while any member attempt is not `GRADED`, and the blockers are listed". The
 * blockers here are `planRelease`'s refusals, read by `loadReleasePlan` -- the same read and the same function the
 * release itself uses. A gate with its own idea of "releasable" admits batches the release then refuses, and a batch
 * refused after entering `RELEASING` is frozen with no way back.
 */

import type { Clock, Millis } from '@orrery/clock';
import { assertNoScoreLeak } from '@orrery/interop';

import type { PrismaClient } from '../prisma/generated/client/client.js';
import {
  type LoadedReleasePlan,
  loadReleasePlan,
  planRelease,
  type ReleaseDb,
  type ReleaseRefusal,
} from './release.js';

/* ──────────────────────────────────────────────────────── the machine ── */

export const RELEASE_BATCH_STATUSES = [
  'DRAFT',
  'READY',
  'RELEASING',
  'RELEASED',
  'CANCELED',
] as const;
export type ReleaseBatchStatus = (typeof RELEASE_BATCH_STATUSES)[number];

/**
 * EVERY LEGAL TRANSITION. Anything not listed is refused, by this table and by the trigger.
 *
 * ```
 * DRAFT ──▶ READY ──▶ RELEASING ──▶ RELEASED
 *   ▲─────────┘
 * DRAFT, READY, RELEASING ──▶ CANCELED
 * ```
 *
 * Three absences are deliberate:
 *
 *  · **`READY → RELEASED`.** `plans/07` §6.1 writes the release as `WHERE status IN ('READY','RELEASING')`, which
 *    admits it. It is refused because a batch that takes that edge was never frozen: it is verified against membership
 *    that is still open, and a member added between the check and the flip is released unchecked. Both hops can share
 *    one transaction, so nothing about atomicity is lost -- only the ability to skip the freeze. **This is a recorded
 *    disagreement with the plan's text, not an amendment of it.**
 *  · **`RELEASING → READY`.** There is no un-freeze. "Frozen until somebody reopens it" is not frozen; a release that
 *    has started finishes or is cancelled, and cancelling costs one new batch.
 *  · **anything out of `RELEASED`.** Visibility is `EXISTS(... status = 'RELEASED')`, so leaving it takes back grades
 *    a student has already read. A gate that admits that is worse than one that never had the state.
 */
export const RELEASE_BATCH_TRANSITIONS: Readonly<
  Record<ReleaseBatchStatus, readonly ReleaseBatchStatus[]>
> = {
  DRAFT: ['READY', 'CANCELED'],
  READY: ['DRAFT', 'RELEASING', 'CANCELED'],
  RELEASING: ['RELEASED', 'CANCELED'],
  RELEASED: [],
  CANCELED: [],
};

export const canTransition = (from: ReleaseBatchStatus, to: ReleaseBatchStatus): boolean =>
  RELEASE_BATCH_TRANSITIONS[from].includes(to);

export const isTerminalStatus = (status: ReleaseBatchStatus): boolean =>
  RELEASE_BATCH_TRANSITIONS[status].length === 0;

/**
 * MEMBERSHIP IS WRITABLE IN `DRAFT` AND `READY`, AND NOWHERE ELSE.
 *
 * Written as "not one of the two open states" rather than "one of the three frozen ones" on purpose: a sixth status
 * added later is frozen until somebody decides otherwise, which is the safe way to be wrong.
 */
export const isMembershipFrozen = (status: ReleaseBatchStatus): boolean =>
  status !== 'DRAFT' && status !== 'READY';

/**
 * A status read from the database, as a `ReleaseBatchStatus` -- or `null` if it is not one.
 *
 * The column arrives as a `string`. Casting it would make every `switch` over the union quietly non-exhaustive the day
 * the enum gains a member this file has not heard of.
 */
export const parseReleaseBatchStatus = (value: unknown): ReleaseBatchStatus | null =>
  (RELEASE_BATCH_STATUSES as readonly unknown[]).includes(value)
    ? (value as ReleaseBatchStatus)
    : null;

/* ─────────────────────────────────────────────────────────── the gate ── */

export type GateBlockerReason =
  /** A batch with no members releases nobody, and once `RELEASING` it could never gain one. */
  'EMPTY_BATCH' | Exclude<ReleaseRefusal, 'ALREADY_RELEASED' | 'BATCH_NOT_RELEASING'>;

export interface GateBlocker {
  /** `null` for a blocker about the batch as a whole. */
  readonly attemptId: string | null;
  readonly reason: GateBlockerReason;
  /** Whether a recorded override can waive it. See `isWaivable`. */
  readonly waivable: boolean;
}

export interface GateVerdict {
  readonly open: boolean;
  /** Every blocker, not the first one: §6.3 says they are LISTED, and a teacher fixing them one refusal at a time
   *  is a teacher who overrides instead. */
  readonly blockers: readonly GateBlocker[];
}

/**
 * WHAT AN OVERRIDE CAN WAIVE: the two "this attempt is not finished being marked" blockers, and nothing else.
 *
 *  · `SCORE_NOT_COMPUTABLE` is not a judgement call. There is no percentage for an all-excused paper, and a reason
 *    typed into a box does not create one.
 *  · `HOLD_WINDOW_NOT_ELAPSED` is the minimum review window (`K-4`). An override that waives it makes the window a
 *    suggestion, and the override is written by the same person the window exists to slow down.
 *  · `EMPTY_BATCH` has nothing to waive.
 */
export const isWaivable = (reason: GateBlockerReason): boolean =>
  reason === 'ATTEMPT_NOT_GRADED' || reason === 'ATTEMPT_NEEDS_HUMAN';

/**
 * THE GATE, as a pure function of what `planRelease` already decided.
 *
 * `entering` is the status the batch is about to take. The hold window blocks `RELEASING` and not `READY`: `READY`
 * means "marked, checked, waiting out the review window", so a hold that blocked it would leave nowhere for a finished
 * batch to wait.
 */
export const evaluateGate = (input: {
  readonly entering: 'READY' | 'RELEASING';
  readonly memberCount: number;
  readonly refusals: readonly {
    readonly attemptId: string | null;
    readonly reason: ReleaseRefusal;
  }[];
}): GateVerdict => {
  const blockers: GateBlocker[] = [];

  if (input.memberCount === 0) {
    blockers.push({ attemptId: null, reason: 'EMPTY_BATCH', waivable: false });
  }

  for (const refusal of input.refusals) {
    // Neither can occur for a batch that is `DRAFT` or `READY`, which the caller has already established. They are
    // dropped by name rather than passed through so the blocker type cannot carry a reason no teacher can act on.
    if (refusal.reason === 'ALREADY_RELEASED' || refusal.reason === 'BATCH_NOT_RELEASING') continue;
    if (refusal.reason === 'HOLD_WINDOW_NOT_ELAPSED' && input.entering === 'READY') continue;
    blockers.push({
      attemptId: refusal.attemptId,
      reason: refusal.reason,
      waivable: isWaivable(refusal.reason),
    });
  }

  return { open: blockers.length === 0, blockers };
};

/* ─────────────────────────────────────────────────────── the override ── */

/**
 * Mirrored by the CHECK `ReleaseBatch_override_complete` in migration `0014`. A test writes a reason one character
 * short through both, so the two numbers cannot drift.
 */
export const MIN_OVERRIDE_REASON = 10;

export type OverrideRefusal =
  /** WHO. An override with no author is the override nobody can audit. */
  | 'NO_ACTOR'
  /** WHY. */
  | 'NO_REASON'
  /** WHEN. A clock that returned nothing usable; refusing beats recording 1970. */
  | 'NO_TIME'
  | 'BATCH_NOT_FOUND'
  /** `RELEASED` or `CANCELED`: the override that batch finished with is the record. */
  | 'BATCH_TERMINAL'
  /** Nothing waivable is blocking. See `decideOverride`. */
  | 'NOTHING_TO_OVERRIDE'
  /** `actorId` names no user. `plans/01` §10: the machine may recommend, only a human disposes. */
  | 'ACTOR_NOT_FOUND';

export interface OverrideRecord {
  readonly reason: string;
  readonly actorId: string;
  readonly at: Millis;
  /** Exactly the blockers the person was looking at. This list IS the scope of the override. */
  readonly waived: readonly { readonly attemptId: string; readonly reason: GateBlockerReason }[];
}

/** Code points, not UTF-16 units: Postgres' `length()` counts characters, and the CHECK is the other half of this. */
const reasonLength = (reason: string): number => [...reason.trim()].length;

/**
 * DECIDE WHETHER AN OVERRIDE MAY BE RECORDED, and what exactly it waives.
 *
 * `blockers` must be computed with NOTHING waived. A new override replaces the old one, so its list has to be the
 * whole current picture: computing it on top of the existing waiver would record only what is newly blocking and
 * silently un-waive everything the previous override covered.
 *
 * The parameters are typed `string`/`number` and checked anyway. This is called from a request handler, and "the type
 * says it is there" has never stopped an empty string arriving.
 */
export const decideOverride = (input: {
  readonly status: ReleaseBatchStatus;
  readonly actorId: string;
  readonly reason: string;
  readonly at: Millis;
  readonly blockers: readonly GateBlocker[];
}):
  | { readonly ok: true; readonly record: OverrideRecord }
  | { readonly ok: false; readonly reason: OverrideRefusal } => {
  if (typeof input.actorId !== 'string' || input.actorId.trim() === '') {
    return { ok: false, reason: 'NO_ACTOR' };
  }
  if (typeof input.reason !== 'string' || reasonLength(input.reason) < MIN_OVERRIDE_REASON) {
    return { ok: false, reason: 'NO_REASON' };
  }
  if (typeof input.at !== 'number' || !Number.isFinite(input.at)) {
    return { ok: false, reason: 'NO_TIME' };
  }
  if (isTerminalStatus(input.status)) return { ok: false, reason: 'BATCH_TERMINAL' };

  const waived = input.blockers.flatMap((blocker) =>
    blocker.waivable && blocker.attemptId !== null
      ? [{ attemptId: blocker.attemptId, reason: blocker.reason }]
      : [],
  );

  /**
   * AN OVERRIDE THAT WAIVES NOTHING IS REFUSED, NOT RECORDED AS A NO-OP.
   *
   * It is the blank cheque again by another route: "override on file" with an empty list reads, to the next person, as
   * though a decision was made about this batch -- and tempts the next change to treat its presence as the waiver.
   */
  if (waived.length === 0) return { ok: false, reason: 'NOTHING_TO_OVERRIDE' };

  return {
    ok: true,
    record: { reason: input.reason.trim(), actorId: input.actorId, at: input.at, waived },
  };
};

/* ───────────────────────────────────────────── what a student may know ── */

/**
 * A student's view of whether their attempt is released. TWO shapes, and the sealed one is a constant.
 *
 * `INV-RELEASE-2` is about inference, and the batch is full of things to infer from: `READY` versus `DRAFT` says
 * marking has finished, a blocker list says whose paper is still being marked, an override reason is free text a
 * teacher wrote about somebody's work, and `minHoldUntil` is a countdown. So none of it is projected. Every state that
 * is not `RELEASED` -- no batch at all, `DRAFT`, `READY`, `RELEASING`, `CANCELED` -- is the SAME frozen object, which
 * makes "no difference in payload size" true by identity rather than by care.
 */
export type StudentReleaseState =
  | { readonly state: 'SEALED' }
  | {
      readonly state: 'RELEASED';
      /** `null` only for a batch released before migration `0014`, which did not require the time. */
      readonly releasedAt: string | null;
    };

export const SEALED_RELEASE_STATE: StudentReleaseState = Object.freeze({ state: 'SEALED' });

/**
 * Build the student view from the ONE fact that decides it: is there a `RELEASED` batch holding this attempt.
 *
 * The argument is that fact and nothing else, so there is no batch in scope here to leak a field from.
 */
export const studentReleaseState = (
  released: { readonly releasedAt: Date | null } | null,
): StudentReleaseState => {
  if (released === null) {
    // Audited on the way out, against the same 23-key corpus as the sealed-grades gate, exactly as
    // `buildStudentGrade` does. Today it cannot fail -- the object is a literal -- and that is the point of putting
    // it here: the day someone "just adds" a field to the sealed arm, this is the line that names it.
    assertNoScoreLeak(SEALED_RELEASE_STATE);
    return SEALED_RELEASE_STATE;
  }
  return {
    state: 'RELEASED',
    releasedAt: released.releasedAt === null ? null : released.releasedAt.toISOString(),
  };
};

/* ─────────────────────────────────────────────────── the transactions ── */

export type ReleaseBatchDb = Pick<
  PrismaClient,
  'releaseBatch' | 'releaseBatchMember' | 'examAttempt' | 'user' | 'auditEvent' | '$transaction'
>;

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type BatchRefusal =
  | 'BATCH_NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'GATE_CLOSED'
  | 'MEMBERSHIP_FROZEN'
  /** An attempt that is not of the batch's own assignment and classroom, or does not exist. */
  | 'ATTEMPT_OUT_OF_SCOPE'
  | 'NO_ACTOR'
  | 'NO_REASON';

export type BatchResult<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly reason: BatchRefusal;
      /** The status the batch was actually in, when there was a batch. */
      readonly status?: ReleaseBatchStatus;
      /** Present for `GATE_CLOSED`. */
      readonly blockers?: readonly GateBlocker[];
      /** Present for `ATTEMPT_OUT_OF_SCOPE`. */
      readonly attemptIds?: readonly string[];
    };

interface LockedBatch {
  readonly status: ReleaseBatchStatus;
  readonly assignmentId: string;
  readonly classroomId: string;
}

/**
 * LOCK THE BATCH ROW, then read it.
 *
 * `FOR UPDATE` is what makes "check, then write" one decision. It also conflicts with the `FOR SHARE` the member
 * trigger takes, so while a transition is deciding, no member can be added or removed: the gate verifies the
 * membership that will be frozen, not the membership as it was a moment before.
 *
 * Raw SQL because Prisma has no row-lock in its query API; the status is cast to text so it arrives as a string to be
 * PARSED, rather than as whatever the driver makes of an enum.
 */
const lockBatch = async (tx: Tx, batchId: string): Promise<LockedBatch | null> => {
  const rows = await tx.$queryRaw<
    { status: string; assignmentId: string; classroomId: string }[]
  >`SELECT "status"::text AS "status", "assignmentId", "classroomId" FROM "ReleaseBatch" WHERE "id" = ${batchId} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;

  const status = parseReleaseBatchStatus(row.status);
  if (status === null) {
    // Not a refusal. A status this file cannot name means the enum and this module have drifted, and guessing which
    // transitions it allows is how a batch gets released from a state nobody designed.
    throw new Error(`RELEASE_BATCH_UNKNOWN_STATUS: "${row.status}" on batch ${batchId}`);
  }
  return { status, assignmentId: row.assignmentId, classroomId: row.classroomId };
};

const audit = async (
  tx: Tx,
  entry: {
    readonly action: string;
    readonly batchId: string;
    readonly classroomId: string;
    readonly actorId: string | null;
    readonly at: Millis;
    readonly meta: Record<string, unknown>;
  },
): Promise<void> => {
  await tx.auditEvent.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: 'ReleaseBatch',
      targetId: entry.batchId,
      classroomId: entry.classroomId,
      ipHash: null,
      // Stamped from the INJECTED clock, like `deletion.ts`: `createdAt` is the database's time, and a record whose
      // only timestamp is one the caller cannot reproduce is a record a test cannot check.
      meta: { ...entry.meta, at: new Date(entry.at).toISOString() } as never,
    },
  });
};

/**
 * `loadReleasePlan` wants `ReleaseDb`, a deliberately narrow structural type (`release.ts`). A Prisma transaction
 * handle satisfies it at runtime; its generated method signatures are too specific to be assignable. This is a cast of
 * the HANDLE, not of data -- every row still goes through `loadReleasePlan`'s translation.
 */
const asReleaseDb = (tx: Tx): ReleaseDb => tx as unknown as ReleaseDb;

/**
 * The gate evaluation never releases anything, so the penalty it passes is irrelevant to the answer: a late penalty
 * scales a percentage that exists and cannot make one `null`, and the scores this plan computes are thrown away.
 */
const GATE_LATE_PENALTY = 0;

const loadGate = async (
  tx: Tx,
  batchId: string,
  entering: 'READY' | 'RELEASING',
  clock: Pick<Clock, 'now'>,
): Promise<{ readonly loaded: LoadedReleasePlan; readonly verdict: GateVerdict } | null> => {
  const loaded = await loadReleasePlan(asReleaseDb(tx), {
    batchId,
    latePenaltyPercent: GATE_LATE_PENALTY,
    clock,
  });
  if (loaded === null) return null;
  return {
    loaded,
    verdict: evaluateGate({
      entering,
      memberCount: loaded.attemptIds.length,
      refusals: loaded.plan.refusals,
    }),
  };
};

/**
 * Which of these attempts are NOT attempts of this assignment in this classroom.
 *
 * The trigger refuses the same thing; this exists so the refusal can say WHICH attempts, which a trigger error
 * cannot do usefully for a batch of thirty.
 */
const outOfScope = async (
  tx: Tx,
  scope: { readonly assignmentId: string; readonly classroomId: string },
  attemptIds: readonly string[],
): Promise<string[]> => {
  if (attemptIds.length === 0) return [];
  const inScope = await tx.examAttempt.findMany({
    where: {
      id: { in: [...attemptIds] },
      assignmentId: scope.assignmentId,
      classroomId: scope.classroomId,
    },
    select: { id: true },
  });
  const found = new Set(inScope.map((attempt) => attempt.id));
  return attemptIds.filter((id) => !found.has(id));
};

/**
 * CREATE A BATCH. Always `DRAFT` -- there is no status parameter, and the trigger refuses any other birth.
 */
export async function createReleaseBatch(
  db: ReleaseBatchDb,
  input: {
    readonly assignmentId: string;
    readonly classroomId: string;
    readonly attemptIds: readonly string[];
    readonly label?: string | null;
    /** `K-4`: the minimum review window. `null` for none. */
    readonly minHoldUntil?: Millis | null;
    readonly actorId: string | null;
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<BatchResult<{ readonly batchId: string; readonly memberCount: number }>> {
  const attemptIds = [...new Set(input.attemptIds)];

  return db.$transaction(async (tx) => {
    const stray = await outOfScope(tx, input, attemptIds);
    if (stray.length > 0) return { ok: false, reason: 'ATTEMPT_OUT_OF_SCOPE', attemptIds: stray };

    const batch = await tx.releaseBatch.create({
      data: {
        assignmentId: input.assignmentId,
        classroomId: input.classroomId,
        label: input.label ?? null,
        minHoldUntil:
          input.minHoldUntil === null || input.minHoldUntil === undefined
            ? null
            : new Date(input.minHoldUntil),
        members: { create: attemptIds.map((attemptId) => ({ attemptId })) },
      },
      select: { id: true },
    });

    await audit(tx, {
      action: 'ReleaseBatch.create',
      batchId: batch.id,
      classroomId: input.classroomId,
      actorId: input.actorId,
      at: input.clock.now(),
      meta: { assignmentId: input.assignmentId, attemptIds },
    });

    return { ok: true, batchId: batch.id, memberCount: attemptIds.length };
  });
}

/**
 * ADD OR REMOVE MEMBERS. Possible in `DRAFT` and `READY`; refused, by this function and by the trigger, everywhere
 * else.
 *
 * This is the function a "sync the batch with the roster" job would call, and it is why the freeze is not that job's
 * responsibility: a student who joins the class the day after release began is refused here with `MEMBERSHIP_FROZEN`
 * and goes into the next batch, rather than being quietly added to results half the class has already read.
 */
export async function changeBatchMembers(
  db: ReleaseBatchDb,
  input: {
    readonly batchId: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
    readonly actorId: string | null;
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<BatchResult<{ readonly added: number; readonly removed: number }>> {
  const add = [...new Set(input.add ?? [])];
  const remove = [...new Set(input.remove ?? [])];

  return db.$transaction(async (tx) => {
    const batch = await lockBatch(tx, input.batchId);
    if (batch === null) return { ok: false, reason: 'BATCH_NOT_FOUND' };
    if (isMembershipFrozen(batch.status)) {
      return { ok: false, reason: 'MEMBERSHIP_FROZEN', status: batch.status };
    }

    const stray = await outOfScope(tx, batch, add);
    if (stray.length > 0) {
      return { ok: false, reason: 'ATTEMPT_OUT_OF_SCOPE', status: batch.status, attemptIds: stray };
    }

    const removed = await tx.releaseBatchMember.deleteMany({
      where: { batchId: input.batchId, attemptId: { in: remove } },
    });
    // `skipDuplicates`: adding a member that is already there is the outcome the caller asked for, not an error.
    const added = await tx.releaseBatchMember.createMany({
      data: add.map((attemptId) => ({ batchId: input.batchId, attemptId })),
      skipDuplicates: true,
    });

    await audit(tx, {
      action: 'ReleaseBatch.members',
      batchId: input.batchId,
      classroomId: batch.classroomId,
      actorId: input.actorId,
      at: input.clock.now(),
      meta: { status: batch.status, add, remove },
    });

    return { ok: true, added: added.count, removed: removed.count };
  });
}

/**
 * ONE TRANSITION: lock, decide, write, audit -- in that order, in one transaction.
 *
 * `gate` names the transitions that must pass the pre-release gate. The write is a compare-and-swap on the status
 * that was locked; under the lock it cannot miss, and the count is checked anyway because a transition that reports
 * success having written nothing is the failure this whole file is about.
 */
const transition = async (
  db: ReleaseBatchDb,
  input: {
    readonly batchId: string;
    readonly to: ReleaseBatchStatus;
    readonly gate: 'READY' | 'RELEASING' | null;
    readonly actorId: string | null;
    readonly clock: Pick<Clock, 'now'>;
    readonly meta?: Record<string, unknown>;
  },
): Promise<BatchResult<{ readonly from: ReleaseBatchStatus; readonly to: ReleaseBatchStatus }>> =>
  db.$transaction(async (tx) => {
    const batch = await lockBatch(tx, input.batchId);
    if (batch === null) return { ok: false, reason: 'BATCH_NOT_FOUND' };
    if (!canTransition(batch.status, input.to)) {
      return { ok: false, reason: 'ILLEGAL_TRANSITION', status: batch.status };
    }

    if (input.gate !== null) {
      const gate = await loadGate(tx, input.batchId, input.gate, input.clock);
      if (gate === null) return { ok: false, reason: 'BATCH_NOT_FOUND' };
      if (!gate.verdict.open) {
        return {
          ok: false,
          reason: 'GATE_CLOSED',
          status: batch.status,
          blockers: gate.verdict.blockers,
        };
      }
    }

    const written = await tx.releaseBatch.updateMany({
      where: { id: input.batchId, status: batch.status },
      data: { status: input.to },
    });
    if (written.count !== 1) {
      throw new Error(
        `RELEASE_BATCH_TRANSITION_LOST: ${batch.status} -> ${input.to} on ${input.batchId} wrote ${String(written.count)} rows under a row lock`,
      );
    }

    await audit(tx, {
      action: 'ReleaseBatch.transition',
      batchId: input.batchId,
      classroomId: batch.classroomId,
      actorId: input.actorId,
      at: input.clock.now(),
      meta: { ...input.meta, from: batch.status, to: input.to },
    });

    return { ok: true, from: batch.status, to: input.to };
  });

interface TransitionInput {
  readonly batchId: string;
  /** `null` for the worker. A teacher's id otherwise. */
  readonly actorId: string | null;
  readonly clock: Pick<Clock, 'now'>;
}

/** `DRAFT → READY`. The gate must be open, hold window aside. */
export const markBatchReady = (db: ReleaseBatchDb, input: TransitionInput) =>
  transition(db, { ...input, to: 'READY', gate: 'READY' });

/** `READY → DRAFT`. The only way back, and only from before the freeze. */
export const reopenBatch = (db: ReleaseBatchDb, input: TransitionInput) =>
  transition(db, { ...input, to: 'DRAFT', gate: null });

/**
 * `READY → RELEASING`. **THIS IS THE FREEZE.**
 *
 * The gate is evaluated under the row lock and the status is written in the same transaction, so the membership that
 * was verified is the membership that is frozen -- there is no instant in which the batch is checked and still open.
 * From here `releaseBatch` (`release.ts`) is the only way forward and `cancelBatch` the only way out.
 */
export const beginRelease = (db: ReleaseBatchDb, input: TransitionInput) =>
  transition(db, { ...input, to: 'RELEASING', gate: 'RELEASING' });

/**
 * `DRAFT | READY | RELEASING → CANCELED`, with a person and a reason.
 *
 * A cancelled batch looks, to the students in it, exactly like one that was never made. The reason is for the
 * teacher's colleague who finds it three weeks later and has to decide whether those results were meant to go out.
 */
export async function cancelBatch(
  db: ReleaseBatchDb,
  input: {
    readonly batchId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<BatchResult<{ readonly from: ReleaseBatchStatus; readonly to: ReleaseBatchStatus }>> {
  if (typeof input.actorId !== 'string' || input.actorId.trim() === '') {
    return { ok: false, reason: 'NO_ACTOR' };
  }
  if (typeof input.reason !== 'string' || reasonLength(input.reason) < MIN_OVERRIDE_REASON) {
    return { ok: false, reason: 'NO_REASON' };
  }
  return transition(db, {
    batchId: input.batchId,
    actorId: input.actorId,
    clock: input.clock,
    to: 'CANCELED',
    gate: null,
    meta: { reason: input.reason.trim() },
  });
}

/**
 * THE BLOCKERS, LISTED -- for the teacher, before they press anything.  (`plans/07` §6.3)
 *
 * **Teacher-facing.** A blocker names an attempt and says what state its marking is in. Nothing here is projected for
 * a student; `attemptReleaseState` is the student's entire view.
 */
export async function evaluateBatchGate(
  db: ReleaseBatchDb,
  input: {
    readonly batchId: string;
    readonly entering: 'READY' | 'RELEASING';
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<(GateVerdict & { readonly status: ReleaseBatchStatus }) | null> {
  return db.$transaction(async (tx) => {
    const gate = await loadGate(tx, input.batchId, input.entering, input.clock);
    if (gate === null) return null;
    const status = parseReleaseBatchStatus(gate.loaded.status);
    if (status === null) {
      throw new Error(
        `RELEASE_BATCH_UNKNOWN_STATUS: "${gate.loaded.status}" on batch ${input.batchId}`,
      );
    }
    return { ...gate.verdict, status };
  });
}

/**
 * RECORD AN OVERRIDE: who, when, why, and exactly which attempts.  (P10-T3)
 *
 * `plans/07` §6.3: "a teacher may override with a reason, stored on the batch and in the audit log". Both writes are
 * in one transaction. The batch row is what the release reads; the audit row is what survives a second override
 * replacing the first, so the history of who waived what is never only as long as the latest decision.
 */
export async function recordReleaseOverride(
  db: ReleaseBatchDb,
  input: {
    readonly batchId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly clock: Pick<Clock, 'now'>;
  },
): Promise<
  | { readonly ok: true; readonly record: OverrideRecord }
  | { readonly ok: false; readonly reason: OverrideRefusal }
> {
  const at = input.clock.now();

  return db.$transaction(async (tx) => {
    const batch = await lockBatch(tx, input.batchId);
    if (batch === null) return { ok: false, reason: 'BATCH_NOT_FOUND' };

    const loaded = await loadReleasePlan(asReleaseDb(tx), {
      batchId: input.batchId,
      latePenaltyPercent: GATE_LATE_PENALTY,
      clock: input.clock,
    });
    if (loaded === null) return { ok: false, reason: 'BATCH_NOT_FOUND' };

    // WITH NOTHING WAIVED -- see `decideOverride`. Same rows, a different question, no second read.
    const unwaived = planRelease({ ...loaded.check, waivedAttemptIds: new Set() });
    const decision = decideOverride({
      status: batch.status,
      actorId: input.actorId,
      reason: input.reason,
      at,
      blockers: evaluateGate({
        entering: 'RELEASING',
        memberCount: loaded.attemptIds.length,
        refusals: unwaived.refusals,
      }).blockers,
    });
    if (!decision.ok) return decision;

    // The foreign key would refuse an unknown author too, as a thrown P2003. Looked up first so it is a refusal with
    // a name, and so the audit row below is never written for an actor who does not exist.
    const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { id: true } });
    if (actor === null) return { ok: false, reason: 'ACTOR_NOT_FOUND' };

    const { record } = decision;
    await tx.releaseBatch.update({
      where: { id: input.batchId },
      data: {
        overrideReason: record.reason,
        overrideById: record.actorId,
        overrideAt: new Date(record.at),
        overrideWaived: record.waived.map((entry) => ({ ...entry })),
      },
    });

    await audit(tx, {
      action: 'ReleaseBatch.override',
      batchId: input.batchId,
      classroomId: batch.classroomId,
      actorId: record.actorId,
      at: record.at,
      meta: { status: batch.status, reason: record.reason, waived: record.waived },
    });

    return { ok: true, record };
  });
}

/**
 * IS THIS ATTEMPT RELEASED?  The one visibility rule, `plans/07` §6.1:
 *
 * ```sql
 * EXISTS (SELECT 1 FROM "ReleaseBatchMember" m JOIN "ReleaseBatch" b ON b.id = m."batchId"
 *         WHERE m."attemptId" = $1 AND b.status = 'RELEASED')
 * ```
 *
 * It answers `SEALED` for an attempt in no batch, in an unreleased batch, and for an id that names no attempt at all
 * -- the same value, never a throw. Whether the caller may ask about this attempt is `@orrery/auth`'s question; what
 * this function must not do is turn "which kind of not-released" into a difference a status code could carry.
 */
export async function attemptReleaseState(
  db: Pick<PrismaClient, 'releaseBatchMember'>,
  attemptId: string,
): Promise<StudentReleaseState> {
  const released = await db.releaseBatchMember.findFirst({
    where: { attemptId, batch: { status: 'RELEASED' } },
    // An attempt can sit in more than one batch. The earliest release is when the student could first see it.
    orderBy: { batch: { releasedAt: 'asc' } },
    select: { batch: { select: { releasedAt: true } } },
  });
  return studentReleaseState(released === null ? null : { releasedAt: released.batch.releasedAt });
}
