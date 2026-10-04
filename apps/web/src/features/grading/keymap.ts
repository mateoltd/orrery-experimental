/**
 * The grading workspace's key map, as data, and the one function that reads a key press.  (P9-T2)
 *
 * ## "KEYBOARD-FIRST" HAS TWO HALVES AND THE SECOND IS THE ONE THAT GETS FORGOTTEN
 *
 * `plans/07` §5.1 lists the bindings: `J`/`K` navigate, `1`-`9` quick-score, `Enter` save and advance, `E` excuse,
 * `F` flag, `R` open feedback. Every one of those is a key a teacher also TYPES. So the first half is that the keys
 * work, and the second is that they do not fire while a comment is being written -- a marker who types "Fine" into
 * the feedback box and has the response flagged, the question excused and the cursor moved has been taught not to
 * trust the screen.
 *
 * So every binding has a SCOPE, and the scope is checked against where focus is, in one place (`resolveKey`):
 *
 *  · `ANYWHERE` -- chorded. Cannot be produced by typing text, so it is safe inside a field. This is how a teacher
 *    moves between responses and saves "without leaving the answer field".
 *  · `OUTSIDE_TEXT_ENTRY` -- a bare letter or digit. Dead while focus is in anything that accepts text.
 *  · `OUTSIDE_CONTROLS` -- bare `Enter`. Dead on a button, a checkbox, a radio or a link as well, because there
 *    `Enter` already belongs to the control and stealing it turns "activate this button" into "save this mark".
 *
 * ## THE CHORDS ARE CHOSEN AROUND THE BROWSER, AND THE LIST OF WHAT WAS AVOIDED IS DATA
 *
 * `plans/09` §6.1 is blunt about a product claiming to intercept a key the browser owns. The same class of
 * dishonesty is available here: `Ctrl+J`, `Ctrl+K`, `Ctrl+E`, `Ctrl+F` and `Ctrl+R` are downloads, search, search,
 * find and RELOAD, and a "shortcut" on any of them either does nothing or works in one browser and reloads the page
 * -- and the draft with it -- in another. `RESERVED_CHORDS` records what is deliberately not bound and who owns it,
 * and a test asserts no binding is on it and that `resolveKey` ignores every one.
 *
 * That list is assembled from the documented defaults of Chrome, Firefox, Edge and Safari. It is NOT derived from an
 * automated run against real browsers, and it does not cover extensions or assistive technology.
 *
 * ## AND A SHORTCUT IS NEVER THE ONLY WAY
 *
 * A screen reader in browse mode consumes bare letters before the page sees them (`K` is "next link", `1`-`6` are
 * heading levels), so for those users the bare-key half of this table does not exist. `plans/15` rule 5 requires
 * every interaction to be keyboard-operable, which a shortcut alone does not achieve. `EQUIVALENT_CONTROL` therefore
 * names, for every action, the real control that produces the SAME OUTCOME, and the workspace test presses the key
 * and the control and compares what happened.
 *
 * ## `role="application"` IS NOT USED
 *
 * It would hand every key to the page -- and take away the browser's and the screen reader's own, which is exactly
 * what `@orrery/contracts/a11y/keymap` records refusing for the editor. The workspace is ordinary controls plus a
 * `keydown` listener that declines most keys.
 */

export type GradingAction =
  | 'response.next'
  | 'response.previous'
  | 'mark.saveAndNext'
  /** A digit: the band in that position, or that many marks on a question with no rubric. */
  | 'mark.digit'
  | 'mark.excuse'
  | 'mark.flag'
  | 'feedback.open'
  | 'help.open';

export type KeyScope = 'ANYWHERE' | 'OUTSIDE_TEXT_ENTRY' | 'OUTSIDE_CONTROLS';

export interface GradingBinding {
  readonly action: GradingAction;
  /** Human-facing, and the exact string `chordOf` produces for the key press. `0-9` is the one range. */
  readonly chord: string;
  readonly scope: KeyScope;
  /** What it does, shown in the shortcuts list. */
  readonly description: string;
}

