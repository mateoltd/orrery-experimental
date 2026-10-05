/**
 * Sealed auto-grade review: "this key looks wrong", and the blast radius BEFORE anything is applied.  (P9-T6)
 *
 * ## WHAT THIS MODULE IS: A FLAG AND A NUMBER, NOT A MECHANISM
 *
 * `plans/07` §5.1: "Sealed auto-grades **visible but not editable inline** -- a teacher who believes a key is wrong
 * flags it, which triggers a reviewed regrade across all affected attempts rather than a quiet local override."
 *
 * The word carrying the weight is **flags**. A marker looking at a sealed auto-grade has three honest moves and this
 * task builds exactly one of them:
 *
 *  · accept the mark,
 *  · mark the response by hand **where the policy allows it** (`needsHuman` rows -- `grading-policy.ts:105`),
 *  · or say the KEY is wrong, which is a statement about the assignment and not about one paper.
 *
 * The third is the dangerous one to implement, because the cheapest implementation is a button that rewrites
 * `Question.spec` and calls the grader again. That is a **silent key rewrite**: it changes what every student on the
 * assignment was assessed against, moves a mark that may already be released, and attaches no reason to any of it. So
 * nothing here can write a key, and `KeyBearingField` below is the list that makes adding a way to do so a compile
 * error rather than a code review's memory.
 *
 * ## AND THE FLAG CANNOT MOVE A MARK, WHICH IS `INV-RELEASE-1` IN THIS FEATURE
 *
 * `flagAutoGradeKey` (in `grading-review-flag.ts`) writes exactly one row into one append-only log and touches no other
 * table. A mark moves only through `grading-regrade.ts`'s `applyRegrade`, which recomputes the preview under locks and
 * refuses a stale token. So the chain from "I think this key is wrong" to "a published figure moved" is
 * flag -> reviewed -> preview -> token -> apply, with no branch that skips a step.
 *
 * ## THE FLAG MUST CARRY A REASON, BECAUSE A FLAG WITH NO REASON IS A FLAG NOBODY CAN ACT ON
 *
 * The person who upholds it is not the person who raised it. Without a reason the record is "someone thought
 * something", which is indistinguishable weeks later from a marker having been irritated -- and `plans/07` §3.4's rule
 * ("A teacher must never be asked to trust an opaque score") is about opaque judgements, not only opaque numbers.
 */

import type { RegradePreview } from './grading-regrade.js';

/**
 * THE REVIEW TARGET: what a marker is shown about a sealed auto-grade in order to judge the KEY.
 *
 * ## THIS TYPE HAS NO SCORE FIELD, AND THAT IS THE POINT RATHER THAN AN OMISSION
 *
 * `SCORE_BEARING_KEYS` (`packages/interop/src/boundary.ts:113`) is the repository's own list of keys that must not
 * reach a surface that should not be carrying a mark. This target shares no name with any of them, so
 * `findScoreBearingKeys` over a populated payload returns `[]` -- which `grading-review.test.ts` asserts rather than
 * trusting this comment.
 *
 * Why the type and not a runtime filter: a runtime filter is a line somebody deletes. A field added here is a **compile
 * error** in `AutoGradeReviewApi`'s inertness assertion, which is "prefer a type-level guarantee over a runtime check"
 * doing real work.
 *
 * And WHY a key review must not be handed a mark even though the marker is a teacher: the flag is about the
 * assignment, and an edit box sitting next to this target is an edit box a marker reaches for. `plans/07` §5.1 wants the
 * inline override to be the thing that is hard, and the cheapest way to make it hard is for the screen the flag is
 * raised from to have nowhere to type one.
 */
export interface SealedAutoGradeTarget {
  readonly responseId: string;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly questionId: string;
  /** Position in the RESOLVED variant, so the marker can find it on the paper. */
  readonly position: number;
  /** What the question is WORTH. What was awarded is not on this object at all. */
  readonly worth: number;
  /** The version of the automatic marker that produced the stored decision, or null if none ran. */
  readonly markedByVersion: string | null;
  readonly gradedAt: string | null;
  readonly needsHuman: boolean;
  readonly released: boolean;
  /** Open flags THIS reporter has already raised against this key. One open flag per reporter per key. */
  readonly openFlagsByReporter: number;
}

