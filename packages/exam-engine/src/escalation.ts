/**
 * `@orrery/exam-engine` -- the exam runtime's evaluation layer.  (P8-T1, P8-T2, P8-T11)
 *
 * `plans/00` describes this package as the one that "decides deadlines and escalation", isomorphic, at 100% branch
 * coverage. It exists because those two decisions are made in at least three places -- the browser before a write, the
 * server on the write path, and the teacher tooling -- and three implementations of one decision drift.
 *
 * ## IT DEPENDS ON `@orrery/contracts`, IT DOES NOT MOVE ANYTHING OUT OF IT
 *
 * The policy model, defaults, validation, deep-freeze and versioned snapshot already exist in `@orrery/contracts/policy`
 * (P7-T8), and the absolute/per-question/grace deadline arithmetic already exists in
 * `contracts/src/policy/deadline.ts`. Relocating them would be a large refactor of code that is already correct and
 * already tested, and would buy nothing: the boundary that matters is the DECISION, not where the schema lives. So the
 * engine consumes them and adds only what is missing -- evaluation, which turns state into a verdict.
 *
 * That consolidation is recorded as the remaining part of P8-T1 rather than quietly skipped.
 */

/**
 * A NULL THRESHOLD MEANS "NOT POLICED", AND IT NEVER MEANS ZERO.
 *
 * `ExamPolicy.thresholds` is `number | null` per kind. Every threshold in this package is nullable, and the difference
 * is the whole reason the type is:
 *
 *  · `0` -- this kind of violation is forbidden outright. The first one is the violation.
 *  · `null` -- this kind is not policed. **Falling through to `count > 0` here would forbid every kind of violation
 *    for every policy**, because `0 >= null` is false and `1 > null` is true. A null threshold silently becoming zero
 *    tolerance is the sort of bug that turns a quiz into a proctored exam, and it would ship because the code reads
 *    plausibly.
 *
 * `thresholdFor` exists so that distinction is made in exactly one place.
 */
export type ViolationKind =
  | 'fullscreenExit'
  | 'focusLoss'
  | 'tabHide'
  | 'pointerLockLoss'
  | 'copyAttempt';

/** The `thresholds` keys on `ExamPolicy`, which are named in the plural. */
type ThresholdKey =
  | 'fullscreenExits'
  | 'focusLosses'
  | 'tabHides'
  | 'pointerLockLosses'
  | 'copyAttempts';

/**
 * EXPORTED so a test can assert the map covers the schema rather than re-deriving it.
 *
 * A threshold added to `ExamPolicy` and forgotten here is SILENTLY unpoliced -- the lookup yields `undefined`, which
 * this module reads as "not policed", so the omission raises nothing at all.
 */
export const THRESHOLD_KEYS_FOR_KINDS: Readonly<Record<ViolationKind, ThresholdKey>> =
  Object.freeze({
    fullscreenExit: 'fullscreenExits',
    focusLoss: 'focusLosses',
    tabHide: 'tabHides',
    pointerLockLoss: 'pointerLockLosses',
    copyAttempt: 'copyAttempts',
  });

/** How many of each kind have been observed. Absent means zero; a count is never negative. */
export type ViolationCounts = Partial<Record<ViolationKind, number>>;

/**
 * The escalation ladder, ordered from least to most severe.  (`V-12`, corrected in P8-T11)
 *
 * **THE TOP RUNG IS `FREEZE_AND_SUBMIT` AND THERE IS NO `TERMINATE`.** This type still had `TERMINATE` as its most
 * severe rung and `EscalationVerdict` still had an `isTerminal` flag, three weeks of `V-12`-corrected prose sitting
 * directly on top of uncorrected code. `V-12` is specific about what the original did: it set the attempt to
 * `TERMINATED`, submitted "held answers", and so **irreversibly discarded every unwritten item**, reducing the grade.
 *
 * The correction was applied to the documentation, the attempt-status enum gained a `FROZEN` sibling, and this
 * ladder was left alone -- which is worse than never having started, because the corrected prose was describing
 * behaviour this module could not produce, and a reader would reasonably believe the code agreed with the plan.
 */
export type Rung = 'NONE' | 'WARN' | 'BLOCK_UNTIL_RELOCK' | 'REQUIRE_RELOCK' | 'FREEZE_AND_SUBMIT';

