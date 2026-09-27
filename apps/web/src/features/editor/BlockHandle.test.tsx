// @vitest-environment jsdom
/**
 * The block handle, and the blocker it resolves.  (P2-T3b)
 *
 * ## The test that settles blocker 1
 *
 * `renders all 500 handles as real, focusable, named buttons`. Blocker 1 was that virtualisation
 * unmounts off-screen DOM and therefore unmounts the focusable controls, so the two stated
 * requirements could not both hold. The resolution is `content-visibility`, which skips rendering
 * without removing the element — and this suite proves the element is there, is a `<button>`, has
 * an accessible name, and is focusable, at 500 blocks.
 *
 * ## What this suite cannot prove, and says so
 *
 * jsdom has no layout or paint engine, so it cannot show that the document is FAST. It proves the
 * mechanism is the non-unmounting one and that focusability survives at scale. The performance
 * claim itself needs a real browser, and asserting it here would be asserting nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockHandle, moveBlock, VIRTUALISATION_CSS } from './BlockHandle.js';

afterEach(cleanup);

/** The 500-block fixture the packet asks for. */
const BLOCKS = Array.from({ length: 500 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  type: i % 3 === 0 ? 'paragraph' : i % 3 === 1 ? 'equation' : 'embedSimulation',
}));

const noop = () => {};

/**
 * The GRIP, not "a button mentioning the position".
 *
 * The Move up and Move down buttons are named "Move up: paragraph block 3 of 500", so a matcher
 * of /block \d+ of 500/ finds all three per block and the 500 assertion came back as 1500.
 * Querying the grip by the phrase only IT has is the difference between testing the handle and
 * testing a substring.
 */
const GRIP = /Press Enter for the block menu/;

describe('the 500-block fixture', () => {
  it('renders all 500 handles as real, focusable, named buttons', () => {
    render(
      <div className="orrery-doc">
        <style>{VIRTUALISATION_CSS}</style>
        {BLOCKS.map((b, i) => (
          <BlockHandle
            key={b.id}
            blockId={b.id}
            position={i}
            total={BLOCKS.length}
            blockType={b.type}
            onAction={noop}
          />
        ))}
      </div>,
    );
    const grips = screen.getAllByRole('button', { name: GRIP });
    // Every one, and a real BUTTON — a `div` with `role="button"` and a tabIndex is how the
    // keyboard traps get in, because it comes without Enter, Space, or a disabled state.
    expect(grips).toHaveLength(500);
    for (const grip of grips) expect(grip.tagName).toBe('BUTTON');

    // Focusable: this is the property a virtualised list destroys, so it is asserted on the
    // 500th handle as well as the first. Off-screen-ness must not matter.
    grips[499]?.focus();
    expect(document.activeElement).toBe(grips[499]);
    grips[0]?.focus();
    expect(document.activeElement).toBe(grips[0]);
  });

  it('virtualises by SKIPPING RENDERING, not by unmounting', () => {
    // The mechanism is the whole blocker, so it is asserted directly rather than inferred.
    expect(VIRTUALISATION_CSS).toContain('content-visibility: auto');
    expect(VIRTUALISATION_CSS).toContain('contain-intrinsic-size');
    // Nothing that removes an element from the document. A JS virtualiser would appear here as
    // a windowing calculation; its absence is the point.
    expect(VIRTUALISATION_CSS).not.toMatch(/innerHeight|IntersectionObserver|translateY|spacer/);
  });

  it('degrades to SLOWER AND CORRECT where content-visibility is unsupported', () => {
    // The fallback must never be the loss of function. Asserted as text because that is what it
    // is: a CSS fallback, with no way to feature-detect in a test.
    expect(VIRTUALISATION_CSS).toContain('@supports not (content-visibility: auto)');
  });
});

describe('accessible names', () => {
  it('name the BLOCK and its position, not just "drag handle"', () => {
    render(
      <BlockHandle blockId="b1" position={2} total={10} blockType="equation" onAction={noop} />,
    );
    // "Drag handle" on forty rows tells a screen-reader user nothing about which row they are on.
    expect(screen.getByRole('button', { name: /equation, block 3 of 10/ })).toBeTruthy();
  });

  it('describe the handle with the shortcut list, using aria-describedby not aria-label', () => {
    render(
      <BlockHandle blockId="b1" position={0} total={10} blockType="paragraph" onAction={noop} />,
    );
    const grip = screen.getByRole('button', { name: /paragraph, block 1 of 10/ });
    const describedBy = grip.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy ?? '');
    expect(help?.textContent).toContain('Control Shift Up and Down');
    // A label REPLACES the visible text; a description supplements it. Overwriting the name
    // with the shortcut list would mean the name is never announced.
    expect(grip.getAttribute('aria-label')).toBeTruthy();
  });

  it('say when Move up is unavailable, in the description', () => {
    render(
      <BlockHandle blockId="b1" position={0} total={3} blockType="paragraph" onAction={noop} />,
    );
    const grip = screen.getByRole('button', { name: /paragraph, block 1 of 3/ });
    const help = document.getElementById(grip.getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toContain('unavailable at the top');
  });
});

