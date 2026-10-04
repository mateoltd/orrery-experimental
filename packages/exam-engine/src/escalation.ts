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

/** The escalation ladder, ordered from least to most severe. `TERMINATE` is terminal. */
export type Rung = 'NONE' | 'WARN' | 'BLOCK_UNTIL_RELOCK' | 'REQUIRE_RELOCK' | 'TERMINATE';

/** The ladder in order. The INDEX is the escalation, so a policy's `escalation` array selects a prefix of this. */
export const LADDER: readonly Rung[] = Object.freeze([
  'WARN',
  'BLOCK_UNTIL_RELOCK',
  'REQUIRE_RELOCK',
  'TERMINATE',
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
  /** How far past its threshold the worst kind is, as a fraction. `0` means exactly at it, which IS a breach. */
  readonly worstOvershoot: number;
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

  for (const kind of ALL_KINDS) {
    const threshold = input.thresholds[THRESHOLD_KEYS_FOR_KINDS[kind]];
    const count = Math.max(0, input.counts[kind] ?? 0);

    if (threshold === null || threshold === undefined) {
      // NOT POLICED. Not "already breached" -- see the note at the top of this file.
      unpoliced.push(kind);
      continue;
    }

    // `>=`, not `>`: a threshold of 3 means the THIRD violation is the breach. A policy reading "up to 3" and one
    // reading "more than 3" differ by exactly one violation, and the student cannot tell which one they are in.
    if (count >= threshold) {
      breached.push(kind);
      // A threshold of 0 gives a division by zero; every count is a breach there, which is what 0 means.
      worstOvershoot = Math.max(worstOvershoot, threshold === 0 ? count : count - threshold + 1);
    }
  }

  return { breached, unpoliced, worstOvershoot };
};

export interface EscalationVerdict {
  /** The rung reached. Never lower than the rung the policy's ladder makes reachable. */
  readonly rung: Rung;
  /** The kinds responsible, so the student is told WHAT happened and not merely that something did. */
  readonly reasons: readonly ViolationKind[];
  readonly report: BreachReport;
  /**
   * True once `TERMINATE` is reached.
   *
   * Separate from `rung === 'TERMINATE'` so a caller cannot accidentally treat it as just another level. Termination
   * ends the attempt; the other rungs do not.
   */
  readonly isTerminal: boolean;
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
    return { rung: 'NONE', reasons: [], report, isTerminal: false };
  }

  /**
   * THE LADDER IS A PREFIX SELECTOR, AND AN EMPTY ONE ESCALATES TO NOTHING.
   *
   * A policy whose `escalation` array is empty is a policy that has decided not to escalate, and it must be honoured:
   * `ladder[depth - 1]` on an empty array is `undefined`, which would otherwise become a rung named "undefined".
   */
  const ladder = input.ladder.filter((rung): rung is Rung => rung !== 'NONE');
  if (ladder.length === 0) {
    return { rung: 'NONE', reasons: report.breached, report, isTerminal: false };
  }

  const depth = Math.min(report.breached.length, ladder.length);
  const rung = ladder[depth - 1] ?? 'NONE';

  return {
    rung,
    reasons: report.breached,
    report,
    isTerminal: rung === 'TERMINATE',
  };
};