/** The ladder in order. The INDEX is the escalation, so a policy's `escalation` array selects a prefix of this. */
export const LADDER: readonly Rung[] = Object.freeze([
  'WARN',
  'BLOCK_UNTIL_RELOCK',
  'REQUIRE_RELOCK',
  'FREEZE_AND_SUBMIT',
]);

/** Where a rung sits in the ladder. `NONE` is below `WARN`, so no policy escalates to it by accident. */
export const rungIndex = (rung: Rung): number => (rung === 'NONE' ? -1 : LADDER.indexOf(rung));

/** The stricter of two rungs. Used wherever evidence is merged, so merging can never SOFTEN an outcome. */
export const maxRung = (a: Rung, b: Rung): Rung => (rungIndex(a) >= rungIndex(b) ? a : b);

export interface EscalationInput {
  readonly counts: ViolationCounts;
  readonly thresholds: Readonly<Record<ThresholdKey, number | null>>;
  /** The policy's ladder, ordered. A policy that omits a rung does not escalate to it. */
  readonly ladder: readonly Rung[];
}

/** Which kinds are over their threshold, and which are merely not policed. Kept separate so a caller can say why. */
export interface BreachReport {
  /** Kinds whose count has reached a NON-NULL threshold. */
  readonly breached: readonly ViolationKind[];
  /** Kinds with a null threshold. Reported so "not policed" is visible rather than inferred from silence. */
  readonly unpoliced: readonly ViolationKind[];
  /**
   * How far past its threshold the worst kind is. `0` means exactly at it, which IS a breach.
   *
   * **THIS IS A NUMBER AND NOT A RANKING, AND IT DELIBERATELY DOES NOT DRIVE THE RUNG.** It is carried for the
   * teacher's timeline (P8-T14) to say "how far past". Severity is the DEPTH of breached kinds, below.
   */
  readonly worstOvershoot: number;
  /**
   * Which kind overshot most. Reported so a teacher can be told WHAT happened rather than merely that something did.
   *
   * `null` when nothing breached. Ties are broken deterministically by the fixed `ALL_KINDS` order rather than by
   * iteration luck: an arbitrary answer in a teacher-facing report is worse than no answer, and no test may assert
   * otherwise. (P8-T11's first draft returned the first kind in iteration order while documenting itself as
   * returning "the most severe" -- overshoot and severity are different questions, and conflating them is how a
   * reporting helper starts quietly answering the wrong one.)
   */
  readonly worstKind: ViolationKind | null;
}

const ALL_KINDS: readonly ViolationKind[] = Object.freeze([
  'fullscreenExit',
  'focusLoss',
  'tabHide',
  'pointerLockLoss',
  'copyAttempt',
]);

/**
 * CLASSIFY THE EVIDENCE AGAINST THE POLICY'S THRESHOLDS.
 *
 * Pure, total, and deliberately boring: the value of this function is that it has one interpretation, available to the
 * browser, the server and the teacher tooling without any of them re-deriving it.
 */
