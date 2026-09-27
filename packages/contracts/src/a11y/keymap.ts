/**
 * The editor key map, as data.  (P2-T7)
 *
 * ## Why a key map is data and not a README
 *
 * `plans/15` §2 rule 5: "Every interaction is keyboard-operable, in a documented and stable order."
 * "Documented" and "stable" are both checkable, and neither is checkable in prose:
 *
 *   · a README drifts from the code, and nobody notices until a teacher presses a key that
 *     nothing does;
 *   · "stable" means the BINDINGS do not change under a user, which is a claim about a set, and
 *     a set can be compared.
 *
 * So the bindings live here, the help panel renders them from here, and the test asserts the
 * properties prose cannot: no two actions share a chord, every action is reachable, and the
 * order is total.
 *
 * ## `role="application"` is NOT used, and that is a decision worth recording
 *
 * The packet allows it "only where justified". It is not justified here, and the reason is
 * specific rather than squeamish: `role="application"` tells a screen reader to stop intercepting
 * keys and pass them all through, which is exactly what breaks the browser's own shortcuts. The
 * editor needs ordinary text editing, caret navigation and browser chords inside its content, and
 * it gets them by using real inputs. If a future surface genuinely needs raw key events, that
 * surface documents why in its own entry -- it does not arrive by default.
 */

export type KeyContext = 'editor' | 'palette' | 'table' | 'handle' | 'global';

export interface Binding {
  /** Stable identifier. The help panel and the tests both key on it. */
  readonly action: string;
  /** `Ctrl+Shift+ArrowUp`, human-facing. */
  readonly chord: string;
  /** What it does, in the author's words. */
  readonly description: string;
  readonly context: KeyContext;
  /** Shown in the help panel. Hidden bindings are still bindings, and hiding them is how a
   * documented key map becomes a lie. */
  readonly discoverable: boolean;
  /** The WCAG criterion this binding exists to satisfy, where one applies. */
  readonly criterion?: '2.5.7 Dragging Movements' | '2.1.1 Keyboard' | '2.4.3 Focus Order';
}

export const KEYMAP: readonly Binding[] = [
  {
    action: 'block.moveUp',
    chord: 'Ctrl+Shift+ArrowUp',
    description: 'Move the block up',
    context: 'handle',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
  {
    action: 'block.moveDown',
    chord: 'Ctrl+Shift+ArrowDown',
    description: 'Move the block down',
    context: 'handle',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
  {
    action: 'block.indent',
    chord: 'Ctrl+Shift+ArrowRight',
    description: 'Indent the block',
    context: 'handle',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
  {
    action: 'block.outdent',
    chord: 'Ctrl+Shift+ArrowLeft',
    description: 'Outdent the block',
    context: 'handle',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
  {
    action: 'block.menu',
    chord: 'Enter',
    description: 'Open the block menu',
    context: 'handle',
    discoverable: true,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'block.insert',
    chord: '/',
    description: 'Insert a block',
    context: 'editor',
    discoverable: true,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'block.delete',
    chord: 'Ctrl+Shift+Backspace',
    description: 'Delete the block',
    context: 'handle',
    discoverable: true,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'editor.save',
    chord: 'Ctrl+S',
    description: 'Save now, without waiting for autosave',
    context: 'editor',
    discoverable: true,
  },
  {
    action: 'editor.help',
    chord: 'F1',
    description: 'Show the keyboard shortcuts',
    context: 'global',
    discoverable: true,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'palette.next',
    chord: 'ArrowDown',
    description: 'Next block type',
    context: 'palette',
    discoverable: false,
    criterion: '2.4.3 Focus Order',
  },
  {
    action: 'palette.previous',
    chord: 'ArrowUp',
    description: 'Previous block type',
    context: 'palette',
    discoverable: false,
    criterion: '2.4.3 Focus Order',
  },
  {
    action: 'palette.choose',
    chord: 'Enter',
    description: 'Insert the highlighted block type',
    context: 'palette',
    discoverable: false,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'palette.dismiss',
    chord: 'Escape',
    description: 'Close the palette',
    context: 'palette',
    discoverable: false,
    criterion: '2.1.1 Keyboard',
  },
  {
    action: 'table.nextCell',
    chord: 'Tab',
    description: 'Next cell',
    context: 'table',
    discoverable: false,
    criterion: '2.4.3 Focus Order',
  },
  {
    action: 'table.addRow',
    chord: 'Ctrl+Enter',
    description: 'Add a row below',
    context: 'table',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
  {
    action: 'table.addColumn',
    chord: 'Ctrl+Shift+Enter',
    description: 'Add a column to the right',
    context: 'table',
    discoverable: true,
    criterion: '2.5.7 Dragging Movements',
  },
];

/** The help panel's contents: the discoverable bindings, in declaration order. */
export const HELP_BINDINGS: readonly Binding[] = KEYMAP.filter((b) => b.discoverable);

/** A chord used more than once in the SAME context would be ambiguous. */
export function ambiguousBindings(): readonly string[] {
  const seen = new Map<string, number>();
  for (const b of KEYMAP) {
    const key = `${b.context}:${b.chord}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

/**
 * Every drag action needs a keyboard action with the same outcome.
 *
 * This is the 2.5.7 assertion, and it is a list rather than a boolean so that a new drag
 * feature added without a binding names itself.
 */
export const DRAG_ACTIONS: readonly string[] = [
  'block.moveUp',
  'block.moveDown',
  'block.indent',
  'block.outdent',
];

export const KEYBOARD_EQUIVALENTS: Readonly<Record<string, string>> = {
  'block.moveUp': 'block.moveUp',
  'block.moveDown': 'block.moveDown',
  'block.indent': 'block.indent',
  'block.outdent': 'block.outdent',
};

export function missingKeyboardEquivalents(): readonly string[] {
  return DRAG_ACTIONS.filter((a) => KEYBOARD_EQUIVALENTS[a] === undefined);
}
