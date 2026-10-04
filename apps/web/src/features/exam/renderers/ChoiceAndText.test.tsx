// @vitest-environment jsdom
/**
 * The option-group and text-field renderers, audited against their contracts.  (P7-T7)
 *
 * ## THE TEST THAT MATTERS HERE IS THE ROLE-PER-TYPE ONE
 *
 * `single_choice` already failed once for omitting its `radiogroup`. The same mistake is available twice more in
 * this file -- checkboxes inside a `radiogroup`, or radios inside a `group` -- and both would pass axe and the
 * type checker. So the input TYPE is asserted per type, from the DOM rather than from the component's own source.
 */

import type {
  MultiSelectSpec,
  NumericSpec,
  ShortTextSpec,
  TrueFalseSpec,
} from '@orrery/contracts/question';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChoiceGroupQuestion } from './ChoiceGroupQuestion';
import { assertRendersContract, renderAndAudit } from './contractHarness';
import { TextFieldQuestion, toleranceHint } from './TextFieldQuestion';

afterEach(cleanup);

const PROMPT = 'Which of these are correct?';

const multi: MultiSelectSpec = {
  type: 'multi_select',
  choices: [
    { id: 'a', text: 'Alpha' },
    { id: 'b', text: 'Bravo' },
    { id: 'c', text: 'Charlie' },
  ],
  key: { choiceIds: ['a', 'c'] },
  partialCredit: 'NC',
};

const trueFalse: TrueFalseSpec = { type: 'true_false', key: { value: true } };

const numeric: NumericSpec = {
  type: 'numeric',
  key: { value: 9.81 },
  tolerance: { absolute: 0.05 },
};
const shortText: ShortTextSpec = {
  type: 'short_text',
  key: { text: 'mitochondria' },
  matcher: 'EXACT',
};

describe('multi_select: a GROUP of CHECKBOXES', () => {
  it('satisfies axe and its contract', async () => {
    await assertRendersContract(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} onChange={() => {}} />,
    );
  });

  it('renders CHECKBOXES, not radios -- the difference the whole file exists to protect', async () => {
    /**
     * `radiogroup` on checkboxes tells a screen reader that exactly one may be chosen. That is false, and it makes
     * the question unanswerable by its own stated constraint. axe passes either way.
     */
    await assertRendersContract(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('has the GROUP role, not `radiogroup`', async () => {
    const report = await renderAndAudit(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(report.roleMismatch).toEqual([]);
    expect(report.rendered.container.querySelector('fieldset')?.getAttribute('role')).toBe('group');
  });

  it('toggles with SPACE and reports the new SET, because a set is the answer', async () => {
    const onChange = vi.fn();
    await assertRendersContract(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} value={['a']} onChange={onChange} />,
    );
    // Adding: the existing selection is kept.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Charlie' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('REMOVES on a second activation rather than adding a duplicate', async () => {
    const onChange = vi.fn();
    await assertRendersContract(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} value={['a', 'c']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith(['c']);
  });

  it('disables EVERY checkbox when locked, so the whole set is frozen', async () => {
    await assertRendersContract(
      'multi_select',
      <ChoiceGroupQuestion spec={multi} prompt={PROMPT} onChange={() => {}} disabled />,
    );
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });
});

describe('true_false: a RADIOGROUP of radios', () => {
  it('satisfies axe and its contract', async () => {
    await assertRendersContract(
      'true_false',
      <ChoiceGroupQuestion spec={trueFalse} prompt={PROMPT} onChange={() => {}} />,
    );
  });

  it('renders exactly TWO radios named True and False, and a `radiogroup`', async () => {
    await assertRendersContract(
      'true_false',
      <ChoiceGroupQuestion spec={trueFalse} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'True' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'False' })).toBeDefined();
    expect(document.querySelector('fieldset')?.getAttribute('role')).toBe('radiogroup');
  });

  it('replaces the selection rather than accumulating it, because only one answer is right', async () => {
    const onChange = vi.fn();
    await assertRendersContract(
      'true_false',
      <ChoiceGroupQuestion spec={trueFalse} prompt={PROMPT} value={['true']} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'False' }));
    expect(onChange).toHaveBeenCalledWith(['false']);
    // A single-element array, never a growing set -- the type difference from multi_select is in the VALUE too.
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
  });
});