export const classifyBreaches = (input: EscalationInput): BreachReport => {
  const breached: ViolationKind[] = [];
  const unpoliced: ViolationKind[] = [];
  let worstOvershoot = 0;
  let worstKind: ViolationKind | null = null;

  for (const kind of ALL_KINDS) {
    const threshold = input.thresholds[THRESHOLD_KEYS_FOR_KINDS[kind]];
    const count = Math.max(0, input.counts[kind] ?? 0);

    if (threshold === null || threshold === undefined) {
      // NOT POLICED. Not "already breached" -- see the note at the top of this file.
      unpoliced.push(kind);
      continue;
    }

    /**
     * **A BREACH IS SOMETHING A STUDENT DID, SO THE FIRST COUNT THAT CAN BREACH IS ONE.**  (`ADV-A2`)
     *
     * This was a bare `count >= threshold`, and `0 >= 0` is true: under a threshold of `0` a student was in breach at
     * a count of ZERO, before any event existed. The rung is the number of breached KINDS, so zero tolerance on four
     * kinds put every student on `FREEZE_AND_SUBMIT` at the first evaluation -- frozen for having started.
     *
     * The floor is on the THRESHOLD and not a `threshold === 0` branch, so "no breach without an event" holds for any
     * number a caller passes (a negative one, a fraction below one) and not only for the single value someone thought
     * of. `engine.test.ts` covered zero only at a count of one or more, where `>=` and this agree.
     *
     * HONEST CONSEQUENCE: `0` and `1` now breach at the same count, the first violation. That is what the note at the
     * top of this file says `0` means, and what `>=` has always made `1` mean. It is NOT `null`: zero tolerance is
     * breached by the first event and "not policed" by none, and the guard above is still the only place that
     * distinction is made.
     */
    const firstBreachingCount = Math.max(threshold, 1);

    // `>=`, not `>`: a threshold of 3 means the THIRD violation is the breach. A policy reading "up to 3" and one
    // reading "more than 3" differ by exactly one violation, and the student cannot tell which one they are in.
    if (count >= firstBreachingCount) {
      breached.push(kind);
      // The same number as before the floor for every threshold, zero included: it used to be special-cased to
      // `count`, which is what this gives.
      const overshoot = count - firstBreachingCount + 1;
      // Strict `>` so a tie keeps the earlier kind -- deterministic, and the tie itself is not a finding.
      if (worstKind === null || overshoot > worstOvershoot) {
        worstOvershoot = overshoot;
        worstKind = kind;
      }
    }
  }

  return { breached, unpoliced, worstOvershoot, worstKind };
};

export interface EscalationVerdict {
  /** The rung reached. Never lower than the rung the policy's ladder makes reachable. */
  readonly rung: Rung;
  /** The kinds responsible, so the student is told WHAT happened and not merely that something did. */
  readonly reasons: readonly ViolationKind[];
  readonly report: BreachReport;
  /**
   * True once the attempt is FROZEN.  (`V-12`)
   *
   * ## WHY THIS REPLACED `isTerminal`, AND IT IS NOT A RENAME
   *
   * The old flag was `isTerminal: rung === 'TERMINATE'`, and it existed so "a caller cannot accidentally treat it as
   * just another level" -- which was the correct instinct about a flag that ended an attempt irreversibly. The
   * mistake was in the ladder rather than the flag. So the flag stays, because the asymmetry is real and worth
   * asserting, but it now reports a FREEZE, and freezing is **reversible**: a teacher reinstates with a recorded
   * reason. `reversible` is carried beside it so that the reversibility is a stated property rather than an inference
   * nobody is obliged to make.
   */
  readonly freezesAttempt: boolean;
  /** Always `true`: no rung in this ladder ends an attempt permanently. `V-12`. */
  readonly reversible: true;
}

/**
 * DECIDE THE ESCALATION RUNG.
 *
 * ## WHY THE DEPTH IS A COUNT OF BREACHED KINDS AND NOT A SUM
 *
 * A student who left fullscreen five times and never lost focus has committed one KIND of violation, repeatedly. A
 * student who left fullscreen once, hid the tab once and lost focus once has committed three. The second student is the
 * one worth escalating, and a sum gets that backwards -- five tab hides outranks three distinct behaviours.
 *
 * ## AND WHY `worstOvershoot` IS NOT USED FOR THE RUNG
 *
 * It is tempting to escalate further the further past a threshold someone is. That makes one repeated mistake worse
 * than several different ones, which is the same inversion. `worstOvershoot` is carried for the teacher's timeline
 * (P8-T14) and deliberately does not drive this decision.
 */
export const evaluateEscalation = (input: EscalationInput): EscalationVerdict => {
  const report = classifyBreaches(input);

  if (report.breached.length === 0) {
    return { rung: 'NONE', reasons: [], report, freezesAttempt: false, reversible: true };
  }

  /**
   * THE LADDER IS A PREFIX SELECTOR, AND AN EMPTY ONE ESCALATES TO NOTHING.
   *
   * A policy whose `escalation` array is empty is a policy that has decided not to escalate, and it must be honoured:
   * `ladder[depth - 1]` on an empty array is `undefined`, which would otherwise become a rung named "undefined".
   */
  const ladder = input.ladder.filter((rung): rung is Rung => rung !== 'NONE');
  if (ladder.length === 0) {
    return {
      rung: 'NONE',
      reasons: report.breached,
      report,
      freezesAttempt: false,
      reversible: true,
    };
  }

  const depth = Math.min(report.breached.length, ladder.length);
  const rung = ladder[depth - 1] ?? 'NONE';

  return {
    rung,
    reasons: report.breached,
    report,
    // The ONLY rung that touches the attempt, and it freezes rather than terminating.
    freezesAttempt: rung === 'FREEZE_AND_SUBMIT',
    reversible: true,
  };
};