/** Long enough for a paragraph saying what is wrong with the key; far below a pasted essay per paper. */
export const KEY_FLAG_REASON_MAX_CHARS = 2_000;

export type KeyFlagRefusal =
  | 'NOT_FOUND'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'NOT_SEALED_AUTOMATIC'
  | 'ALREADY_FLAGGED';

/**
 * THE FACTS THE DECISION READS, and nothing about the mark.
 *
 * `isSealedAutomatic` re-derives the predicate `grading-write.ts` already uses rather than importing it, because
 * `grading-policy.ts` is committed and this task must not fork it. Two copies of a definition is exactly how "the flag
 * screen lets me edit the response the mark screen forbids editing" happens, so `grading-review.test.ts` holds this
 * one against `decideGradingWrite`'s public result over a shared table of facts -- agreement is proved, not asserted.
 */
export interface AutoGradeKeyFlagFacts {
  readonly status: string;
  readonly hasAutomaticMark: boolean;
  readonly hasManualMark: boolean;
  readonly isExcused: boolean;
  readonly needsHuman: boolean;
  readonly openFlagsByReporter: number;
}

export interface AutoGradeKeyFlagRequest {
  readonly reason: string;
}

/**
 * WHETHER A MARK MAY BE TYPED OVER THIS ROW: `sealedAutomatic` as `grading-write.ts:126-129` spells it.
 *
 * `autoScore !== null && manualScore === null && !needsHuman` -- with the excuse test that `grading-write.ts` omits
 * because it reaches the row through a different path. `decideGradingWrite` answers `SEALED_AUTOMATIC` for a SCORE
 * when its own facts say sealed; this predicate must agree with it, and the conformance test in
 * `grading-review.test.ts` is the reason they do.
 */
export const isSealedAutomatic = (facts: AutoGradeKeyFlagFacts): boolean =>
  facts.hasAutomaticMark && !facts.hasManualMark && !facts.needsHuman && !facts.isExcused;

const REVIEWABLE_STATUSES: readonly string[] = ['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'];

/**
 * WHETHER A MARKER MAY RAISE "THIS KEY LOOKS WRONG" HERE, or why not.
 *
 * Two decisions worth spelling out:
 *
 *  · **A `needsHuman` row is NOT flaggable.** It is already awaiting a person with no mark, so the right move is to
 *    mark it; pointing a marker at an assignment-wide regrade to fix one unread paper would move 200 marks.
 *  · **Release does NOT block a flag.** `INV-RELEASE-1` says a released figure must never move *silently*; it does not
 *    say a released figure cannot be disputed, and refusing the flag on a released paper would make the case where a
 *    student has most to lose the one case nobody may raise. The flag is allowed; the regrade path carries the notice.
 */
export const decideAutoGradeKeyFlag = (
  facts: AutoGradeKeyFlagFacts,
  request: AutoGradeKeyFlagRequest,
): KeyFlagRefusal | null => {
  if (request.reason.trim() === '') return 'REASON_REQUIRED';
  if (request.reason.length > KEY_FLAG_REASON_MAX_CHARS) return 'REASON_TOO_LONG';
  if (!REVIEWABLE_STATUSES.includes(facts.status)) return 'NOT_FOUND';
  if (!isSealedAutomatic(facts)) return 'NOT_SEALED_AUTOMATIC';
  if (facts.openFlagsByReporter > 0) return 'ALREADY_FLAGGED';
  return null;
};

/* ───────────────────────────────────────────────────────── the population ── */

/**
 * HOW MANY RESPONSES SIT UNDER ONE KEY, and which of them a key change would reach.
 *
 * ## THE FIVE CATEGORIES ARE A PARTITION, AND `isPartitioned` PROVES IT
 *
 * They are cut with the exact predicate `grading-regrade.ts:237-241` uses to decide whether to recompute: the question
 * is selected AND `manualScore === null` AND NOT excused. So `sealedAutomatic + awaitingHuman + notAutomaticallyGraded`
 * is precisely the set a confirmed regrade re-runs the grader over, and the two "preserved" categories are precisely
 * the rows that survive one -- `grading-regrade.ts:236`, "Manual decisions and excuses survive a changed automatic
 * key".
 *
 * `sealedAutomatic` and `awaitingHuman` split that set by `needsHuman`, because the two behave differently under a
 * regrade: a sealed mark is a figure that moves, and a `NEEDS_HUMAN` response is one a regrade may RESOLVE. Which is
 * why `plans/07` §3.4's "a student is never auto-zeroed because our code failed" has to survive a regrade and not
 * only a grade.
 *
 * `notAutomaticallyGraded` is the fourth case and it is here because it reads as a bug: a response in a reviewable
 * attempt that was never auto-graded and is not awaiting a human. A regrade WILL compute a mark for it, so it belongs
 * in the blast radius even though there is nothing to move today.
 */