describe('truthful boundaries', () => {
  it('disable Move up on the first block rather than doing nothing when pressed', () => {
    // A control that lies about availability is worse than no control: it looks like the
    // keyboard is broken.
    const onAction = vi.fn();
    const { rerender } = render(
      <BlockHandle blockId="b1" position={0} total={3} blockType="p" onAction={onAction} />,
    );
    const up = screen.getByRole('button', { name: /^Move up/ }) as HTMLButtonElement;
    expect(up.disabled).toBe(true);
    fireEvent.click(up);
    expect(onAction).not.toHaveBeenCalled();

    rerender(<BlockHandle blockId="b1" position={1} total={3} blockType="p" onAction={onAction} />);
    const up2 = screen.getByRole('button', { name: /^Move up/ }) as HTMLButtonElement;
    expect(up2.disabled).toBe(false);
    fireEvent.click(up2);
    expect(onAction).toHaveBeenCalledWith('move-up');
  });

  it('disable Move down on the last block', () => {
    render(<BlockHandle blockId="b1" position={2} total={3} blockType="p" onAction={noop} />);
    expect((screen.getByRole('button', { name: /^Move down/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('keyboard movement', () => {
  it('moves the block on Ctrl+Shift+Arrow and keeps focus on the SAME handle', () => {
    // The most common way a "keyboard-navigable" editor loses the keyboard user: after a move
    // the block is elsewhere, so a handle re-rendered at a new index drops focus to the body and
    // strands them at the top of the page.
    const onAction = vi.fn();
    render(
      <BlockHandle blockId="b1" position={1} total={5} blockType="paragraph" onAction={onAction} />,
    );
    const grip = screen.getByRole('button', { name: GRIP });
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    expect(onAction).toHaveBeenCalledWith('move-up');
    expect(document.activeElement).toBe(grip);
  });

  it('maps Right and Left to indent and outdent', () => {
    const onAction = vi.fn();
    render(
      <BlockHandle blockId="b1" position={1} total={5} blockType="list" onAction={onAction} />,
    );
    const grip = screen.getByRole('button', { name: GRIP });
    fireEvent.keyDown(grip, { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(grip, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['indent', 'outdent']);
  });

  it('ignores the arrows without all three modifiers, and plain arrow keys', () => {
    // Ctrl+Shift+Up means something else entirely in a text field, and a bare arrow key must
    // still scroll the document.
    const onAction = vi.fn();
    render(<BlockHandle blockId="b1" position={1} total={5} blockType="p" onAction={onAction} />);
    const grip = screen.getByRole('button', { name: GRIP });
    for (const init of [
      { key: 'ArrowUp' },
      { key: 'ArrowUp', ctrlKey: true },
      { key: 'ArrowUp', shiftKey: true },
      { key: 'ArrowUp', ctrlKey: true, metaKey: true },
    ]) {
      fireEvent.keyDown(grip, init);
    }
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('moveBlock, the 2.5.7 keyboard alternative to drag', () => {
  it('moves a block and leaves the rest in order', () => {
    expect(moveBlock(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveBlock(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('clamps rather than throwing or losing a block', () => {
    // A keyboard user holding the arrow key should reach the end and stop, not crash the editor
    // and not silently drop a block out of the document.
    expect(moveBlock(['a', 'b'], 0, 99)).toEqual(['b', 'a']);
    expect(moveBlock(['a', 'b'], 99, 0)).toEqual(['a', 'b']);
    expect(moveBlock(['a', 'b'], -5, 0)).toEqual(['a', 'b']);
  });

  it('never loses or duplicates a block', () => {
    const ids = ['a', 'b', 'c', 'd'];
    for (let from = 0; from < ids.length; from += 1) {
      for (let to = 0; to < ids.length; to += 1) {
        const next = moveBlock(ids, from, to);
        expect([...next].sort(), `${from}->${to}`).toEqual([...ids].sort());
      }
    }
  });
});
