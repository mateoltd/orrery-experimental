/**
 * The roster READ model.  (P4-T6)
 *
 * ## Why this is not in `roster.ts`
 *
 * `roster.ts` is the CSV import: it takes text a teacher uploaded and reconciles it against the
 * database. This file takes a teacher looking at a classroom and answers "who is in here, and how
 * are they doing". They share a table and almost nothing else, and one file named `roster.ts`
 * doing both would be the file nobody re-reads before changing the import.
 *
 * ## The classroom scope is IN THE QUERY, and that is a test-shaped instruction
 *
 * `plans/12` §4: "A teacher sees only their own classrooms. Classroom scoping is applied *in the
 * query*, not filtered afterwards, and a test asserts the generated SQL contains the scope."
 *
 * It is stated that bluntly because the two implementations are INDISTINGUISHABLE from the
 * result. A post-filter passes every behavioural test in the file — it just reads the whole
 * classroom table and throws the rows away afterwards, which is correct output from a function
 * that scales like the school. Only the emitted SQL tells them apart. So `listRoster` takes
 * `classroomId` and puts it in the `where`, and the test captures the statement and asserts the
 * scope is a bound parameter of it.
 *
 * ## A GRADE IS FETCHED ONLY WHEN IT HAS BEEN RELEASED, as a predicate and not a display rule
 *
 * The summary shows "grade (released only)". The tempting implementation fetches the grade and
 * then declines to display it if unreleased — a display rule, in the client, where a future
 * component, an export, or a `title` attribute quietly undoes it.
 *
 * So an unreleased grade is never selected at all. The condition is a `RELEASED` batch on the
 * assignment, in the same `where` as everything else, because `ReleaseBatch` is the mechanism:
 * "results remain withheld until `ReleaseBatch.status = 'RELEASED'`" is an invariant of the data,
 * and filtering on it states the invariant rather than re-deciding it.
 *
 * ## A PLACEHOLDER IS SHOWN AS A PLACEHOLDER
 *
 * `plans/12` §3: unmatched students get placeholder accounts pending registration, matched on
 * first login by email. An unverified account is not yet a person, and a roster that renders it
 * as an ordinary member tells a teacher 400 children have accounts when 40 do. So `isPlaceholder`
 * is on the row and the UI must distinguish it.
 *
 * ## FOUR EMPTY STATES, because "no results" has four causes and two of them are emergencies
 *
 *  · `noMembers` — nobody has joined. Expected; the next step is to invite.
 *  · `searchExcluded` — they are all there and the search box hid them. The honest fix is to
 *    clear the box, and the misleading one sends the teacher to a support ticket.
 *  · `filterExcluded` — narrowed by role, same argument.
 *
 * The counts behind these are taken with the search and the role filter REMOVED and the classroom
 * scope kept, because the number that makes "nothing found" honest is how many there were before
 * the filter hid them.
 *
 * ## There is a FOURTH case, and it is deliberately NOT an empty state
 *
 * The first version had `endedHidden` here. It was DEAD: a room always has at least one ACTIVE
 * member — the owner — so a page with no search and no role filter is never empty, and the arm
 * could not fire. A union arm nobody can reach is worse than no arm, because the next reader
 * trusts that the empty states are exhaustive.
 *
 * A student who left is not an empty page either; they are a row the teacher cannot see. So it is
 * `endedCount` on the page — a number the UI can offer to reveal ("2 students left this year") —
 * and the test that was going to assert an empty state now asserts the count.
 */

import type { Actor } from '@orrery/auth/types';
import { type Clock, systemClock } from '@orrery/clock';
import { type ClassroomRole, permit } from './classrooms.js';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

const ROSTER_DEFAULT_LIMIT = 50;
const ROSTER_MAX_LIMIT = 200;
/** Bumped if the cursor payload changes shape. Opaque to clients either way. */
const CURSOR_VERSION = 1;

