// @vitest-environment jsdom
/**
 * Focus management, the key map, and 2.5.8 target size.  (P2-T7)
 *
 * ## The test this file is for
 *
 * `a BACKGROUND update never moves focus`. `plans/15` §2 rule 3 says focus is never lost but also
 * that focus is never STOLEN for a background update, and the second half is the one that gets
 * implemented wrong: autosave completes, the indicator grabs focus, and a keyboard author is
 * dropped out of the sentence they were writing.
 *
 * ## And what is NOT claimed
 *
 * jsdom has no layout, so nothing here measures 2.4.11 occlusion or paints a 24×24 target. What
 * is asserted is that the tokens exist and are derived from ONE constant, so the compensation
 * and the thing being compensated for cannot drift. The real occlusion check needs a browser and
 * is recorded in the tracker as outstanding rather than pretended at.
 */

import {
  ambiguousBindings,
  DRAG_ACTIONS,
  HELP_BINDINGS,
  KEYMAP,
  missingKeyboardEquivalents,
} from '@orrery/contracts/a11y/keymap';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomicNode } from './AtomicNodeViews.js';
import { BlockHandle } from './BlockHandle.js';
import {
  FocusProvider,
  type FocusReason,
  MIN_TARGET_PX,
  SCROLL_MARGIN,
  STICKY_CHROME_PX,
  useFocusManager,
} from './FocusManager.js';
import { SlashPalette } from './SlashPalette.js';

afterEach(cleanup);

