'use client';

/**
 * The teacher-facing evidence timeline and the `IntegrityVerdict`.  (P8-T14)
 *
 * ## THIS IS A TIMELINE, NOT A DETECTION
 *
 * `plans/09` §7.3 lists the copy requirements, and every one of them exists because the obvious version of this screen
 * is a lie detector:
 *
 *  · a banner stating this is **evidence, not a determination**
 *  · event-describing language, never intent: "left fullscreen 3 times", never "attempted to cheat"
 *  · a required verdict with a reason before any void
 *  · the `RN-01` finding quoted in the help text, **because a teacher who believes this is a lie detector will use it
 *    as one**
 *
 * So this module produces a chronology and a form. It does not produce a conclusion, and the strongest thing in it is
 * the refusal to produce one.
 *
 * ## `V-12`: THE LADDER STOPS AT FREEZE, AND `FREEZE_AND_SUBMIT` IS NOT A VERDICT
 *
 * The original `TERMINATE` set the attempt to `TERMINED` and submitted "held answers", **irreversibly discarding every
 * unwritten answer**. The automatic ladder now stops at freeze and notify. `FREEZE_AND_SUBMIT` submits what WAS
 * written, leaves the attempt `FROZEN`, and **requires a human `IntegrityVerdict` before any score is affected**. So
 * freezing is reversible and submitting is not a sanction -- it is preservation.
 *
 * ## AND A FROZEN ATTEMPT CANNOT BE VOIDED WITHOUT A REASON (`U-2` territory)
 *
 * `IntegrityVerdict` carries `NO_CONCERN | NOTED | REVIEW | VOIDED` with a reason, an author and a timestamp. `VOIDED`
 * is the only one that affects a score, so it is the only one the module insists on a reason for -- and a reason the
 * teacher wrote, not a category they picked.
 */

import type { EvidenceType } from '@orrery/exam-engine/evidence';

/** What the timeline records. Severity and whether it counts, as P7-T7's table defines them. */
export interface TimelineEntry {
  readonly at: number;
  readonly type: EvidenceType;
  readonly severity: 'INFO' | 'WARN' | 'VIOLATION';
  /**
   * THE EVENT-DESCRIBING PHRASE.
   *
   * Never a claim about intent. `plans/09` §7.3 gives "left fullscreen 3 times" as the model and "attempted to cheat" as
   * the thing not to write -- and the difference is not style, because a sentence about intent is a conclusion the
   * evidence does not support, in a document a teacher will act on.
   */
  readonly phrase: string;
  /** Present when this entry crossed a threshold. `U-2`: these are never dropped. */
  readonly crossedThreshold?: number;
  /** Present on a threshold crossing, per `U-2`: what was lost to telemetry shedding, so under-counting is visible. */
  readonly droppedEventCount?: number;
}

/** The report's own numbers, from the attempt. Not computed here -- read, so a stale figure is visibly stale. */
export interface TimelineFacts {
  readonly attemptId: string;
  readonly entries: readonly TimelineEntry[];
  /** The preflight record from `start`, which the teacher needs to interpret the rest. */
  readonly preflight: Readonly<Record<string, string | number | boolean | null>>;
  /** Similarity cluster membership, response ids only. Never names -- `RN-01`. */
  readonly similarityClusters: readonly {
    readonly id: string;
    readonly responseIds: readonly string[];
  }[];
  /** Force-exit reports, from `lifecycleGuard`. */
  readonly forceExits: readonly { readonly at: number; readonly phase: string }[];
  /** Whether the attempt is `FROZEN`, which changes what the teacher is being asked to decide. */
  readonly isFrozen: boolean;
  /** `U-2`: what telemetry shedding lost on this attempt. */
  readonly droppedEventCount: number;
}

/**
 * THE BANNER. `plans/09` §7.3 requires it, and requiring it is not the same as displaying it.
 *
 * Exported as a constant so a screen cannot show the timeline without access to the sentence that qualifies it -- and
 * so the wording is reviewable in one place rather than retyped per component.
 */
export const EVIDENCE_BANNER =
  'This is evidence, not a determination. It records what happened on this device. It does not conclude anything about ' +
  'the student, and nothing here changes a score on its own.';

/** THE HELP TEXT, carrying `RN-01` because a teacher who believes this is a lie detector will use it as one. */
export const INTEGRITY_HELP =
  'These signals detect unusual activity; they do not detect cheating. Similar answers have innocent explanations -- a ' +
  'shared model answer, a group assignment, or a student using dictation. Leaving fullscreen is something everyone ' +
  'does. Review the work and decide whether anything needs following up. A finding here is not evidence of misconduct.';

/** `IntegrityVerdict`, as `plans/01`'s model records it. Only a human reaches one. */
export type VerdictConclusion = 'NO_CONCERN' | 'NOTED' | 'REVIEW' | 'VOIDED';

export interface IntegrityVerdict {
  readonly conclusion: VerdictConclusion;
  /**
   * REQUIRED, AND REQUIRED IN THE TEACHER'S OWN WORDS.
   *
   * `plans/09` §7.3: "a required verdict with a reason before any void". A category alone is a classification with no
   * reasoning behind it, and `NO_CONCERN` with an empty reason is indistinguishable from a verdict nobody thought about.
   */
  readonly reason: string;
  readonly authorId: string;
  readonly at: number;
  /** Which verdict this REPLACES, if any. A verdict is a human conclusion and revising one must leave a trail. */
  readonly supersedes: number | null;
}

/** The shortest reason that is still a reason. Below this it is a category, not a justification. */
export const MIN_VERDICT_REASON = 20;

