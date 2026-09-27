// @vitest-environment jsdom
/**
 * The slash palette and the four atomic node views.  (P2-T3c)
 *
 * ## The three tests this file is for
 *
 *  · `FOCUS NEVER LEAVES THE INPUT while arrowing` — the non-trap property, asserted across every
 *    entry rather than the first two.
 *  · `Tab moves on instead of selecting` — a palette that captures Tab is a keyboard trap by
 *    definition.
 *  · `a 6x40 table is ONE tab stop` — the reason the four types are atomic, measured rather than
 *    asserted in a comment.
 */

import type { Block } from '@orrery/contracts/blocks';
import {
  PALETTE,
  paletteQuery,
  searchPalette,
  shouldOpenPalette,
  stripCommand,
} from '@orrery/contracts/editor/palette';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtomicNode } from './AtomicNodeViews.js';
import { SlashPalette } from './SlashPalette.js';

afterEach(cleanup);

describe('palette matching', () => {
  it('finds a list when the author types "bullet"', () => {
    // The whole reason keywords exist. An author does not know the schema.
    expect(searchPalette('bullet')[0]?.type).toBe('list');
    expect(searchPalette('todo')[0]?.type).toBe('list');
    expect(searchPalette('quote')[0]?.type).toBe('blockquote');
    expect(searchPalette('latex')[0]?.type).toBe('equation');
  });

  it('ranks a label prefix above a keyword', () => {
    // Typing three letters must not make the right answer fourth.
    const first = searchPalette('tab');
    expect(first[0]?.type).toBe('table');
  });

  it('keeps equally-scored matches in a stable order', () => {
    // An author arrowing down should not have the list reshuffle as they type.
    const a = searchPalette('im').map((e) => e.type);
    const b = searchPalette('im').map((e) => e.type);
    expect(a).toEqual(b);
  });

  it('returns everything for an empty query, because browsing is useful', () => {
    expect(searchPalette('')).toHaveLength(16);
    expect(searchPalette('   ')).toHaveLength(16);
  });

  it('covers every block type exactly once', () => {
    // A type with no palette entry cannot be inserted at all, and a type with two is a duplicate
    // row an author has to read past.
    const types = PALETTE.map((e) => e.type);
    expect(new Set(types).size).toBe(16);
  });

  it('stays open WHILE the query is typed, which is the whole point', () => {
    // The first version checked that the text ENDED with `/`, which is true for exactly one
    // keystroke -- so the palette closed on the next character and could never be filtered. Type
    // `/`, see sixteen blocks, type `t`, and the list vanished.
    expect(shouldOpenPalette('/', 1)).toBe(true);
    expect(shouldOpenPalette('/tab', 4)).toBe(true);
    expect(shouldOpenPalette('/bullet', 7)).toBe(true);
  });

  it('does not open mid-line, because a slash in a sentence is a slash', () => {
    expect(shouldOpenPalette('tides/', 6)).toBe(false);
    expect(shouldOpenPalette('3/4', 3)).toBe(false);
    expect(shouldOpenPalette('and/or', 6)).toBe(false);
    // But a new LINE is a new context, so a slash at the start of one does open.
    expect(shouldOpenPalette('a\n/', 3)).toBe(true);
    expect(shouldOpenPalette('a\n/tab', 6)).toBe(true);
    expect(shouldOpenPalette('a\nx/', 4)).toBe(false);
  });

  it('reads the query from the same place it decides the palette is open', () => {
    // Computed two different ways, these disagree at the end of a line, and the symptom is a
    // palette filtering on the wrong text.
    expect(paletteQuery('/tab', 4)).toBe('tab');
    expect(paletteQuery('/bullet', 7)).toBe('bullet');
    expect(paletteQuery('a\n/tab', 6)).toBe('tab');
    expect(paletteQuery('3/4', 3)).toBeNull();
  });

  it('strips the command and leaves the rest of the line alone', () => {
    expect(stripCommand('/tab', 4, 3)).toBe('');
    expect(stripCommand('a /tab b', 6, 3)).toBe('a  b');
  });
});

