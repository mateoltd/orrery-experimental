// @vitest-environment jsdom
/**
 * The `ordering` renderer, and the `2.5.7` requirement it exists to satisfy.  (P7-T7)
 *
 * ## THE TEST THAT MATTERS IS THE ONE THAT PROVES MOVE IS NOT SWAP
 *
 * Everything else here -- focus, the roving tabindex, the announcement -- is supporting detail for a single
 * requirement: a keyboard reorder must produce **the same document** a pointer reorder produces. A swap produces a
 * different one, and a blind student and a sighted student would then submit different answers to the same question.
 */

import type { PublicOrderingSpec } from '@orrery/contracts/question';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRendersContract, PUBLIC_COMMON } from './contractHarness.js';
import { moveItem, OrderingQuestion } from './OrderingQuestion';

afterEach(cleanup);

const spec: PublicOrderingSpec = {
  ...PUBLIC_COMMON,
  type: 'ordering',
  items: [
    { id: 'a', text: 'Solar wind' },
    { id: 'b', text: 'Magnetosphere' },
    { id: 'c', text: 'Ionosphere' },
    { id: 'd', text: 'Thermosphere' },
  ],
};

const PROMPT = 'Put these layers in order, from the Sun outwards.';

/** Stateful, because a controlled list pinned to a fixed `value` cannot be reordered at all. */
const Stateful = ({
  initial = ['a', 'b', 'c', 'd'],
  spy,
}: {
  readonly initial?: readonly string[];
  readonly spy?: (ids: readonly string[]) => void;
}): React.ReactElement => {
  const [order, setOrder] = React.useState<readonly string[]>(initial);
  return (
    <OrderingQuestion
      spec={spec}
      prompt={PROMPT}
      value={order}
      onChange={(next) => {
        spy?.(next);
        setOrder(next);
      }}
    />
  );
};

describe('moveItem SPLICES, and that is the whole of 2.5.7', () => {
  it('MOVES the item and shifts the others, rather than exchanging two positions', () => {
    // A swap here would give `[c, b, a]`; the correct document is `[a, c, b]`.
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    // And this is the assertion a swap-based implementation fails.
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -2)).toEqual(['c', 'a', 'b']);
  });

  it('is a NO-OP for an out-of-range move, rather than clamping to the end', () => {
    // Clamping would report a move that did not happen, and the live-region announcement would then be a lie
    // about the document the student just submitted.
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const order = ['a', 'b', 'c'];
    moveItem(order, 0, 2);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('handles the empty and single-item cases', () => {
    expect(moveItem([], 0, 1)).toEqual([]);
    expect(moveItem(['a'], 0, 1)).toEqual(['a']);
  });
});

