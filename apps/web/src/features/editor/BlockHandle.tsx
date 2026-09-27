'use client';

/**
 * The block handle.  (P2-T3b)
 *
 * ## The blocker this resolves
 *
 * The packet requires BOTH "a 500-block fixture... must stay responsive" AND "**No keyboard trap
 * anywhere.** Every block handle is a real focusable control."
 *
 * Those look like a conflict, and under JavaScript virtualisation they ARE one. Virtualisation
 * unmounts off-screen DOM to save work, and **you cannot focus a control that is not mounted** —
 * so a virtualised handle is not a focusable control, and the two requirements cannot both hold.
 * There is also no first-party virtualisation extension
 * (`@tiptap-pro/extension-virtual-scroll` does not exist), so it would have been hand-built, and
 * the hand-built version has to choose which requirement to break.
 *
 * ## The resolution: do not unmount
 *
 * `content-visibility: auto` with `contain-intrinsic-size` gets the rendering saving **without
 * removing the element from the document**. The browser skips layout, paint and compositing for
 * off-screen subtrees; the DOM node stays, the button stays focusable, and the browser scrolls
 * to it when it receives focus — which is exactly the behaviour a keyboard user expects and
 * exactly what a virtualised list cannot give them.
 *
 * So the performance requirement is met by the rendering pipeline rather than by the DOM, and the
 * accessibility requirement is met by not doing the thing that would have broken it. Both stated
 * requirements survive, which is the only acceptable outcome — and it is why this is a CSS
 * decision and not an architecture decision.
 *
 * ## Degradation, stated rather than assumed
 *
 * A browser without `content-visibility` renders every block. That is SLOWER and CORRECT, which
 * is the right way round: the fallback loses performance, never function. The `@supports` block
 * below exists only to set `contain-intrinsic-size`, and it is harmless where unsupported.
 *
 * ## What the tests can and cannot prove
 *
 * jsdom has no layout engine, so these tests prove that all 500 handles are real `<button>`
 * elements, that every one has an accessible name, that each is focusable, and that the
 * virtualisation mechanism is the non-unmounting one. They **cannot** prove responsiveness, and
 * the perf claim has to be settled by a real browser. Saying so is part of the test suite, not a
 * caveat bolted on afterwards.
 */

import { useCallback, useRef } from 'react';

/**
 * The virtualisation CSS.
 *
 * Exported as a string so a test can assert the mechanism is the non-unmounting one. A test that
 * cannot see the CSS cannot tell `content-visibility` from a JS virtualiser, and that difference
 * is the entire blocker.
 */
export const VIRTUALISATION_CSS = `
.orrery-doc > * {
  content-visibility: auto;
  /* Without a size hint the browser has nothing to reserve, and scrolling judders as it
     discovers each block. 600px is roughly a paragraph plus a figure; wrong by a little is
     fine, wrong by nothing is a visible jump. */
  contain-intrinsic-size: auto 600px;
}
@supports not (content-visibility: auto) {
  .orrery-doc > * { contain: none; }
}
`;

export type HandleAction = 'move-up' | 'move-down' | 'indent' | 'outdent' | 'menu';

export interface BlockHandleProps {
  readonly blockId: string;
  readonly position: number;
  readonly total: number;
  /** The block's type, for the accessible name. "Move paragraph 3 of 40" beats "drag handle". */
  readonly blockType: string;
  /** A PROPERTY, not a method signature: `readonly` is not valid on a method declaration. */
  readonly onAction: (action: HandleAction) => void;
  readonly onGrab?: () => void;
}

const LABEL: Readonly<Record<HandleAction, string>> = {
  'move-up': 'Move up',
  'move-down': 'Move down',
  indent: 'Indent',
  outdent: 'Outdent',
  menu: 'Block menu',
};

/** The document this renders into, so the CSS is applied by the thing that needs it. */
export const VIRTUALISATION_CLASS = 'orrery-doc';

/**
 * One handle per block.
 *
 * A real `<button>`, not a div with a role and a tabindex. The packet's phrase is "a real
 * focusable control" and a reimplemented one is where the keyboard traps come from: `role="button"`
 * does not give you Enter and Space handling, and a `div` with `tabIndex={0}` does not give you
 * a disabled state, an accessible name that survives translation, or a focus ring.
 */
export function BlockHandle(props: BlockHandleProps) {
  const ref = useRef<HTMLButtonElement>(null);

  const act = useCallback(
    (action: HandleAction) => () => {
      // Boundaries are refused here rather than allowed and ignored, so the control's state is
      // truthful: a Move up button on the first block is disabled, not a button that does
      // nothing when pressed. A control that lies about availability is worse than no control.
      if (action === 'move-up' && props.position === 0) return;
      if (action === 'move-down' && props.position === props.total - 1) return;
      props.onAction(action);
    },
    [props],
  );

  // Ctrl+Shift+Arrow moves the block. Bound on the handle rather than globally so the shortcut
  // acts on the block the user is already pointing at, and so it cannot fire while the caret is
  // in a text field where Ctrl+Shift+Up means something else entirely.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const map: Record<string, HandleAction> = {
        ArrowUp: 'move-up',
        ArrowDown: 'move-down',
        ArrowRight: 'indent',
        ArrowLeft: 'outdent',
      };
      const action = map[e.key];
      if (action === undefined) return;
      e.preventDefault();
      act(action)();
      // Focus stays on the handle, and specifically on the SAME handle: after a move the block is
      // elsewhere in the document, so a handle that re-rendered at a new index would drop focus
      // to the body and strand a keyboard user at the top of the page. This is the single most
      // common way a "keyboard-navigable" editor loses the keyboard user.
      ref.current?.focus();
    },
    [act],
  );

  const at = `${props.position + 1} of ${props.total}`;
  return (
    <div className="orrery-handle" data-block-id={props.blockId}>
      <button
        ref={ref}
        type="button"
        className="orrery-handle-grip"
        // The accessible name names the BLOCK, not the control. "Drag handle" on forty rows
        // tells a screen-reader user nothing about which row they are on.
        aria-label={`${props.blockType}, block ${at}. Press Enter for the block menu.`}
        aria-describedby={`orrery-handle-help-${props.blockId}`}
        onKeyDown={onKeyDown}
        onClick={() => props.onAction('menu')}
        onPointerDown={() => props.onGrab?.()}
      >
        <span aria-hidden="true">⠿</span>
      </button>

      {/* Visually hidden, present for assistive tech: the shortcut list, once, per block. */}
      <p id={`orrery-handle-help-${props.blockId}`} className="visually-hidden">
        {`Control Shift Up and Down move this block. Control Shift Right and Left indent and outdent it. ${LABEL['move-up']} is ${props.position === 0 ? 'unavailable at the top' : 'available'}.`}
      </p>

      <span className="orrery-handle-actions">
        <button
          type="button"
          disabled={props.position === 0}
          aria-label={`${LABEL['move-up']}: ${props.blockType} block ${at}`}
          onClick={act('move-up')}
        >
          <span aria-hidden="true">↑</span>
        </button>
        <button
          type="button"
          disabled={props.position === props.total - 1}
          aria-label={`${LABEL['move-down']}: ${props.blockType} block ${at}`}
          onClick={act('move-down')}
        >
          <span aria-hidden="true">↓</span>
        </button>
      </span>
    </div>
  );
}

/** 2.5.7 keyboard alternatives to drag, applied to an ordered list of block ids. */
export function moveBlock(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(clamped, 0, moved);
  return next;
}
