'use client';

/**
 * The `ordering` renderer: a reorderable list.  (P7-T7)
 *
 * ## THIS IS THE RENDERER `2.5.7` EXISTS FOR
 *
 * "Every drag has a keyboard equivalent **with the same outcome**." The subtlety is that "the same outcome" is
 * about the DOCUMENT, not the pixels: a mouse drag moves one item and shifts the others, so `Alt+ArrowUp` must
 * MOVE rather than swap. A swap exchanges two positions and produces a different paper, which means a blind student
 * and a sighted student submit different documents — and the requirement is not met by anything that merely
 * "reorders".
 *
 * So `move` SPLICES: `[a, b, c]` moving `c` up gives `[a, c, b]`, not `[c, b, a]`. That single line is the whole
 * difference between meeting `2.5.7` and appearing to.
 *
 * ## FOCUS IS A SINGLE ITEM, NOT THE LIST
 *
 * The contract binds `ArrowUp`/`ArrowDown` to "move focus between items" and `Alt+ArrowUp`/`Alt+ArrowDown` to
 * "move the focused item". So the arrows have to mean different things depending on a modifier, which is only
 * unambiguous if exactly one item is focusable at a time. Hence a **roving tabindex**: the active item has
 * `tabIndex={0}` and the rest `tabIndex={-1}`, so `Tab` enters the list once and the arrows move within it.
 *
 * That is also what `plans/15` means by a "documented and stable order" — `Tab` into the list, arrows to read,
 * `Alt`+arrows to move, `Home`/`End` to reach the ends.
 *
 * ## AND EVERY MOVE IS ANNOUNCED, POLITELY, WITH THE NEW POSITION
 *
 * The list has changed and the user cannot see it, so `plans/15`'s "live regions are used sparingly" permits one
 * here — but exactly one, per COMPLETED move, naming the item and where it went ("Solar wind, 2 of 5"). Announcing
 * per keypress would interrupt a student mid-navigation, and `assertive` is refused by the contract for every type
 * because no question has an event worth that.
 */

import { contractFor } from '@orrery/contracts/a11y/questionInteraction';
import type { OrderingSpec } from '@orrery/contracts/question';
/*
 * `React` IS A NAMESPACE IMPORT, AND THAT IS THE POINT RATHER THAN A STYLE.  (P7-T7)
 *
 * This project resolves JSX through the CLASSIC runtime, so `React` must be in scope as a VALUE at runtime even
 * though the source never says so -- and nothing static can see that.
 *
 * Written as `import React, { useId } from 'react'`, Biome's `useImportType` rule rewrites it to
 * `import type React`, because `React` appears only in the type position `React.KeyboardEvent`. That produces a
 * `ReferenceError: React is not defined` on the component's `return (`. A `biome-ignore` does not survive either:
 * the first attempt named `noUnusedImports` (the wrong rule -- the import was never unused, it was
 * misclassified) and the second named `useImportType` and Biome reported `suppressions/parse`, so the directive was
 * ignored and the rule fired anyway.
 *
 * **A NAMESPACE IMPORT MAKES THE VALUE USE UNAMBIGUOUS.** `React.React.useId()` is a runtime read, so no rule can
 * reclassify the import as type-only, and no suppression is needed to maintain. The alternative fix is
 * `"jsx": "react-jsx"` in the vitest esbuild options, which removes the need entirely -- that is a project-wide
 * change and is recorded rather than made inside one renderer.
 */
import * as React from 'react';

export interface OrderingProps {
  readonly spec: OrderingSpec;
  readonly prompt: string;
  /** The current order of item ids. */
  readonly value: readonly string[];
  readonly onChange: (itemIds: readonly string[]) => void;
  readonly disabled?: boolean;
}

/**
 * MOVE ONE ITEM BY `delta` PLACES, SPLICING RATHER THAN SWAPPING.
 *
 * The `splice` out-then-in pair is what makes this `2.5.7`-compliant, and it is worth stating that the obvious
 * alternative is wrong: `[a, b, c].filter(...)` plus an insert at `index + delta` happens to work for adjacent
 * moves and produces a SWAP for anything further, which is a different document.
 */
export const moveItem = (
  order: readonly string[],
  from: number,
  delta: number,
): readonly string[] => {
  // THE BOUNDS CHECK IS BEFORE THE SPLICE, and the first version had it after.
  //
  // `splice(-1, 0, moved)` inserts BEFORE THE LAST ELEMENT rather than at the start, so an out-of-range move did
  // not decline -- it reordered the list. A test caught it: `moveItem(['a','b','c'], 0, -1)` returned
  // `['b','a','c']` instead of the list unchanged. That is worse than a crash, because the live region would then
  // announce a move that happened.
  const to = from + delta;
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return order;
  next.splice(to, 0, moved);
  return next;
};