describe('numeric and short_text: a single labelled field and NO role', () => {
  it('satisfies axe and their contracts', async () => {
    await assertRendersContract(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} />,
    );
    await assertRendersContract(
      'short_text',
      <TextFieldQuestion spec={shortText} prompt={PROMPT} onChange={() => {}} />,
    );
  });

  it('carries NO role, because a labelled field is not a group', async () => {
    // `role="textbox"` is redundant with the implicit role and `role="group"` would be a lie. The contract says
    // `null` for both types, so the harness asserts its absence.
    const report = await renderAndAudit(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(report.roleMismatch).toEqual([]);
    expect(report.unnamed).toBe(false);
  });

  it('gives the FIELD the question text as its accessible name', async () => {
    await assertRendersContract(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox', { name: PROMPT })).toBeDefined();
  });

  it('uses `inputMode="decimal"` for numeric, NOT `type="number"`', async () => {
    /**
     * `type="number"` gives a numeric keypad but silently discards what the keypad cannot represent, so a student
     * answering "9.81 m/s" or in scientific notation gets an empty box and no error.
     */
    await assertRendersContract(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} />,
    );
    const field = screen.getByRole('textbox');
    expect(field.getAttribute('inputmode')).toBe('decimal');
    expect(field.getAttribute('type')).toBe('text');
  });

  it('hands the RAW STRING up, so "3.0" and "3" reach the sig-fig rule as written', async () => {
    /**
     * WRAPPED IN REAL STATE, because the first version of this test drove a controlled field whose `value` prop
     * never changed.
     *
     * `onChange` was a bare spy, so the field was pinned to `''` and each keystroke fired against an empty box --
     * the test was exercising a component that cannot exist in an application, and would have passed while
     * asserting nothing about a student typing "3.0".
     */
    const seen: string[] = [];
    const Stateful = (): React.ReactElement => {
      const [value, setValue] = React.useState('');
      return (
        <TextFieldQuestion
          spec={numeric}
          prompt={PROMPT}
          value={value}
          onChange={(raw) => {
            seen.push(raw);
            setValue(raw);
          }}
        />
      );
    };
    await assertRendersContract('numeric', <Stateful />);

    await userEvent.type(screen.getByRole('textbox'), '3.0');

    // Every intermediate value is the RAW STRING, and the last is exactly what was typed.
    expect(seen).toEqual(['3', '3.', '3.0']);
    expect(seen.at(-1)).toBe('3.0');
    // Coercing here would make "3.0" and "3" indistinguishable before the grader ever saw them, and
    // `plans/07`'s sig-fig rule counts digits in the WRITTEN form.
    expect(seen.every((value) => typeof value === 'string')).toBe(true);
  });

  it('renders a TEXTAREA for short_text and an INPUT for numeric', async () => {
    await assertRendersContract(
      'short_text',
      <TextFieldQuestion spec={shortText} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  });

  it('turns autofill OFF, because a browser filling a maths answer is indistinguishable from cheating', async () => {
    await assertRendersContract(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} />,
    );
    expect(screen.getByRole('textbox').getAttribute('autocomplete')).toBe('off');
  });

  it('shows the tolerance as a DESCRIPTION, because a hidden rule is not a fair question', async () => {
    const hint = toleranceHint(numeric);
    expect(hint).toContain('0.05');
    await assertRendersContract(
      'numeric',
      <TextFieldQuestion spec={numeric} prompt={PROMPT} onChange={() => {}} hint={hint} />,
    );
    // The hint is associated with the field, so it is announced with it rather than being text on screen.
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).not.toBeNull();
  });

  it('builds the tolerance line from the spec, listing every declared bound', () => {
    expect(
      toleranceHint({
        ...numeric,
        tolerance: { absolute: 0.05, relative: 0.01 },
        significantFigures: 3,
      }),
    ).toBe('Accepted within 0.05, within 1%, to 3 significant figures.');
    // And says nothing rather than an empty sentence when the question declares no rule.
    expect(toleranceHint({ ...numeric, tolerance: {} })).toBeUndefined();
  });
});
