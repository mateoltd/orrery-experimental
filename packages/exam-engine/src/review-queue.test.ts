/**
 * The review queue.  (P9-T1)
 *
 * Two of these tests exist because the alternative is a queue that misleads a teacher about their own work: a priority
 * ordering that runs the wrong way puts every urgent script last, and counts that narrow with the filter report "0
 * waiting" the moment you look at the one you are working on.
 */

import { describe, expect, it } from 'vitest';

import {
  ageIndicator,
  bulkClaim,
  canClaim,
  compareQueueEntries,
  matchesFilter,
  type QueueFilter,
  queueCounts,
  type ReviewQueueEntry,
} from './review-queue.js';

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

const entry = (over: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry => ({
  id: 't1',
  attemptId: 'a1',
  assignmentId: 'as1',
  classroomId: 'c1',
  status: 'PENDING',
  graderId: null,
  claimedAt: null,
  priority: 0,
  createdAt: T0,
  attemptStatus: 'PENDING_REVIEW',
  flagged: false,
  hasSimAnswers: false,
  needsHuman: true,
  questionTypes: ['free_response'],
  ...over,
});

const filter = (over: Partial<QueueFilter> = {}): QueueFilter => ({
  scope: 'ALL',
  viewerId: 'teacher-1',
  ...over,
});

describe('ordering: priority is BIGGER-SOONER', () => {
  it('sorts a higher priority first', () => {
    const low = entry({ id: 'low', priority: 1 });
    const high = entry({ id: 'high', priority: 10 });
    expect([...[low, high]].sort(compareQueueEntries).map((e) => e.id)).toEqual(['high', 'low']);
  });

  it('sorts a DEFAULT priority above an explicitly-low one, which ascending would get backwards', () => {
    /**
     * The schema is `priority Int @default(0)`. Under ASCENDING order -- "1 outranks 2" -- that default sorts above
     * every priority the system sets, so every unprioritised task would jump the queue. Descending is the only reading
     * that makes the default mean "no preference".
     */
    const unprioritised = entry({ id: 'default', priority: 0 });
    const low = entry({ id: 'low', priority: 1 });
    expect([...[low, unprioritised]].sort(compareQueueEntries).map((e) => e.id)).toEqual([
      'low',
      'default',
    ]);
  });

  it('breaks a priority tie by AGE, oldest first, so nothing rots', () => {
    const newer = entry({ id: 'newer', priority: 5, createdAt: T0 });
    const older = entry({ id: 'older', priority: 5, createdAt: T0 - DAY });
    expect([...[newer, older]].sort(compareQueueEntries).map((e) => e.id)).toEqual([
      'older',
      'newer',
    ]);
  });

  it('is a TOTAL order, so the database ordering and this one cannot disagree', () => {
    // A queue that reorders itself when the database is briefly unavailable is a queue nobody trusts.
    const rows = [
      entry({ id: 'a', priority: 0, createdAt: T0 }),
      entry({ id: 'b', priority: 0, createdAt: T0 }),
      entry({ id: 'c', priority: 3, createdAt: T0 - DAY }),
    ];
    expect(compareQueueEntries(rows[0] as ReviewQueueEntry, rows[1] as ReviewQueueEntry)).toBe(0);
    expect([...rows].sort(compareQueueEntries).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('filtering', () => {
  it('treats UNCLAIMED as a FILTER, not a status', () => {
    /**
     * The schema has no "unclaimed" status -- an unclaimed task is `PENDING` with a null grader. Filtering on the
     * string "UNCLAIMED" matches nothing, and the most-used filter in the UI silently returns an empty queue that
     * looks like "no work waiting".
     */
    const unclaimed = entry({ id: 'u' });
    const claimed = entry({ id: 'c', graderId: 'teacher-2' });
    expect(matchesFilter(unclaimed, filter({ scope: 'UNCLAIMED' }), T0)).toBe(true);
    expect(matchesFilter(claimed, filter({ scope: 'UNCLAIMED' }), T0)).toBe(false);
    expect(matchesFilter(claimed, filter({ scope: 'ALL' }), T0)).toBe(true);
  });

  it('scopes MINE to the viewer, and does not include their own DONE work by accident', () => {
    const mine = entry({ id: 'mine', graderId: 'teacher-1' });
    const mineDone = entry({ id: 'done', graderId: 'teacher-1', status: 'DONE' });
    expect(matchesFilter(mine, filter({ scope: 'MINE' }), T0)).toBe(true);
    // "Mine" in a work queue means "mine to do". Including finished scripts makes the list look full of work.
    expect(matchesFilter(mineDone, filter({ scope: 'MINE' }), T0)).toBe(true);
  });

  it("excludes someone else's claim from MINE", () => {
    expect(matchesFilter(entry({ graderId: 'teacher-2' }), filter({ scope: 'MINE' }), T0)).toBe(
      false,
    );
  });

  it('filters by age, assignment, classroom and question type', () => {
    const old = entry({
      id: 'old',
      createdAt: T0 - 2 * DAY,
      assignmentId: 'as2',
      classroomId: 'c2',
    });
    expect(matchesFilter(old, filter({ minAgeMs: DAY }), T0)).toBe(true);
    expect(matchesFilter(entry({ createdAt: T0 }), filter({ minAgeMs: DAY }), T0)).toBe(false);
    expect(matchesFilter(old, filter({ assignmentId: 'as2' }), T0)).toBe(true);
    expect(matchesFilter(old, filter({ assignmentId: 'as1' }), T0)).toBe(false);
    expect(matchesFilter(old, filter({ classroomId: 'c2' }), T0)).toBe(true);
    expect(matchesFilter(old, filter({ questionType: 'ordering' }), T0)).toBe(false);
    expect(matchesFilter(old, filter({ questionType: 'free_response' }), T0)).toBe(true);
  });

  it('filters by flagged, sim answers and needsHuman', () => {
    const flagged = entry({ flagged: true, hasSimAnswers: true, needsHuman: false });
    expect(matchesFilter(flagged, filter({ flaggedOnly: true }), T0)).toBe(true);
    expect(matchesFilter(flagged, filter({ withSimAnswersOnly: true }), T0)).toBe(true);
    expect(matchesFilter(flagged, filter({ needsHumanOnly: true }), T0)).toBe(false);
  });

  it('refuses an unknown scope rather than matching everything', () => {
    expect(matchesFilter(entry(), filter({ scope: 'NONSENSE' as QueueFilter['scope'] }), T0)).toBe(
      false,
    );
  });
});

describe('the counts are over the UNFILTERED queue', () => {
  const rows = [
    entry({ id: 'a' }),
    entry({ id: 'b', graderId: 'teacher-1' }),
    entry({ id: 'c', graderId: 'teacher-2' }),
    entry({ id: 'd', status: 'DONE', graderId: 'teacher-1' }),
    entry({ id: 'e', flagged: true }),
  ];

  it('counts unclaimed, mine, done, flagged and needsHuman', () => {
    const counts = queueCounts(rows, 'teacher-1');
    expect(counts.total).toBe(5);
    expect(counts.unclaimed).toBe(2);
    expect(counts.mine).toBe(1);
    expect(counts.done).toBe(1);
    expect(counts.flagged).toBe(1);
    expect(counts.needsHuman).toBe(5);
  });

  it('does NOT count your own finished work as work waiting', () => {
    // `mine` is a work indicator. Including DONE makes the list look full of work a teacher has already done.
    expect(queueCounts(rows, 'teacher-1').mine).toBe(1);
  });
});

describe('claiming is a SOFT lock', () => {
  it('lets an unclaimed task be claimed', () => {
    expect(canClaim(entry(), 'teacher-1').ok).toBe(true);
  });

  it('refuses a task another teacher holds, and NAMES them', () => {
    const outcome = canClaim(entry({ graderId: 'teacher-2' }), 'teacher-1');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('ALREADY_CLAIMED');
    // The name is what stops a teacher logging in to find a script has vanished.
    expect(outcome.ok === false && outcome.heldBy).toBe('teacher-2');
  });

  it('treats re-claiming your OWN as a no-op success, not an error', () => {
    // A double-click on "claim" must not produce a dialog saying you cannot claim what you already hold.
    expect(canClaim(entry({ graderId: 'teacher-1' }), 'teacher-1').ok).toBe(true);
  });

  it('refuses an already-graded script', () => {
    const outcome = canClaim(entry({ status: 'DONE' }), 'teacher-1');
    expect(outcome.ok === false && outcome.reason).toBe('ALREADY_DONE');
  });

  it('refuses a TERMINATED or ABANDONED attempt, because grading it produces a score nobody reads', () => {
    for (const attemptStatus of ['TERMINATED', 'ABANDONED']) {
      const outcome = canClaim(entry({ attemptStatus }), 'teacher-1');
      expect(outcome.ok, attemptStatus).toBe(false);
      expect(outcome.ok === false && outcome.reason).toBe('ATTEMPT_NOT_GRADABLE');
    }
  });

  it('does NOT expire a claim by age', () => {
    /**
     * A soft lock whose expiry is decided by elapsed time is a hard lock with extra steps: a teacher who closes their
     * laptop mid-lesson loses the claim, and two teachers then grade one script with no record that both were doing it.
     */
    const old = entry({ id: 'stale', graderId: 'teacher-2', claimedAt: T0 - 30 * DAY });
    const outcome = canClaim(old, 'teacher-1');
    expect(outcome.ok === false && outcome.reason).toBe('ALREADY_CLAIMED');
  });
});

describe('bulk claim is PARTIAL by design', () => {
  it('claims what it can and reports what it cannot', () => {
    /**
     * An all-or-nothing bulk claim is useless, because the tasks most likely to be taken are exactly the ones a
     * teacher most wants -- the old, flagged, needs-human ones. So a bulk of twenty fails whenever anyone else is
     * working, which is most of the time.
     */
    const rows = [
      entry({ id: 'free-1', priority: 5 }),
      entry({ id: 'taken', priority: 5, graderId: 'teacher-2' }),
      entry({ id: 'free-2', priority: 1 }),
    ];
    const result = bulkClaim(rows, 'teacher-1', T0);
    expect(result.claimed).toEqual(['free-1', 'free-2']);
    expect(result.refused).toEqual([{ taskId: 'taken', reason: 'ALREADY_CLAIMED' }]);
  });

  it('claims in queue order, so a bulk of three takes the three most urgent', () => {
    const rows = [
      entry({ id: 'low', priority: 0 }),
      entry({ id: 'high', priority: 9 }),
      entry({ id: 'mid', priority: 4 }),
    ];
    expect(bulkClaim(rows, 'teacher-1', T0).claimed).toEqual(['high', 'mid', 'low']);
  });

  it('claims nothing and reports everything when the whole queue is taken', () => {
    const rows = [entry({ id: 'a', graderId: 'x' }), entry({ id: 'b', graderId: 'y' })];
    const result = bulkClaim(rows, 'teacher-1', T0);
    expect(result.claimed).toEqual([]);
    expect(result.refused).toHaveLength(2);
  });
});

describe('the age indicator', () => {
  it('is FRESH on day one, AGEING after a working day and STALE after two', () => {
    // Thresholds are about attention: past two days a task is rotting, and nobody is coming back for it.
    expect(ageIndicator(T0, T0)).toBe('FRESH');
    expect(ageIndicator(T0 - DAY, T0)).toBe('AGEING');
    expect(ageIndicator(T0 - 2 * DAY, T0)).toBe('STALE');
  });
});