export interface RosterQuery {
  readonly classroomId: string;
  /** Matched against the account name, the classroom display name, and the email. */
  readonly search?: string | null;
  readonly role?: ClassroomRole | null;
  /** `false` by default: a roster page about who is HERE. */
  readonly includeEnded?: boolean;
  readonly limit?: number;
  /** Opaque. Only ever a `nextCursor` from a previous page of the SAME query. */
  readonly cursor?: string | null;
}

export interface RosterSummary {
  readonly assignmentsPublished: number;
  readonly attempts: number;
  readonly completed: number;
  readonly inProgress: number;
  readonly releasedGrades: number;
  /** `null` when nothing has been released — NOT zero, because zero is a mark that was awarded. */
  readonly latestReleasedPercentage: number | null;
  readonly latestReleasedLabel: string | null;
  readonly accommodations: number;
  /** The most recent thing they did in this classroom, or `null` if they have done nothing. */
  readonly lastActivityAt: Date | null;
}

export interface RosterRow {
  readonly enrollmentId: string;
  readonly userId: string;
  /** What to print. The override wins, and `hasDisplayNameOverride` says so on the row. */
  readonly displayName: string;
  readonly accountName: string;
  readonly hasDisplayNameOverride: boolean;
  readonly email: string;
  readonly role: ClassroomRole;
  readonly status: 'ACTIVE' | 'ENDED';
  readonly joinedAt: Date;
  readonly isPlaceholder: boolean;
  readonly summary: RosterSummary;
}

export type RosterEmpty =
  | { readonly reason: 'noMembers'; readonly inScope: 0 }
  | { readonly reason: 'searchExcluded'; readonly inScope: number; readonly search: string }
  | { readonly reason: 'filterExcluded'; readonly inScope: number; readonly role: ClassroomRole };

export interface RosterPage {
  readonly items: readonly RosterRow[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly empty: RosterEmpty | null;
  /**
   * How many memberships have ended, so the page can offer to show them. `null` when the query
   * already includes ended rows, because counting them again would be the same number twice.
   */
  readonly endedCount: number | null;
  readonly sort: 'name';
}

/** A refusal, carrying the status the caller should return. */
export class RosterDenied extends Error {
  constructor(
    readonly httpStatus: 403 | 404,
    readonly reason: string,
  ) {
    super(`listRoster refused: ${reason}`);
    this.name = 'RosterDenied';
  }
}

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, name, id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { name: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('listRoster: malformed cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== CURSOR_VERSION ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string'
  ) {
    throw new Error('listRoster: unrecognised cursor');
  }
  return { name: parsed[1], id: parsed[2] };
}

/**
 * The name a roster row sorts, searches and displays under.
 *
 * `plans/12` §6: the override is "the name a student appears under in that classroom only". So it
 * is the name for SORTING and SEARCHING too, not only for display — a teacher looking for "Reddy"
 * is looking for the name the class knows them by, and a list that puts them under a name nobody
 * uses is a list the teacher has to re-scan.
 */
function effectiveName(name: string, override: string | null): string {
  const trimmed = override?.trim();
  return trimmed === undefined || trimmed === '' ? name : trimmed;
}

type Candidate = {
  id: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: Date;
  displayNameOverride: string | null;
  user: { name: string; email: string; emailVerified: boolean };
};

const CANDIDATE_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  joinedAt: true,
  displayNameOverride: true,
  user: { select: { name: true, email: true, emailVerified: true } },
} as const;

/**
 * Scoping predicates, in ONE place, because they are built up and a copy is a leak.
 *
 * `plans/12` §4 again: the classroom id is a bound parameter of the statement from the first
 * predicate, never a comparison made in JavaScript on rows already read.
 */
function scopeFor(query: RosterQuery): Record<string, unknown> {
  const search = query.search?.trim() ?? '';
  const scope: Record<string, unknown> = {
    classroomId: query.classroomId,
    ...(query.includeEnded === true ? {} : { status: 'ACTIVE' }),
  };
  if (query.role !== null && query.role !== undefined) scope.role = query.role;
  if (search !== '') {
    scope.user = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        {
          enrollments: { some: { displayNameOverride: { contains: search, mode: 'insensitive' } } },
        },
      ],
    };
  }
  return scope;
}