/**
 * WHAT A RUNG DOES, WITH THE STUDENT-VISIBLE CONSEQUENCE.  (P8-T11)
 *
 * ## THE RUNG AND ITS CONSEQUENCE ARE SEPARATE BECAUSE THE LADDER IS NOT THE EFFECT
 *
 * A policy names rungs; the platform decides what a rung *does* to a session. Keeping that apart is what lets a
 * policy select a prefix of the ladder without also carrying the platform's side effects -- and it is why there is no
 * way to write a policy that freezes an attempt and skips the reason recording.
 */
export interface RungEffect {
  readonly rung: Rung;
  /** What the STUDENT is told. Empty at `NONE`, because silence is the honest state. */
  readonly studentMessage: string;
  /** What the attempt does. `null` at every rung below freeze -- NO RUNG CHANGES A SCORE. */
  readonly attemptEffect: 'NONE' | 'FROZEN';
  /** Whether a teacher can reverse this with a recorded reason. True everywhere, `V-12`. */
  readonly reversible: boolean;
  /** True only for freeze, and then only for the answers the student actually WROTE. */
  readonly submitsWrittenAnswers: boolean;
}

const EFFECTS: Readonly<Record<Rung, RungEffect>> = Object.freeze({
  NONE: {
    rung: 'NONE',
    studentMessage: '',
    attemptEffect: 'NONE',
    reversible: true,
    submitsWrittenAnswers: false,
  },
  WARN: {
    rung: 'WARN',
    // "You may go back to the exam" rather than a warning about rules. A rung the student cannot act on teaches them
    // the messages are noise, and then the freeze message is noise too.
    studentMessage: 'You may go back to the exam. This has been recorded.',
    attemptEffect: 'NONE',
    reversible: true,
    submitsWrittenAnswers: false,
  },
  BLOCK_UNTIL_RELOCK: {
    rung: 'BLOCK_UNTIL_RELOCK',
    studentMessage: 'Return to fullscreen to carry on.',
    attemptEffect: 'NONE',
    reversible: true,
    submitsWrittenAnswers: false,
  },
  REQUIRE_RELOCK: {
    rung: 'REQUIRE_RELOCK',
    studentMessage: 'Click to continue. You will need to do this before your next question.',
    attemptEffect: 'NONE',
    reversible: true,
    submitsWrittenAnswers: false,
  },
  FREEZE_AND_SUBMIT: {
    rung: 'FREEZE_AND_SUBMIT',
    /**
     * The message says what happened to the ANSWERS, because that is what a student is actually anxious about, and
     * because `V-12`'s entire correction was that the previous version silently discarded unwritten work. A student
     * who has just seen "this attempt has been stopped" is owed the answer to "did I lose my work" immediately.
     */
    studentMessage:
      'This attempt has been stopped and your written answers have been submitted. Nothing you have written has been ' +
      'discarded. Your teacher will review this and you can raise it with them.',
    attemptEffect: 'FROZEN',
    // Reversible: the teacher can reinstate with a recorded reason. Irreversibility is the bug `V-12` corrected.
    reversible: true,
    // Only what was WRITTEN. The original submitted "held answers" and so discarded every unwritten item.
    submitsWrittenAnswers: true,
  },
});

/** The effect of a rung. Exported so the ladder and the effects cannot drift apart. */
export const effectOf = (rung: Rung): RungEffect => EFFECTS[rung];

/** What the platform does to the attempt for a rung. Nothing in here changes a score. */
export type AttemptTransition =
  | { readonly kind: 'UNCHANGED'; readonly to: string }
  | {
      readonly kind: 'FROZEN';
      readonly to: 'FROZEN';
      readonly submitsWrittenAnswers: true;
      readonly reversible: true;
    };

