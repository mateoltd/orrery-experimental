/**
 * The exam policy: its type, its two profiles, how it resolves, and how it is validated.  (P5-T1)
 *
 * ## WHY THIS IS IN CONTRACTS AND NOT IN `packages/db`
 *
 * `plans/09` §4 is a pure function of four inputs producing a frozen value. A database does not
 * know what a grace period is, and putting `resolve()` next to Prisma would make the two hardest
 * things in P5 — the fold order and the consistency rules — untestable without a server running.
 * So the vocabulary and the arithmetic live here, and `packages/db/src/assignments.ts` only
 * fetches the four inputs and writes the result.
 *
 * ## THE FOLD ORDER IS THE SPECIFICATION
 *
 * ```
 * resolvedAtPublish = resolve(assignment.policyOverride,
 *                            resourceVersion.assessmentPolicy,
 *                            studentOverride,
 *                            accommodation)
 * ```
 *
 * Read left to right as increasing priority, which is the only reading that makes sense: a
 * version is what the author wrote, an assignment is what the teacher set, a student override is
 * what the teacher granted to one child, and an accommodation is a right rather than a
 * preference. Every disagreement is resolved in favour of the thing further right.
 *
 * ## `Infinity` CANNOT BE STORED, AND THE PLAN ASKS FOR IT
 *
 * `plans/09` §4.1: `thresholds: { fullscreenExits: 8, focusLosses: 25, tabHides: 12,
 * pointerLockLosses: Infinity, copyAttempts: 20 }`. The reasoning is sound and documented
 * (Escape releases pointer lock and browsers deliberately prevent interception, so counting it
 * penalises a documented browser behaviour).
 *
 * But `ExamAttempt.policySnapshot` is a Prisma `Json` column, and `JSON.stringify(Infinity)` is
 * `null`. A policy with a threshold of `Infinity` therefore serialises to a snapshot claiming
 * "no threshold" and deserialises as zero-or-undefined — which is a threshold of *zero*, the
 * exact opposite of the intent, and it would terminate students who pressed Escape.
 *
 * So `NEVER` is a first-class value in the serialised form, and the number is `null` on the wire.
 * A `null` threshold means the counter is not collected at all. `deserialize` maps it back to
 * `Infinity` for internal comparisons, so the rule is still "never fires" — expressed once, in
 * one place, instead of every comparison remembering the difference between `0` and "never".
 */

import { z } from 'zod';

/** A threshold that never fires. Serialised as `null`; see the module comment. */
export const NEVER = null as null;

const requirement = z.enum(['OFF', 'WARN', 'REQUIRE']);

const thresholds = z.object({
  fullscreenExits: z.number().int().nonnegative().nullable(),
  focusLosses: z.number().int().nonnegative().nullable(),
  tabHides: z.number().int().nonnegative().nullable(),
  pointerLockLosses: z.number().int().nonnegative().nullable(),
  copyAttempts: z.number().int().nonnegative().nullable(),
});

const availabilityWindow = z.object({
  from: z.string().nullable(),
  until: z.string().nullable(),
});

/**
 * The policy, as STORED.
 *
 * Every threshold is nullable and `null` means "never". The alternative — a sentinel number, or
 * `Infinity` — is either a magic constant somebody compares against in six places or a value
 * that silently becomes `null` on the way to the database and `0` on the way back.
 */
export const examPolicySchema = z.object({
  version: z.literal(1),

  totalTimeLimitSec: z.number().int().positive().nullable(),
  perQuestionTimeLimitSec: z.number().int().positive().nullable(),
  perQuestionExpiry: z.enum(['SOFT', 'LOCK', 'AUTO_SUBMIT']),
  availabilityWindow: availabilityWindow.nullable(),
  gracePeriodSec: z.number().int().nonnegative(),

  requireFullscreen: requirement,
  requirePointerLock: requirement,
  focusWatchdog: requirement,
  multiTabPolicy: z.enum(['WARN', 'BLOCK']),
  blockCopyPaste: z.boolean(),
  blockContextMenu: z.boolean(),
  blockPrintSave: z.boolean(),

  thresholds: thresholds,
  escalation: z.array(z.enum(['WARN', 'BLOCK_UNTIL_RELOCK', 'REQUIRE_RELOCK', 'TERMINATE'])),

  maxAttempts: z.number().int().positive(),
  allowPracticeAttempt: z.boolean(),
  navigation: z.enum(['ONE_AT_A_TIME', 'ALL_AT_ONCE']),
  lockQuestionAfterAnswer: z.boolean(),
  showQuestionNumbers: z.boolean(),
  showCorrectAnswersAfterRelease: z.boolean(),
  reviewMode: z.literal('MANUAL'),
});

