/**
 * Accommodations: what a teacher grants, and what it silences.  (P8-T12, `INV-ACC-1`)
 *
 * ## INV-ACC-1, STATED PRECISELY BECAUSE THE OBVIOUS READING OF IT IS WRONG
 *
 * `plans/01` §11: "A relaxation granted to a student produces **zero** violation events for the affected watchdogs. They
 * route to a…"
 *
 * The obvious implementation is "if the student has DISABLE_FULLSCREEN, ignore fullscreen events". That is wrong in a way
 * that costs a student their grade, and the difference is **the event versus the count**:
 *
 * - **ZERO VIOLATION EVENTS** is the requirement. The fullscreen watchdog is not merely muted -- it does not fire, so
 *   nothing reaches the timeline, nothing reaches a strike counter, and nothing needs to be explained away later.
 * - **The relaxation itself is still recorded**, as `INFO`. A screen-reader user's session showing no fullscreen events at
 *   all is indistinguishable from a session where the feature was never used, and a teacher looking at an
 *   accommodation-holder's timeline has to be able to see WHY it is quiet. `INV-ACC-1` says the relaxation produces zero
 *   VIOLATIONS, not zero events -- and the difference between those two readings is the difference between a quiet
 *   timeline and a false one.
 *
 * ## AND THE RELAXATION MUST BE ATTACHED TO A HUNDRED, NOT INFERRED
 *
 * A student's browser lacking `pointerLock` is a preflight relaxation (`session.ts`, `NO_*`). An accommodation is a
 * TEACHER's decision about a student. Conflating them would let a student claim an exemption by making their browser
 * look incapable, which is the most obvious way to defeat an integrity system and the reason the two vocabularies are
 * separate types rather than one list.
 */

import {
  countsAsStrike,
  EVIDENCE_RULES,
  type EvidenceType,
  evidenceRuleFor,
  type Severity,
  type StrikePolicyView,
} from './evidence.js';

/** What a teacher can grant. `U-3`/`U-5`: input, output and presentation, not just integrity. */
export type GrantedRelaxation =
  /** The fullscreen watchdog does not fire. The student's session is not offline-capable without it. */
  | 'DISABLE_FULLSCREEN'
  /**
   * Escape releases pointer lock and browsers deliberately prevent interception, so a pointer-lock requirement is
   * unsatisfiable by keyboard for some students. `plans/09` §4.1 already sets the default threshold to `null` ("never")
   * for this reason; a grant here is the per-student version of the same reasoning.
   */
  | 'DISABLE_POINTER_LOCK'
  /** Tab-hide and focus-loss watchdogs do not fire. */
  | 'DISABLE_TAB_WATCHDOG'
  /** Copy, paste and context-menu guards are not applied. */
  | 'ALLOW_COPY'
  /** Screen-reader users are not nagged about focus changes at all. */
  | 'DISABLE_FOCUS_NAG'
  /** Additional time, as a percentage of the paper's total. `Accommodation.extraTimePercent`. */
  | 'EXTRA_TIME_PERCENT';

/** Which watchdog a relaxation silences. One relaxation may silence more than one watchdog. */
export type WatchdogName = 'FULLSCREEN' | 'POINTER_LOCK' | 'TAB_HIDE' | 'FOCUS' | 'COPY';

/**
 * THE ROUTING TABLE. Data, so a new watchdog cannot be added without deciding what it does under each relaxation.
 *
 * `null` means "this relaxation does not silence this watchdog", which is different from `[]` ("this watchdog is not
 * subject to accommodations at all") and different again from listing every relaxation ("silenced by any of them").
 */
const ROUTING: Readonly<Record<WatchdogName, readonly GrantedRelaxation[]>> = Object.freeze({
  FULLSCREEN: ['DISABLE_FULLSCREEN'],
  POINTER_LOCK: ['DISABLE_POINTER_LOCK'],
  TAB_HIDE: ['DISABLE_TAB_WATCHDOG'],
  FOCUS: ['DISABLE_TAB_WATCHDOG', 'DISABLE_FOCUS_NAG'],
  COPY: ['ALLOW_COPY'],
});