/**
 * THE BINDINGS. Every one is shown in the shortcuts list: a hidden binding is how a documented key map becomes a lie.
 */
export const GRADING_KEYMAP: readonly GradingBinding[] = [
  {
    action: 'response.next',
    chord: 'J',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description: 'Next response',
  },
  {
    action: 'response.previous',
    chord: 'K',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description: 'Previous response',
  },
  {
    action: 'response.next',
    chord: 'Alt+J',
    scope: 'ANYWHERE',
    description: 'Next response, from inside a field. The draft is kept.',
  },
  {
    action: 'response.previous',
    chord: 'Alt+K',
    scope: 'ANYWHERE',
    description: 'Previous response, from inside a field. The draft is kept.',
  },
  {
    action: 'mark.digit',
    chord: '0-9',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description:
      'Apply the rubric band with that number. On a question with no rubric, give that many marks.',
  },
  {
    action: 'mark.saveAndNext',
    chord: 'Enter',
    scope: 'OUTSIDE_CONTROLS',
    description: 'Save the mark and go to the next response awaiting a mark',
  },
  {
    action: 'mark.saveAndNext',
    chord: 'Ctrl+Enter',
    scope: 'ANYWHERE',
    description: 'Save the mark and go on, from inside a field',
  },
  {
    action: 'mark.saveAndNext',
    chord: 'Meta+Enter',
    scope: 'ANYWHERE',
    description: 'Save the mark and go on, from inside a field (Command+Enter on a Mac)',
  },
  {
    action: 'mark.excuse',
    chord: 'E',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description:
      'Excuse this response, or undo that. A reason is asked for before it can be saved.',
  },
  {
    action: 'mark.flag',
    chord: 'F',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description: 'Flag this response for follow-up, or remove the flag',
  },
  {
    action: 'feedback.open',
    chord: 'R',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description: 'Move to the feedback field',
  },
  {
    action: 'help.open',
    chord: '?',
    scope: 'OUTSIDE_TEXT_ENTRY',
    description: 'Show these shortcuts',
  },
];

/**
 * THE CONTROL THAT DOES THE SAME THING, by accessible name.
 *
 * Declared here so the test that presses the key and the test that uses the control are checking against one list,
 * and so an action added to the map without a control fails a test rather than shipping keyboard-shortcut-only.
 */
export const EQUIVALENT_CONTROL: Readonly<Record<GradingAction, string>> = {
  'response.next': 'Next response',
  'response.previous': 'Previous response',
  'mark.saveAndNext': 'Save mark and go to the next response',
  'mark.digit': 'Rubric band',
  'mark.excuse': 'Excuse this response',
  'mark.flag': 'Flag this response for follow-up',
  'feedback.open': 'Feedback to the student',
  'help.open': 'Keyboard shortcuts',
};

/**
 * CHORDS THIS WORKSPACE WILL NOT BIND, and whose they are.
 *
 * Not exhaustive of everything a browser does. It is the set a grading shortcut would plausibly be put on -- the
 * `Ctrl` and `Alt` forms of the plan's own letters, the digit rows, and the keys that navigate or reload.
 */
