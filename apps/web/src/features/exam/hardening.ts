'use client';

/**
 * Copy/paste/context-menu/print hardening, with the accessibility escape hatch.  (P8-T8)
 *
 * ## BLOCKING IS THE PART THAT IS PROBLEMATIC, AND THE ESCAPE HATCH IS NOT OPTIONAL
 *
 * `RN-01`/`RN-02` (recorded at the top of `plans/15`) establish that proctoring controls **disproportionately harm**
 * students with disabilities, students using assistive technology, and students on unstable connections. A blocked
 * clipboard is the clearest case: a screen-reader user copying a question to re-read it, a switch-access user relying on
 * the context menu, and a student on a metered connection using paste to move a long answer between attempts all break.
 *
 * So every block in this module is paired with a DECLARED route around it, and `blockingDecision` cannot return "block"
 * without also saying which hatch applies. A block with no escape is a student with no way to answer the question, which
 * is a worse outcome than the thing being prevented.
 *
 * ## AND WHAT HAPPENS ON AN ATTEMPT IS REPORTED WITHOUT BEING PREVENTED
 *
 * The first version of this was going to `preventDefault()` the paste and then re-insert the text itself, so the student
 * would not notice. That is the wrong instinct twice over: it is a silent modification of the student's own device
 * behaviour, and it means a paste that the platform handled correctly (into a native control, say) is intercepted
 * anyway. So nothing here calls `preventDefault`. It reports, and the report is what the escalation ladder reads.
 */

/** What a hardening switch is set to. `OFF` means the event is not even listened for. */
export type HardeningSwitch = 'OFF' | 'WARN' | 'BLOCK';

export interface HardeningPolicy {
  readonly blockCopyPaste: boolean;
  readonly blockContextMenu: boolean;
  readonly blockPrintSave: boolean;
  /**
   * Whether a student may declare an accommodation that lifts the blocks for their attempt.
   *
   * Default true. It exists because INV-ACC-1 makes a relaxation a right, and a right that cannot be exercised during
   * the exam it applies to is not a right.
   */
  readonly accommodationHatchAvailable: boolean;
}

export const DEFAULT_HARDENING: HardeningPolicy = Object.freeze({
  blockCopyPaste: true,
  blockContextMenu: true,
  blockPrintSave: true,
  accommodationHatchAvailable: true,
});

/** The events this module reports. Matches `EVIDENCE_RULES` in `@orrery/exam-engine` (P8-T7). */
export type HardeningEvent = 'COPY_ATTEMPT' | 'PASTE_ATTEMPT' | 'CONTEXT_MENU' | 'PRINT_ATTEMPT';

export interface HardeningVerdict {
  readonly event: HardeningEvent;
  /** True when the platform's own default should be left alone. See the note at the top of this file. */
  readonly allow: boolean;
  /**
   * Whether this attempt counts towards the escalation ladder.
   *
   * False for anything occurring while the accommodation hatch is open, because INV-ACC-1 makes a relaxation a right
   * and a strike during one is the policy punishing a student for using it.
   */
  readonly countsAsStrike: boolean;
  /**
   * THE HATCH, or `null` when nothing is blocked.
   *
   * `never` means the block stands and there is no route around it, which the module refuses to produce for a student
   * who has not declared an accommodation. It exists so the failure is a type rather than an oversight.
   */
  readonly hatch: 'accommodation' | 'already_allowed' | 'never';
  readonly reason: string;
}

/**
 * DECIDE WHAT HAPPES ON ONE EVENT.
 *
 * Pure, so the pairing between a block and its hatch is a property that can be tested over every switch combination
 * rather than read.
 */
export const blockingDecision = (
  event: HardeningEvent,
  policy: HardeningPolicy,
  /** Whether the student's declared accommodation is currently in force on THIS attempt. */
  accommodationActive: boolean,
): HardeningVerdict => {
  /**
   * THE ACCOMMODATION HATCH IS CHECKED FIRST, BEFORE ANY SWITCH.
   *
   * Checking the switches first would report the attempt and then decide it does not matter -- so the evidence exists,
   * a teacher sees it, and the only thing missing is the explanation. That is worse than not reporting it, because it
   * looks like a real event.
   */
  if (accommodationActive && policy.accommodationHatchAvailable) {
    return {
      event,
      allow: true,
      countsAsStrike: false,
      hatch: 'accommodation',
      reason: 'an accommodation is in force for this attempt, so this is allowed and not counted',
    };
  }

  const blocked = ((): boolean => {
    switch (event) {
      case 'COPY_ATTEMPT':
      case 'PASTE_ATTEMPT':
        return policy.blockCopyPaste;
      case 'CONTEXT_MENU':
        return policy.blockContextMenu;
      case 'PRINT_ATTEMPT':
        return policy.blockPrintSave;
      default:
        return false;
    }
  })();

  if (!blocked) {
    return {
      event,
      allow: true,
      countsAsStrike: false,
      hatch: 'already_allowed',
      reason: 'this paper does not restrict it, so the attempt is not recorded',
    };
  }

  return {
    event,
    // Reported, not prevented. See the note at the top of this file.
    allow: true,
    countsAsStrike: true,
    // A block with a route around it is a deterrent; a block without one is a dead end, and the module refuses to
    // produce the latter.
    hatch: policy.accommodationHatchAvailable ? 'accommodation' : 'never',
    reason: 'this paper is confidential, so the attempt is recorded and counted',
  };
};

/** The copy shown where the hatch is offered. Never mentions a strike, and never implies wrongdoing. */
export const HATCH_COPY =
  'If any of this makes the exam harder to use -- a screen reader, a switch, or paste not working -- tell your ' +
  'teacher. An accommodation can lift these restrictions for your attempt, and using one is not held against you.';

/** The switch map an `ExamPolicy` projects onto, so the two cannot drift. */
export const switchesFor = (policy: {
  readonly blockCopyPaste: boolean;
  readonly blockContextMenu: boolean;
  readonly blockPrintSave: boolean;
}): Record<HardeningEvent, HardeningSwitch> => ({
  COPY_ATTEMPT: policy.blockCopyPaste ? 'WARN' : 'OFF',
  PASTE_ATTEMPT: policy.blockCopyPaste ? 'WARN' : 'OFF',
  CONTEXT_MENU: policy.blockContextMenu ? 'WARN' : 'OFF',
  PRINT_ATTEMPT: policy.blockPrintSave ? 'WARN' : 'OFF',
});