/**
 * WHICH GRANTED RELAXATION SILENCES THIS WATCHDOG, or `null`. The one reader of `ROUTING` by watchdog.
 *
 * `producesViolation` asked this with `.some` and `routeWatchdogEvent` asked it again with `.find`, three lines apart,
 * which is two answers to one question waiting for one of them to be edited. `Object.hasOwn` for the reason
 * `evidenceRuleFor` uses it: `ROUTING['constructor']` is a function, not a missing row.
 */
const silencingRelaxation = (
  watchdog: WatchdogName,
  relaxations: readonly GrantedRelaxation[],
): GrantedRelaxation | null => {
  const silencedBy = Object.hasOwn(ROUTING, watchdog) ? ROUTING[watchdog] : [];
  return silencedBy.find((relaxation) => relaxations.includes(relaxation)) ?? null;
};

/** Every watchdog a relaxation silences, so a caller can ask the question the other way round. */
export const watchdogsSilencedBy = (relaxation: GrantedRelaxation): readonly WatchdogName[] =>
  (Object.keys(ROUTING) as WatchdogName[]).filter((watchdog) =>
    (ROUTING[watchdog] ?? []).includes(relaxation),
  );

/**
 * **INV-ACC-1: DOES A WATCHDOG EVENT BECOME A VIOLATION UNDER THESE RELAXATIONS?**
 *
 * `false` means the event is reclassified to `INFO` and is still recorded. See the header: silencing the event entirely
 * would make an accommodation-holder's timeline indistinguishable from an unused feature.
 */
export const producesViolation = (
  watchdog: WatchdogName,
  relaxations: readonly GrantedRelaxation[],
): boolean => silencingRelaxation(watchdog, relaxations) === null;

/**
 * WHICH WATCHDOG REPORTS EACH EVENT, so a relaxation can be applied to an EVENT and not only to a watchdog's name.
 *
 * Nothing mapped one vocabulary to the other. `EVIDENCE_RULES` is keyed by event type and `ROUTING` by watchdog, so
 * anything applying `INV-ACC-1` to a real event had to invent the pairing at the call site -- and a test in `apps/web`
 * did, noting that "nothing in the codebase maps one to the other yet".
 *
 * A `Record` over `EvidenceType`: a new event type does not compile until someone has decided whether a relaxation
 * reaches it. `null` means no watchdog in `ROUTING` reports it, so no relaxation changes how it is treated.
 *
 * TWO ROWS ARE DECISIONS AND NOT TRANSCRIPTION:
 *
 *  · `PRINT_ATTEMPT` is `COPY`. `plans/09` §6.3 lists `beforeprint` among the events the copy/paste hardening
 *    intercepts and says "accommodations mode disables it entirely", and `blockingDecision` in `apps/web` already
 *    lifts all four for an accommodation-holder. `null` here would have the server strike a student for a print the
 *    client told them was allowed.
 *  · `MULTI_TAB_DETECTED` is `null`. No relaxation in `ROUTING` silences a second live session, so it counts for an
 *    accommodation-holder as for anyone. `plans/09` §8's `ALLOW_TAB_SWITCH` is about leaving the tab, not about
 *    sitting the paper twice.
 */