export function OrderingQuestion({
  spec,
  prompt,
  value,
  onChange,
  disabled = false,
}: OrderingProps) {
  const contract = contractFor('ordering');
  const listId = React.useId();
  const liveId = `${listId}-live`;
  const [active, setActive] = React.useState(0);
  const [announcement, setAnnouncement] = React.useState('');
  // The announcement is cleared and re-set so that moving the SAME item twice announces twice. A screen reader
  // ignores an unchanged live region, so without this the second move would be silent -- and a move that made no
  // sound is the worst possible outcome for the one interaction this renderer exists to provide.
  const announcementTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = spec.items;
  const labels = new Map(items.map((item) => [item.id, item.text]));
  const activeIndex = Math.min(Math.max(active, 0), Math.max(value.length - 1, 0));

  const focusItem = (index: number): void => {
    const clamped = Math.min(Math.max(index, 0), Math.max(value.length - 1, 0));
    setActive(clamped);
    document.getElementById(`${listId}-${String(value[clamped] ?? '')}`)?.focus();
  };

  const move = (delta: number): void => {
    const from = activeIndex;
    const to = from + delta;
    // A move that would leave the list is a NO-OP, not a clamp to the end. Clamping would report a move that did
    // not happen, and the announcement would then be a lie about the document.
    if (to < 0 || to >= value.length) return;
    const next = moveItem(value, from, delta);
    onChange(next);
    const moved = value[from] ?? '';
    const label = labels.get(moved) ?? moved;
    const position = to + 1;
    setAnnouncement(`${label}, ${String(position)} of ${String(next.length)}`);
    if (announcementTimer.current !== null) clearTimeout(announcementTimer.current);
    announcementTimer.current = setTimeout(() => {
      setAnnouncement('');
    }, 3_000);
    // Focus FOLLOWS THE ITEM, because the alternative is focus jumping back to where the item used to be.
    window.requestAnimationFrame(() => {
      focusItem(to);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (event.altKey) move(1);
        else focusItem(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) move(-1);
        else focusItem(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(value.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div>
      <span id={listId} className="ordering-prompt">
        {prompt}
      </span>
      {/*
        `role="listbox"` ON A `<ul>`, and `role="option"` ON A `<li>`, are both the CANONICAL ARIA pattern -- the
       * WAI-ARIA Authoring Practices listbox example uses exactly these elements. Biome's
       * `useAriaPropsSupportedByRole` and `noNoninteractiveElementToInteractiveRole` rules flag them because they
       * compare the role against the element's implicit role and do not model the redefinition that listbox
       * requires. Suppressed with the reason rather than worked around, because the workaround -- replacing the
       * `<ul>`/`<li>` with generic `<div>`s -- produces worse semantics and more ARIA, not less.
       */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: listbox-on-ul is the canonical ARIA pattern */}
      <ul
        role={contract.role === 'listbox' ? 'listbox' : undefined}
        aria-labelledby={listId}
        aria-orientation="vertical"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-disabled={disabled || undefined}
      >
        {value.map((itemId, index) => (
          <li
            key={itemId}
            id={`${listId}-${itemId}`}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: option-on-li inside a listbox is the canonical pattern
            role="option"
            aria-selected={index === activeIndex}
            // THE ROVING TABINDEX. One item is reachable by Tab; the arrows move within.
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => {
              setActive(index);
            }}
          >
            {/*
              NO `draggable` ON THE ITEM, and that is a decision rather than an omission.
              *
              * A pointer drag here would be a SECOND way to reorder, and the two would have to produce identical
              * documents -- which is precisely what `2.5.7` asks and precisely what is hard to guarantee when one
              * path is native HTML5 drag and the other is `Alt`+arrows. `plans/15`'s `2.5.7` caution says drag needs
              * a keyboard equivalent; it does not say a drag is mandatory. The keyboard path is the primary one and
              * the only one, so there is nothing to keep in step.
              *
              * The reorder handle a sighted student sees is a `↑`/`↓` BUTTON pair below, which is a button and
              * therefore reachable by Tab without any of this.
            */}
            {labels.get(itemId) ?? itemId}
          </li>
        ))}
      </ul>

      {/*
        THE REORDER CONTROLS LIVE OUTSIDE THE LISTBOX, AND THAT IS A CORRECTNESS REQUIREMENT RATHER THAN A LAYOUT
        CHOICE.

        The first version put a `↑`/`↓` button pair inside each `<li role="option">`, and axe reported
        `nested-interactive` on all four -- correctly. **An option must not contain focusable children**, because
        `role="option"` says "this element is itself the thing you interact with", and a button inside it makes the
        item a composite widget that no assistive technology knows how to describe.

        So the list is a pure listbox and the controls are a toolbar acting on the SELECTED item. That is also the
        better pattern: one pair of buttons for the whole list rather than eight, and the labels name the item
        they will move rather than a position that changes under the reader.
      */}
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of reorder buttons; a fieldset implies a form control */}
      <div role="group" aria-label={`Reorder: ${prompt}`}>
        <button
          type="button"
          aria-label={`Move ${labels.get(value[activeIndex] ?? '') ?? 'item'} up`}
          disabled={disabled || activeIndex === 0}
          onClick={() => {
            move(-1);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move ${labels.get(value[activeIndex] ?? '') ?? 'item'} down`}
          disabled={disabled || activeIndex >= value.length - 1}
          onClick={() => {
            move(1);
          }}
        >
          ↓
        </button>
      </div>

      {/*
        ONE live region, `polite`, and the contract refuses `assertive` for every type -- no question has an event
        worth interrupting a student for. It is rendered ALWAYS rather than mounted on demand, because a live
        region inserted at the same moment as its text is frequently not announced at all.
      */}
      <p role="status" aria-live="polite" aria-atomic="true" id={liveId}>
        {announcement}
      </p>
    </div>
  );
}