describe('the palette is not a keyboard trap', () => {
  const setup = () => {
    const onInsert = vi.fn();
    const onChange = vi.fn();
    const onClose = vi.fn();
    // A bare `/` at the START of a line. The first version of this fixture was `hello /`, which
    // is mid-line -- and the palette correctly refuses to open there, so the test was failing
    // because its own input was wrong. `shouldOpenPalette` is working; the fixture was not.
    const utils = render(
      <SlashPalette
        value="/"
        caret={1}
        onChange={onChange}
        onInsert={onInsert}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    input.focus();
    return { onInsert, onChange, onClose, input, utils };
  };

  it('FOCUS NEVER LEAVES THE INPUT while arrowing through every entry', () => {
    const { input } = setup();
    const count = screen.getAllByRole('option').length;
    expect(count).toBe(16);
    // Arrows all the way round, twice, so a wrap-around bug cannot hide.
    for (let i = 0; i < count * 2; i += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(document.activeElement, `after ${i + 1} downs`).toBe(input);
    }
    for (let i = 0; i < count; i += 1) {
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(input);
    }
  });

  it('moves the ACTIVE OPTION with aria-activedescendant, not real focus', () => {
    // The documented ARIA combobox mechanism. If focus were moving instead, this attribute
    // would be absent -- and its absence is what makes a palette a trap.
    const { input } = setup();
    const first = screen.getAllByRole('option')[0];
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1];
    expect(second?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(second?.id);
  });

  it('Tab moves ON instead of selecting', () => {
    // A palette that captures Tab cannot reach the next control in the page. That is a trap by
    // definition, regardless of what Escape does.
    const { input, onInsert } = setup();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape closes, restores the text, and returns focus to the input', () => {
    // A stray `/` left in the document is the kind of small corruption that survives review.
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <SlashPalette
        value="/tab"
        caret={4}
        onChange={onChange}
        onInsert={vi.fn()}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ value: '', caret: 0 });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('inserts nothing on an empty query, because "/" then Enter is not a heading', () => {
    // Somebody typing `3/4`, or starting a line with a slash, would silently get a block.
    const onInsert = vi.fn();
    render(
      <SlashPalette value="/" caret={1} onChange={vi.fn()} onInsert={onInsert} onClose={vi.fn()} />,
    );
    const input = screen.getByRole('combobox');
    // Browsable: all sixteen, which is useful.
    expect(screen.getAllByRole('option')).toHaveLength(16);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('inserts the chosen type and removes the command text', () => {
    const onInsert = vi.fn();
    const onChange = vi.fn();
    render(
      <SlashPalette
        value="/tab"
        caret={4}
        onChange={onChange}
        onInsert={onInsert}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onInsert).toHaveBeenCalledWith('table');
    expect(onChange).toHaveBeenCalledWith({ value: '', caret: 0 });
  });

  it('announces the COUNT rather than the selection', () => {
    render(
      <SlashPalette
        value="/ta"
        caret={3}
        onChange={vi.fn()}
        onInsert={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const live = document.querySelector('[aria-live="polite"]');
    // A screen-reader user needs to know whether the filter is working, not what is selected.
    expect(live?.textContent).toMatch(/\d+ blocks? available/);
  });

  it('opens from the TEXT, so a paste ending in a slash opens it too', () => {
    // The first version listened for the keypress and missed a paste entirely. Open state is
    // derived from the value, so whatever put the slash there does not matter.
    const { rerender } = render(
      <SlashPalette value="" caret={0} onChange={vi.fn()} onInsert={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    rerender(
      <SlashPalette value="/" caret={1} onChange={vi.fn()} onInsert={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(16);
  });

  it('does NOT open mid-line, because a slash in a sentence is a slash', () => {
    // Opening a palette over somebody's half-written prose is the kind of "helpful" that makes
    // an editor unusable.
    render(
      <SlashPalette
        value="3/4"
        caret={3}
        onChange={vi.fn()}
        onInsert={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// ── The atomic node views ─────────────────────────────────────────────────────

const table = (cols: number, rows: number): Block => ({
  type: 'table',
  id: '00000000-0000-4000-8000-0000000000aa',
  caption: 'Surface gravity by body',
  header: Array.from({ length: cols }, (_, i) => `c${i}`),
  rows: Array.from({ length: rows }, () => Array.from({ length: cols }, (_, i) => `${i}`)),
});

describe('the four atomic node views', () => {
  it('a 6x40 table is ONE tab stop, which is why it is atomic', () => {
    // 240 cells. As ordinary editable content that is 240 focus stops between one block and the
    // next, and "no keyboard trap anywhere" stops being achievable.
    const block = table(6, 40);
    const cells = block.type === 'table' ? block.header.length * block.rows.length : 0;
    expect(cells).toBe(240);

    render(<AtomicNode block={block} onEdit={vi.fn()} position={0} total={1} />);
    const group = screen.getByTestId('node-table');

    // ONE tab stop, and it is the Edit control. The first version also put tabIndex on the
    // section, giving TWO stops per block -- land on the group, tab again to reach Edit -- and
    // making a non-interactive element focusable besides.
    expect(group.getAttribute('tabindex')).toBeNull();
    const tabbable = group.querySelectorAll(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(tabbable.length).toBe(1);

    // And the block's whole description is in that control's ACCESSIBLE NAME, so one Tab both
    // lands on the action and says what it acts on. A visually hidden paragraph does not work
    // here, because a non-focusable group is never announced on focus.
    const edit = within(group).getByRole('button');
    const name = edit.getAttribute('aria-label') ?? '';
    expect(name).toContain('Surface gravity by body');
    expect(name).toContain('240 cells');
    expect(name).toContain('6 columns by 40 rows');
    // Visible text stays short; the description is for assistive tech.
    expect(edit.textContent).toBe('Edit table');
  });

  it('every atomic view exposes a labelled name that describes the CONTENT', () => {
    const cases: Block[] = [
      table(3, 2),
      {
        type: 'code',
        id: '00000000-0000-4000-8000-0000000000bb',
        code: 'a\nb\nc',
        language: 'python',
      },
      {
        type: 'embedExternal',
        id: '00000000-0000-4000-8000-0000000000cc',
        provider: 'youtube',
        providerId: 'abc123',
        title: 'A talk about tides',
      },
      {
        type: 'embedSimulation',
        id: '00000000-0000-4000-8000-0000000000dd',
        simId: 'tidal-locking',
        simVersion: '1.4.2',
        params: {},
        seedPolicy: 'FIXED',
        mode: 'graded',
      },
    ];
    for (const block of cases) {
      const { unmount } = render(
        <AtomicNode block={block} onEdit={vi.fn()} position={0} total={1} />,
      );
      // The testid is PER TYPE, so the assertion is about the right view rather than whichever
      // one happens to be on screen -- a blanket replace once hardcoded `node-table` here, and
      // every case after the first was being checked against the table's markup.
      const group = screen.getByTestId(`node-${block.type}`);
      // A screen-reader user moving through a document should hear the document, so the name
      // carries the author's own words and the facts that matter.
      const name = within(group).getByRole('button').getAttribute('aria-label') ?? '';
      expect(name.length, block.type).toBeGreaterThan(10);
      expect(name, block.type).toMatch(/^Edit /);
      unmount();
    }
  });

  it('names a simulation by its id, mode and seed, and WARNS about a gradeable float', () => {
    const bad = render(
      <AtomicNode
        block={{
          type: 'embedSimulation',
          id: '00000000-0000-4000-8000-0000000000dd',
          simId: 'tidal-locking',
          simVersion: '1.4.2',
          params: {},
          seedPolicy: 'PER_STUDENT',
          mode: 'graded',
        }}
        onEdit={vi.fn()}
        position={0}
        total={1}
      />,
    );
    // A GRADED simulation with a per-student seed cannot be marked, and the publish checklist
    // blocks it -- so the author finds out while editing rather than at publish time.
    expect(screen.getByRole('alert').textContent).toContain('cannot be marked');
    // The warning is in the control's accessible name, since that is what is announced.
    const badName =
      within(screen.getByTestId('node-embedSimulation'))
        .getByRole('button')
        .getAttribute('aria-label') ?? '';
    expect(badName).toContain('WARNING seed is not fixed');
    bad.unmount();

    render(
      <AtomicNode
        block={{
          type: 'embedSimulation',
          id: '00000000-0000-4000-8000-0000000000de',
          simId: 'orbits',
          simVersion: '2.0.0',
          params: {},
          seedPolicy: 'FIXED',
          mode: 'practice',
        }}
        onEdit={vi.fn()}
        position={0}
        total={1}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing for a non-atomic block', () => {
    const { container } = render(
      <AtomicNode
        block={{ type: 'divider', id: '00000000-0000-4000-8000-0000000000ee', variant: 'solid' }}
        onEdit={vi.fn()}
        position={0}
        total={1}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