/**
 * APPLY A RUNG TO AN ATTEMPT.
 *
 * `V-12` in one function: no rung terminates, no rung discards, and the one rung that submits **submits only what was
 * written**. There is deliberately no branch that produces a score, because `plans/01` says the machine may recommend
 * and only a human disposes -- and the reason that is not a slogan is that this function has no vocabulary for it.
 */
export const applyRung = (effect: RungEffect, currentStatus: string): AttemptTransition => {
  if (effect.attemptEffect === 'FROZEN') {
    return { kind: 'FROZEN', to: 'FROZEN', submitsWrittenAnswers: true, reversible: true };
  }
  return { kind: 'UNCHANGED', to: currentStatus };
};

/** A teacher's decision on a frozen attempt. Every variant carries a reason and an author. */
export type TeacherDecision =
  | {
      readonly decision: 'REINSTATE';
      readonly to: string;
      readonly reason: string;
      readonly authorId: string;
    }
  | {
      readonly decision: 'VOID';
      readonly to: 'VOIDED';
      readonly reason: string;
      readonly authorId: string;
    };

const MIN_REASON = 20;

/**
 * REINSTATE OR VOID A FROZEN ATTEMPT -- THE TWO THINGS A TEACHER CAN DO WITH A FREEZE.
 *
 * ## THIS FUNCTION IS WHY A FREEZE IS SAFE, SO IT IS STRICTER THAN LOOKS
 *
 * Both variants require a reason of at least 20 characters and an author, because **a reversal with no record is
 * indistinguishable from a freeze that never happened** -- and an unrecorded reinstatement is indistinguishable from
 * collusion, which is the accusation this whole screen exists to avoid making.
 *
 * `VOID` is refused on an unfrozen attempt. That is not a workflow rule: `P8-T14`'s `IntegrityVerdict` refuses it too,
 * because freezing is the step at which a teacher can still change their mind, and voiding first skips it.
 */
export const reinstate = (
  frozen: boolean,
  reason: string,
  authorId: string,
): { ok: true; transition: TeacherDecision } | { ok: false; message: string } => {
  if (!frozen) {
    return { ok: false, message: 'this attempt is not frozen, so there is nothing to reinstate' };
  }
  if (authorId.trim().length === 0) {
    return {
      ok: false,
      message: 'a teacher decision needs an author, because only a human disposes',
    };
  }
  if (reason.trim().length < MIN_REASON) {
    return {
      ok: false,
      message: `that needs a reason of at least ${MIN_REASON} characters, for the record`,
    };
  }
  return {
    ok: true,
    transition: {
      decision: 'REINSTATE',
      to: 'IN_PROGRESS',
      reason: reason.trim(),
      authorId: authorId.trim(),
    },
  };
};

/**
 * COUNT A STRIKE, PER KIND.  (`B11`)
 *
 * ## ONE COUNTER COULD NOT REPRESENT FIVE THRESHOLDS, AND WOULD MIS-ATTRIBUTE RATHER THAN UNDER-COUNT
 *
 * The schema records `AttemptStrikeCounter { attemptId, kind, count }` with a composite key. An earlier draft had a
 * single `Int` on the attempt, and `plans/09` §7.1 says why that is wrong in a sentence: "a student who left fullscreen
 * 12 times would trip the `tabHides: 3` threshold". One counter does not under-count -- it MIS-ATTRIBUTES, and a
 * student is escalated for something they did not do.
 *
 * Returns a new object rather than mutating, because a counter writable from two places (the evidence writer and the
 * ladder) is a counter whose total cannot be trusted.
 */
export const countStrike = (counts: ViolationCounts, kind: ViolationKind): ViolationCounts => ({
  ...counts,
  [kind]: (counts[kind] ?? 0) + 1,
});

/**
 * `U-2`: A THRESHOLD CROSSING SURVIVES TELEMETRY SHEDDING, AND NOTHING ELSE NEEDS TO.
 *
 * P7-T7's writer sheds load by dropping the OLDEST events. A crossing is the one record that must survive, because the
 * escalation was COMPUTED from it -- and if the crossing is lost while the events underneath it survive, a teacher is
 * left looking at a counter that rose with nothing to explain it. `INV-ACC-1` accommodations are the other exception,
 * and are handled where they are granted rather than here.
 */
export const survivesShedding = (kind: string): boolean => kind.endsWith('_THRESHOLD_REACHED');
