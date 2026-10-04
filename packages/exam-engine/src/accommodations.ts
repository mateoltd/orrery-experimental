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
): boolean => !(ROUTING[watchdog] ?? []).some((relaxation) => relaxations.includes(relaxation));

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
 * ROUTE AN EVENT, once, for every caller.
 *
 * ## WHY ROUTING HAPPENED IN THREE PLACES BEFORE
 *
 * The strike counter, the escalation ladder and the teacher timeline each decided independently whether a relaxation
 * applied, and each decided slightly differently. Three implementations of one routing rule is the same defect as three
 * implementations of a deadline: they drift, and they drift in the direction that happens to be locally reasonable.
 *
 * So this is the only place a relaxation is interpreted. A caller that wants the answer calls it; a caller that wants to
 * decide for itself has to write the routing table again, and the table is exported so it can be asserted against.
 */
export const routeWatchdogEvent = (input: {
  readonly watchdog: WatchdogName;
  readonly severity: 'INFO' | 'WARN' | 'VIOLATION';
  readonly relaxations: readonly GrantedRelaxation[];
}): RoutedEvent => {
  if (!producesViolation(input.watchdog, input.relaxations)) {
    const silencing = (ROUTING[input.watchdog] ?? []).find((relaxation) =>
      input.relaxations.includes(relaxation),
    );
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
      relaxedBy: silencing ?? null,
      countsAsStrike: false,
    };
  }

  return {
    watchdog: input.watchdog,
    severity: input.severity,
    recorded: true,
    relaxedBy: null,
    countsAsStrike: input.severity === 'VIOLATION',
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