export interface KeyPopulation {
  readonly assignmentId: string;
  readonly questionId: string;
  readonly responses: number;
  readonly sealedAutomatic: number;
  readonly awaitingHuman: number;
  readonly notAutomaticallyGraded: number;
  readonly preservedByManualMark: number;
  readonly preservedAsExcused: number;
}

export const isPartitioned = (population: KeyPopulation): boolean =>
  population.responses ===
  population.sealedAutomatic +
    population.awaitingHuman +
    population.notAutomaticallyGraded +
    population.preservedByManualMark +
    population.preservedAsExcused;

/* ─────────────────────────────────────────────────────── the blast radius ── */

/**
 * WHAT A MARKER IS SHOWN BEFORE CONFIRMING, assembled from TWO SOURCES AND FROM NEITHER ALONE.
 *
 * The population comes from `readKeyPopulation`; the outcome comes from `previewRegrade` restricted to this one
 * question. Using the preview rather than a query of our own is the design: the numbers on the screen are produced by
 * the same function that will produce the numbers the confirmation token commits over, so they cannot disagree. A
 * review surface that computes its own "about 200 papers" and then hands a token for somebody else's arithmetic is a
 * review surface that lies with a count in it.
 *
 * `null` means the preview was NOT scoped to this one question alone, in which case its `changes` are about other
 * questions too and every count below would be wrong. The scoping is the caller's `questionIds`, checked here because
 * `RegradeAttemptPreview.changes` carries a `responseId` and not a `questionId`.
 */
export const blastRadius = (
  preview: RegradePreview,
  population: KeyPopulation,
): BlastRadius | null => {
  const scoped = preview.request.questionIds;
  if (scoped === undefined || scoped.length !== 1 || scoped[0] !== population.questionId)
    return null;

  const comparable = preview.attempts.filter((attempt) => attempt.delta !== null);
  const moved = comparable.filter((attempt) => attempt.delta !== 0);
  const gained = moved.filter((attempt) => (attempt.delta ?? 0) > 0).length;
  /**
   * A paper whose total does not move can still have had its RESPONSES rewritten, and `grading-regrade.ts:134-138`
   * already distinguishes the two for the same reason. `attemptsRewriting` is the honest "this key is underneath this
   * paper" number; `affectedAttempts` is the honest "this student sees a different figure" number.
   */
  const rewritten = preview.attempts.filter((attempt) => attempt.changes.length > 0);

  return {
    ...population,
    attemptsRewriting: rewritten.length,
    affectedAttempts: moved.length,
    alreadyReleased: moved.filter((attempt) => attempt.released).length,
    gained,
    lost: moved.length - gained,
    unchanged: comparable.length - moved.length,
    /** Papers whose total does not move but whose stored automatic figure does. */
    rewrittenButUnchanged: rewritten.filter((attempt) => attempt.delta === 0).length,
    /** Papers whose stored automatic figure is being replaced by one that needs a human. */
    wouldBecomeProvisional: rewritten.filter((attempt) => attempt.after.isProvisional).length,
  };
};

export interface BlastRadius extends KeyPopulation {
  /** Papers whose stored automatic figure would be rewritten, whether or not the total moves. */
  readonly attemptsRewriting: number;
  /** Papers whose final figure would move. */
  readonly affectedAttempts: number;
  readonly alreadyReleased: number;
  readonly gained: number;
  readonly lost: number;
  readonly unchanged: number;
  readonly rewrittenButUnchanged: number;
  readonly wouldBecomeProvisional: number;
}

/* ─────────────────────────────────────────────────── the append-only flag ── */

