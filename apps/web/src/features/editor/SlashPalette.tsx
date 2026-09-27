'use client';

/**
 * The slash-command palette.  (P2-T3c)
 *
 * ## The one thing that must not go wrong
 *
 * **Focus stays in the text input, always.** The active option is communicated with
 * `aria-activedescendant`, which is how the ARIA combobox pattern is meant to work: DOM focus
 * never leaves the input, and the focus ring never jumps into a list the author did not ask to
 * be in.
 *
 * The tempting alternative is to move real focus onto each option as the arrow keys are pressed.
 * That is also the single most common way a command palette becomes a keyboard trap: the author
 * arrows down into a list, cannot get back to the document because the list swallows Escape, and
 * reloads. So `aria-activedescendant` here is not a detail — it is the whole design, and the test
 * asserts focus never leaves the input while arrowing through every entry.
 *
 * ## Nothing is inserted on an empty query
 *
 * Typing `/` and pressing Enter must not create a heading. Somebody who types a slash to write
 * `3/4`, or starts a line with one, would silently get a block. The list is browsable with an
 * empty query, but Enter does nothing until something is actually active — and Escape restores
 * the original text rather than leaving a stray `/` behind.
 *
 * ## The live region announces the count, not the change
 *
 * Announcing "Table selected" on every keystroke is noise. Announcing "16 blocks" and then
 * "3 blocks" tells a screen-reader user whether the filter is working, which is the thing they
 * are actually trying to find out.
 */

import type { BlockType } from '@orrery/contracts/blocks';
import {
  PALETTE,
  type PaletteEntry,
  paletteQuery,
  searchPalette,
  shouldOpenPalette,
  stripCommand,
} from '@orrery/contracts/editor/palette';
import { useCallback, useId, useMemo, useRef, useState } from 'react';

export interface SlashPaletteProps {
  readonly value: string;
  readonly caret: number;
  /** Properties, not method signatures: `readonly` is not valid on a method declaration. */
  readonly onChange: (next: { value: string; caret: number }) => void;
  readonly onInsert: (type: BlockType) => void;
  /** Called after Escape, so the host can re-render without the palette. */
  readonly onClose: () => void;
}

export function SlashPalette(props: SlashPaletteProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);

  /**
   * Open state DERIVED from the text, plus a "dismissed" flag.
   *
   * The first version kept `open` and `query` in state, set by a `detect()` called from
   * `onChange` — so a palette whose host rendered with `value="hello /"` never opened at all,
   * and a paste ending in `/` was missed entirely. Deriving both from the text makes them
   * impossible to desync: the palette is open exactly when the text says it should be, and the
   * only extra state is whether the author has explicitly dismissed it.
   */
  const [dismissed, setDismissed] = useState(false);
  const open = shouldOpenPalette(props.value, props.caret) && !dismissed;
  // `paletteQuery` rather than slicing at the call site: the query and the open state must agree
  // about where the line starts, and computing them two different ways is how a palette ends up
  // filtering on the wrong text.
  const query = open ? (paletteQuery(props.value, props.caret) ?? '') : '';

  const results = useMemo(() => (open ? searchPalette(query) : []), [open, query]);

  const choose = useCallback(
    (entry: PaletteEntry) => {
      // An empty query is a BROWSE, not a selection. Inserting the first entry because the author
      // pressed Enter on a bare slash is how you insert a heading into somebody's arithmetic.
      if (query.trim() === '') return;
      props.onChange({
        value: stripCommand(props.value, props.caret, query.length),
        caret: props.caret - query.length - 1,
      });
      props.onInsert(entry.type);
      setDismissed(true);
      // Focus deliberately left where the author was typing. After inserting, the caret is
      // inside the new block and the palette is gone; pulling focus to a toolbar would be the
      // trap all over again.
    },
    [props, query],
  );

  const close = useCallback(() => {
    // Escape puts the text back. Leaving a stray `/` in the document is the kind of small
    // corruption that survives review and annoys a teacher for a year.
    props.onChange({
      value: stripCommand(props.value, props.caret, query.length),
      caret: props.caret - query.length - 1,
    });
    setDismissed(true);
    props.onClose();
    inputRef.current?.focus();
  }, [props, query]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
          return;
        case 'ArrowUp':
          e.preventDefault();
          setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
          return;
        case 'Enter': {
          const entry = results[active];
          if (entry !== undefined) {
            e.preventDefault();
            choose(entry);
          }
          return;
        }
        case 'Escape':
          e.preventDefault();
          close();
          return;
        case 'Tab':
          // Tab MOVES ON, it does not select. A palette that captures Tab is a keyboard trap by
          // definition: the author cannot reach the next control in the page.
          close();
          return;
        default:
          return;
      }
    },
    [active, choose, close, open, results],
  );

  return (
    <div className="orrery-palette-host">
      <input
        ref={inputRef}
        // `role="combobox"` with the three aria properties is the documented pattern, and it is
        // what lets `aria-activedescendant` work: focus is in the input, the active OPTION is
        // referenced by id.
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && results[active] !== undefined ? `${listId}-${active}` : undefined
        }
        aria-label="Block text"
        value={props.value}
        onChange={(e) => {
          // `selectionStart` is `number | null` in the DOM types. It is null only for input
          // types that do not support selection, and this is a plain text input, so the
          // fallback is a conversion rather than a guess.
          const caret = e.target.selectionStart ?? e.target.value.length;
          // Typing PAST the slash re-opens a dismissed palette, which is why dismissal is a
          // flag rather than a one-way latch: an author who presses Escape and keeps typing
          // should get the palette back the next time they type `/`.
          if (caret === 0 || e.target.value[caret - 1] !== '/') setDismissed(false);
          props.onChange({ value: e.target.value, caret });
        }}
        onKeyDown={onKeyDown}
      />

      {/* Announces the COUNT, which is what a screen-reader user needs to know: whether the
          filter is doing anything. Announcing the selected item on every keystroke is noise. */}
      <p aria-live="polite" className="visually-hidden">
        {open ? `${results.length} block${results.length === 1 ? '' : 's'} available` : ''}
      </p>

      {/*
        `div`, not `ul`/`li`. The ARIA combobox pattern replaces the list semantics with
        listbox/option anyway, so the list element bought nothing -- and `aria-activedescendant`
        means the options are correctly NOT focusable, which `li role="option"` reads as a bug.
        The roles are identical; the elements are the ones that do not carry a conflicting
        implicit role.
      */}
      {open && (
        <div id={listId} role="listbox" aria-label="Insert a block" className="orrery-palette">
          {results.map((entry, i) => (
            <div
              key={entry.type}
              id={`${listId}-${i}`}
              role="option"
              // `tabIndex={-1}` is the correct companion to `aria-activedescendant`, not a
              // workaround: the options must be PROGRAMMATICALLY focusable so a screen reader
              // can move its virtual cursor onto the active one, and must NOT be in the tab
              // order, because the tab order belongs to the text input. It is also exactly what
              // the `option must be focusable` rule is asking for -- which is the rule being
              // satisfied on its own terms rather than suppressed.
              tabIndex={-1}
              aria-selected={i === active}
              // `onMouseDown` rather than `onClick`: mousedown fires before the input blurs, so
              // clicking an option does not first close the palette out from under the click.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(entry);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="orrery-palette__label">{entry.label}</span>
              <span className="orrery-palette__hint">{entry.hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { PALETTE };