export type ExamPolicy = z.infer<typeof examPolicySchema>;

/** A partial policy, as an author or a teacher writes one. Every field optional. */
export const policyOverrideSchema = examPolicySchema
  .partial()
  .extend({ version: z.literal(1).optional(), thresholds: thresholds.partial().optional() });

export type PolicyOverride = z.infer<typeof policyOverrideSchema>;

/**
 * The EXAM profile, verbatim from `plans/09` §4.1.
 *
 * Two decisions in here are documented in the plan and would otherwise look like typos:
 * `pointerLockLosses` is `null` ("never") because Escape releases pointer lock and browsers
 * deliberately prevent interception; and `escalation` never contains `TERMINATE`, because
 * V-12 says a student's session is never ended automatically.
 */
export const EXAM_PROFILE_DEFAULTS: ExamPolicy = Object.freeze({
  version: 1,
  totalTimeLimitSec: null,
  perQuestionTimeLimitSec: null,
  perQuestionExpiry: 'SOFT',
  availabilityWindow: null,
  gracePeriodSec: 60,
  requireFullscreen: 'WARN',
  requirePointerLock: 'WARN',
  focusWatchdog: 'WARN',
  multiTabPolicy: 'WARN',
  blockCopyPaste: false,
  blockContextMenu: false,
  blockPrintSave: false,
  thresholds: {
    fullscreenExits: 8,
    focusLosses: 25,
    tabHides: 12,
    pointerLockLosses: null,
    copyAttempts: 20,
  },
  escalation: ['WARN', 'BLOCK_UNTIL_RELOCK'],
  maxAttempts: 1,
  allowPracticeAttempt: false,
  navigation: 'ONE_AT_A_TIME',
  lockQuestionAfterAnswer: false,
  showQuestionNumbers: true,
  showCorrectAnswersAfterRelease: false,
  reviewMode: 'MANUAL',
}) as ExamPolicy;

/** The QUIZ profile. Controls are OFF and every threshold never fires. */
export const QUIZ_PROFILE_DEFAULTS: ExamPolicy = Object.freeze({
  ...EXAM_PROFILE_DEFAULTS,
  requireFullscreen: 'OFF',
  requirePointerLock: 'OFF',
  focusWatchdog: 'OFF',
  multiTabPolicy: 'WARN',
  thresholds: {
    fullscreenExits: null,
    focusLosses: null,
    tabHides: null,
    pointerLockLosses: null,
    copyAttempts: null,
  },
  escalation: [],
  navigation: 'ALL_AT_ONCE',
  allowPracticeAttempt: true,
}) as ExamPolicy;

export function profileFor(mode: 'ASSIGNMENT' | 'EXAM'): ExamPolicy {
  return mode === 'EXAM' ? EXAM_PROFILE_DEFAULTS : QUIZ_PROFILE_DEFAULTS;
}

/** A per-student grant, as `AssignmentStudentOverride` stores it. */
export interface StudentOverride {
  readonly availableFrom?: string | null;
  readonly availableUntil?: string | null;
  readonly maxAttempts?: number | null;
  readonly extraTimePercent?: number | null;
  readonly policyOverride?: PolicyOverride | null;
}

/** A right, from `Accommodation`. `relaxations` are the named accommodations. */
export interface AccommodationInput {
  readonly relaxations: readonly string[];
  readonly extraTimePercent?: number | null;
  readonly status?: string;
  readonly revokedAt?: Date | null;
  readonly expiresAt?: Date | null;
}

