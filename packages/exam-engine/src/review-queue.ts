/**
 * The review queue: ordering, claiming, and bulk claiming.  (P9-T1)
 *
 * `plans/07` §5.2's requirements, verbatim: "Filters: assignment, classroom, reviewer (mine / unclaimed / all), age,
 * question type, flagged, has-sim-answers, `needsHuman`. Bulk claim. Age and count indicators so nothing rots. Every
 * teacher in the classroom can see the queue; claiming takes a soft lock."
 *
 * ## `priority` IS BIGGER-SOONER, AND THE DEFAULT OF 0 IS DELIBERATE
 *
 * The schema is `priority Int @default(0)` with `@@index([status, priority, createdAt])`. Two orderings are possible with
 * that index and they are opposites, so the direction has to be a decision rather than a convention:
 *
 *  · ascending -- `priority` is a RANK, and 1 outranks 2.
 *  · descending -- `priority` is a WEIGHT, and 100 outranks 10.
 *
 * Descending is right here because the column is set by the system rather than by a teacher's numbering scheme, and
 * because a task with no explicit priority must sort ABOVE the explicitly-low ones rather than below everything. With
 * ascending, the default `0` would sort above every priority a teacher set. `compareQueueEntries` implements descending
 * and the tests pin both directions, because getting this backwards produces a queue where every urgent item is last.
 *
 * ## AND AGE IS THE FINAL TIEBREAK, NOT THE PRIMARY SORT
 *
 * §5.2 says "priority by age" at the point of creation, and "age and count indicators so nothing rots". Age alone would
 * starve a genuinely urgent attempt behind a thousand old easy ones; priority alone would let a low-priority task rot
 * forever. So priority first, then oldest first, and `ageMs` is exposed for the indicator rather than only for sorting.
 *
 * ## AND A SOFT LOCK IS NOT A LOCK
 *
 * §5.2 says "claiming takes a soft lock". That word is load-bearing: a hard lock means a teacher who closes their laptop
 * strands a student's script forever, and the queue has no way to notice. So a claim records WHO and WHEN and is
 * releasable, and `canClaim` deliberately does not consult age -- a soft lock that expires by itself is a hard lock
 * with extra steps, and P9-T8 is where the optimistic locking lives.
 */

import type { Millis } from '@orrery/clock';

export type ReviewTaskStatus = 'PENDING' | 'CLAIMED' | 'DONE';
export type ReviewerScope = 'MINE' | 'UNCLAIMED' | 'ALL';

/** One queue row, as `ReviewTask` stores it plus the fields the queue's indicators need. */
export interface ReviewQueueEntry {
  readonly id: string;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly classroomId: string;
  readonly status: ReviewTaskStatus;
  /** `null` until claimed. */
  readonly graderId: string | null;
  readonly claimedAt: Millis | null;
  /** Bigger is sooner. See the note at the top of this file. */
  readonly priority: number;
  readonly createdAt: Millis;
  readonly attemptStatus: string;
  readonly flagged: boolean;
  readonly hasSimAnswers: boolean;
  readonly needsHuman: boolean;
  readonly questionTypes: readonly string[];
}

export interface QueueFilter {
  readonly assignmentId?: string;
  readonly classroomId?: string;
  readonly scope: ReviewerScope;
  readonly viewerId: string;
  /** Only entries at least this old. */
  readonly minAgeMs?: Millis;
  readonly questionType?: string;
  readonly flaggedOnly?: boolean;
  readonly withSimAnswersOnly?: boolean;
  readonly needsHumanOnly?: boolean;
}

/**
 * ORDER TWO ENTRIES.
 *
 * Priority descending, then oldest first. Exported so the database's `orderBy` and the in-memory list can be checked
 * against each other -- a queue whose SQL ordering and whose fallback ordering disagree is a queue that reorders
 * itself when the database is briefly unavailable.
 */
export const compareQueueEntries = (a: ReviewQueueEntry, b: ReviewQueueEntry): number => {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.createdAt - b.createdAt;
};

