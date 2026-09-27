// @vitest-environment jsdom
/**
 * The three-way panel.  (P2-T4)
 *
 * ## The two tests that matter
 *
 *  · `refuses to apply until EVERY conflict is chosen` — an apply button that silently applies
 *    half a merge is how somebody loses an edit, and the button says how many are left rather
 *    than just being greyed out.
 *  · `offers only the sides that exist` — a delete-vs-edit conflict has ONE legal pick, because
 *    the block is gone from one side and offering "delete" would be offering what that author
 *    already did.
 */

import { type MergeResult, mergeDocuments, type Resolution } from '@orrery/contracts/merge';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictPanel } from './ConflictPanel.js';

afterEach(cleanup);

let n = 0;
function id(): string {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}
type Para = { type: 'paragraph'; id: string; content: { text: string }[] };

const edited = (block: Para, text: string): Para => ({ ...block, content: [{ text }] });

/**
 * A paragraph with an explicit id.
 *
 * Fixtures used to build a block and then assign `block.id = a` afterwards, which needed an
 * `as never` and a cast back through `{id: string}` -- three casts to express "a block with this
 * id". Building it with the id is the same thing without the casts, and a fixture that needs
 * casts is usually a fixture that is lying about its shape.
 */
const fixed = (text: string, blockId: string): Para => ({
  type: 'paragraph',
  id: blockId,
  content: [{ text }],
});

/** Two editors who changed the SAME block differently. */
const editVsEdit = (): MergeResult => {
  const base = [fixed('original text', id())];
  return mergeDocuments(
    base,
    [edited(base[0] as Para, 'my version')],
    [edited(base[0] as Para, 'their version')],
  );
};

/** One editor deleted it, the other fixed a typo in it. */
const deleteVsEdit = (): MergeResult => {
  const base = [fixed('has a typo', id())];
  return mergeDocuments(base, [], [edited(base[0] as Para, 'typo fixed')]);
};

describe('a block changed differently on both sides', () => {
  it('asks for a decision, as a RADIO GROUP with position in set', () => {
    // A radio group is announced "2 of 2", which is the only thing that makes a twelve-block
    // conflict panel navigable. Three buttons per row would read as three separate actions.
    const onApply = vi.fn();
    render(<ConflictPanel result={editVsEdit()} onApply={onApply} onCancel={() => {}} />);
    // A `<fieldset>` with a `<legend>` is a `group`, and that is the right role -- adding
    // `role="radiogroup"` on top would replace the fieldset's own semantics for no gain. What
    // matters is that the radios are ONE named set, so the reader hears "1 of 2" rather than
    // four unlabelled buttons.
    expect(screen.getByRole('group', { name: /Block 1 of 1/ })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    // Same `name`, which is what actually makes them one group in the accessibility tree.
    expect(new Set(radios.map((r) => (r as HTMLInputElement).name)).size).toBe(1);
  });

  it('says WHY it is asking, in terms of what happened not what to do', () => {
    render(<ConflictPanel result={editVsEdit()} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/changed differently by you and by them/)).toBeTruthy();
  });

  it('shows BOTH versions, rendered, so the choice can actually be made', () => {
    render(<ConflictPanel result={editVsEdit()} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Your version')).toBeTruthy();
    expect(screen.getByText('The saved version')).toBeTruthy();
    // Rendered, not summarised: a diff summary asks the author to decide something they cannot
    // decide without seeing the words.
    expect(screen.getByText('my version')).toBeTruthy();
    expect(screen.getByText('their version')).toBeTruthy();
  });

  it('says nothing is overwritten until a choice is made', () => {
    render(<ConflictPanel result={editVsEdit()} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Nothing is overwritten until you choose/)).toBeTruthy();
  });
});