/**
 * THE IDENTITY OF ONE KEY IN ONE ASSIGNMENT, as a single opaque string.
 *
 * `AuditEvent` is indexed `(targetType, targetId, createdAt)` and has no key-pair index, so the two halves are joined
 * into one id rather than a second key added to a table whose shape this task does not get to change.
 *
 * ## THE SEPARATOR IS A COLON, AND THE FIRST VERSION WAS A NUL, WHICH POSTGRES REFUSED
 *
 * `\u0000` cannot be stored in a `text` column at all. Postgres answers `22021: invalid byte sequence for encoding
 * "UTF8": 0x00`, so `readKeyHistory` -- the query that finds the history for the DEDUPE check on the flag write -- threw
 * before the flag could be recorded, and every flag failed. A separator chosen for being unambiguous in JavaScript was
 * chosen without asking what the column accepts; the test that caught it is the first one in the integration file,
 * because it is the first one that writes anything.
 *
 * A colon is safe because both halves are `uuid(7)` primary keys, which cannot contain one, so the `split` in
 * `flagsFrom` is unambiguous rather than lucky. `grading-review.test.ts` asserts the split round-trips, and
 * `grading-review-flag.integration.test.ts` exercises the write path that Postgres rejected.
 */
export const KEY_FLAG_SEPARATOR = ':';
export const keyFlagIdentity = (assignmentId: string, questionId: string): string =>
  `${assignmentId}${KEY_FLAG_SEPARATOR}${questionId}`;

export const KEY_FLAG_TARGET_TYPE = 'AssignmentQuestionKey';
export const KEY_FLAG_RAISED = 'AUTO_GRADE_KEY_FLAGGED';
export const KEY_FLAG_UPHELD = 'AUTO_GRADE_KEY_UPHELD';
export const KEY_FLAG_DISMISSED = 'AUTO_GRADE_KEY_DISMISSED';

/** A RAISED flag, as the review surface reads it. No mark, and no field that could become one. */
export interface AutoGradeKeyFlag {
  readonly key: string;
  readonly assignmentId: string;
  readonly questionId: string;
  readonly raisedById: string;
  readonly reason: string;
  readonly raisedAt: string;
  /** How many times this flag has been upheld or dismissed. `0` while open. */
  readonly timesResolved: number;
  /** The most recent resolution, or null while open. */
  readonly resolution: KeyFlagResolution | null;
  readonly resolvedById: string | null;
}

export interface KeyFlagEvent {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorId: string | null;
  readonly reason: string;
  readonly at: string;
}

export type KeyFlagResolution = 'UPHELD' | 'DISMISSED';

export const resolutionAction = (resolution: KeyFlagResolution): string =>
  resolution === 'UPHELD' ? KEY_FLAG_UPHELD : KEY_FLAG_DISMISSED;

/**
 * THE FLAGS IN AN ORDERED SLICE OF THE LOG, folded into one entry per RAISING.
 *
 * ## WHY A FOLD AND NOT A `status` COLUMN
 *
 * `packages/db/prisma/schema.prisma:1243-1250` carries the argument for append-only history: rows written before a
 * correction still have to say what they said, and deleting one to express "no longer open" makes the history
 * unreadable. A `status` column on a flag table is the same mistake in miniature -- and it is also why this task needs
 * no migration: `AuditEvent` already is an audited, append-only, indexed action log, and a flag carrying a reason, an
 * author, a question and a resolution is exactly an action in it.
 *
 * A resolution closes the most recent UNRESOLVED raising for that key, and a resolution with no open raising is
 * ignored rather than inventing one. "Raised, dismissed, raised again, upheld" is therefore two raisings, one of them
 * open, and `timesResolved: 1` -- which is what tells a reviewer the key has been argued about twice.
 *
 * Input must be ordered by `at`; the caller reads an indexed range and the test asserts a reversal flips the pairing,
 * so the ordering is a stated requirement rather than an assumption.
 */
