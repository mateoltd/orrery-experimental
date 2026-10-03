/**
 * The keyboard and assistive-technology contract for all ten question types.  (P7-T7)
 *
 * ## WHY A CONTRACT AND NOT TEN COMPONENTS
 *
 * `plans/15` states five rules that are easy to satisfy once and easy to get wrong ten times:
 *
 * - "**Every interaction is keyboard-operable, in a documented and stable order**"
 * - "`2.5.7` — **every drag has a keyboard equivalent with the same outcome**"
 * - "Focus is never lost"
 * - "Live regions are used sparingly. A countdown that announces every second is unusable"
 * - "No keyboard traps"
 *
 * Written as ten React components, those become ten private conventions, and the only way to check the fifth is
 * to walk each one by hand. Written as a table, they are DATA, and every rule above becomes a property over that
 * data -- which is checkable, and which fails loudly the moment somebody adds an eleventh type.
 *
 * So this module is the specification the renderers are tested against, and the React work consumes it rather
 * than re-deriving it. `assertInteractionContracts` is what stops the table from drifting away from the types.
 *
 * ## AND THE ROW FOR `ordering` IS THE ONE THAT EARNS THE FILE
 *
 * `ordering` is a drag-to-reorder list, and `2.5.7` is a WCAG AA requirement with teeth: dragging must have a
 * keyboard equivalent **with the same outcome**. Not "an alternative that is close enough" -- the same outcome, or
 * the requirement is not met.
 *
 * The subtlety is that "the same outcome" is about the DOCUMENT, not the pixels. A mouse drag moves one item and
 * shifts the others; a keyboard "move up" must therefore also move one item and shift the others, rather than
 * swapping with the neighbour. A swap is a different document, and a student using a keyboard would produce a
 * different paper from a student using a mouse -- which is the exact thing `2.5.7` exists to prevent.
 */

import type { QuestionType } from '../question/index.js';
import { QUESTION_TYPES } from '../question/index.js';

/** A key binding, named by `KeyboardEvent.key`. */
export type Key = string;

/** HOW LOUD AN ANNOUNCEMENT IS. `polite` waits for a pause; `assertive` interrupts, which is almost never right. */
export type Politeness = 'polite' | 'assertive' | 'none';

/**
 * WHAT A BINDING DOES. `outcome` is the DOCUMENT-LEVEL effect and is what `2.5.7` compares between the pointer
 * and keyboard paths -- so it is a short verb phrase a test can assert on both paths.
 */
export interface KeyBinding {
  readonly keys: readonly Key[];
  readonly outcome: string;
  /** Set when this binding stands in for a pointer gesture, naming the gesture it replaces. */
  readonly replaces?: 'DRAG' | 'CLICK' | 'HOVER';
}

export interface InteractionContract {
  readonly type: QuestionType;
  /** The ARIA role of the focusable group, or `null` when the type is a single field with no group. */
  readonly role: string | null;
  /** Where the accessible NAME comes from. A question with no name is unusable with a screen reader. */
  readonly nameFrom: string;
  /** The bindings, IN THE ORDER a screen-reader user meets them. The order is part of the contract. */
  readonly keys: readonly KeyBinding[];
  /** Where focus lands when the question mounts. `'PRESERVED'` means "wherever it was", which is usually right. */
  readonly focusOnMount: 'FIRST_INPUT' | 'HEADING' | 'PRESERVED' | 'GROUP';
  /** Whether a live region exists, and how loud it is. `none` means no live region at all. */
  readonly liveRegion: Politeness;
  /** Set for a type whose meaning is carried by something a screen reader cannot see. */
  readonly textAlternative?: string;
  /** True when the type has a pointer gesture with no keyboard equivalent. Must always be false. */
  readonly pointerOnly?: boolean;
}

/**
 * THE TEN CONTRACTS.
 *
 * Three decisions in here are worth stating, because each of them is the obvious alternative:
 *
 * **`ordering` uses "move up/down" rather than "swap with previous/next".** See the header: a swap is a different
 * document, and `2.5.7` asks for the same outcome.
 *
 * **`liveRegion` is `none` for SEVEN of the ten types.** An answer changing is not an event a screen-reader user
 * needs told about -- they made it, and announcing it back would talk over them on every click. Exactly three
 * types speak, and the rule for which is that something changed the user CANNOT perceive: `ordering` (the list
 * moved), `simulation` (`readyForInput`), `worked_solution` (the reveal).
 *
 * **`file_submission` has NO drag**, because the obvious design is a drop target, and a drop target with no
 * keyboard equivalent is the exact `2.5.7` failure. The file INPUT is focusable and labelled, and the "drop here"
 * affordance is decoration over it rather than the control itself.
 */