export const RESERVED_CHORDS: readonly { readonly chord: string; readonly ownedBy: string }[] = [
  { chord: 'Ctrl+R', ownedBy: 'reload -- which discards anything not yet kept' },
  { chord: 'F5', ownedBy: 'reload' },
  { chord: 'Ctrl+F', ownedBy: 'find in page' },
  { chord: 'Ctrl+J', ownedBy: 'downloads (Chrome, Firefox, Edge)' },
  { chord: 'Ctrl+K', ownedBy: 'search / address bar' },
  { chord: 'Ctrl+E', ownedBy: 'search / address bar' },
  { chord: 'Ctrl+L', ownedBy: 'address bar' },
  { chord: 'Ctrl+D', ownedBy: 'bookmark this page' },
  { chord: 'Ctrl+P', ownedBy: 'print' },
  { chord: 'Ctrl+S', ownedBy: 'save page' },
  { chord: 'Ctrl+W', ownedBy: 'close tab; not interceptable' },
  { chord: 'Ctrl+T', ownedBy: 'new tab; not interceptable' },
  { chord: 'Ctrl+N', ownedBy: 'new window; not interceptable' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((digit) => [
    { chord: `Ctrl+${String(digit)}`, ownedBy: 'switch tab' },
    { chord: `Alt+${String(digit)}`, ownedBy: 'switch tab (Linux)' },
    { chord: `Meta+${String(digit)}`, ownedBy: 'switch tab (macOS)' },
  ]),
  { chord: 'Alt+ArrowLeft', ownedBy: 'history back -- leaves the page' },
  { chord: 'Alt+ArrowRight', ownedBy: 'history forward' },
  { chord: 'Alt+F', ownedBy: 'browser menu (Chrome, Firefox, Edge on Windows and Linux)' },
  { chord: 'Alt+E', ownedBy: 'browser menu (Chrome, Firefox on Windows and Linux)' },
  { chord: 'Alt+D', ownedBy: 'address bar' },
  { chord: 'Meta+R', ownedBy: 'reload (macOS)' },
  { chord: 'Meta+F', ownedBy: 'find in page (macOS)' },
  { chord: 'Meta+W', ownedBy: 'close tab (macOS)' },
  { chord: 'Escape', ownedBy: 'leaves fullscreen, cancels an IME composition; plans/09 §6.1' },
  { chord: 'Tab', ownedBy: 'focus order. Binding it is a keyboard trap' },
  { chord: 'Shift+Tab', ownedBy: 'focus order' },
  { chord: 'Space', ownedBy: 'scrolls the page, activates the focused control' },
  { chord: 'F6', ownedBy: 'moves between browser panes' },
];

/** The parts of a `KeyboardEvent` this reads. A plain object, so the resolver is testable without a DOM. */
export interface KeyPress {
  readonly key: string;
  /** The physical key. Used for `Alt` chords, where `key` is whatever the OS layer types. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  /** Auto-repeat from a held key. */
  readonly repeat: boolean;
  /** An IME composition is in progress, so the key belongs to it. */
  readonly isComposing: boolean;
}

/**
 * THE CHORD A KEY PRESS IS, as the string the key map uses.
 *
 * ## `Alt` CHORDS ARE READ FROM `code`, NOT `key`
 *
 * On macOS `Option+J` produces `key: '∆'`, and on several Windows layouts `Alt` combinations produce a dead key.
 * Matching `key` would make `Alt+J` work on one operating system and silently not on another. `code` is the physical
 * key, which is the same everywhere.
 *
 * ## `Shift` IS IGNORED FOR A PRINTABLE KEY AND KEPT FOR EVERYTHING ELSE
 *
 * `?` needs `Shift` on a US keyboard and does not on others, and `J` arrives upper-case under Caps Lock with no
 * `Shift` at all -- so for a printable key the character is the chord. `Shift+Enter` and `Shift+Tab` are different
 * chords from `Enter` and `Tab` and stay different.
 */
export const chordOf = (press: KeyPress): string => {
  const printable = press.key.length === 1;
  let name: string;
  if (press.altKey && /^Key[A-Z]$/.test(press.code)) name = press.code.slice(3);
  else if (press.altKey && /^Digit\d$/.test(press.code)) name = press.code.slice(5);
  else if (press.key === ' ') name = 'Space';
  else name = printable ? press.key.toUpperCase() : press.key;

  const modifiers: string[] = [];
  if (press.ctrlKey) modifiers.push('Ctrl');
  if (press.altKey) modifiers.push('Alt');
  if (press.metaKey) modifiers.push('Meta');
  if (press.shiftKey && (!printable || press.ctrlKey || press.altKey || press.metaKey)) {
    modifiers.push('Shift');
  }
  return [...modifiers, name].join('+');
};

/**
 * WHERE FOCUS IS, as far as a shortcut is concerned.
 *
 *  · `TEXT_ENTRY` -- typing goes somewhere. Bare keys are the user's text.
 *  · `KEYS_OFF` -- inside a region that has opted out (the rubric editor, the shortcuts list). Its buttons are not
 *    text fields, but `E` on "Move band up" excusing the response underneath is the same surprise.
 *  · `CONTROL` -- a button, checkbox, radio, link or summary. Letters and digits are free; `Enter` is the control's.
 *  · `NONE` -- a pane, a heading, the page.
 */
export type FocusKind = 'TEXT_ENTRY' | 'KEYS_OFF' | 'CONTROL' | 'NONE';

/** Marks a subtree whose controls must not trigger bare-key shortcuts. */
export const KEYS_OFF_ATTRIBUTE = 'data-grading-keys';

/** `<input>` types that are operated rather than typed into. Everything else on an `<input>` takes text. */
const OPERATED_INPUT_TYPES: readonly string[] = [
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'file',
  'image',
  'range',
  'color',
];

export const focusKindOf = (element: Element | null): FocusKind => {
  if (element === null) return 'NONE';
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return 'TEXT_ENTRY';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (!OPERATED_INPUT_TYPES.includes(type)) return 'TEXT_ENTRY';
  }
  const editable = element.closest('[contenteditable]');
  if (editable !== null && editable.getAttribute('contenteditable') !== 'false') {
    return 'TEXT_ENTRY';
  }
  if (element.closest(`[${KEYS_OFF_ATTRIBUTE}="off"]`) !== null) return 'KEYS_OFF';
  if (tag === 'input' || tag === 'button' || tag === 'summary' || tag === 'a') return 'CONTROL';
  return 'NONE';
};