export type VerdictRefusal =
  | 'REASON_TOO_SHORT'
  | 'VOID_REQUIRES_FROZEN'
  | 'NO_AUTHOR'
  | 'VERDICT_IS_NOT_A_HUMAN_CONCLUSION';

export type VerdictOutcome =
  | { readonly ok: true; readonly verdict: IntegrityVerdict }
  | { readonly ok: false; readonly reason: VerdictRefusal; readonly message: string };

/**
 * RECORD A VERDICT, or refuse.
 *
 * The machine may RECOMMEND; only a human DISPOSES. So there is no function here that produces a verdict from
 * evidence, and the absence is deliberate -- an `autoVerdict(evidence)` would be called by something eventually.
 */
export const recordVerdict = (input: {
  readonly conclusion: VerdictConclusion;
  readonly reason: string;
  readonly authorId: string;
  readonly at: number;
  readonly supersedes?: number | null;
  readonly attemptIsFrozen: boolean;
}): VerdictOutcome => {
  if (input.authorId.trim().length === 0) {
    // `plans/01`: "only a human disposes". A verdict with no author is a system conclusion wearing a teacher's name.
    return { ok: false, reason: 'NO_AUTHOR', message: 'a verdict needs an author' };
  }

  if (input.reason.trim().length < MIN_VERDICT_REASON) {
    // Every conclusion needs a reason, not only `VOIDED`. `NO_CONCERN` with an empty reason is indistinguishable
    // from a verdict nobody thought about -- and it is the conclusion most likely to be ticked without reading.
    return {
      ok: false,
      reason: 'REASON_TOO_SHORT',
      message: `a verdict needs a reason of at least ${String(MIN_VERDICT_REASON)} characters, in your own words`,
    };
  }

  if (input.conclusion === 'VOIDED' && !input.attemptIsFrozen) {
    /**
     * VOIDING REQUIRES THE ATTEMPT TO BE FROZEN FIRST.
     *
     * `V-12`'s sequence is freeze, then a human decision, and voiding is the decision. Voiding an attempt that is still
     * open skips the freeze step, which is the step where a teacher can still reinstate -- so the requirement is not
     * bureaucracy, it is the reversibility the correction was written to restore.
     */
    return {
      ok: false,
      reason: 'VOID_REQUIRES_FROZEN',
      message: 'freeze the attempt before voiding it, so the decision can still be reversed',
    };
  }

  return {
    ok: true,
    verdict: {
      conclusion: input.conclusion,
      reason: input.reason.trim(),
      authorId: input.authorId,
      at: input.at,
      supersedes: input.supersedes ?? null,
    },
  };
};

export interface TimelineReport {
  readonly attemptId: string;
  readonly banner: string;
  readonly help: string;
  /** Chronological, with a STABLE tie-break so two events at the same instant do not swap between renders. */
  readonly entries: readonly TimelineEntry[];
  readonly preflight: Readonly<Record<string, string | number | boolean | null>>;
  readonly similarityClusters: readonly {
    readonly id: string;
    readonly responseIds: readonly string[];
  }[];
  readonly forceExits: readonly { readonly at: number; readonly phase: string }[];
  readonly droppedEventCount: number;
  readonly isFrozen: boolean;
  /** True when the teacher has everything they need to decide. */
  readonly isReviewable: boolean;
  readonly missingForDecision: readonly string[];
}

/**
 * BUILD THE REPORT.
 *
 * `isReviewable` is the field that matters: it says whether the evidence shown is SUFFICIENT to decide, which is not
 * the same as whether evidence exists. A timeline with events and no preflight record cannot be read, because a
 * fullscreen exit means something completely different on a device that could never enter fullscreen.
 */
export const buildTimeline = (facts: TimelineFacts): TimelineReport => {
  const entries = [...facts.entries].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    // Stable secondary key, so two events in the same millisecond keep a fixed order across renders. Without it the
    // list reshuffles and a teacher comparing two screenshots of the same attempt sees differences that are not there.
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });

  const missingForDecision: string[] = [];
  if (Object.keys(facts.preflight).length === 0) {
    // The preflight record is what makes the rest interpretable. An exit from fullscreen on a device that could never
    // enter it is a capability failure, not a choice.
    missingForDecision.push('the preflight record, without which the events cannot be interpreted');
  }
  if (entries.length === 0) missingForDecision.push('any events at all');
  if (facts.droppedEventCount > 0) {
    // `U-2`: a teacher must be able to see that the escalation was under-counted, or a clean timeline reads as a clean
    // attempt.
    missingForDecision.push(
      `${String(facts.droppedEventCount)} event(s) lost to telemetry shedding, so counts here are lower than they were`,
    );
  }

  return {
    attemptId: facts.attemptId,
    banner: EVIDENCE_BANNER,
    help: INTEGRITY_HELP,
    entries,
    preflight: facts.preflight,
    similarityClusters: facts.similarityClusters,
    forceExits: facts.forceExits,
    droppedEventCount: facts.droppedEventCount,
    isFrozen: facts.isFrozen,
    isReviewable: missingForDecision.length === 0,
    missingForDecision,
  };
};

/**
 * A ONE-LINE SUMMARY of an event, for a teacher skimming rather than reading.
 *
 * Event-describing, with the COUNT rather than an adjective: "left fullscreen 3 times" is a fact a teacher can check
 * against the timeline. "repeatedly left fullscreen" is a characterisation, and characterisations are where intent
 * gets smuggled in.
 */
export const summariseCounts = (entries: readonly TimelineEntry[]): readonly string[] => {
  const counts = new Map<EvidenceType, number>();
  for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${String(count)} × ${type.toLowerCase().replace(/_/g, ' ')}`);
};