export const WATCHDOG_OF_EVENT: Readonly<Record<EvidenceType, WatchdogName | null>> = Object.freeze(
  {
    EXAM_STARTED: null,
    FULLSCREEN_ENTERED: 'FULLSCREEN',
    FULLSCREEN_EXITED: 'FULLSCREEN',
    FULLSCREEN_DENIED: 'FULLSCREEN',
    POINTERLOCK_ENTERED: 'POINTER_LOCK',
    POINTERLOCK_LOST: 'POINTER_LOCK',
    WINDOW_BLURRED: 'FOCUS',
    WINDOW_FOCUSED: 'FOCUS',
    TAB_HIDDEN: 'TAB_HIDE',
    TAB_VISIBLE: 'TAB_HIDE',
    MULTI_TAB_DETECTED: null,
    COPY_ATTEMPT: 'COPY',
    PASTE_ATTEMPT: 'COPY',
    CONTEXT_MENU: 'COPY',
    PRINT_ATTEMPT: 'COPY',
    SAVE_ATTEMPT: null,
    DEVTOOLS_SIZE_ANOMALY: null,
    SAVE_REJECTED_LATE: null,
    QUESTION_WINDOW_CLOSED: null,
    CLOCK_SKEW_DETECTED: null,
    NETWORK_LOST: null,
    NETWORK_RESTORED: null,
    AUTOSAVE_QUEUED: null,
    SIM_LOAD_FAILED: null,
    ACCOMMODATION_RELAXED: null,
    VIOLATION_THRESHOLD_REACHED: null,
    ATTEMPT_TERMINATED: null,
    ATTEMPT_SUBMITTED: null,
  },
);

/** One event, routed: what the timeline shows, why it is quiet if it is, and whether a counter moves. */
export interface RoutedEvidence {
  readonly type: EvidenceType;
  /** The watchdog that reports this type, or `null` when no relaxation can reach it. */
  readonly watchdog: WatchdogName | null;
  /** `INFO` when relaxed, otherwise the severity `EVIDENCE_RULES` files the type at. */
  readonly severity: Severity;
  /** **Always true**: a relaxation changes severity, never existence. */
  readonly recorded: true;
  /** The relaxation responsible, so a timeline can SAY why a student is quiet rather than merely showing that they are. */
  readonly relaxedBy: GrantedRelaxation | null;
  /** Whether a strike counter moves. Never true while `relaxedBy` is set. `INV-ACC-1`. */
  readonly countsAsStrike: boolean;
}

/**
 * **DOES THIS EVENT COUNT, FOR THIS STUDENT, UNDER THIS POLICY?** The whole answer, and the one a write path calls.
 *
 * ## WHY THIS EXISTS: THE QUESTION HAD TWO HALVES AND NO FUNCTION ASKED BOTH  (`ADV-A1`)
 *
 * `countsAsStrike` knew the table and the policy and nothing about the student. `routeWatchdogEvent` knew the student's
 * relaxations and decided the rest for itself, from severity. A telemetry route had to pick one: the first alone and
 * `INV-ACC-1` is not applied at all; the second alone and `thresholds.tabHides` is dead, because a tab hide is `WARN`.
 *
 * So this takes all three inputs, REQUIRED, and composes the two rules without restating either:
 *
 *  · whether a relaxation the student holds silences the watchdog -- `silencingRelaxation`, here;
 *  · otherwise whether the table and the policy count it -- `countsAsStrike`, in `evidence.ts`.
 *
 * `relaxations` is not optional and has no default. An empty array is a statement that the student holds none; an
 * omitted argument would be the same value arrived at by forgetting, and the student it is forgotten for is the one
 * `INV-ACC-1` exists to protect.
 *
 * THE RELAXATION IS CHECKED FIRST. Asking the policy first would count the event and then decide it did not matter.
 *
 * HONEST LIMIT: nothing on a write path calls this yet, because there is no telemetry route. PF-8 is the record of a
 * function carrying the right vocabulary with no production caller, so that is stated here rather than discovered
 * later: this is proven to be the one answer, and not yet proven to be the one anyone asks.
 */
