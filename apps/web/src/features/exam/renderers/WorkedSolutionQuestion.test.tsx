// @vitest-environment jsdom

import type { WorkedSolutionSpec } from '@orrery/contracts/question';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract } from './contractHarness';
import { solutionHeading, solutionSummary, WorkedSolutionQuestion } from './WorkedSolutionQuestion';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const spec: WorkedSolutionSpec = {
  type: 'worked_solution',
  steps: [
    { id: 's1', prompt: 'Write the equation of motion.', points: 2, key: { text: 'F = ma' } },
    { id: 's2', prompt: 'Rearrange it for acceleration.', points: 1, key: { text: 'a = F / m' } },
    // A step with NO key, to pin the difference between "expected answer is blank" and "not compared".
    { id: 's3', prompt: 'State what a negative sign means.', points: 1 },
  ],
};

afterEach(cleanup);

const Stateful = ({
  answered = false,
  spy,
}: {
  readonly answered?: boolean;
  readonly spy?: () => void;
}) => (
  <WorkedSolutionQuestion
    spec={spec}
    prompt="Show the derivation."
    answered={answered}
    onReveal={() => {
      spy?.();
    }}
  />
);

describe('as DRAWN', () => {
  it('is a REGION named by its own heading, with the step count in it', async () => {
    await assertRendersContract('worked_solution', <Stateful />);
    expect(screen.getByRole('region', { name: 'Worked solution: 3 steps' })).toBeDefined();
  });

  it('names the region by `aria-labelledby` on the real heading, not a repeated string', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful />);
    const region = container.querySelector('[role="region"]');
    const labelledBy = region?.getAttribute('aria-labelledby');
    // A duplicated `aria-label` would have to be edited in step with the heading every time a spec changes.
    expect(region?.getAttribute('aria-label')).toBeNull();
    expect(container.querySelector(`#${labelledBy}`)?.textContent).toBe(solutionHeading(spec));
  });

  it('states the per-step marks and their sum, derived rather than hard-coded', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful />);
    expect(container.textContent).toContain(solutionSummary(spec));
    expect(container.textContent).toContain('3 steps, 4 marks.');
    expect(container.textContent).toContain('2 marks');
    expect(container.textContent).toContain('1 mark');
  });

  it('lists the step PROMPTS before the reveal, because a student may know what is being asked', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful answered />);
    expect(container.textContent).toContain('Write the equation of motion.');
    expect(container.textContent).toContain('State what a negative sign means.');
  });

  it('NEVER shows a step answer before the reveal, even once the student has answered', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful answered />);
    /**
     * This is the leak the two gates exist to prevent. `key` is the only answer text the renderer is given, so
     * printing it eagerly turns the question into a transcription exercise -- and it does it one keystroke from the
     * mark scheme on every attempt.
     */
    expect(container.textContent).not.toContain('F = ma');
    expect(container.textContent).not.toContain('a = F / m');
    expect(screen.queryByTestId('reveal-s1')).toBeNull();
  });

  it('offers NO reveal control at all until the student has answered', async () => {
    await assertRendersContract('worked_solution', <Stateful answered={false} />);
    /**
     * Not a disabled button. A permanently disabled control is something a screen-reader user tabs through on every
     * attempt and it explains itself only by being un-clickable; not offering it says the same thing with nothing to
     * dismiss.
     */
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has a POLITE live region that is empty until something is announced', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful answered />);
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('');
  });
});

describe('as DRIVEN', () => {
  it('shows each step answer on reveal, and none before it', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful answered />);
    await userEvent.click(screen.getByRole('button', { name: /Show the worked solution/ }));
    expect(screen.getByTestId('reveal-s1').textContent).toBe('F = ma');
    expect(screen.getByTestId('reveal-s2').textContent).toBe('a = F / m');
    /**
     * A step with no `key` renders NO answer element. An empty one would read as "the expected answer is blank",
     * which is a different and wrong statement from "this step is not marked by comparison".
     */
    expect(screen.queryByTestId('reveal-s3')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('is reachable by Tab, which is what `replaces: CLICK` asserts', async () => {
    await assertRendersContract('worked_solution', <Stateful answered />);
    await userEvent.tab();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Show the worked solution/ }),
    );
  });

  it('announces the reveal politely, because focus does not move and a screen-reader user would otherwise hear nothing', async () => {
    const { container } = await assertRendersContract('worked_solution', <Stateful answered />);
    await userEvent.click(screen.getByRole('button', { name: /Show the worked solution/ }));
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('The worked solution is now shown below.');
    /**
     * Focus stays on the control. `plans/15`'s rule is that focus moves only deliberately, and a disclosure that
     * steals focus to the newly revealed content scrolls a student past the answer they were reading.
     */
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Worked solution shown below/ }),
    );
  });

  it('reports the reveal once, and does not leave a live control that re-fires', async () => {
    const spy = vi.fn();
    await assertRendersContract(
      'worked_solution',
      <WorkedSolutionQuestion spec={spec} prompt="Show." answered onReveal={spy} />,
    );
    const button = screen.getByRole('button', { name: /Show the worked solution/ });
    await userEvent.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    // The button relabels to a spent state rather than inviting the same click again.
    expect(screen.getByRole('button', { name: /Worked solution shown below/ })).toBeDefined();
  });
});

describe('the derived strings', () => {
  it('singularises correctly, because "1 steps" reads as a bug to a student', () => {
    expect(
      solutionHeading({ type: 'worked_solution', steps: [{ id: 'a', prompt: 'p', points: 1 }] }),
    ).toBe('Worked solution: 1 step');
  });

  it('sums the marks from the spec, so the display cannot disagree with the grading', () => {
    expect(solutionSummary(spec)).toBe('3 steps, 4 marks.');
    expect(solutionSummary({ type: 'worked_solution', steps: [] })).toBe('0 steps, 0 marks.');
  });
});
