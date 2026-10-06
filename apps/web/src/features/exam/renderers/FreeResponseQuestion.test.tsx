// @vitest-environment jsdom

import type { PublicFreeResponseSpec } from '@orrery/contracts/question';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract, PUBLIC_COMMON } from './contractHarness.js';
import { DEFAULT_MARKING_NOTE, FreeResponseQuestion } from './FreeResponseQuestion';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const spec: PublicFreeResponseSpec = {
  ...PUBLIC_COMMON,
  type: 'free_response',
};

afterEach(cleanup);

const Stateful = ({
  initial = '',
  spy,
}: {
  readonly initial?: string;
  readonly spy?: (next: string) => void;
}) => {
  const [value, setValue] = React.useState(initial);
  return (
    <FreeResponseQuestion
      spec={spec}
      prompt="Explain why the satellite's speed changes at this point in its orbit."
      value={value}
      onChange={(next) => {
        setValue(next);
        spy?.(next);
      }}
    />
  );
};

describe('as DRAWN', () => {
  it('is a single LABELLED textarea, with no role, because the contract says `role: null`', async () => {
    await assertRendersContract('free_response', <Stateful />);
    // The accessible name IS the question text, via `<label for>` -- not an `aria-label` second copy.
    expect(screen.getByRole('textbox', { name: /Explain why the satellite/ })).toBeDefined();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    // One control, not a group: `role="group"` would claim a grouping that does not exist.
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('shows the REVIEW MODEL, because this is the only type a human grades', async () => {
    await assertRendersContract('free_response', <Stateful />);
    expect(screen.getByText(DEFAULT_MARKING_NOTE)).toBeDefined();
  });

  it('NEVER PRINTS `conceptHints`, which is the auto-grading assist and not a scoring rule', async () => {
    const { container } = await assertRendersContract('free_response', <Stateful />);
    // `plans/07` says the keyword layer only SUGGESTS. A student who sees it concludes their answer is scored
    // against a keyword list, which is false -- and a correct answer that avoids both words then reads as wrong.
    expect(screen.queryByText(/momentum/)).toBeNull();
    expect(screen.queryByText(/impulse/)).toBeNull();
    expect(container.textContent).not.toContain('momentum');
    expect(container.textContent).not.toContain('impulse');
  });

  it('does not print the RUBRIC either, which is stripped from the student payload', async () => {
    const { container } = await assertRendersContract('free_response', <Stateful />);
    expect(container.textContent).not.toContain('both forces');
    expect(container.textContent).not.toContain('1');
  });

  it('associates the marking note with the field, so it is read with the question', async () => {
    const { container } = await assertRendersContract('free_response', <Stateful />);
    const field = screen.getByRole('textbox');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    // `describedBy` is the id of a real element in THIS render, not a dangling reference.
    const note = container.querySelector(`#${describedBy}`);
    expect(note?.textContent).toBe(DEFAULT_MARKING_NOTE);
  });
});

describe('as DRIVEN', () => {
  it('reports the answer AS WRITTEN, in full, with no truncation', async () => {
    const spy = vi.fn();
    await assertRendersContract('free_response', <Stateful spy={spy} />);

    // A long answer is NOT capped at render time. A silent cap would turn "too long to mark" into "blank", which
    // the grader scores differently, while looking to the student like a complete answer.
    const long = 'The gravitational force is stronger here. '.repeat(200);
    await userEvent.type(screen.getByRole('textbox'), long.slice(0, 60));
    expect(spy).toHaveBeenCalled();
    // Every keystroke reports the whole current value, not a delta.
    for (const call of spy.mock.calls) {
      expect(typeof call[0]).toBe('string');
    }
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value.length).toBe(60);
  });

  it('is reachable by Tab, which is what `replaces: CLICK` in the contract asserts', async () => {
    await assertRendersContract('free_response', <Stateful />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('honours `disabled`', async () => {
    const { container } = await assertRendersContract(
      'free_response',
      <FreeResponseQuestion
        spec={spec}
        prompt="Explain."
        value="draft"
        onChange={() => {
          /* a disabled field must not reach here */
        }}
        disabled
      />,
    );
    const field = container.querySelector('textarea');
    expect(field?.disabled).toBe(true);
    expect((field as HTMLTextAreaElement).readOnly || field?.disabled).toBe(true);
  });
});
