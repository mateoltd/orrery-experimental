// @vitest-environment jsdom

import type { SimulationSpec } from '@orrery/contracts/question';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract } from './contractHarness';
import { SimulationQuestion } from './SimulationQuestion';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const spec: SimulationSpec = { type: 'simulation', simId: 'orbital-decay', simVersion: '1.4.0' };

const textAlternative = {
  shows:
    'a satellite losing altitude on each of three orbits, with its trail fading as altitude falls.',
  task: 'Run all three orbits, then set the drag to 400 m/s and read the new perigee.',
  reportedIn: 'the perigee field below the simulation, which records your final reading.',
};

afterEach(cleanup);

const Stateful = ({
  readyForInput,
  handledKeys,
  spy,
}: {
  readonly readyForInput?: string;
  readonly handledKeys?: readonly string[];
  readonly spy?: { engage: () => void; release: () => void };
}) => (
  <SimulationQuestion
    spec={spec}
    prompt="What happens to the perigee as the orbit decays?"
    title="Orbital decay"
    textAlternative={textAlternative}
    onEngage={() => {
      spy?.engage();
    }}
    onRelease={() => {
      spy?.release();
    }}
    handledKeys={handledKeys}
    readyForInput={readyForInput}
  />
);

describe('as DRAWN', () => {
  it('is an APPLICATION region named by the sim title PLUS the question text', async () => {
    await assertRendersContract('simulation', <Stateful />);
    const region = screen.getByRole('application', {
      name: /Orbital decay\. What happens to the perigee/,
    });
    expect(region).toBeDefined();
    /**
     * The title alone says which simulation and the question alone says nothing about what will happen, so the
     * contract asks for both. Either half on its own is an announcement the student cannot act on.
     */
    expect(region.getAttribute('aria-label')).toBe(
      'Orbital decay. What happens to the perigee as the orbit decays?',
    );
  });

  it('carries a TEXT ALTERNATIVE with all THREE parts, because for a blind student it IS the question', async () => {
    const { container } = await assertRendersContract('simulation', <Stateful />);
    /**
     * `plans/15` calls canvas the biggest risk in the plan, and the failure is subtle: a summary like "an orbital
     * simulation" passes every check and answers nothing. The contract names three parts and all three are asserted.
     */
    expect(container.textContent).toContain(textAlternative.shows);
    expect(container.textContent).toContain(textAlternative.task);
    expect(container.textContent).toContain(textAlternative.reportedIn);
    expect(screen.getByText('What this shows')).toBeDefined();
    expect(screen.getByText('Where your answer is reported')).toBeDefined();
  });

  it('VISIBLELY renders the text alternative and describes the region with it', async () => {
    const { container } = await assertRendersContract('simulation', <Stateful />);
    // Not `hidden`: a text alternative a sighted keyboard user cannot read is not an alternative for them either.
    const alt = container.querySelector('dl');
    expect(alt).not.toBeNull();
    const region = screen.getByRole('application');
    expect(region.getAttribute('aria-describedby')).toBe(alt?.id);
  });

  it('does NOT take focus on mount, because `focusOnMount: PRESERVED`', async () => {
    await assertRendersContract('simulation', <Stateful />);
    /**
     * Mounting a question must never yank focus from wherever the student was -- `plans/15`'s rule is that focus
     * moves only deliberately. So the surface is focusable but not focused.
     */
    const surface = screen.getByRole('button', { name: /interactive surface/ });
    expect(surface).not.toBe(document.activeElement);
    expect(document.activeElement).toBe(document.body);
  });

  it('shows the PINNED sim id and version, which is how a bug report identifies what the student saw', async () => {
    const { container } = await assertRendersContract('simulation', <Stateful />);
    expect(container.textContent).toContain('orbital-decay@1.4.0');
  });

  it('announces ONLY `readyForInput`, politely', async () => {
    const { container } = await assertRendersContract(
      'simulation',
      <Stateful readyForInput="Ready for input." />,
    );
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe('Ready for input.');
  });

  it('has an EMPTY live region when there is nothing ready, rather than repeating the title', async () => {
    const { container } = await assertRendersContract('simulation', <Stateful />);
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
  });
});

describe('as DRIVEN', () => {
  it('hands control over on Enter, and says in its name how', async () => {
    const spy = { engage: vi.fn(), release: vi.fn() };
    await assertRendersContract('simulation', <Stateful spy={spy} />);
    const surface = screen.getByRole('button', { name: /Press Enter to hand control/ });
    surface.focus();
    await userEvent.keyboard('{Enter}');
    expect(spy.engage).toHaveBeenCalledTimes(1);
    expect(spy.release).not.toHaveBeenCalled();
  });

  it('returns control to the question chrome on Escape, and focus goes somewhere VISIBLE', async () => {
    const spy = { engage: vi.fn(), release: vi.fn() };
    await assertRendersContract('simulation', <Stateful spy={spy} />);
    screen.getByRole('button', { name: /interactive surface/ }).focus();
    await userEvent.keyboard('{Escape}');
    expect(spy.release).toHaveBeenCalledTimes(1);
    /**
     * Releasing control while focus stays inside the sim would leave the student with focus on a surface they have
     * just been told they left. `plans/15`: focus is never lost, and never left where it cannot be seen.
     */
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Return to the question/ }),
    );
  });

  it('gives a CLICK route back too, because clicking is how a student engages and so has no keypress to discover Escape from', async () => {
    const spy = { engage: vi.fn(), release: vi.fn() };
    await assertRendersContract('simulation', <Stateful spy={spy} />);
    await userEvent.click(screen.getByRole('button', { name: /Return to the question/ }));
    expect(spy.release).toHaveBeenCalledTimes(1);
    // A visible route exists regardless of whether the student ever presses Escape.
    expect(screen.getByRole('button', { name: /Return to the question/ })).toBeDefined();
  });

  it('does NOT trap Tab, which is WCAG 2.1.2 and unconditional', async () => {
    await assertRendersContract('simulation', <Stateful />);
    const surface = screen.getByRole('button', { name: /interactive surface/ });
    surface.focus();
    const before = document.activeElement;
    await userEvent.tab();
    /**
     * `Escape` is the DISCOVERABLE route out, not the only one. A widget that swallows Tab to keep focus inside
     * itself is a keyboard trap unless it provides an explicit exit, and this one does -- so trapping as well would
     * make the exit harder to find, not safer.
     */
    expect(before).toBe(surface);
    expect(document.activeElement).not.toBe(surface);
  });

  it('does NOT steal Escape from a simulation that uses it as its own key', async () => {
    const spy = { engage: vi.fn(), release: vi.fn() };
    await assertRendersContract('simulation', <Stateful spy={spy} handledKeys={['Escape']} />);
    screen.getByRole('button', { name: /interactive surface/ }).focus();
    await userEvent.keyboard('{Escape}');
    /**
     * `Escape` is a common simulation key -- cancel a run, close a dialog. Releasing unconditionally would make
     * Escape unusable inside the sim, which is the one place the student most needs their own keys.
     */
    expect(spy.release).not.toHaveBeenCalled();
  });

  it('ignores everything else, because the keys belong to the simulation', async () => {
    const spy = { engage: vi.fn(), release: vi.fn() };
    await assertRendersContract('simulation', <Stateful spy={spy} />);
    const surface = screen.getByRole('button', { name: /interactive surface/ });
    surface.focus();
    await userEvent.keyboard('{ArrowLeft}{a}{7}');
    expect(spy.engage).not.toHaveBeenCalled();
    expect(spy.release).not.toHaveBeenCalled();
  });
});