export const routeEvidence = (input: {
  readonly type: EvidenceType;
  readonly policy: StrikePolicyView;
  readonly relaxations: readonly GrantedRelaxation[];
}): RoutedEvidence => {
  // First, and for its throw: `WATCHDOG_OF_EVENT['constructor']` is a function too, and reading it before this would
  // route an event type that does not exist.
  const rule = evidenceRuleFor(input.type);
  const watchdog = WATCHDOG_OF_EVENT[input.type];
  const relaxedBy = watchdog === null ? null : silencingRelaxation(watchdog, input.relaxations);

  if (relaxedBy !== null) {
    return {
      type: input.type,
      watchdog,
      // Downgraded, not dropped, and from `WARN` as well as from `VIOLATION`. See `routeWatchdogEvent`.
      severity: 'INFO',
      recorded: true,
      relaxedBy,
      countsAsStrike: false,
    };
  }

  return {
    type: input.type,
    watchdog,
    severity: rule.severity,
    recorded: true,
    relaxedBy: null,
    countsAsStrike: countsAsStrike(input.type, input.policy),
  };
};

/** Every event type a watchdog reports, read off `WATCHDOG_OF_EVENT` rather than listed a second time. */
export const eventsReportedBy = (watchdog: WatchdogName): readonly EvidenceType[] =>
  (Object.keys(WATCHDOG_OF_EVENT) as EvidenceType[]).filter(
    (type) => WATCHDOG_OF_EVENT[type] === watchdog,
  );

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  INFO: 0,
  WARN: 1,
  VIOLATION: 2,
});

/**
 * A policy with every switch on, for the one caller that is not told the policy. See `routeWatchdogEvent`.
 *
 * Typed as `StrikePolicyView` so a switch added to the view does not compile until it is switched on here.
 */
const EVERY_SWITCH_ON: StrikePolicyView = Object.freeze({
  requireFullscreen: 'REQUIRE',
  requirePointerLock: 'REQUIRE',
  multiTabPolicy: 'BLOCK',
  blockCopyPaste: true,
  blockPrintSave: true,
});

export interface RoutedEvent {
  readonly watchdog: WatchdogName;
  /** `INFO` when relaxed, otherwise whatever the event's own severity was. */
  readonly severity: 'INFO' | 'WARN' | 'VIOLATION';
  /** True when the event is still recorded. **Always true**: a relaxation changes severity, never existence. */
  readonly recorded: true;
  /** The relaxation responsible, so a timeline can SAY why a student is quiet rather than merely showing that they are. */
  readonly relaxedBy: GrantedRelaxation | null;
  /** Whether this event counts towards a strike. `INV-ACC-1`. */
  readonly countsAsStrike: boolean;
}

/**
 * ROUTE A WATCHDOG'S EVENT BY WATCHDOG AND SEVERITY -- the older question, kept for the callers that ask it.
 *
 * ## WHY ROUTING HAPPENED IN THREE PLACES BEFORE
 *
 * The strike counter, the escalation ladder and the teacher timeline each decided independently whether a relaxation
 * applied, and each decided slightly differently. Three implementations of one routing rule is the same defect as three
 * implementations of a deadline: they drift, and they drift in the direction that happens to be locally reasonable.
 *
 * ## AND THEN THIS FUNCTION WAS THE SECOND IMPLEMENTATION OF A DIFFERENT RULE  (`ADV-A1`)
 *
 * It ended relaxation being interpreted in three places and, in the same breath, decided the UN-relaxed case for
 * itself: `countsAsStrike: severity === 'VIOLATION'`. `evidence.ts` already answered that from `plans/09` §7.1's
 * table, where a tab hide, a focus loss, a pointer-lock loss and a copy attempt are all `WARN` and all count. So the
 * two disagreed on every one of them, and this one's answer made four of the five thresholds unreachable.
 *
 * It holds no strike rule now. The un-relaxed answer is `countsAsStrike`'s, asked about the events the table says this
 * watchdog reports.
 *
 * ## WHAT THIS SHAPE CANNOT KNOW, AND WHY A WRITE PATH MUST NOT CALL IT
 *
 * It is told a watchdog and a severity. It is not told the POLICY and it is not told the event TYPE, so it answers
 * "could an event from this watchdog, filed at this severity or below, count under a policy that polices it" -- and
 * says yes in two cases where `routeEvidence` says no:
 *
 *  · the policy has the switch OFF. This has never been told the policy; it used to count every `VIOLATION` anyway.
 *  · the event is a RETURN. `TAB_VISIBLE` and `TAB_HIDDEN` are both `WARN` from the same watchdog, as are
 *    `WINDOW_FOCUSED` and `WINDOW_BLURRED`, and nothing in `(watchdog, severity)` tells them apart.
 *
 * `>=` on severity because a server reclassifies severity upward from policy (`plans/09` §7), and an event that
 * counted as `WARN` does not stop counting because it was filed as a `VIOLATION`.
 *
 * @deprecated for anything that holds an event. Call `routeEvidence`, which is told the type and the policy.
 */
