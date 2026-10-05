'use client';

/**
 * The three-way panel: *your version* / *saved version* / *both*.  (P2-T4)
 *
 * ## What the packet asks for, and what it does not
 *
 * "A three-way panel: *your version* / *saved version* / *both*, merging per-block where blocks
 * are independent" and "done when two concurrent editors produce a merge the user can understand
 * and choose from".
 *
 * Note what is NOT in that: it does not ask for a merge that resolves itself. `both` is offered
 * ONLY where the two sides' changes are genuinely independent, which after the per-block merge
 * means: never for a conflicting block. Two editors who made the same change to the same block
 * have CONVERGED, and offering them a choice between two identical things teaches them that the
 * panel is noise.
 *
 * ## The decision is a radio group, not three buttons
 *
 * Two options per conflicting block, so it is one choice from a set — which is a radio group.
 * Three buttons would be a "save" button per row, and the author would have to work out that
 * they are alternatives. A `radiogroup` with a real `<fieldset>` and `<legend>` announces
 * "block 3 of 5, 2 of 3" as position-in-set, which is the only thing that makes a twelve-block
 * conflict panel navigable.
 *
 * ## Both versions are shown, rendered, in full
 *
 * A panel that shows a diff summary is asking the author to make a decision they cannot make.
 * So each side is rendered with the same renderer students see. That also means the panel is
 * covered by the renderer's own tests rather than having its own idea of what a block looks
 * like.
 */

import type { MergeItem, MergeResult, Resolution } from '@orrery/contracts/merge';
import { renderBlock } from '@orrery/contracts/render';
import { useState } from 'react';
import { TrustedHtml } from './TrustedHtml.js';

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  'conflict-edit-vs-edit': 'This block was changed differently by you and by them.',
  'conflict-delete-vs-edit': 'One of you deleted this block and the other edited it.',
};

export function ConflictPanel(props: {
  readonly result: MergeResult;
  /** Properties, not method signatures: `readonly` is not valid on a method declaration. */
  readonly onApply: (choices: Readonly<Record<string, Resolution>>) => void;
  readonly onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Readonly<Record<string, Resolution>>>({});
  const conflicts = props.result.conflicts;
  const unresolved = conflicts.filter((c) => choices[c.id] === undefined).length;

  if (conflicts.length === 0) {
    // Merged cleanly. Still shown, because "we merged your work with theirs" is information the
    // author wants, and silently merging is how a lesson changes without anybody deciding to.
    // No `role="region"`: a `<section>` with an accessible name IS a region, and stating it
    // again is redundant markup that a screen reader has to be handed twice.
    return (
      <section aria-labelledby="conflict-heading" className="orrery-conflicts">
        <h2 id="conflict-heading">Merged with the saved version</h2>
        <p>
          {props.result.merged.length} block{props.result.merged.length === 1 ? '' : 's'} kept, and
          nothing needed a decision.
        </p>
        {props.result.orderConflict && (
          <p role="status">
            One of you reordered these blocks. The order has been kept as yours — check it reads the
            way you meant.
          </p>
        )}
        <button type="button" onClick={() => props.onApply({})}>
          Keep the merged version
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="conflict-heading" className="orrery-conflicts">
      <h2 id="conflict-heading">
        {conflicts.length} block{conflicts.length === 1 ? '' : 's'} need a decision
      </h2>
      <p>
        Your work and the saved version disagree. Nothing is overwritten until you choose — and the
        blocks that did not conflict have already been merged.
      </p>

      <ol>
        {conflicts.map((item, index) => (
          <ConflictRow
            key={item.id}
            item={item}
            index={index}
            total={conflicts.length}
            choice={choices[item.id]}
            onChoose={(side) => setChoices((prev) => ({ ...prev, [item.id]: side }))}
          />
        ))}
      </ol>

      <div className="orrery-conflicts__actions">
        {/* Disabled until every conflict has a choice, and the button says how many are left.
            An apply button that silently applies half a merge is how somebody loses an edit. */}
        <button type="button" disabled={unresolved > 0} onClick={() => props.onApply(choices)}>
          {unresolved > 0
            ? `Choose for ${unresolved} more block${unresolved === 1 ? '' : 's'}`
            : 'Save the merged version'}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel and keep editing
        </button>
      </div>
    </section>
  );
}

function ConflictRow(props: {
  item: MergeItem;
  index: number;
  total: number;
  choice: Resolution | undefined;
  onChoose(side: Resolution): void;
}) {
  const { item, index, total, choice } = props;
  const name = `conflict-${item.id}`;
  return (
    <li>
      <fieldset>
        {/* The legend NAMES the block and nothing else. The reason is rendered once, visibly,
            below: the first version put it here hidden as well, so a screen reader heard every
            sentence twice. */}
        <legend>{`Block ${index + 1} of ${total}`}</legend>
        <p className="orrery-conflicts__why">
          {OUTCOME_TEXT[item.outcome] ?? 'This block was changed on both sides.'}
        </p>

        <div className="orrery-conflicts__sides">
          {(item.choices ?? []).map((side) => {
            const block = side === 'mine' ? item.mine : item.theirs;
            const id = `${name}-${side}`;
            return (
              <div key={side} className="orrery-conflicts__side">
                <input
                  type="radio"
                  id={id}
                  name={name}
                  checked={choice === side}
                  onChange={() => props.onChoose(side)}
                />
                <label htmlFor={id}>{side === 'mine' ? 'Your version' : 'The saved version'}</label>
                {/* Rendered with the SAME renderer students see, so the author is choosing
                    between the two things as they will actually appear -- and so this panel
                    cannot drift from the one rendering. The markup is mounted by `TrustedHtml`,
                    the one component in the app allowed to do it, rather than by an inline
                    `dangerouslySetInnerHTML` that a reviewer would have to audit here. The "allowed to" is now
                    enforced: `eslint.config.js` bans every string-to-markup sink and bans `new DOMParser`
                    outside `TrustedHtml.tsx`, so a second mount site is a lint error (P14-T16, TM-21). */}
                <div className="orrery-conflicts__preview">
                  {block === null ? (
                    <p className="muted">(deleted)</p>
                  ) : (
                    <TrustedHtml html={renderBlock(block)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>
    </li>
  );
}
