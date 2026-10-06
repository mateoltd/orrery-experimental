'use client';

/**
 * The `single_choice` renderer.  (P7-T7)
 *
 * ## THE POINT: THIS RENDERER ADDS NO KEY HANDLERS AT ALL
 *
 * `INTERACTION_CONTRACTS.single_choice` binds `Tab` to focus the group, `ArrowUp`/`ArrowDown` to move between
 * options and `Space`/`Enter` to select. **Every one of those is native behaviour of a group of radio inputs in a
 * `radiogroup`.** The browser already implements the contract; the renderer's job is to use the elements that
 * implement it rather than to re-implement it.
 *
 * That is the whole design, and it is why this is the first renderer written: a hand-rolled `onKeyDown` for arrow
 * navigation is where a renderer gets the roving tabindex wrong, announces the wrong number of options, or breaks
 * when a question has two options instead of four. **The first way to make an interaction keyboard-operable is to
 * find the element that already is.**
 *
 * ## AND THE CONTRACT IS ASSERTED AGAINST THE RENDERED DOM, NOT QUOTED IN A COMMENT
 *
 * `contractHarness.assertRendersContract` checks that the role the contract declares is the role in the DOM and
 * that an accessible name was computed. A renderer that ignores its contract fails there, which is the only way the
 * contract stays load-bearing rather than becoming documentation with a test file beside it.
 */

import { contractFor } from '@orrery/contracts/a11y/questionInteraction';
import type { PublicSingleChoiceSpec } from '@orrery/contracts/question';
// the classic transform its absence is a `ReferenceError` on the `return (`, which is an unhelpful place to find out.
import * as React from 'react';

export interface SingleChoiceProps {
  readonly spec: PublicSingleChoiceSpec;
  /**
   * THE QUESTION TEXT, and it is a PROP rather than `spec.prompt` because no such field exists.
   *
   * `QuestionSpec` carries the key, the marks, the timing and the options -- **not the prose**. The question text
   * belongs to the resource's content document, so a renderer that read it off the spec would be reading a field
   * that has never existed, and the compiler would have caught it if the spec had been typed.
   *
   * So the text is passed in, and the component has no way to render a nameless question -- which is the property
   * that matters, because a nameless fieldset announces as "group" and a student hears nothing about what they are
   * answering.
   */
  readonly prompt: string;
  /** The chosen option id, or `null`/`undefined` when nothing is chosen. */
  readonly value?: string | null;
  readonly onChange: (choiceId: string) => void;
  /** Set when the question is locked or the attempt is closed. Native `disabled` is used, not `aria-disabled`. */
  readonly disabled?: boolean;
}

export function SingleChoiceQuestion({
  spec,
  prompt,
  value,
  onChange,
  disabled = false,
}: SingleChoiceProps) {
  const contract = contractFor('single_choice');
  const headingId = React.useId();

  return (
    <fieldset
      /*
       * `role="radiogroup"` EXPLICITLY, and the first version of this renderer omitted it -- wrongly.
       *
       * The reasoning was that a `<fieldset>` already has the implicit role `group`, that the radios inside already
       * announce single selection, and that declaring it twice is redundant. **That reasoning is wrong, and
       * `contractHarness` caught it:** `group` and `radiogroup` are different roles, and only `radiogroup` carries
       * the "exactly one of these may be chosen, and the arrow keys move between them" semantics that the contract
       * binds `ArrowUp`/`ArrowDown` to. Under `group`, a screen reader announces a generic group of radios and the
       * student is never told that one answer is the answer.
       *
       * So the role is stated, narrowed from the contract's `string | null` rather than cast -- a cast would let a
       * typo in the contract reach the DOM as an invalid role, which axe does not check.
       *
       * This is also why the contract is the source and not a comment: the comment was confidently wrong, and only
       * something comparing the DOM against the contract noticed.
       */
      role={contract.role === 'radiogroup' ? 'radiogroup' : undefined}
      aria-labelledby={headingId}
      disabled={disabled}
    >
      {/*
        THE LEGEND IS THE ACCESSIBLE NAME, and it is a `<legend>` rather than a heading on purpose.

        A screen reader announces a fieldset by its legend, so the question text IS the group's name with no
        `aria-label` to keep in sync. The contract says the name comes from "the question text", and this is how
        that claim is paid rather than restated.
      */}
      <legend id={headingId}>{renderInline(prompt)}</legend>

      {spec.choices.map((choice) => {
        const inputId = `${headingId}-${choice.id}`;
        return (
          <div key={choice.id}>
            <input
              type="radio"
              id={inputId}
              name={headingId}
              value={choice.id}
              checked={value === choice.id}
              onChange={() => {
                onChange(choice.id);
              }}
              disabled={disabled}
            />
            {/*
              A `<label>` wrapping the input, not an `id`/`for` pair on a sibling. The implicit association cannot
              be broken by a markup edit elsewhere in the option list, and the clickable area is the whole row --
              which matters for a student with a motor impairment and for anyone on a touch screen.
            */}
            <label htmlFor={inputId}>{renderInline(choice.text)}</label>
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * INLINE TEXT ONLY, and the limitation is stated rather than hidden.
 *
 * `PublicSingleChoiceSpec.choices[].text` is a plain string, not a rich-text document, so there is nothing to render but
 * the string. A question whose prompt needs a formula or a diagram is a different spec shape, and pretending to
 * support it here would mean silently dropping the maths -- which is worse than not offering it.
 *
 * `strings` is left to React's default escaping. `dangerouslySetInnerHTML` is banned outright by `eslint.config.js`
 * (`NO_MARKUP_SINKS[0]`, added in `P14-T16`), so adding one here for a question bank would be an XSS hole reachable by
 * anyone who can edit a bank **and** a lint error. The ban is asserted to fire by
 * `packages/config/src/lint-rules.verify.test.ts`.
 */
const renderInline = (text: string): string => text;
