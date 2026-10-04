'use client';

/**
 * The option-group renderers: `multi_select` and `true_false`.  (P7-T7)
 *
 * ## ONE COMPONENT, TWO TYPES, AND THE DIFFERENCE IS THE CONTRACT'S
 *
 * These two are the same shape — a labelled group of options — and they differ in exactly one respect: whether
 * zero or one or many may be chosen. `INTERACTION_CONTRACTS` already states that as `role`, and this component
 * derives its `type`, its `checked` semantics and its role from the contract rather than from a prop that a caller
 * could set inconsistently with the type.
 *
 * **`multi_select` IS A `group` OF CHECKBOXES AND `true_false` IS A `radiogroup` OF RADIOS**, and swapping them is
 * not a cosmetic mistake. `radiogroup` on checkboxes tells a screen reader that exactly one may be chosen, which
 * is false and which makes the question unanswerable by its stated constraint. `group` on radios loses the
 * single-selection semantics and the arrow-key behaviour that goes with it.
 *
 * So the input type comes from the contract's role, and a test asserts each renderer's DOM matches — which is the
 * same check that caught `single_choice` omitting its `radiogroup`.
 *
 * ## AND AGAIN, NO `onKeyDown`
 *
 * Arrow navigation within a radio group is the browser's. **Space toggling a checkbox is also the browser's**, and
 * that is the one that is usually re-implemented badly: a custom handler that toggles on `Space` fires *and* the
 * native toggle fires, so the checkbox flips twice and appears not to respond.
 */

import { contractFor } from '@orrery/contracts/a11y/questionInteraction';
import type { MultiSelectSpec, TrueFalseSpec } from '@orrery/contracts/question';
import * as React from 'react';

export interface ChoiceGroupProps {
  readonly spec: MultiSelectSpec | TrueFalseSpec;
  readonly prompt: string;
  /** The chosen option ids. A single-element array for `true_false`. */
  readonly value?: readonly string[];
  readonly onChange: (choiceIds: readonly string[]) => void;
  readonly disabled?: boolean;
}

export function ChoiceGroupQuestion({
  spec,
  prompt,
  value = [],
  onChange,
  disabled = false,
}: ChoiceGroupProps) {
  const contract = contractFor(spec.type);
  const groupId = React.useId();
  const multiple = contract.role === 'group';

  const choices: readonly { id: string; text: string }[] =
    spec.type === 'true_false'
      ? [
          { id: 'true', text: 'True' },
          { id: 'false', text: 'False' },
        ]
      : spec.choices;

  const toggle = (id: string): void => {
    if (!multiple) {
      onChange([id]);
      return;
    }
    onChange(value.includes(id) ? value.filter((held) => held !== id) : [...value, id]);
  };

  return (
    <fieldset
      role={contract.role === 'radiogroup' ? 'radiogroup' : 'group'}
      aria-labelledby={groupId}
      disabled={disabled}
    >
      <legend id={groupId}>{prompt}</legend>

      {choices.map((choice) => {
        const inputId = `${groupId}-${choice.id}`;
        return (
          <div key={choice.id}>
            {/*
              `type` IS DERIVED FROM THE CONTRACT'S ROLE, not from `spec.type`, so the two cannot drift. A
              `multi_select` rendered as radios would pass axe, pass the types, and be unanswerable by its own
              stated constraint.
            */}
            <input
              type={multiple ? 'checkbox' : 'radio'}
              id={inputId}
              name={groupId}
              value={choice.id}
              checked={value.includes(choice.id)}
              onChange={() => {
                toggle(choice.id);
              }}
              disabled={disabled}
            />
            <label htmlFor={inputId}>{choice.text}</label>
          </div>
        );
      })}
    </fieldset>
  );
}
