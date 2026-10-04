/**
 * WHICH WRITES MAY BE SHED, STATED ONCE.  (P8-T9b, `B10`)
 *
 * ## WHY THIS IS A MODULE AND NOT A COMMENT
 *
 * `B10` was: "`WINDOW_CLOSING` shed answer writes inside the grace window, **discarding** answers the plan had promised
 * to keep." The fix for that was applied where the shedding happened, and the *reason* was written in a comment beside
 * the queue ceiling in `evidence.ts` and in a comment in `outbox.ts`.
 *
 * **Two comments are not a policy.** They are correct today, they are three files apart, and nothing checks that the next
 * write path added to this codebase has read either of them. So the rule lives here as data, and the interesting part is
 * the property test at the bottom: it walks the real sheddable sites and asserts that nothing carrying an answer is
 * among them.
 *
 * ## WHY TELEMETRY MAY BE SHED AND ANSWERS MAY NOT
 *
 * `plans/09` §7: "`sendBeacon` is fire-and-forget and may be lost: **telemetry may be incomplete, and that is
 * acceptable.**" That is a licence, and it is specific. An unanswered question contributes zero to a score; losing the
 * record that a student hid a tab costs a teacher's evidence, not a student's mark. Shedding the second to preserve the
 * first inverts the entire priority order of the product.
 *
 * So the asymmetry is not a tuning knob. It is the difference between a record and a result.
 */

import type { EvidenceType } from './evidence.js';

/** What a write is, for shedding purposes. The two categories are not interchangeable and never will be. */
export type WriteClass =
  /** Fire-and-forget diagnostics. Incompleteness is acceptable and the loss is counted. */
  | 'TELEMETRY'
  /**
   * Anything a student's MARK depends on.
   *
   * Never shed, never trimmed, never given a cap that drops. If the queue is full the correct behaviour is to keep the
   * write and let something else fail -- because the alternative is a grading injustice that nobody notices until a
   * student complains about a mark.
   */
  | 'ANSWER_BEARING';

/**
 * EVERY EVIDENCE EVENT IS TELEMETRY. Stated as a function of the type rather than as a hand-kept list, because a
 * hand-kept list is a list that a new event type is not added to -- and the failure mode of a new event type missing
 * from a shedding list is that it gets SHED when it should not.
 *
 * `VIOLATION_THRESHOLD_REACHED` is here too, and it is the sharpest case: it is the record the escalation was COMPUTED
 * from, so losing it while keeping the events underneath leaves a teacher looking at a counter that rose with nothing
 * to explain it. The batcher already treats it as surviving shedding (`survivesShedding`, P8-T11); this is the statement
 * of why that is not optional.
 */
export const writeClassOfEvidence = (_type: EvidenceType): WriteClass => 'TELEMETRY';

/**
 * THE WRITE PATHS, AND WHICH CLASS EACH BELONGS TO.
 *
 * `TRUSTWORTHY_CLASSES` exists so a test can walk this table and assert the classification rather than restate it.
 */
export interface WritePath {
  readonly id: string;
  readonly class: WriteClass;
  /** One line, in terms of what is lost. A path whose cost cannot be stated is a path nobody will think twice about. */
  readonly costIfLost: string;
}

export const WRITE_PATHS: readonly WritePath[] = Object.freeze([
  {
    id: 'evidence.batch',
    class: 'TELEMETRY',
    costIfLost: 'a hole in the teacher timeline, and the hole is counted rather than hidden',
  },
  {
    id: 'evidence.sessionEvents',
    class: 'TELEMETRY',
    costIfLost:
      'preflight detail, which is why a missing preflight makes a timeline NOT reviewable (P8-T14)',
  },
  {
    id: 'outbox.answerSave',
    class: 'ANSWER_BEARING',
    costIfLost: "a student's work, and therefore a mark they had already earned",
  },
  {
    id: 'outbox.submit',
    class: 'ANSWER_BEARING',
    costIfLost: 'the submission itself, which is the difference between a grade and no grade',
  },
  {
    id: 'session.resumeToken',
    class: 'ANSWER_BEARING',
    costIfLost: "the student's own unfinished attempt, with no way back to it",
  },
]);

/** The paths that may shed, for a shedder to consult. Kept as a lookup so a caller cannot accidentally test membership wrong. */
export const SHEDDABLE: ReadonlySet<string> = new Set(
  WRITE_PATHS.filter((path) => path.class === 'TELEMETRY').map((path) => path.id),
);

/**
 * MAY THIS PATH BE SHED?
 *
 * **UNKNOWN PATHS ARE REFUSED.** A write path that is not in the table gets `false`, so the safe answer is the default
 * and the dangerous one requires an explicit entry. The opposite default -- "unlisted means telemetry" -- is how a new
 * answer-bearing write path silently becomes droppable the day someone forgets to register it.
 */
export const mayShed = (pathId: string): boolean => SHEDDABLE.has(pathId);

/** The paths that must never be shed, for a test to assert against. */
export const NEVER_SHED: readonly string[] = WRITE_PATHS.filter(
  (path) => path.class === 'ANSWER_BEARING',
).map((path) => path.id);

/**
 * WHAT TO DO WHEN A QUEUE IS FULL. One answer per class, and the two are not variations on a theme.
 */
export type OverflowResponse =
  /** Telemetry: drop the oldest, count the loss, keep going. `plans/09` §7 licenses it. */
  | 'DROP_OLDEST_AND_COUNT'
  /**
   * Answers: grow. **NOT block.** The exam surface is the one place in this product where telling a student "you cannot
   * continue right now" is unacceptable -- a blocked write mid-exam is a lost sitting, and it is the student who pays
   * for a device that ran out of space. So the queue grows until the device or the student stops, both of which are
   * visible, rather than the write silently vanishing, which is not.
   */
  | 'GROW'
  /**
   * Nothing here maps to this today. It exists so that "block the writer" is a *declared* option somebody must choose
   * deliberately for a future path, rather than something a shedder reaches for by default.
   */
  | 'BLOCK_THE_WRITER';

export const overflowResponseFor = (writeClass: WriteClass): OverflowResponse =>
  writeClass === 'TELEMETRY' ? 'DROP_OLDEST_AND_COUNT' : 'GROW';

/**
 * THE ASYMMETRY, IN ONE LINE EACH, because it is the whole module.
 *
 * Telemetry drops the OLDEST: a queue that sheds recent events loses the ones a teacher is currently looking at, and the
 * oldest are least likely to matter to the incident being reviewed. Answers drop nothing.
 */
export const SHEDDING_DOCTRINE = Object.freeze({
  telemetry: 'drop the oldest, count the loss, never block the exam',
  answers: 'grow; never silently lose a write a mark depends on',
  unlisted: 'refused, because the safe answer must be the default',
} as const);
