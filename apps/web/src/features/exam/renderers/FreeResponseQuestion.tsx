'use client';

/**
 * The `free_response` renderer.  (P7-T7)
 *
 * ## WHY THIS IS NOT `TextFieldQuestion`
 *
 * `short_text` and `free_response` are both a labelled `<textarea>`, so the temptation is to add
 * `free_response` to the union in `TextFieldQuestion` and get it for free. That would be wrong for one reason that
 * matters: **`free_response` is the only type whose grading is a human judgement**, and everything about how it is
 * drawn has to make that visible rather than implying an auto-grade that will never arrive.
 *
 * ## THE KEYWORD LAYER IS NOT SHOWN, AND SAYING SO IS THE POINT
 *
 * `PublicFreeResponseSpec.conceptHints` is an optional layer that only *suggests*. `plans/07` is careful that it never
 * decides a score, and it is stripped from the student payload along with the rubric. So the renderer must not print
 * it. A student who sees "expected concepts: momentum, impulse" reasonably concludes the answer is graded against
 * that list, and a written answer that is correct without using either word becomes a support conversation.
 *
 * What the renderer *can* say is something narrower and true: that a human reads this. `plans/07` grades prose by
 * rubric band, and a student told "this is marked by a person" can write an answer pitched at a person instead of
 * gaming a keyword matcher. So the rendered text states the reviewing model and nothing about the hints.
 */

import type { PublicFreeResponseSpec } from '@orrery/contracts/question';
import * as React from 'react';

export interface FreeResponseProps {
  readonly spec: PublicFreeResponseSpec;
  readonly prompt: string;
  readonly value?: string;
  /**
   * The answer as written, in full.
   *
   * No length cap is applied here. `plans/07` treats an unanswered and an unanswerable question differently, and a
   * silent truncation at some character count would turn the second into the first while looking like a full answer.
   */
  readonly onChange: (raw: string) => void;
  readonly disabled?: boolean;
  /**
   * The review model, as shown to the student.
   *
   * Defaults to the sentence below. It is a prop because a pilot deployment may need to say something more
   * specific, and a caller that has real information should be able to supply it rather than have it edited into a
   * shared component.
   */
  readonly markingNote?: string;
}

/** The default statement of HOW this answer is marked, and nothing about what it is compared against. */
export const DEFAULT_MARKING_NOTE = 'A person marks this answer against a rubric.';

/**
 * `spec` IS ACCEPTED AND DELIBERATELY NOT READ.
 *
 * It is in the props because every renderer in this directory takes its spec, and a dispatcher that had to special
 * case `free_response` would eventually get the special case wrong. Nothing here reads it: `rubric` is stripped
 * from the student payload, and `conceptHints` is the assist that must not be shown. Reading either would be the bug.
 */
export function FreeResponseQuestion({
  prompt,
  value = '',
  onChange,
  disabled = false,
  markingNote = DEFAULT_MARKING_NOTE,
}: FreeResponseProps) {
  const fieldId = React.useId();
  const noteId = `${fieldId}-note`;

  return (
    <div>
      {/*
        A `<label>`, so the accessible name IS the visible question text. `INTERACTION_CONTRACTS.free_response`
        names the field "the question text, via the textarea label", which is this and not `aria-label` -- with
        `aria-label` the name would be a second copy of the prompt and would fall out of step when a question is
        reworded.
      */}
      <label htmlFor={fieldId}>{prompt}</label>

      {/*
        NO `role` ATTRIBUTE, AND THAT MATCHES THE CONTRACT'S `role: null`.
        *
        * A single labelled textarea is not a group. `role="textbox"` is redundant with the implicit role, and
        * `role="group"` would claim a grouping that does not exist. The harness asserts the drawn DOM against the
        * contract, so adding a role here fails there rather than in production.
        */}
      <textarea
        id={fieldId}
        value={value}
        rows={8}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        disabled={disabled}
        aria-describedby={noteId}
        autoComplete="off"
      />

      {/*
        THE REVIEW MODEL IS SHOWN, AND THE HINTS ARE NOT.
        *
        * `plans/07` grades prose by rubric band with a human in the loop, so a student who knows that can pitch an
        * answer at a reader. `spec.conceptHints` is the auto-grading assist: printing it would tell the student
        * their answer is scored against a keyword list, which is both false (it only suggests) and the kind of
        * hidden rule that generates disputes. It is referenced nowhere in the rendered output.
        */}
      <p id={noteId}>{markingNote}</p>
    </div>
  );
}