export interface ResolveInput {
  readonly mode: 'ASSIGNMENT' | 'EXAM';
  /** `ResourceVersion.assessmentPolicy` — what the author wrote. Lowest priority. */
  readonly versionPolicy?: PolicyOverride | null;
  /** `Assignment.policyOverride` — what the teacher set for the class. */
  readonly assignmentOverride?: PolicyOverride | null;
  /** `AssignmentStudentOverride` for this student. */
  readonly studentOverride?: StudentOverride | null;
  /** `Accommodation` for this student. A RIGHT, so it wins over every preference. */
  readonly accommodation?: AccommodationInput | null;
  /** `Assignment.availableFrom/Until`, folded into the window when the policy has none. */
  readonly assignmentWindow?: { readonly from: Date | null; readonly until: Date | null };
  /**
   * `Assignment.maxAttempts` — the COLUMN, not a policy field.
   *
   * This exists because the first version of the to-do list told a student with two attempts
   * allowed and one used that their work was `completed`. The column is the teacher-set value and
   * the policy profile default is 1, and the fold was taking the PROFILE's number — so the
   * column a teacher had explicitly changed was silently ignored, and the student was told their
   * remaining attempt did not exist.
   *
   * So the column is applied after the policy merge and before the student override: the column
   * is what the teacher set for the class, and the override is what they set for one child.
   */
  readonly assignmentMaxAttempts?: number | null;
  /**
   * When the fold happens, for the accommodation expiry test.  (P5-T1)
   *
   * The first version called `Date.now()` inside `activeAccommodation`, and INV-TIME-1 caught it
   * — correctly, and for a reason beyond the rule. A function that reads the host clock is not
   * pure, so an accommodation expiring at 16:00 is evaluated against the SERVER's wall clock
   * rather than the one the caller believes in, and a test can only exercise the branch by
   * setting the machine's clock. The instant is an input like any other.
   */
  readonly now?: Date;
}

const iso = (d: Date | null | undefined): string | null => (d == null ? null : d.toISOString());

/**
 * Resolve the effective policy for one student.
 *
 * ## C13: `extraTimePercent` lived on BOTH the override and the accommodation
 *
 * The schema comment says "the merge is now a documented fold; a mid-exam grant is computed
 * from REMAINING time". This is that fold, and it takes the LARGER of the two. A smaller value
 * would be the dangerous choice: a teacher who grants 25% and an accommodation that says 50% do
 * not disagree, they stack, and taking the smaller would hand a child less time than the law
 * and the plan both promise them.
 *
 * ## Extra time becomes a `totalTimeLimitSec`, not a field of its own
 *
 * The stored policy has no `extraTimePercent`. A percentage of what? The limit may be untimed
 * (`null`), in which case a percentage of it is nothing. Multiplying once, at resolve time, and
 * storing an absolute number means the attempt's deadline cannot drift when somebody edits the
 * accommodation mid-exam — which is INV-POLICY-1's whole point.
 */
export function resolvePolicy(input: ResolveInput): ExamPolicy {
  const base = profileFor(input.mode);
  const versionPolicy = input.versionPolicy ?? undefined;
  const assignmentOverride = input.assignmentOverride ?? undefined;
  const studentOverride = input.studentOverride ?? undefined;
  const studentPolicy = studentOverride?.policyOverride ?? undefined;

  const merged: ExamPolicy = {
    ...base,
    ...(versionPolicy ?? {}),
    ...(assignmentOverride ?? {}),
    ...(studentPolicy ?? {}),
    thresholds: {
      ...base.thresholds,
      ...(versionPolicy?.thresholds ?? {}),
      ...(assignmentOverride?.thresholds ?? {}),
      ...(studentPolicy?.thresholds ?? {}),
    },
    escalation:
      studentPolicy?.escalation ??
      assignmentOverride?.escalation ??
      versionPolicy?.escalation ??
      base.escalation,
    version: 1,
  };

  // The availability window: the narrowest of the four sources that express one. A student who
  // is given an earlier `until` loses access earlier, which is the point of an override.
  const windows: { from: string | null; until: string | null }[] = [];
  if (merged.availabilityWindow !== null) windows.push(merged.availabilityWindow);
  if (input.assignmentWindow !== undefined) {
    windows.push({
      from: iso(input.assignmentWindow.from),
      until: iso(input.assignmentWindow.until),
    });
  }
  const overrideFrom = studentOverride?.availableFrom ?? null;
  const overrideUntil = studentOverride?.availableUntil ?? null;
  if (overrideFrom !== null || overrideUntil !== null) {
    windows.push({ from: overrideFrom, until: overrideUntil });
  }
  const availabilityWindow = windows.length === 0 ? null : narrowest(windows);

  const extraTime = extraTimePercent(input);

  const totalTimeLimitSec = applyExtraTime(merged.totalTimeLimitSec, extraTime);
  const perQuestionTimeLimitSec = applyExtraTime(merged.perQuestionTimeLimitSec, extraTime);

  return Object.freeze({
    ...merged,
    availabilityWindow,
    totalTimeLimitSec,
    perQuestionTimeLimitSec,
    maxAttempts: studentOverride?.maxAttempts ?? input.assignmentMaxAttempts ?? merged.maxAttempts,
  });
}