export async function listRoster(
  db: Db,
  actor: Actor,
  query: RosterQuery,
  _clock: Clock = systemClock,
): Promise<RosterPage> {
  // The gate, not a comment. `permit` is the shared builder; an inline `can()` here is the
  // documented third way this family has grown a deny with the wrong context attached.
  // `action: 'read'` on the classroom is what §4's row authorises for: "Manage members and
  // roles". Reading a roster is not a separate capability, and inventing one would mean a second
  // place to forget to check it.
  const decision = await permit(db, {
    action: 'read',
    classroomId: query.classroomId,
    actor,
  });
  if (!decision.ok) throw new RosterDenied(decision.httpStatus, decision.reason);

  const limit = Math.min(Math.max(query.limit ?? ROSTER_DEFAULT_LIMIT, 1), ROSTER_MAX_LIMIT);
  const search = query.search?.trim() ?? '';
  const role = query.role ?? null;
  const scope = scopeFor(query);

  const total = await db.enrollment.count({ where: scope });

  // A first page reads a seeded window, doubles it, and re-sorts. OFFSET would be shorter, but
  // OFFSET is a lie on a table that changes under you — the roster grows as students join, and a
  // page requested twice returns overlapping or skipped rows.
  const overfetch = limit + 1;
  let take = 50;
  for (;;) {
    const candidates = await db.enrollment.findMany({
      where: scope,
      select: CANDIDATE_SELECT,
      take,
      orderBy: { id: 'asc' },
    });
    if (candidates.length >= overfetch || take >= 4000) {
      const sorted = [...candidates].sort(compareByEffectiveName);
      // The cursor is applied to the SORTED WINDOW, not to the statement. That is weaker than a
      // true keyset and stronger than ignoring it, and the reason is the sort key: it is
      // `COALESCE("displayNameOverride", "name")`, which Prisma cannot order by, and any teacher
      // in the room can change a display name at any moment. A keyset over a mutable sort key
      // cannot be made correct — moving a row across the cursor drops it from both pages or
      // duplicates it. Dropping the prefix here gives pages that do not overlap and do not skip
      // within one snapshot of the room, which is the guarantee a teacher paging a roster needs.
      const from =
        query.cursor === null || query.cursor === undefined
          ? 0
          : cursorIndex(sorted, decodeCursor(query.cursor));
      return buildPage(db, query, sorted.slice(from, from + overfetch), limit, total, search, role);
    }
    take = Math.min(take * 4, 4000);
  }
}

/**
 * `id` is always the final tiebreaker.
 *
 * Two students called Alex Chen must still have a total order, or a page boundary between them
 * is arbitrary and the pair can swap places on every reload.
 */
/**
 * Where the next page starts.
 *
 * By the CURSOR'S OWN id when that row is still in the window, because the id is a total order
 * and survives a display name being edited. When the row is gone — a student was removed, or a
 * search changed — the position is recovered from the stored name and clamped, so a stale cursor
 * pages forward instead of silently restarting at the top, which is what an ignored cursor does
 * and how a teacher ends up reading page 2 twice.
 */
function cursorIndex(sorted: readonly Candidate[], cursor: { name: string; id: string }): number {
  const exact = sorted.findIndex((c) => c.id === cursor.id);
  if (exact >= 0) return exact + 1;
  const byName = sorted.findIndex(
    (c) =>
      effectiveName(c.user.name, c.displayNameOverride).toLowerCase() === cursor.name.toLowerCase(),
  );
  return byName >= 0 ? byName + 1 : 0;
}

function compareByEffectiveName(a: Candidate, b: Candidate): number {
  const an = effectiveName(a.user.name, a.displayNameOverride).toLowerCase();
  const bn = effectiveName(b.user.name, b.displayNameOverride).toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return a.id < b.id ? -1 : 1;
}

interface ReleasedGrade {
  percentage: unknown;
  finalScore: unknown;
  maxScore: unknown;
  at: Date;
}