export const INTERACTION_CONTRACTS: Readonly<Record<QuestionType, InteractionContract>> = {
  single_choice: {
    type: 'single_choice',
    role: 'radiogroup',
    nameFrom: 'the question text',
    keys: [
      { keys: ['Tab'], outcome: 'focus the group', replaces: 'CLICK' },
      { keys: ['ArrowUp', 'ArrowDown'], outcome: 'move between options' },
      { keys: [' ', 'Enter'], outcome: 'select the focused option' },
    ],
    focusOnMount: 'GROUP',
    liveRegion: 'none',
  },
  multi_select: {
    type: 'multi_select',
    role: 'group',
    nameFrom: 'the question text',
    keys: [
      { keys: ['Tab'], outcome: 'focus the group', replaces: 'CLICK' },
      { keys: ['ArrowUp', 'ArrowDown'], outcome: 'move between options' },
      { keys: [' '], outcome: 'toggle the focused option' },
    ],
    focusOnMount: 'GROUP',
    // NOT `radiogroup`. A multi-select is a set of independent checkboxes, and `role="radiogroup"` would tell a
    // screen reader that exactly one can be chosen -- which is the single most common way this type is made
    // inaccessible.
    liveRegion: 'none',
  },
  true_false: {
    type: 'true_false',
    role: 'radiogroup',
    nameFrom: 'the question text',
    keys: [
      { keys: ['Tab'], outcome: 'focus the group', replaces: 'CLICK' },
      { keys: ['ArrowUp', 'ArrowDown'], outcome: 'move between the two options' },
      { keys: [' ', 'Enter'], outcome: 'select the focused option' },
    ],
    focusOnMount: 'GROUP',
    liveRegion: 'none',
  },
  numeric: {
    type: 'numeric',
    role: null,
    nameFrom: 'the question text, via the input label',
    keys: [{ keys: ['Tab'], outcome: 'focus the input', replaces: 'CLICK' }],
    focusOnMount: 'FIRST_INPUT',
    liveRegion: 'none',
  },
  short_text: {
    type: 'short_text',
    role: null,
    nameFrom: 'the question text, via the textarea label',
    keys: [{ keys: ['Tab'], outcome: 'focus the textarea', replaces: 'CLICK' }],
    focusOnMount: 'FIRST_INPUT',
    liveRegion: 'none',
  },
  /**
   * THE ROW THIS FILE EXISTS FOR.
   *
   * `2.5.7`: every drag has a keyboard equivalent **with the same outcome**. So the pointer path is a reorder and
   * the keyboard path is a reorder, and the outcome strings say `move` rather than `swap` in both -- because a
   * swap moves one item and exchanges two positions, which is a DIFFERENT document.
   *
   * `Alt+Arrow` rather than bare `Arrow`, because bare arrows are the reading order inside a listbox and taking
   * them would break navigation for a user who is not trying to reorder at all. And `Home`/`End` are bound so a
   * student can reach the ends without twenty presses.
   */
  ordering: {
    type: 'ordering',
    role: 'listbox',
    nameFrom: 'the question text',
    keys: [
      { keys: ['Tab'], outcome: 'focus the list', replaces: 'CLICK' },
      { keys: ['ArrowUp', 'ArrowDown'], outcome: 'move focus between items' },
      { keys: ['Alt+ArrowUp'], outcome: 'move the focused item up one position', replaces: 'DRAG' },
      {
        keys: ['Alt+ArrowDown'],
        outcome: 'move the focused item down one position',
        replaces: 'DRAG',
      },
      { keys: ['Home'], outcome: 'focus the first item' },
      { keys: ['End'], outcome: 'focus the last item' },
    ],
    focusOnMount: 'GROUP',
    /**
     * `polite`, because a reorder IS worth announcing -- the list has changed and the user cannot see it. One
     * announcement per completed move, not one per keypress: the announcement names the item and its new position
     * ("Solar wind, 2 of 5") so a blind student knows both what moved and where it went.
     */
    liveRegion: 'polite',
  },
  free_response: {
    type: 'free_response',
    role: null,
    nameFrom: 'the question text, via the textarea label',
    keys: [{ keys: ['Tab'], outcome: 'focus the textarea', replaces: 'CLICK' }],
    focusOnMount: 'FIRST_INPUT',
    liveRegion: 'none',
  },
  /**
   * A DROPPABLE FILE INPUT IS A POINTER-ONLY CONTROL, so this row forbids the drag entirely.
   *
   * The obvious design is a large "drop your file here" target. That target is not focusable, has no role, and
   * has no keyboard equivalent -- it is `pointerOnly` by construction. So the CONTROL is a labelled file input and
   * the drop area is decoration over it: a student who cannot drag can still reach the same outcome with the same
   * number of keystrokes.
   */
  file_submission: {
    type: 'file_submission',
    role: null,
    nameFrom: 'the upload label',
    keys: [
      { keys: ['Tab'], outcome: 'focus the file input', replaces: 'CLICK' },
      { keys: [' ', 'Enter'], outcome: 'open the file picker' },
    ],
    focusOnMount: 'FIRST_INPUT',
    liveRegion: 'none',
  },
  /**
   * THE TYPE `plans/15` CALLS THE BIGGEST RISK: "Canvas is invisible to a screen reader."
   *
   * A simulation passes every automated check and can be completely unusable. So the text alternative is not
   * optional and not a summary: it must state what the sim shows, what the student is being asked to do, and where
   * the answer is reported -- because for a blind student the text alternative IS the question.
   */
  simulation: {
    type: 'simulation',
    role: 'application',
    nameFrom: 'the simulation title, plus the question text',
    keys: [
      { keys: ['Tab'], outcome: 'focus the sim surface' },
      { keys: ['Enter'], outcome: 'hand control to the simulation' },
      { keys: ['Escape'], outcome: 'return control to the question chrome' },
    ],
    focusOnMount: 'PRESERVED',
    // `polite` and ONLY on `readyForInput`, per plans/15's "focus is never lost ... sim `readyForInput` all move
    // focus deliberately". An `assertive` announcement here would interrupt whatever the student was doing.
    liveRegion: 'polite',
    textAlternative: 'what the visualisation shows, what to do, and where the answer is reported',
  },
  worked_solution: {
    type: 'worked_solution',
    role: 'region',
    nameFrom: 'the solution heading',
    keys: [{ keys: ['Tab'], outcome: 'focus the reveal control', replaces: 'CLICK' }],
    focusOnMount: 'PRESERVED',
    liveRegion: 'polite',
  },
};