export type ResolvedKey =
  | { readonly action: Exclude<GradingAction, 'mark.digit'> }
  | { readonly action: 'mark.digit'; readonly digit: number };

const allowedIn = (scope: KeyScope, focus: FocusKind): boolean => {
  switch (scope) {
    case 'ANYWHERE':
      return true;
    case 'OUTSIDE_TEXT_ENTRY':
      return focus === 'NONE' || focus === 'CONTROL';
    case 'OUTSIDE_CONTROLS':
      return focus === 'NONE';
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
};

/**
 * WHAT A KEY PRESS MEANS HERE, OR `null` -- AND `null` IS THE COMMON ANSWER.
 *
 * `null` means the workspace does nothing and, critically, does not `preventDefault`: the key goes to the field, the
 * control or the browser exactly as though this listener did not exist.
 *
 * Auto-repeat is ignored for every action. A held `Enter` would otherwise save and advance through a whole attempt at
 * the keyboard's repeat rate, saving whatever marks happened to be in the drafts.
 */
export const resolveKey = (press: KeyPress, focus: FocusKind): ResolvedKey | null => {
  if (press.isComposing || press.repeat) return null;

  const chord = chordOf(press);

  if (/^\d$/.test(chord)) {
    const binding = GRADING_KEYMAP.find((candidate) => candidate.action === 'mark.digit');
    return binding !== undefined && allowedIn(binding.scope, focus)
      ? { action: 'mark.digit', digit: Number(chord) }
      : null;
  }

  for (const binding of GRADING_KEYMAP) {
    if (binding.action === 'mark.digit' || binding.chord !== chord) continue;
    return allowedIn(binding.scope, focus) ? { action: binding.action } : null;
  }
  return null;
};

/** A chord bound twice would mean one key press with two meanings. */
export const ambiguousBindings = (): readonly string[] => {
  const seen = new Map<string, number>();
  for (const binding of GRADING_KEYMAP) {
    seen.set(binding.chord, (seen.get(binding.chord) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([chord]) => chord);
};

/** Every chord the map can respond to, with the digit range expanded. */
export const boundChords = (): readonly string[] =>
  GRADING_KEYMAP.flatMap((binding) =>
    binding.chord === '0-9' ? ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] : [binding.chord],
  );