describe('as DRAWN', () => {
  it('satisfies axe and its contract', async () => {
    await assertRendersContract('ordering', <Stateful />);
  });

  it("is a LISTBOX of options, in the student's order", async () => {
    await assertRendersContract('ordering', <Stateful />);
    expect(screen.getByRole('listbox')).toBeDefined();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    // The options carry the ITEM TEXT only. The `↑`/`↓` buttons are in the toolbar, because an option may not
    // contain focusable children -- see the `nested-interactive` case below.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Solar wind',
      'Magnetosphere',
      'Ionosphere',
      'Thermosphere',
    ]);
  });

  it('keeps the reorder controls OUTSIDE the listbox, because an option may not contain focusable children', async () => {
    /**
     * axe reported `nested-interactive` on all four items when the buttons were inside each `<li role="option">`,
     * and it was right: `role="option"` says "this element is itself the thing you interact with", so a button
     * inside it makes the item a composite widget no assistive technology knows how to describe.
     *
     * The controls are a TOOLBAR acting on the selected item, which is also the better pattern: one pair of buttons
     * for the whole list rather than eight, and the label names the item that will move rather than a position
     * that changes under the reader.
     */
    await assertRendersContract('ordering', <Stateful />);
    const toolbar = screen.getByRole('group', { name: /Reorder/ });
    expect(toolbar.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(
      screen.getAllByRole('option').every((option) => option.querySelector('button') === null),
    ).toBe(true);
  });

  it('labels the controls with the SELECTED item, and disables the impossible directions', async () => {
    await assertRendersContract('ordering', <Stateful />);
    // First item selected: up is impossible, and the down button names the item that WILL move.
    expect(screen.getByRole('button', { name: 'Move Solar wind up' })).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Move Solar wind up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Move Solar wind down' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('as DRIVEN: the keyboard equivalent produces the SAME DOCUMENT', () => {
  it('moves an item with Alt+ArrowDown, splicing rather than swapping', async () => {
    const spy = vi.fn();
    await assertRendersContract('ordering', <Stateful spy={spy} />);
    screen.getAllByRole('option')[0]?.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    // `[a,b,c,d]` with `a` moved down one is `[b,a,c,d]` -- the swap would be `[b,a,c,d]` too, so this case
    // alone does not distinguish them; the next one does.
    expect(spy).toHaveBeenCalledWith(['b', 'a', 'c', 'd']);
  });

  it('moves an item THREE places and shifts the rest, which a swap could not do', async () => {
    /**
     * THE ASSERTION THAT SEPARATES MOVE FROM SWAP.
     *
     * Moving `a` down three in `[a,b,c,d]` gives `[b,c,d,a]`. A swap-based implementation would give `[d,b,c,a]`:
     * one correct element and a wrong tail, which is a DIFFERENT PAPER. A student who reordered with a keyboard
     * would submit an answer the marker cannot reconcile with anyone else's.
     */
    const spy = vi.fn();
    await assertRendersContract('ordering', <Stateful spy={spy} />);

    /**
     * EACH MOVE IS SYNCHRONIZED ON RATHER THAN FIRED BACK TO BACK.
     *
     * The first version of this test chained three keystrokes and asserted on the final list. It passed alone and
     * failed in the full suite, which is the worst kind of failure: the cause is that a move hands focus to the
     * moved item inside a `requestAnimationFrame`, so a keystroke issued before React has re-rendered lands on
     * the previous render's state. How many of the three moves land then depends on machine load, and the test
     * result with it.
     *
     * `waitFor` on the call count turns that race into an explicit synchronization point: move `n` is not attempted
     * until move `n - 1` has been observed, so the sequence is deterministic and the final list is assertable.
     */
    /** Lets the renderer's own `requestAnimationFrame` focus handoff finish, so it cannot steal focus mid-test. */
    const settleFrame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    };

    for (let step = 0; step < 3; step += 1) {
      await settleFrame();
      const options = screen.getAllByRole('option');
      const target = options[step];
      if (target === undefined) throw new Error(`expected at least ${step + 1} options`);
      target.focus();
      await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(step + 1);
      });
    }

    expect(spy).toHaveBeenLastCalledWith(['b', 'c', 'd', 'a']);

    /**
     * EVERY INTERMEDIATE DOCUMENT IS ALSO A ROTATION. This is the property that actually rules out a swap
     * implementation: moving `a` down repeatedly walks it toward the end while shifting everything up once, so
     * each step is `[b,a,c,d]`, `[b,c,a,d]`, `[b,c,d,a]`. A swap-based `moveItem` yields `[b,a,c,d]` then
     * `[c,b,a,d]` -- a transposed pair with an untouched tail, which is not a rotation of the previous document.
     */
    for (const [index, call] of spy.mock.calls.entries()) {
      const result = call[0] as string[];
      expect([...result].sort()).toEqual(['a', 'b', 'c', 'd']);
      if (index > 0) {
        const previous = spy.mock.calls[index - 1]?.[0] as string[];
        const movedFrom = previous.indexOf('a');
        const movedTo = result.indexOf('a');
        expect(movedTo).toBe(movedFrom + 1);
        for (let i = 0; i < result.length; i += 1) {
          if (i !== movedFrom && i !== movedTo) expect(result[i]).toBe(previous[i]);
        }
      }
    }
  });

  it('moves focus with BARE arrows and moves the item with Alt+arrows, and never confuses them', async () => {
    const spy = vi.fn();
    await assertRendersContract('ordering', <Stateful spy={spy} />);
    const options = screen.getAllByRole('option');
    options[0]?.focus();
    // Bare arrow: focus moves, nothing is reordered.
    await userEvent.keyboard('{ArrowDown}');
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toContain('Magnetosphere');
  });

  it('keeps exactly ONE item in the tab order, so Tab enters the list once', async () => {
    /**
     * The roving tabindex, which is what makes `Arrow` and `Alt+Arrow` unambiguous: if every item were a tab stop,
     * `Tab` would walk past each one and the arrows would have no defined starting point.
     */
    await assertRendersContract('ordering', <Stateful />);
    const tabbable = screen
      .getAllByRole('option')
      .filter((option) => option.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
  });

  it('reaches both ends with Home and End, so no one presses an arrow twenty times', async () => {
    await assertRendersContract('ordering', <Stateful />);
    screen.getAllByRole('option')[0]?.focus();
    await userEvent.keyboard('{End}');
    expect(document.activeElement?.textContent).toContain('Thermosphere');
    await userEvent.keyboard('{Home}');
    expect(document.activeElement?.textContent).toContain('Solar wind');
  });

  it('ANNOUNCES the move politely, with the item and its new position', async () => {
    await assertRendersContract('ordering', <Stateful />);
    screen.getAllByRole('option')[0]?.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    // "one announcement per COMPLETED move, naming the item and where it went"
    expect(live.textContent).toContain('Solar wind');
    expect(live.textContent).toContain('2 of 4');
  });

  it('does NOT announce a move that did not happen', async () => {
    // The first item cannot move up. Announcing "1 of 4" after a refused move would be a lie about the document.
    await assertRendersContract('ordering', <Stateful />);
    screen.getAllByRole('option')[0]?.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('reorders with the visible BUTTONS and produces the same document as the keyboard', async () => {
    const spy = vi.fn();
    await assertRendersContract('ordering', <Stateful spy={spy} />);
    // Select the THIRD item, then move it up: the toolbar acts on the selection.
    const options = screen.getAllByRole('option');
    const third = options[2];
    if (third === undefined) throw new Error('the list should have three items');
    await userEvent.click(third);
    await userEvent.click(screen.getByRole('button', { name: 'Move Ionosphere up' }));
    // Same splice, so the pointer path and the keyboard path cannot diverge -- which is the requirement.
    expect(spy).toHaveBeenCalledWith(['a', 'c', 'b', 'd']);
  });

  it('reorders a THREE-item list identically by keyboard and by button', async () => {
    // The regression guard for a swap-based implementation: with three items every swap happens to equal the move,
    // so a four-item list is where the two diverge and this is the case worth having both paths compared on.
    const byKeyboard = vi.fn();
    await assertRendersContract(
      'ordering',
      <Stateful initial={['a', 'b', 'c', 'd']} spy={byKeyboard} />,
    );
    screen.getAllByRole('option')[0]?.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    const keyboardResult = byKeyboard.mock.calls[0]?.[0];

    cleanup();
    const byButton = vi.fn();
    await assertRendersContract(
      'ordering',
      <Stateful initial={['a', 'b', 'c', 'd']} spy={byButton} />,
    );
    // The toolbar moves the SELECTED item, which is the first after a fresh mount.
    await userEvent.click(screen.getByRole('button', { name: 'Move Solar wind down' }));
    const buttonResult = byButton.mock.calls[0]?.[0];

    // Both paths produce the SAME list, which is what "the same outcome" means.
    expect(keyboardResult).toEqual(buttonResult);
    expect(keyboardResult).toEqual(['b', 'a', 'c', 'd']);
  });
});