/** Does this entry match the filter? Pure, so the filter is testable without a database. */
export const matchesFilter = (
  entry: ReviewQueueEntry,
  filter: QueueFilter,
  now: Millis,
): boolean => {
  if (filter.assignmentId !== undefined && entry.assignmentId !== filter.assignmentId) return false;
  if (filter.classroomId !== undefined && entry.classroomId !== filter.classroomId) return false;

  /**
   * `UNCLAIMED` IS A FILTER, NOT A STATUS.
   *
   * The schema has no "unclaimed" status -- an unclaimed task is `PENDING` with a null grader -- so a scope that
   * filtered on the string "UNCLAIMED" would match nothing at all, and the most-used filter in the UI would silently
   * return an empty queue that looks like "no work waiting".
   */
  switch (filter.scope) {
    case 'MINE':
      if (entry.graderId !== filter.viewerId) return false;
      break;
    case 'UNCLAIMED':
      if (entry.status !== 'PENDING' || entry.graderId !== null) return false;
      break;
    case 'ALL':
      break;
    default:
      return false;
  }

  if (filter.minAgeMs !== undefined && now - entry.createdAt < filter.minAgeMs) return false;
  if (filter.questionType !== undefined && !entry.questionTypes.includes(filter.questionType))
    return false;
  if (filter.flaggedOnly === true && !entry.flagged) return false;
  if (filter.withSimAnswersOnly === true && !entry.hasSimAnswers) return false;
  if (filter.needsHumanOnly === true && !entry.needsHuman) return false;

  return true;
};

export interface QueueCounts {
  readonly total: number;
  readonly unclaimed: number;
  readonly mine: number;
  readonly done: number;
  readonly flagged: number;
  readonly needsHuman: number;
}

/**
 * THE COUNTS, over the UNFILTERED queue.
 *
 * Over the unfiltered set on purpose: the counts are indicators of how much work is waiting, and a count that narrowed
 * with the current filter would report "0 waiting" the moment you filtered to the one you are working on, which is the
 * opposite of what an indicator is for. It also means the numbers stay stable as a teacher clicks around, so a falling
 * count means work got done.
 */
export const queueCounts = (
  entries: readonly ReviewQueueEntry[],
  viewerId: string,
): QueueCounts => {
  let unclaimed = 0;
  let mine = 0;
  let done = 0;
  let flagged = 0;
  let needsHuman = 0;

  for (const entry of entries) {
    if (entry.status === 'PENDING' && entry.graderId === null) unclaimed += 1;
    if (entry.graderId === viewerId && entry.status !== 'DONE') mine += 1;
    if (entry.status === 'DONE') done += 1;
    if (entry.flagged) flagged += 1;
    if (entry.needsHuman) needsHuman += 1;
  }

  return { total: entries.length, unclaimed, mine, done, flagged, needsHuman };
};

export type ClaimRefusal =
  /** Somebody else holds it. */
  | 'ALREADY_CLAIMED'
  /** Already graded, so there is nothing to claim. */
  | 'ALREADY_DONE'
  /** Soft locks are not transferable by the queue; releasing is a separate, deliberate act. */
  | 'CLAIM_EXPIRED';

export type ClaimOutcome =
  | { readonly ok: true; readonly entry: ReviewQueueEntry }
  | {
      readonly ok: false;
      readonly reason: ClaimRefusal;
      readonly message: string;
      readonly heldBy: string | null;
    };

/**
 * CAN THIS TEACHER TAKE THIS TASK?
 *
 * ## AND IT DELIBERATELY DOES NOT CHECK THE CLAIM'S AGE
 *
 * A soft lock whose expiry is decided here would be a hard lock with extra steps: a teacher who closes their laptop
 * mid-lesson would lose their claim, and two teachers would then grade the same script with no record that both were
 * doing it. P9-T8 is where optimistic locking and presence live. What this refuses is a claim held by SOMEONE ELSE,
 * which is the case a bulk-claim has to get right.
 */