/**
 * The INTERSECTION of every window, and the function is called `narrowest` because that is what
 * it has to be.
 *
 * The first version took the earliest start and the latest end, which is the UNION — the widest
 * window anyone states. A test caught it immediately by asserting a student's own narrower window
 * came out as the narrowest, and it did not: a student given a personal window was being handed
 * back the longest one of the lot. Narrowing is the entire point of a per-student override, and
 * the buggy version quietly undid it while looking completely correct.
 *
 * Compared by INSTANT rather than by string. A version policy may carry `+01:00` and an override
 * `Z`, and `2026-09-01T09:00+01:00` is earlier than `2026-09-01T08:00Z` while sorting later as a
 * string. The original timestamp is preserved on the winning candidate so the stored value keeps
 * the offset its author wrote.
 *
 * An empty intersection is returned as-is — from later than until — and `validatePolicy` reports
 * it as the "starts at or after it ends" error rather than this function inventing a window.
 */
function narrowest(windows: readonly { from: string | null; until: string | null }[]): {
  from: string | null;
  until: string | null;
} {
  const starts = windows.map((w) => w.from).filter((v): v is string => v !== null);
  const ends = windows.map((w) => w.until).filter((v): v is string => v !== null);
  const later = starts.reduce<string | null>(
    (best, v) => (best === null || Date.parse(v) > Date.parse(best) ? v : best),
    null,
  );
  const earlier = ends.reduce<string | null>(
    (best, v) => (best === null || Date.parse(v) < Date.parse(best) ? v : best),
    null,
  );
  return { from: later, until: earlier };
}

/** C13's fold. The LARGER wins, because under-granting time is the dangerous direction. */
export function extraTimePercent(input: ResolveInput): number {
  const candidates = [
    input.studentOverride?.extraTimePercent ?? null,
    activeAccommodation(input.accommodation, input.now)?.extraTimePercent ?? null,
  ].filter((v): v is number => v !== null);
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}

function activeAccommodation(
  a: AccommodationInput | null | undefined,
  now: Date | undefined,
): AccommodationInput | null {
  if (a === null || a === undefined) return null;
  if (a.status !== undefined && a.status !== 'ACTIVE') return null;
  if (a.revokedAt != null) return null;
  // Without a supplied instant there is nothing to compare against, so an accommodation carrying
  // an expiry date is treated as ACTIVE rather than as expired. Defaulting to "denied" would mean
  // a caller who forgot `now` silently strips a child's extra time, which is the failure
  // direction that matters: the grant is a right, and losing one is worse than keeping one too
  // long.
  if (now !== undefined && a.expiresAt != null && a.expiresAt.getTime() < now.getTime())
    return null;
  return a;
}

/**
 * `null` stays `null`.
 *
 * An untimed exam plus extra time is still untimed: there is no limit to extend, and inventing
 * one would turn an untimed assignment into a timed one because a student has an accommodation.
 */
function applyExtraTime(limitSec: number | null, extraPercent: number): number | null {
  if (limitSec === null) return null;
  if (extraPercent === 0) return limitSec;
  return Math.round((limitSec * (100 + extraPercent)) / 100);
}

export interface PolicyProblem {
  readonly field: string;
  readonly problem: string;
  /** `false` for a warning. INV-POLICY-2 grades per-question sums as a warning, not an error. */
  readonly error: boolean;
}

/**
 * INV-POLICY-2, at AUTHORING time.
 *
 * The plan is emphatic that this happens while the teacher is editing, with field-level errors,
 * "never at exam start" — because a student discovering at 09:00 that the policy is impossible
 * is a support incident with a deadline attached.
 */
