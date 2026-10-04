// @vitest-environment jsdom
/**
 * The `single_choice` renderer, audited against its own contract.  (P7-T7)
 *
 * ## THE TEST IS TWO HALVES BECAUSE "CORRECT AS DRAWN" AND "RESPONDS" ARE DIFFERENT QUESTIONS
 *
 * `assertRendersContract` answers the first: no axe violation, the role the contract declares is the role in the
 * DOM, and an accessible name was computed. The keyboard half answers the second: the bindings the contract
 * promises actually do something.
 *
 * Conflating them is how a renderer ends up passing because the label was right and the arrow keys were not.
 */

import { contractFor } from '@orrery/contracts/a11y/questionInteraction';
import type { SingleChoiceSpec } from '@orrery/contracts/question';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
/**
 * `React` IS IMPORTED EXPLICITLY even though `esbuild: {jsx: 'automatic'}` is set in `vitest.config.ts`.
 *
 * With the automatic runtime this import is unused; with the classic transform its absence is a
 * `ReferenceError: React is not defined` on every JSX expression. Importing it costs nothing and makes the file
 * independent of which transform a given run resolved -- which is not a hypothetical, since that is exactly what
 * happened here.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract, renderAndAudit } from './contractHarness';
import { SingleChoiceQuestion } from './SingleChoiceQuestion';

/**
 * CLEANUP AFTER EVERY TEST, and without it every assertion about "the" radio is ambiguous.
 *
 * The editor's a11y test does the same. `render` appends to `document.body` and does not remove what it added, so
 * a second test's `getByRole('radio', {name: 'Alpha'})` finds the first test's too -- which surfaced as
 * "Found multiple elements" and, worse, would have let an assertion pass against another test's DOM.
 */
afterEach(cleanup);

const spec: SingleChoiceSpec = {
  type: 'single_choice',
  choices: [
    { id: 'a', text: 'Alpha' },
    { id: 'b', text: 'Bravo' },
    { id: 'c', text: 'Charlie' },
  ],
  key: { choiceId: 'a' },
};

const PROMPT = 'Which one is the powerhouse of the cell?';

describe("as DRAWN: axe, the contract's role, and an accessible name", () => {
  it('satisfies the contract and axe together', async () => {
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={() => {}} />,
    );
  });

  it('names the group with the QUESTION TEXT, via a legend, with no aria-label to drift', async () => {
    const report = await renderAndAudit(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(report.unnamed).toBe(false);
    // The legend IS the name, which is why the contract's `nameFrom` can say "the question text" and be true.
    expect(report.rendered.container.querySelector('legend')?.textContent).toBe(PROMPT);
    expect(report.rendered.container.querySelector('[aria-label]')).toBeNull();
  });

  it('gives every option its own accessible name', async () => {
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={() => {}} />,
    );
    for (const label of ['Alpha', 'Bravo', 'Charlie']) {
      expect(screen.getByRole('radio', { name: label })).toBeDefined();
    }
  });

  it('is CLEAN WITH ONE OPTION AND WITH MANY, because the contract does not care about the count', async () => {
    for (const count of [1, 2, 3, 12]) {
      const wide: SingleChoiceSpec = {
        ...spec,
        choices: Array.from({ length: count }, (_, n) => ({
          id: `o${String(n)}`,
          text: `Option ${String(n)}`,
        })),
      };
      await assertRendersContract(
        'single_choice',
        <SingleChoiceQuestion spec={wide} prompt={PROMPT} onChange={() => {}} />,
      );
    }
  });

  it('reports a role MISMATCH when a renderer ignores its contract, which is what the harness is for', async () => {
    /**
     * THE HARNESS'S OWN TEST, and the reason it exists.
     *
     * `axe` cannot catch this: a `<div>` with nothing on it has no axe violation at all. It is not a labelled
     * control, so there is no label to be missing -- it is simply not a control. Only comparing the rendered role
     * against `INTERACTION_CONTRACTS` notices, which is the difference between an audit and a lint.
     */
    const report = await renderAndAudit('ordering', <div>just some text</div>);
    expect(report.violations).toEqual([]);
    expect(report.roleMismatch).toEqual(['contract says listbox, DOM says null']);
    expect(report.unnamed).toBe(true);
  });
});

describe("as DRIVEN: the contract's bindings actually work", () => {
  it('selects with a CLICK, because the input is a real input', async () => {
    const onChange = vi.fn();
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Bravo' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('moves between options with the ARROW KEYS, with NO key handler in the renderer', async () => {
    /**
     * THE POINT OF THE WHOLE FILE. The contract binds `ArrowUp`/`ArrowDown` to "move between options", and this
     * renderer has no `onKeyDown` anywhere. The behaviour is the browser's, because the markup is a group of
     * native radios -- which is where a hand-rolled implementation would get the roving tabindex wrong.
     */
    const onChange = vi.fn();
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={onChange} value="a" />,
    );
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    alpha.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('reaches every option with Tab, because each is a separate tab stop in a radiogroup', async () => {
    // Native radios in a group share ONE tab stop and arrow between themselves -- which is why a student tabs
    // once into a question and then arrows, and why `Tab` never skips an option silently.
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(contractFor('single_choice').keys.some((binding) => binding.keys.includes('Tab'))).toBe(
      true,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
  });

  it('reflects `value` as CHECKED, so a re-render after a 409 shows the kept answer', async () => {
    // The reconcile dialog from P7-T11 resolves to `value` changing; a renderer that ignored it would leave the
    // student looking at the answer they just declined.
    const { rerender } = render(
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} value="a" onChange={() => {}} />,
    );
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveProperty('checked', true);
    rerender(<SingleChoiceQuestion spec={spec} prompt={PROMPT} value="c" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Charlie' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveProperty('checked', false);
  });

  it('disables EVERY option when the question is locked, not just the first', async () => {
    /**
     * A half-disabled radiogroup is the classic `lockQuestionAfterAnswer` bug: the student can still change the
     * answer they were not permitted to keep, and the store refuses it with `LOCKED` -- so the radio moves back
     * under their finger and the interface looks broken.
     */
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={() => {}} disabled />,
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
  });

  it('does not fire onChange when a disabled option is clicked', async () => {
    const onChange = vi.fn();
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} onChange={onChange} disabled />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Bravo' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders an unselected question with NOTHING checked', async () => {
    await assertRendersContract(
      'single_choice',
      <SingleChoiceQuestion spec={spec} prompt={PROMPT} value={null} onChange={() => {}} />,
    );
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
  });
});