async function buildPage(
  db: Db,
  query: RosterQuery,
  window: readonly Candidate[],
  limit: number,
  total: number,
  search: string,
  role: ClassroomRole | null,
): Promise<RosterPage> {
  const hasMore = window.length > limit;
  const items = window.slice(0, limit);
  const studentIds = [...new Set(items.map((e) => e.userId))];

  const [assignmentsPublished, attempts, released, accommodations] = await Promise.all([
    db.assignment.count({ where: { classroomId: query.classroomId, status: 'PUBLISHED' } }),
    // One query for the WHOLE page, not one per student. The per-student version of this is the
    // easiest N+1 to write here, because each row already has a `userId` in hand.
    db.examAttempt.findMany({
      where: { classroomId: query.classroomId, studentId: { in: studentIds } },
      select: { studentId: true, status: true, startedAt: true, submittedAt: true },
    }),
    /**
     * ⚠️ **THE GATE WAS ON THE ASSIGNMENT, NOT ON THE ATTEMPT, AND IT LEAKED A SEALED GRADE.**
     *
     * This read it as
     *
     * ```ts
     * assignment: { releaseBatches: { some: { status: 'RELEASED' } } }
     * ```
     *
     * which asks "does this assignment have ANY released batch" -- a fact about the assignment, not about this
     * attempt. Release is **per batch membership** (`plans/01` §10: membership is frozen on `RELEASING`, and the
     * whole point is that a batch releases exactly its own members), so the two are different questions and only
     * one of them is the gate.
     *
     * The failure is concrete and needs no exotic setup: batch `B1` holds student S's attempt and is `RELEASED`;
     * batch `B2` holds student T's attempt on the *same assignment* and is still `DRAFT`. T's attempt satisfies the
     * predicate -- the assignment owns a released batch -- so `finalScore`, `maxScore` and `percentage` were read
     * for an attempt nobody had released, and the roster row showed them. `INV-RELEASE-2` says no score is
     * *inferable* before release, and a percentage on a teacher's roster is about as inferable as it gets.
     *
     * **IT WAS ALSO NOT A TYPE ERROR OR A CRASH.** The query is valid Prisma, the columns exist, and the row is
     * only wrong when a second batch exists -- which is the normal state of any classroom releasing in more than one
     * go. A gate this narrow passes every test written against a single batch, and there were several.
     *
     * **THE RELATION WAS ALREADY THERE.** `ExamAttempt.releaseMembers` has existed since `0001_init`, so the
     * correct query was always writable -- one word different. That is worth recording precisely because the
     * narrative I first reached for ("the schema was missing the relation") was wrong, and it is the more
     * comfortable story: a missing schema feature looks like an oversight somebody can fix, whereas "the right
     * query was available and a query chose a different one" means a gate can be wrong while everything it is
     * built from is correct. Gates do not fail loudly. They fail quietly, and the wrongness is in the sentence
     * nobody re-reads.
     *
     * The narrower reading is also the safer one in the other direction: membership is the ONLY thing that is
     * frozen, so it is the only sound basis for a visibility decision.
     */
    db.examAttempt.findMany({
      where: {
        classroomId: query.classroomId,
        studentId: { in: studentIds },
        releaseMembers: { some: { batch: { status: 'RELEASED' } } },
      },
      select: {
        studentId: true,
        finalScore: true,
        maxScore: true,
        percentage: true,
        submittedAt: true,
      },
    }),
    db.accommodation.groupBy({
      by: ['studentId'],
      where: {
        classroomId: query.classroomId,
        studentId: { in: studentIds },
        status: 'ACTIVE',
        revokedAt: null,
      },
      _count: { _all: true },
    }),
  ]);

  const slots = new Map<
    string,
    {
      attempts: number;
      completed: number;
      inProgress: number;
      last: Date | null;
      grades: ReleasedGrade[];
    }
  >();
  for (const id of studentIds) {
    slots.set(id, { attempts: 0, completed: 0, inProgress: 0, last: null, grades: [] });
  }
  for (const a of attempts) {
    const slot = slots.get(a.studentId);
    if (slot === undefined) continue;
    slot.attempts += 1;
    if (a.status === 'SUBMITTED' || a.status === 'GRADED' || a.status === 'PENDING_REVIEW') {
      slot.completed += 1;
    }
    if (a.status === 'IN_PROGRESS') slot.inProgress += 1;
    for (const at of [a.startedAt, a.submittedAt]) {
      if (at !== null && (slot.last === null || at > slot.last)) slot.last = at;
    }
  }
  for (const g of released) {
    const slot = slots.get(g.studentId);
    if (slot === undefined) continue;
    slot.grades.push({
      percentage: g.percentage,
      finalScore: g.finalScore,
      maxScore: g.maxScore,
      at: g.submittedAt ?? new Date(0),
    });
  }
  const accom = new Map(accommodations.map((a) => [a.studentId, a._count._all]));

  const rows: RosterRow[] = items.map((e) => {
    const slot = slots.get(e.userId);
    const grades = slot?.grades ?? [];
    const latest = grades.length === 0 ? undefined : grades.reduce((a, b) => (b.at > a.at ? b : a));
    const override = e.displayNameOverride?.trim();
    return {
      enrollmentId: e.id,
      userId: e.userId,
      displayName: effectiveName(e.user.name, e.displayNameOverride),
      accountName: e.user.name,
      hasDisplayNameOverride: override !== undefined && override !== '',
      email: e.user.email,
      role: e.role as ClassroomRole,
      status: e.status === 'ACTIVE' ? ('ACTIVE' as const) : ('ENDED' as const),
      joinedAt: e.joinedAt,
      isPlaceholder: !e.user.emailVerified,
      summary: {
        assignmentsPublished,
        attempts: slot?.attempts ?? 0,
        completed: slot?.completed ?? 0,
        inProgress: slot?.inProgress ?? 0,
        releasedGrades: grades.length,
        latestReleasedPercentage: toNumber(latest?.percentage),
        latestReleasedLabel: formatGrade(latest),
        accommodations: accom.get(e.userId) ?? 0,
        lastActivityAt: slot?.last ?? null,
      },
    };
  });

  // The counts behind the empty states, with the search and role filter DROPPED and the
  // classroom scope KEPT. Two extra COUNTs against a classroom-sized index is a fair price for
  // not sending a teacher to a support ticket, and it is why the empty state can say "40 students
  // are in this class, none match 'Zzz'" instead of "no results".
  let empty: RosterEmpty | null = null;
  if (rows.length === 0) {
    const unfiltered = await db.enrollment.count({
      where: scopeFor({ classroomId: query.classroomId, includeEnded: query.includeEnded }),
    });
    if (search !== '') {
      empty = { reason: 'searchExcluded', inScope: unfiltered, search };
    } else if (role !== null) {
      empty = { reason: 'filterExcluded', inScope: unfiltered, role };
    } else {
      empty = { reason: 'noMembers', inScope: 0 };
    }
  }

  // Batched with the others, and only when the rows are not already showing ended membership.
  const endedCount =
    query.includeEnded === true
      ? null
      : (await db.enrollment.count({
          where: scopeFor({ classroomId: query.classroomId, includeEnded: true }),
        })) -
        (await db.enrollment.count({
          where: scopeFor({ classroomId: query.classroomId, includeEnded: false }),
        }));

  const last = items[items.length - 1];
  return {
    items: rows,
    total,
    hasMore,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor(effectiveName(last.user.name, last.displayNameOverride), last.id)
        : null,
    empty,
    endedCount,
    sort: 'name',
  };
}

function formatGrade(g: ReleasedGrade | undefined): string | null {
  if (g === undefined) return null;
  const pct = toNumber(g.percentage);
  if (pct !== null) return `${pct.toFixed(1)}%`;
  const final = toNumber(g.finalScore);
  const max = toNumber(g.maxScore);
  if (final !== null && max !== null && max > 0) return `${final.toFixed(1)} / ${max.toFixed(1)}`;
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