export function validatePolicy(policy: ExamPolicy): readonly PolicyProblem[] {
  const problems: PolicyProblem[] = [];

  const parsed = examPolicySchema.safeParse(policy);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push({
        field: issue.path.join('.') || '(root)',
        problem: issue.message,
        error: true,
      });
    }
    // A shape that will not parse cannot be reasoned about further; reporting twelve derived
    // errors on top of the three that caused them is noise, not detail.
    return problems;
  }

  const window = policy.availabilityWindow;
  if (window !== null && window.from !== null && window.until !== null) {
    if (window.from >= window.until) {
      problems.push({
        field: 'availabilityWindow',
        problem: 'the window starts at or after it ends, so nothing is ever available',
        error: true,
      });
    }
    if (
      policy.totalTimeLimitSec !== null &&
      Date.parse(window.until) - Date.parse(window.from) < policy.totalTimeLimitSec * 1000
    ) {
      // Stated as an ERROR by the plan: a student who cannot finish in the window is a policy
      // that cannot be sat, not a strict one.
      problems.push({
        field: 'availabilityWindow',
        problem:
          'the window is shorter than the total time limit, so the exam cannot be completed inside it',
        error: true,
      });
    }
  }

  if (policy.perQuestionExpiry !== 'SOFT' && policy.perQuestionTimeLimitSec === null) {
    // The plan: "perQuestionExpiry ≠ SOFT with no per-question limit is an error". The reason is
    // that `LOCK` and `AUTO_SUBMIT` are statements about a per-question deadline, and without
    // one they are two different ways of saying nothing.
    problems.push({
      field: 'perQuestionExpiry',
      problem: `${policy.perQuestionExpiry} needs a per-question time limit; there is no deadline for it to act on`,
      error: true,
    });
  }

  if (
    policy.perQuestionTimeLimitSec !== null &&
    policy.totalTimeLimitSec !== null &&
    policy.perQuestionTimeLimitSec > policy.totalTimeLimitSec
  ) {
    // A WARNING, per the plan. Per-question limits summing beyond the total is a warning, not an
    // error — the total is what bounds the attempt, and the plan says the authoring surface must
    // not be a wall.
    problems.push({
      field: 'perQuestionTimeLimitSec',
      problem: 'a per-question limit longer than the total limit can never apply',
      error: false,
    });
  }

  return problems;
}

/** `true` when nothing above is an error. Warnings do not block. */
export function isPublishable(problems: readonly PolicyProblem[]): boolean {
  return problems.every((p) => !p.error);
}

/**
 * RECURSIVE FREEZE, because the shallow version was wrong in a way that only showed up on audit.
 *
 * `Object.freeze` is shallow. This function applied it to the policy, to `thresholds` and to `escalation`, and the
 * `thresholds` half came from a test that caught `policy.thresholds.fullscreenExits = 0` still going through. The
 * same bug was then left sitting one level deeper: `availabilityWindow` is a nullable nested object, it was never
 * frozen at all, and `policy.availabilityWindow.from = <anything>` mutated a snapshot that INV-POLICY-1 says cannot
 * change. A frozen shell with a mutable interior is not a snapshot.
 *
 * Hand-written freezing is how that happened -- it enumerates the fields that were thought of, and a schema field
 * added later is silently left mutable. So this walks the value instead. The cost is that it also freezes anything
 * reachable from the policy, which for `ExamPolicy` is exactly the intent: nothing reachable from a snapshot should
 * be writable.
 */
function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== 'object') return value;

  // `seen` is the cycle guard, and it is NOT `Object.isFrozen`.
  //
  // The first version of this function used `Object.isFrozen(value)` as its "already handled" check, which is wrong:
  // `resolvePolicy` returns an ALREADY-FROZEN policy whose `escalation` array is not itself frozen, so the walk
  // returned on the first line, never reached `escalation`, and left it mutable. The pre-existing test
  // `a FROZEN policy is frozen all the way down` caught it -- which is the argument for keeping that test.
  //
  // "Already frozen" and "already visited" are different facts. Only the second one means stop.
  const node = value as unknown as object;
  if (seen.has(node)) return value;
  seen.add(node);

  // Children are walked whether or not the parent is frozen, so a frozen shell with a mutable interior is repaired
  // rather than trusted.
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/**
 * Freeze for storage, and normalise the thresholds.
 *
 * INV-POLICY-1: once an attempt exists, its `policySnapshot` never changes. Mid-exam changes go through audited
 * `DEADLINE_EXTENDED` / `POLICY_OVERRIDDEN` events, never a silent rewrite -- and a rewrite here would be invisible
 * in the audit trail, because the snapshot is what the audit compares against.
 */
export function freezePolicy(policy: ExamPolicy): ExamPolicy {
  return deepFreeze(policy);
}

/** Parse a stored snapshot, denying rather than throwing: a corrupt snapshot is not a page. */
export function readPolicySnapshot(raw: unknown): ExamPolicy | null {
  const parsed = examPolicySchema.safeParse(raw);
  return parsed.success ? freezePolicy(parsed.data) : null;
}