export const flagsFrom = (events: readonly KeyFlagEvent[]): readonly AutoGradeKeyFlag[] => {
  type Slot = { event: KeyFlagEvent; resolution: KeyFlagResolution | null; by: string | null };
  const slots: Slot[] = [];
  for (const event of events) {
    if (event.targetType !== KEY_FLAG_TARGET_TYPE) continue;
    if (event.action === KEY_FLAG_RAISED) {
      slots.push({ event, resolution: null, by: null });
      continue;
    }
    const resolution =
      event.action === KEY_FLAG_UPHELD
        ? 'UPHELD'
        : event.action === KEY_FLAG_DISMISSED
          ? 'DISMISSED'
          : null;
    if (resolution === null) continue;
    const last = slots[slots.length - 1];
    if (last === undefined || last.event.targetId !== event.targetId || last.resolution !== null)
      continue;
    last.resolution = resolution;
    last.by = event.actorId;
  }
  return slots.map((slot) => {
    const [assignmentId = '', questionId = ''] = slot.event.targetId.split(KEY_FLAG_SEPARATOR);
    return {
      key: slot.event.targetId,
      assignmentId,
      questionId,
      raisedById: slot.event.actorId ?? '',
      reason: slot.event.reason,
      raisedAt: slot.event.at,
      timesResolved: slot.resolution === null ? 0 : 1,
      resolution: slot.resolution,
      resolvedById: slot.by,
    };
  });
};

/** Open flags only. A resolved one stays in the history: `plans/07` §7 wants regrades append-only too. */
export const openFlagsFrom = (events: readonly KeyFlagEvent[]): readonly AutoGradeKeyFlag[] =>
  flagsFrom(events).filter((flag) => flag.resolution === null);

/* ───────────────────────────────────────────── the compile-time guarantee ── */

/**
 * THE FIELDS THAT WOULD LET A CALL MOVE A MARK OR REWRITE A KEY.
 *
 * Read as the names `SCORE_BEARING_KEYS` already treats as load-bearing, plus the two that carry an answer key and the
 * three that would let a caller choose a different rubric. A parameter object holding any of these is a parameter
 * object the review surface could be handed a way to change an assessment with.
 */
export type KeyBearingField =
  | 'spec'
  | 'blocks'
  | 'modelAnswer'
  | 'correctAnswer'
  | 'answerKey'
  | 'autoScore'
  | 'autoRawScore'
  | 'manualScore'
  | 'finalScore'
  | 'points'
  | 'score'
  | 'percentage'
  | 'rubric'
  | 'partialCreditMethod'
  | 'rubricScores';

/** Distributes a union so each member is examined on its own. `T extends unknown ? T : never` and nothing cleverer. */
type Distributive<T> = T extends unknown ? T : never;

/**
 * THE PARAMETER OBJECTS THAT COULD CARRY A KEY, as `{ type, fields }` pairs. `never` when there are none.
 *
 * ## WHY THIS CANNOT BE `Extract<keyof Parameters, KeyBearingField>` AND WHAT THAT WRITTEN FORM DID
 *
 * `keyof` of a UNION is the INTERSECTION of its members' keys. The first version of this was exactly that, over the
 * union of every parameter object in the review surface, and it passed with `points` sitting in a flag input -- because
 * the intersection was computed across six unrelated parameter types and `points` was in one of them rather than all.
 * A guarantee that cannot see the field it was written to forbid is worse than no guarantee, because it is a green
 * build.
 *
 * So the union is distributed first, each object is checked on its own, and the offenders are reported with their type.
 * `never` is the answer when there are none, which is why the assertion below tests `[never]` in brackets: a bare
 * `[X] extends [never]` distributes over `X` and would accept a single offender.
 */
export type KeyBearingParameters<Parameters> =
  Distributive<Parameters> extends infer One
    ? One extends object
      ? [Extract<keyof One, KeyBearingField>] extends [never]
        ? never
        : { readonly type: One; readonly fields: Extract<keyof One, KeyBearingField> }
      : never
    : never;

/** `true` when no parameter object of the review surface can carry a key or a mark. */
export type CarriesNothingKeyBearing<Parameters> = [KeyBearingParameters<Parameters>] extends [
  never,
]
  ? true
  : {
      readonly REVIEW_SURFACE_CAN_REWRITE_A_KEY_OR_MOVE_A_MARK: KeyBearingParameters<Parameters>;
    };

/**
 * WHAT A `true` HERE MEANS, AND WHY IT IS A TYPE RATHER THAN A TEST.
 *
 * Assign this to a `true` and the compiler refuses the moment a review entry point grows a parameter carrying a key or
 * a mark -- with the offending field named in the error, because it is the `Extract` that produced the object. A test
 * would have to enumerate the fields it forbids, and would then forbid exactly the ones its author listed.
 */
export type ReviewSurfaceIsInert<Parameters> = CarriesNothingKeyBearing<Parameters>;
