'use client';

/**
 * The `worked_solution` renderer.  (P7-T7)
 *
 * ## `step.key` IS THE ANSWER, AND WHEN IT APPEARS IS THE WHOLE DESIGN PROBLEM
 *
 * `WorkedSolutionSpec.steps[].key` is the expected answer for that step, and it is also the only answer text this
 * renderer is given -- there is no separate "worked reasoning" field. So `key` is not a marker's-only field that a
 * solution politely declines to print: a worked solution that never shows the answer is not a worked solution.
 *
 * The question is therefore WHEN, and the answer is: after the student has answered *and* explicitly asked. Both
 * gates matter and they are different gates.
 *
 * - **Answered** -- otherwise "show me the answer" is a button that exists on every attempt, one keystroke from the
 *   mark scheme, and the question becomes a transcription exercise.
 * - **Revealed** -- even having answered, a student is entitled to choose not to look. A solution displayed
 *   unconditionally is a spoiler displayed unconditionally.
 *
 * The first version of this file took the opposite position -- "never show `key`" -- on the reasoning that it leaks
 * the mark scheme. That reasoning was wrong: the leak is real but the gate above already prevents it, and refusing to
 * show the answer at all makes the type useless.
 *
 * ## WHY THE REVEAL IS EXPLICIT AND WHY IT IS ANNOUNCED
 *
 * A worked solution shown immediately is a spoiler shown immediately; a solution behind a disclosure gives the student
 * the choice of whether they have earned it. The contract requires `Tab` to reach the reveal control with
 * `replaces: CLICK`, and `liveRegion: 'polite'` because revealing changes what is on screen without changing focus --
 * a sighted student sees the steps appear and a screen-reader user would otherwise hear nothing at all, which is the
 * exact asymmetry that makes a disclosure useless to them.
 *
 * Focus is NOT moved on reveal (`focusOnMount: 'PRESERVED'` and, deliberately, no focus change afterwards either):
 * `plans/15`'s rule is that focus moves only deliberately, and a disclosure that steals focus to the newly revealed
 * content scrolls a student past the answer they were reading.
 */

import type { WorkedSolutionSpec } from '@orrery/contracts/question';
import * as React from 'react';

export interface WorkedSolutionProps {
  readonly spec: WorkedSolutionSpec;
  readonly prompt: string;
  /** Whether the student has already answered, which is what the reveal is *for*. */
  readonly answered?: boolean;
  readonly onReveal?: () => void;
  readonly disabled?: boolean;
}

/** The heading, which is also the region's accessible name. */
export const solutionHeading = (spec: WorkedSolutionSpec): string =>
  `Worked solution: ${String(spec.steps.length)} step${spec.steps.length === 1 ? '' : 's'}`;

/**
 * The step list as prose.
 *
 * `plans/07` grades a worked solution per step, so partial credit reads "steps 1-3 of 5" rather than one holistic
 * number. The per-step points are therefore worth stating, and the total is worth stating as a sum of the same
 * numbers -- derived, not hard-coded, so a spec and its display cannot disagree.
 */
export const solutionSummary = (spec: WorkedSolutionSpec): string => {
  const total = spec.steps.reduce((sum, step) => sum + step.points, 0);
  return `${String(spec.steps.length)} steps, ${String(total)} marks.`;
};

/**
 * `spec.steps[].key` IS READ, AND ONLY AFTER BOTH GATES.
 *
 * See the note at the top of this file for why the ordering matters.
 */
export function WorkedSolutionQuestion({
  spec,
  prompt,
  answered = false,
  onReveal,
  disabled = false,
}: WorkedSolutionProps) {
  const [revealed, setRevealed] = React.useState(false);
  const regionId = React.useId();
  const headingId = `${regionId}-heading`;
  const statusId = `${regionId}-status`;
  const heading = solutionHeading(spec);

  return (
    <div>
      {/*
        THE REGION, NAMED BY ITS OWN HEADING.

        `nameFrom: 'the solution heading'` -- so the heading element is the name, via `aria-labelledby` rather than a
        repeated `aria-label` string that could fall out of step when the step count changes.
      */}
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled region wrapping the steps is the contract's shape */}
      <div role="region" aria-labelledby={headingId}>
        <h3 id={headingId}>{heading}</h3>
        <p>{prompt}</p>
        <p>{solutionSummary(spec)}</p>

        {/*
          THE REVEAL CONTROL, AND IT IS NOT RENDERED UNTIL THE STUDENT HAS ANSWERED.

          Gating on `answered` rather than merely disabling it: a permanently disabled button is a dead control that
          a screen-reader user must tab through on every attempt, and it explains itself by being un-clickable. Not
          offering it says the same thing with nothing to dismiss.

          The steps themselves are listed whether or not the solution is revealed -- a student is entitled to know what
          is being asked and how it is marked. What is withheld until they choose is the worked reasoning.
        */}
        {answered ? (
          <button
            type="button"
            disabled={disabled}
            aria-controls={regionId}
            aria-expanded={revealed}
            onClick={() => {
              setRevealed(true);
              onReveal?.();
            }}
          >
            {revealed ? 'Worked solution shown below' : 'Show the worked solution'}
          </button>
        ) : null}

        {/*
          THE POLITE LIVE REGION, announcing that the solution is now visible.

          Revealing changes the page without moving focus, so a screen-reader user would otherwise hear nothing --
          which is precisely the asymmetry that makes a disclosure useless to them. `polite`, not `assertive`: the
          student pressed the control and is waiting for it.
        */}
        <div role="status" aria-live="polite" aria-atomic="true" id={statusId}>
          {revealed ? 'The worked solution is now shown below.' : ''}
        </div>

        {/*
          THE STEPS, AND THE ANSWERS AFTER THE REVEAL.

          The step prompts and their marks are listed whether or not the solution is revealed: a student is entitled
          to know what is being asked and how it is marked, and `plans/07` grades this type per step, so "steps 1-3 of
          5" is a real and legible result. What is withheld until they ask is each step's expected answer.

          A step with no `key` renders no answer at all rather than an empty one, which would read as "the expected
          answer is blank" instead of "this step is not answerable by comparison".
        */}
        <ol>
          {spec.steps.map((step, index) => (
            <li
              key={step.id}
              aria-label={`Step ${String(index + 1)} of ${String(spec.steps.length)}`}
            >
              <p>{step.prompt}</p>
              <p>
                {String(step.points)} mark{step.points === 1 ? '' : 's'}
              </p>
              {revealed && step.key !== undefined ? (
                <p data-testid={`reveal-${step.id}`}>{step.key.text}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