export const routeWatchdogEvent = (input: {
  readonly watchdog: WatchdogName;
  readonly severity: 'INFO' | 'WARN' | 'VIOLATION';
  readonly relaxations: readonly GrantedRelaxation[];
}): RoutedEvent => {
  const relaxedBy = silencingRelaxation(input.watchdog, input.relaxations);

  if (relaxedBy !== null) {
    return {
      watchdog: input.watchdog,
      // Downgraded, not dropped. An accommodation-holder's timeline has to be able to explain its own quietness.
      //
      // **EVERYTHING ABOVE `INFO` IS DOWNGRADED, NOT JUST VIOLATIONS** -- and my first comment here said warnings survive,
      // which the code did not do. The rule is the coherent one: **a silenced watchdog contributes nothing above INFO.**
      // A fullscreen WARNING tells a student to return to fullscreen, and a student who has been exempted from the
      // fullscreen requirement must not be told to do the thing they were excused from -- so the message is not merely
      // unhelpful, it is wrong. Downgrading it to INFO is also what keeps the timeline honest: a `WARN` in a relaxed
      // watchdog's column would read as "something was flagged and forgiven", which is a different fact.
      severity: 'INFO',
      recorded: true,
      relaxedBy,
      countsAsStrike: false,
    };
  }

  return {
    watchdog: input.watchdog,
    severity: input.severity,
    recorded: true,
    relaxedBy: null,
    countsAsStrike: eventsReportedBy(input.watchdog).some(
      (type) =>
        SEVERITY_RANK[input.severity] >= SEVERITY_RANK[EVIDENCE_RULES[type].severity] &&
        countsAsStrike(type, EVERY_SWITCH_ON),
    ),
  };
};

/**
 * EXTRA TIME, AS A DEADLINE EXTENSION.
 *
 * ## WHY THIS RETURNS A DELTA AND NOT A NEW DEADLINE
 *
 * `INV-POLICY-1` / `C14`: `ExamAttempt.deadlineAt` is **never rewritten**; extensions are ADDITIVE rows
 * (`AttemptDeadlineExtension`). A function returning "the new deadline" invites a caller to assign it, and one caller
 * eventually will -- which loses every previous extension, because the new value was computed from the base rather than
 * from what is already granted.
 *
 * So this returns the additional seconds, and the caller writes a row. That is the only shape in which "grant twice"
 * means "add twice".
 *
 * ## AND THE STUDENT'S ELAPSED TIME IS NOT HALVED
 *
 * The naive reading of "+25%" is `deadline * 1.25`, which silently shortens the exam for a student who has already spent
 * an hour on a three-hour paper: 1.25 x 2h remaining is 2.5h, which is *less* than the 3h they had. The percentage
 * applies to the paper's TOTAL, so the extension is a share of the total regardless of how much is left.
 */
export const extraTimeSeconds = (totalTimeLimitSec: number, extraTimePercent: number): number => {
  if (totalTimeLimitSec <= 0) return 0;
  // Clamped to [0, 100]: a 400% accommodation would be a four-times-longer paper, which is a data-entry error rather
  // than an accommodation, and arithmetic that trusts it hands a student a deadline nobody intended.
  const percent = Math.min(Math.max(extraTimePercent, 0), 100);
  return Math.round((totalTimeLimitSec * percent) / 100);
};