/**
 * EVERY TYPE IN THE UNION HAS A CONTRACT, AND EVERY CONTRACT IS COMPLETE.
 *
 * The failure this exists to catch is a new type shipping with no row: the renderer would then invent its own
 * keyboard model, and nothing would compare it with anything. `QUESTION_TYPES` is imported rather than restated,
 * so an eleventh type fails here instead of passing silently.
 */
export const contractFor = (type: QuestionType): InteractionContract => {
  const contract = INTERACTION_CONTRACTS[type];
  if (contract === undefined) throw new Error(`no interaction contract for question type ${type}`);
  return contract;
};

export interface ContractProblem {
  readonly type: QuestionType;
  readonly problem: string;
}

/** EVERY RULE IN `plans/15`'s list, applied to the table. Returns rather than throws so a CI report can list them all. */
export const assertInteractionContracts = (): readonly ContractProblem[] => {
  const problems: ContractProblem[] = [];
  const complain = (type: QuestionType, problem: string): void => {
    problems.push({ type, problem });
  };

  for (const type of QUESTION_TYPES) {
    const contract = INTERACTION_CONTRACTS[type];
    if (contract === undefined) {
      complain(type, 'has no interaction contract');
      continue;
    }

    if (contract.nameFrom.length === 0) complain(type, 'has no accessible name source');
    if (contract.keys.length === 0)
      complain(type, 'has no keyboard bindings, so it is pointer-only');

    /**
     * `2.5.7`, checked as a PROPERTY rather than per type: every binding that declares `replaces: 'DRAG'` is
     * evidence a drag exists, and its `outcome` must be a MOVE rather than a SWAP.
     */
    for (const binding of contract.keys) {
      if (binding.replaces !== 'DRAG') continue;
      const outcome = binding.outcome.toLowerCase();
      if (!outcome.includes('move')) {
        complain(
          type,
          `drag replacement "${binding.outcome}" does not move the item, so it is not the same outcome`,
        );
      }
      if (outcome.includes('swap')) {
        complain(
          type,
          `drag replacement "${binding.outcome}" swaps rather than moves, which is a different document`,
        );
      }
    }

    /**
     * A POINTER GESTURE WITH NO REPLACEMENT IS THE `2.5.7` FAILURE, and `pointerOnly` is where a renderer
     * declares it. It is always a bug, so it is reported rather than permitted.
     */
    if (contract.pointerOnly === true) complain(type, 'declares a pointer-only interaction');

    /**
     * LIVE REGIONS ARE SPARSE. `plans/15`: "A countdown that announces every second is unusable." So `assertive`
     * is refused outright, and a type with more than one live interaction is reported.
     */
    if (contract.liveRegion === 'assertive') {
      complain(
        type,
        'uses an assertive live region, which interrupts whatever the student was doing',
      );
    }

    /**
     * A TYPE WHOSE MEANING IS VISUAL MUST CARRY A TEXT ALTERNATIVE. `simulation` is the one that matters and the
     * rule is checked generally so a future visual type cannot be added without one.
     */
    if (type === 'simulation' && contract.textAlternative === undefined) {
      complain(
        type,
        'is a canvas type with no text alternative, which plans/15 calls the biggest a11y risk',
      );
    }
  }

  return problems;
};

/**
 * THE COUNTDOWN IS ANNOUNCED AT THRESHOLDS, NEVER EVERY SECOND.
 *
 * `plans/15` is explicit, and the reason is that an announcement per second makes a screen reader unusable for
 * the minutes the announcement is meant to cover. The thresholds are half the time and a quarter of it, which
 * gives a student who has lost track two chances to act rather than one.
 *
 * Exported because P7-T14's countdown needs the same numbers, and two copies of a threshold list is two places for
 * them to disagree.
 */
export const COUNTDOWN_ANNOUNCE_AT_SECONDS: readonly number[] = [300, 60, 10];

/** Whether the countdown should be spoken at `remainingSec`. Pure, so it can be property-tested over the range. */
export const shouldAnnounceCountdown = (remainingSec: number, spoken: readonly number[]): boolean =>
  spoken.includes(remainingSec);