export const canClaim = (entry: ReviewQueueEntry, graderId: string): ClaimOutcome => {
  if (entry.status === 'DONE') {
    return {
      ok: false,
      reason: 'ALREADY_DONE',
      message: 'this script has already been graded',
      heldBy: entry.graderId,
    };
  }

  // Re-claiming your OWN claim is a no-op success, not a refusal. A double-click on "claim" must not produce an error
  // dialog telling the teacher they cannot claim something they already hold.
  if (entry.graderId === graderId) {
    return { ok: true, entry };
  }

  if (entry.graderId !== null) {
    return {
      ok: false,
      reason: 'ALREADY_CLAIMED',
      message: 'another teacher is already grading this',
      heldBy: entry.graderId,
    };
  }

  if (entry.status !== 'PENDING') {
    return {
      ok: false,
      reason: 'CLAIM_EXPIRED',
      message: 'this claim is no longer active',
      heldBy: entry.graderId,
    };
  }

  /**
   * THE DEAD BRANCH THAT WAS HERE, AND WHY IT IS NOT SIMPLY RESTORED SOMEWHERE ELSE.
   *
   * This refused `TERMINATED` and `ABANDONED`, on the reasoning that grading them "produces a score nobody will
   * read". Neither status can occur: `V-12` removed `TERMINATED` from `AttemptStatus` in P8-T11, and `ABANDONED` was
   * never in the Prisma schema at all -- so the guard was standing in front of nothing, and a frozen attempt was
   * being waved through it by accident rather than by decision.
   *
   * **A FROZEN ATTEMPT MUST BE CLAIMABLE, AND THAT IS THE POINT OF THE CORRECTION.** `V-12` exists because the old
   * termination discarded unwritten work; the freeze that replaced it submits what was written and sends the attempt
   * to a teacher precisely so that a human decides. A guard that made frozen attempts unclaimable would reinstate the
   * original bug with better manners -- the student's written answers would sit in a queue nobody can reach, which is
   * the same lost grade by a different route.
   *
   * So there is deliberately NO branch here. The finding is that the one that existed tested two statuses that
   * cannot occur, and a `FROZEN` check that returned the same value as falling through would be a comment pretending
   * to be a constraint. `ATTEMPT_NOT_GRADABLE` is removed from `ClaimRefusal` with it, because an unused refusal
   * reason in a union is a promise the code no longer keeps.
   */
  return { ok: true, entry };
};

export interface BulkClaimResult {
  readonly claimed: readonly string[];
  readonly refused: readonly { readonly taskId: string; readonly reason: ClaimRefusal }[];
}

/**
 * BULK CLAIM, AND THE PARTIAL SUCCESS IS THE POINT.
 *
 * §5.2 says "Bulk claim" without saying what happens when some of them are taken. Answering that here rather than in a
 * caller: a bulk claim that is all-or-nothing is useless, because the tasks most likely to be taken are exactly the ones
 * a teacher most wants (the old, flagged, needs-human ones), so an all-or-nothing bulk claim of the top twenty fails
 * whenever anyone else is working.
 *
 * So it returns both lists. The claimed ones are real and must be graded; the refused ones are reported so the UI can
 * say which, rather than the teacher discovering it by finding scripts missing from their list.
 */
export const bulkClaim = (
  entries: readonly ReviewQueueEntry[],
  graderId: string,
  now: Millis,
): BulkClaimResult => {
  const ordered = [...entries].sort(compareQueueEntries);
  const claimed: string[] = [];
  const refused: { taskId: string; reason: ClaimRefusal }[] = [];

  for (const entry of ordered) {
    const outcome = canClaim(entry, graderId);
    if (outcome.ok) {
      claimed.push(entry.id);
      void now;
    } else {
      refused.push({ taskId: entry.id, reason: outcome.reason });
    }
  }

  return { claimed, refused };
};

/** THE AGE INDICATOR, and its thresholds are about attention rather than aesthetics. */
export const ageIndicator = (createdAt: Millis, now: Millis): 'FRESH' | 'AGEING' | 'STALE' => {
  const age = now - createdAt;
  // A day is a working day. Past two, a task is rotting: nobody is coming back for it, and it needs reassignment.
  if (age >= 2 * 86_400_000) return 'STALE';
  if (age >= 86_400_000) return 'AGEING';
  return 'FRESH';
};