describe('applying', () => {
  it('refuses until EVERY conflict is chosen, and says how many are left', () => {
    // An apply button that silently applies half a merge is how somebody loses an edit.
    const base = [fixed('one', id()), fixed('two', id())];
    const result = mergeDocuments(
      base,
      [edited(base[0] as Para, 'mine one'), edited(base[1] as Para, 'mine two')],
      [edited(base[0] as Para, 'their one'), edited(base[1] as Para, 'their two')],
    );
    const onApply = vi.fn();
    render(<ConflictPanel result={result} onApply={onApply} onCancel={() => {}} />);
    expect(result.conflicts).toHaveLength(2);

    const apply = screen.getByRole('button', {
      name: /Choose for 2 more blocks/,
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    // Named with the COUNT, so the author knows the scale of what is left.
    fireEvent.click(screen.getAllByRole('radio')[0] as HTMLElement);
    expect(
      (screen.getByRole('button', { name: /Choose for 1 more block/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[2] as HTMLElement);
    const ready = screen.getByRole('button', {
      name: 'Save the merged version',
    }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(Object.keys(onApply.mock.calls[0]?.[0] as Record<string, Resolution>)).toHaveLength(2);
  });

  it('offers a way out that does not discard the author work', () => {
    const onCancel = vi.fn();
    render(<ConflictPanel result={editVsEdit()} onApply={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and keep editing' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('a deletion against an edit', () => {
  it('offers only the side that exists, because "delete" is what that author already did', () => {
    // The block is gone from one side, so the other side is the only thing that can be chosen.
    // Presenting a delete option would be offering a third outcome nobody asked for.
    render(<ConflictPanel result={deleteVsEdit()} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByText('The saved version')).toBeTruthy();
    expect(screen.queryByText('Your version')).toBeNull();
  });

  it('explains it in the terms that matter', () => {
    render(<ConflictPanel result={deleteVsEdit()} onApply={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/deleted this block and the other edited it/)).toBeTruthy();
  });

  it('shows the missing side as null, so the panel can say "(deleted)" rather than show a box', () => {
    // An empty preview next to a rendered one reads as "nothing here" rather than "deleted",
    // and the author picks the wrong one. The first version of this test built the two sides
    // with DIFFERENT ids, so they were different blocks and there was no conflict to look at.
    const r = deleteVsEdit();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]?.mine).toBeNull();
    expect(r.conflicts[0]?.theirs).not.toBeNull();
    expect(r.conflicts[0]?.choices).toEqual(['theirs']);
  });
});

describe('a merge that needs no decision', () => {
  it('still says what happened, because silently merging is how content changes unnoticed', () => {
    const base = [fixed('one', id()), fixed('two', id())];
    // Two editors changed DIFFERENT blocks: nothing to decide.
    // The UNCHANGED side must be the SAME block, id and all. The first version passed
    // `para('two')` and `para('one')` as the untouched sides, and those are NEW blocks with new
    // ids -- so both sides really had changed both blocks, and the fixture asserted a clean
    // merge on a document that had two conflicts in it. A wrong fixture that passes is worse
    // than a missing one, because it reports coverage of a case it never built.
    const result = mergeDocuments(
      base,
      [edited(base[0] as Para, 'mine'), base[1] as Para],
      [base[0] as Para, edited(base[1] as Para, 'theirs')],
    );
    expect(result.conflicts).toEqual([]);
    const onApply = vi.fn();
    render(<ConflictPanel result={result} onApply={onApply} onCancel={() => {}} />);
    expect(screen.getByText(/nothing needed a decision/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the merged version' }));
    expect(onApply).toHaveBeenCalledWith({});
  });

  it('flags an order conflict without blocking on it', () => {
    const a = id();
    const b = id();
    const c = id();
    // Both sides REORDERED, to different orders, with no content change -- the only shape that
    // is an order conflict.
    const base = [fixed('one', a), fixed('two', b), fixed('three', c)];
    const result = mergeDocuments(
      base,
      [fixed('three', c), fixed('two', b), fixed('one', a)],
      [fixed('two', b), fixed('one', a), fixed('three', c)],
    );
    expect(result.orderConflict).toBe(true);
    expect(result.conflicts).toEqual([]);
    render(<ConflictPanel result={result} onApply={() => {}} onCancel={() => {}} />);
    // Surfaced, not enforced: the packet asks for a merge the user can understand, not one that
    // refuses.
    expect(screen.getByRole('status').textContent).toContain('reordered');
  });
});
