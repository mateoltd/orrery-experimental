'use client';

/**
 * The text-field renderers: `numeric` and `short_text`.  (P7-T7)
 *
 * ## WHY THESE TWO SHARE A COMPONENT AND `ordering` DOES NOT
 *
 * Both are a single labelled control holding a string or a number, and the only difference is the element and the
 * `inputMode` a mobile keyboard needs. `ordering` is a reorderable list, which is a different shape with different
 * keyboard requirements, and pretending otherwise would put a drag handler in here.
 *
 * ## AND `inputMode` IS NOT A DETAIL
 *
 * A numeric question answered on a phone is the case where `type="text"` with `inputMode="decimal"` beats
 * `type="number"`: `type="number"` gives a numeric keypad, but it also silently discards what the keypad cannot
 * represent, so a student answering "9.81 m/s" or in scientific notation gets an empty box and no error. `numeric`
 * is graded on a NUMBER and the field is a string, which is why `onChange` hands the raw text up rather than a
 * coerced value -- coercing here would make "3.0" and "3" indistinguishable before the grader ever sees them, and
 * `plans/07`'s significant-figure rule counts digits in the WRITTEN form.
 */

import type { NumericSpec, ShortTextSpec } from '@orrery/contracts/question';
import * as React from 'react';

export interface TextFieldProps {
  readonly spec: NumericSpec | ShortTextSpec;
  readonly prompt: string;
  readonly value?: string;
  /**
   * The RAW STRING, never a coerced number.
   *
   * `plans/07`'s sig-fig rule counts digits in the written form, so "3.0" and "3" are different answers to a
   * question that declares `significantFigures`. Coercing here would discard that before the grader sees it.
   */
  readonly onChange: (raw: string) => void;
  readonly disabled?: boolean;
  /** Reported to the student as `aria-describedby` -- the tolerance, so it is not a hidden rule. */
  readonly hint?: string;
}

export function TextFieldQuestion({
  spec,
  prompt,
  value = '',
  onChange,
  disabled = false,
  hint,
}: TextFieldProps) {
  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const numeric = spec.type === 'numeric';

  return (
    <div>
      {/*
        A `<label>` rather than `aria-label`, for the same reason as the option group: the visible text IS the
        accessible name, so there is no second copy to fall out of step when a question is reworded.
      */}
      <label htmlFor={inputId}>{prompt}</label>

      {/*
        NO `role` ATTRIBUTE, and that is CORRECT rather than an omission.
        *
        * `INTERACTION_CONTRACTS` gives `numeric` and `short_text` a `role` of `null`, because a single labelled field
        is not a group. `role="textbox"` on an `<input type="text">` is redundant with the implicit role, and
        `role="group"` would be a lie. The harness asserts the DOM against the contract, so adding one here fails
        there -- which is why this component does not consult the contract at all rather than consulting it and
        discarding the answer.
      */}
      {numeric ? (
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : hintId}
          // `autoComplete="off"` because a browser autofilling a maths answer from a previous question is a real
          // and reported failure mode, and it would be indistinguishable from a student who cheated.
          autoComplete="off"
        />
      ) : (
        <textarea
          id={inputId}
          value={value}
          rows={3}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : hintId}
          autoComplete="off"
        />
      )}

      {/*
        THE TOLERANCE IS SHOWN. A numeric question graded on a tolerance the student cannot see is a question with
        a hidden rule, and the alternative -- not showing it -- produces support conversations about marks.
      */}
      {hint === undefined ? null : <p id={hintId}>{hint}</p>}
    </div>
  );
}

/** The tolerance line, built from the spec so it cannot drift from what the grader will apply. */
export const toleranceHint = (spec: NumericSpec): string | undefined => {
  const parts: string[] = [];
  if (spec.tolerance.absolute !== undefined)
    parts.push(`within ${String(spec.tolerance.absolute)}`);
  if (spec.tolerance.relative !== undefined)
    parts.push(`within ${String(spec.tolerance.relative * 100)}%`);
  if (spec.significantFigures !== undefined)
    parts.push(`to ${String(spec.significantFigures)} significant figures`);
  return parts.length === 0 ? undefined : `Accepted ${parts.join(', ')}.`;
};