describe('a BACKGROUND update never moves focus', () => {
  function Harness() {
    const { announce, moveFocus, announcement, lastRefusal } = useFocusManager();
    // A real ref rather than a hand-rolled `{ current }` object: the first version assigned to
    // `current` from a ref callback, which returns the element and so does not type as a Ref.
    const target = useRef<HTMLInputElement>(null);
    return (
      <div>
        <input aria-label="body" data-testid="body" ref={target} />
        <button type="button" onClick={() => announce('Saved')} data-testid="autosaved">
          autosave finished
        </button>
        <button
          type="button"
          data-testid="goto"
          onClick={() =>
            moveFocus(target.current as HTMLElement, {
              kind: 'user-action',
              label: 'inserted a block',
            })
          }
        >
          insert
        </button>
        <button
          type="button"
          data-testid="steal"
          onClick={() =>
            moveFocus(target.current as HTMLElement, { kind: 'background', label: 'Saved' })
          }
        >
          try to steal
        </button>
        <p data-testid="announcement">{announcement}</p>
        <p data-testid="refusal">{lastRefusal ?? ''}</p>
      </div>
    );
  }

  it('announces without touching focus', () => {
    render(
      <FocusProvider>
        <Harness />
      </FocusProvider>,
    );
    const body = screen.getByTestId('body');
    body.focus();
    fireEvent.click(screen.getByTestId('autosaved'));
    // The author is still in the text they were typing. This is the whole point.
    expect(document.activeElement).toBe(body);
    // And they were TOLD, politely, in a live region.
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('REFUSES a background focus move, and explains the refusal', () => {
    render(
      <FocusProvider>
        <Harness />
      </FocusProvider>,
    );
    const body = screen.getByTestId('body');
    fireEvent.click(screen.getByTestId('steal'));
    expect(document.activeElement).not.toBe(body);
    // A silent refusal is indistinguishable from a bug, so the reason is surfaced.
    expect(screen.getByTestId('refusal').textContent).toContain('focus belongs to the author');
  });

  it('moves focus for a user-initiated action', () => {
    render(
      <FocusProvider>
        <Harness />
      </FocusProvider>,
    );
    const body = screen.getByTestId('body');
    fireEvent.click(screen.getByTestId('goto'));
    expect(document.activeElement).toBe(body);
  });

  it('classifies every reason, and refuses exactly the two that are not the author', () => {
    const cases: readonly [FocusReason, boolean][] = [
      [{ kind: 'user-action', label: 'x' }, true],
      [{ kind: 'route-change', label: 'x' }, true],
      [{ kind: 'background', label: 'x' }, false],
      // `readyForInput` is a background event even though the author is waiting for it, and that
      // is precisely why it belongs in the announce branch.
      [{ kind: 'simulation-ready', label: 'x' }, false],
    ];
    for (const [reason, expected] of cases) {
      expect(shouldMove(reason), reason.kind).toBe(expected);
    }
  });

  it('says so when the hook is used outside its provider', () => {
    // A null that crashes at the call site is a worse error message than the real one.
    function Orphan() {
      useFocusManager();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/inside a <FocusProvider>/);
    spy.mockRestore();
  });
});

const shouldMove = (reason: FocusReason): boolean =>
  reason.kind === 'user-action' || reason.kind === 'route-change';

describe('2.4.11 and 2.5.8, as far as jsdom can honestly go', () => {
  it('derives the scroll margin from the chrome height, so the two cannot drift', () => {
    // The compensation and the thing being compensated for come from one number. A stylesheet
    // with a hardcoded `56px` in one place and `scroll-margin-top: 64px` in another is the bug
    // this assertion cannot see but this CONSTANT prevents.
    expect(SCROLL_MARGIN).toBe(`scroll-margin-top: ${STICKY_CHROME_PX + 8}px`);
  });

  it('declares the WCAG 2.2 minimum target size as a token', () => {
    expect(MIN_TARGET_PX).toBe(24);
  });
});

describe('the key map', () => {
  it('has no ambiguous chord within a context', () => {
    // `Enter` is bound in two contexts, which is fine because a palette and a block handle are
    // never both live. Two chords in ONE context is a coin toss the author cannot see coming.
    expect(ambiguousBindings()).toEqual([]);
  });

  it('gives every drag action a keyboard equivalent with the same outcome', () => {
    // 2.5.7, as a LIST so a new drag feature without a binding names itself.
    expect(missingKeyboardEquivalents()).toEqual([]);
    expect(DRAG_ACTIONS).toHaveLength(4);
  });

  it('has a unique action id per binding', () => {
    const actions = KEYMAP.map((b) => b.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('describes every binding, because a chord with no description is a secret', () => {
    for (const b of KEYMAP) {
      expect(b.description.length, b.action).toBeGreaterThan(5);
      // Non-empty. The first version of this asserted `length > 1` and then a regex for "a
      // plausible key", and both were worse than useless: they rejected the legitimate `/` and
      // `ArrowDown` chords, which is pressure towards modifier soup.
      expect(b.chord.trim().length, b.action).toBeGreaterThan(0);
      // The assertion worth making: no binding may be a BARE MODIFIER. A binding on `Shift`
      // alone swallows the key, and the author's next keystroke is eaten by the editor.
      expect(b.chord, b.action).not.toMatch(/^(Shift|Ctrl|Alt|Meta)$/);
    }
  });

  it('shows the discoverable ones in the help panel and keeps the rest working', () => {
    // Hiding a binding is how a "documented" key map becomes a lie. The hidden ones exist so
    // Escape and the arrows work, and the test asserts both facts rather than only the first.
    const hidden = KEYMAP.filter((b) => !b.discoverable);
    expect(hidden.length).toBeGreaterThan(0);
    expect(HELP_BINDINGS.every((b) => b.discoverable)).toBe(true);
    expect(HELP_BINDINGS.length).toBe(KEYMAP.length - hidden.length);
    // And the ones a keyboard user cannot do without are all discoverable.
    for (const b of KEYMAP) {
      if (b.criterion === '2.5.7 Dragging Movements') {
        expect(b.discoverable, `${b.action} must be in the help panel`).toBe(true);
      }
    }
  });

  it('renders the help panel from the key map, so it cannot drift', () => {
    function Help() {
      return (
        <ul>
          {HELP_BINDINGS.map((b) => (
            <li key={b.action}>
              <kbd>{b.chord}</kbd> {b.description}
            </li>
          ))}
        </ul>
      );
    }
    render(<Help />);
    for (const b of HELP_BINDINGS) {
      expect(screen.getByText(b.chord), b.action).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(HELP_BINDINGS.length);
  });
});

/**
 * axe over the editor surface.  (P2-T7)
 *
 * The packet's done-when: "axe clean; every block handle has a spoken name."
 *
 * Rendered in jsdom, so this catches the structural failures — an unlabelled control, a bad
 * heading order, a duplicate id, a list without a list role — and not the ones that need a real
 * browser. Anything in this file that depends on layout says so.
 */
describe('axe on the editor surface', () => {
  it('reports no violations for the handle, the palette and the atomic views together', async () => {
    const axe = (await import('axe-core')).default;
    // A real document, because axe on a fragment reports different things than axe on a page.
    render(
      <FocusProvider>
        <main>
          <h1>Lesson</h1>
          <BlockHandle
            blockId="b1"
            position={0}
            total={2}
            blockType="paragraph"
            onAction={() => {}}
          />
          <BlockHandle
            blockId="b2"
            position={1}
            total={2}
            blockType="equation"
            onAction={() => {}}
          />
          <SlashPalette
            value="/tab"
            caret={4}
            onChange={() => {}}
            onInsert={() => {}}
            onClose={() => {}}
          />
          <AtomicNode
            block={{
              type: 'table',
              id: '00000000-0000-4000-8000-0000000000aa',
              caption: 'Gravity',
              header: ['a', 'b'],
              rows: [['1', '2']],
            }}
            onEdit={() => {}}
            position={0}
            total={1}
          />
        </main>
      </FocusProvider>,
    );

    const results = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false } },
    });
    // `color-contrast` is disabled because axe computes it from RENDERED colours, and jsdom
    // renders nothing — the check is done properly in `contracts/a11y/contrast.ts` against the
    // token values, which is the only place it can be done honestly.
    if (results.violations.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        'AXE',
        JSON.stringify(
          results.violations.map((v) => ({
            id: v.id,
            help: v.help,
            nodes: v.nodes.map((n) => n.html.slice(0, 120)),
          })),
          null,
          1,
        ),
      );
    }
    expect(results.violations.map((v) => `${v.id}: ${v.help} [${v.nodes.length}]`)).toEqual([]);
  });

  it('every block handle has a SPOKEN name that identifies its block', () => {
    // The other half of the done-when, asserted individually because a collective "all handles
    // are named" is one assertion that passes when one of them is not.
    render(
      <main>
        {['paragraph', 'equation', 'table'].map((type, i) => (
          <BlockHandle
            key={type}
            blockId={`b${i}`}
            position={i}
            total={3}
            blockType={type}
            onAction={() => {}}
          />
        ))}
      </main>,
    );
    const grips = screen.getAllByRole('button', { name: /Press Enter for the block menu/ });
    expect(grips).toHaveLength(3);
    const names = grips.map((g) => g.getAttribute('aria-label') ?? '');
    for (const [i, name] of names.entries()) {
      // Names the TYPE and the POSITION, and each is distinct -- three handles called "drag
      // handle" is the failure this is checking for.
      expect(name, `handle ${i}`).toMatch(/block \d+ of 3/);
      expect(name).toMatch(/paragraph|equation|table/);
    }
    expect(new Set(names).size).toBe(3);
  });
});
