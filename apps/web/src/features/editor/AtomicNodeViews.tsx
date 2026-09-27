'use client';

/**
 * React node views for the four ATOMIC block types.  (P2-T3c)
 *
 * ## Why these four are atomic, and why it is an accessibility decision
 *
 * The packet names `embedSimulation`, `embedExternal`, `table` and `code` as atomic nodes with
 * React node views. The reason is not tidiness and it is not performance:
 *
 * A 6-column, 40-row table is **240 cells**. Rendered as ordinary editable content that is 240
 * focusable things, and "no keyboard trap anywhere" stops being achievable — the author would
 * have to Tab through two hundred and forty stops to get from one block to the next. As ONE
 * atomic node it is a single focusable thing that opens a table editor, and the requirement is
 * satisfiable at all.
 *
 * So each view is a **summary card**, not the content. It says what the block is, offers one
 * control to edit it, and is a single tab stop. The content is edited in a dialog or a side
 * panel, which is where a table's own keyboard model belongs.
 *
 * ## Every view follows the same three rules
 *
 *  1. **One tab stop.** The card is a single focusable region; the Edit control inside it is the
 *     only thing in the tab order.
 *  2. **The name says what it is.** "Simulation: tidal locking, graded, fixed seed" — not
 *     "card" or "block". A screen-reader user moving through a document should hear the
 *     document.
 *  3. **The summary is derived from the DATA, not typed in.** A summary that can disagree with
 *     the block it summarises is worse than no summary.
 */

import type { Block } from '@orrery/contracts/blocks';
import { useCallback, useId } from 'react';

export interface AtomicNodeViewProps<T extends Block = Block> {
  readonly block: T;
  /** A property, not a method signature: `readonly` is not valid on a method declaration. */
  readonly onEdit: () => void;
  readonly position: number;
  readonly total: number;
}

/** The shared shell. One tab stop, one name, one control. */
function AtomicShell(props: {
  readonly label: string;
  /** The full description, which becomes the Edit control's accessible name. */
  readonly name: string;
  readonly detail: readonly string[];
  readonly onEdit: () => void;
  readonly testId: string;
  children?: React.ReactNode;
}) {
  const headingId = useId();
  return (
    /*
     * A PLAIN `<section>`, with no role and no `aria-labelledby`.
     *
     * The three candidates were all wrong for different reasons. `role="region"` turns every
     * block into a landmark, and a document with forty landmarks is its own navigation problem.
     * `role="group"` claims a set of related CONTROLS under a label, and this is a block of
     * content with one control in it — the honest element for that would be a `<fieldset>`, which
     * would wrap a `<dl>` of prose in a form. And a section with an accessible name IS a region,
     * so the name cannot be kept without the landmark.
     *
     * So: no role at all. The `<h3>` gives document structure, and the Edit control's accessible
     * name carries everything a screen reader needs, which is the part that is actually announced
     * on focus. Nothing is lost, and nothing is claimed that is not true.
     */
    <section className="orrery-atomic" data-testid={props.testId}>
      <h3 id={headingId} className="orrery-atomic__label">
        {props.label}
      </h3>
      <dl className="orrery-atomic__detail">
        {props.detail.map((line) => (
          <div key={line}>
            <dt className="visually-hidden">{line}</dt>
            <dd>{line}</dd>
          </div>
        ))}
      </dl>
      {props.children}
      {/*
        ONE tab stop per block, and it is THIS control.

        The first version put `tabIndex={0}` on the section as well, which meant two tab stops
        per block: land on the group, then tab again to reach Edit. Making a non-interactive
        element focusable is also the `noNoninteractiveTabindex` smell, and it was correct here
        only in the sense that it worked.

        Carrying the full description in the button's accessible NAME is strictly better: the
        author tabs once and hears "Edit table: Surface gravity by body, 6 columns by 40 rows",
        which is both the block and the action in one announcement. A visually hidden paragraph
        for the name does not work here, because a non-focusable group is never announced on
        focus.
      */}
      <button type="button" aria-label={`Edit ${props.name}`} onClick={props.onEdit}>
        {`Edit ${props.label.toLowerCase()}`}
      </button>
    </section>
  );
}

export function SimulationNodeView(
  props: AtomicNodeViewProps<Extract<Block, { type: 'embedSimulation' }>>,
) {
  const b = props.block;
  // `seedPolicy` matters more than it looks. PER_STUDENT and PER_VIEW give every student a
  // different question, so a GRADED simulation with a floating seed is unmarkable -- and the
  // publish checklist blocks it. Surfacing it here means the author sees the problem while
  // editing, not at publish time.
  const seedWarning = b.mode === 'graded' && b.seedPolicy !== 'FIXED';
  return (
    <AtomicShell
      testId="node-embedSimulation"
      label="Simulation"
      name={`Simulation: ${b.simId}, ${b.mode}${seedWarning ? ', WARNING seed is not fixed' : ''}`}
      detail={[`${b.simId} · version ${b.simVersion}`, `${b.mode} · seed ${b.seedPolicy}`]}
      onEdit={props.onEdit}
    >
      {seedWarning && (
        <p role="alert" className="warn">
          This is marked for grading but every student gets a different result, so it cannot be
          marked.
        </p>
      )}
    </AtomicShell>
  );
}

export function ExternalEmbedNodeView(
  props: AtomicNodeViewProps<Extract<Block, { type: 'embedExternal' }>>,
) {
  const b = props.block;
  return (
    <AtomicShell
      testId="node-embedExternal"
      label="Embed"
      // The title is REQUIRED on this block and is the author's own words, so it is the name.
      name={`Embed: ${b.title}, from ${b.provider}`}
      detail={[`${b.provider} · ${b.providerId}`, b.title]}
      onEdit={props.onEdit}
    />
  );
}

export function TableNodeView(props: AtomicNodeViewProps<Extract<Block, { type: 'table' }>>) {
  const b = props.block;
  const cols = b.header.length;
  const rows = b.rows.length;
  return (
    <AtomicShell
      testId="node-table"
      label="Table"
      // The cell count is in the NAME as well as the detail, because the name is what is
      // announced and the cell count is the fact that explains why this is one focus stop rather
      // than two hundred and forty. A summary the author cannot hear is not a summary.
      name={`Table: ${b.caption}, ${cols} columns by ${rows} rows, ${cols * rows} cells`}
      detail={[b.caption, `${cols} × ${rows} = ${cols * rows} cells`]}
      onEdit={props.onEdit}
    />
  );
}

export function CodeNodeView(props: AtomicNodeViewProps<Extract<Block, { type: 'code' }>>) {
  const b = props.block;
  const lines = b.code.split('\n').length;
  return (
    <AtomicShell
      testId="node-code"
      label="Code"
      name={`Code: ${b.language}, ${lines} lines${b.filename ? `, in ${b.filename}` : ''}`}
      detail={[`${b.language} · ${lines} lines`, ...(b.filename ? [b.filename] : [])]}
      onEdit={props.onEdit}
    />
  );
}

export const ATOMIC_VIEWS = {
  embedSimulation: SimulationNodeView,
  embedExternal: ExternalEmbedNodeView,
  table: TableNodeView,
  code: CodeNodeView,
} as const;

/** Render whichever atomic view matches, or `null` for a non-atomic block. */
export function AtomicNode(props: {
  readonly block: Block;
  /** Properties, not method signatures: `readonly` is not valid on a method declaration. */
  readonly onEdit: () => void;
  readonly position: number;
  readonly total: number;
}) {
  const View = ATOMIC_VIEWS[props.block.type as keyof typeof ATOMIC_VIEWS] as
    | ((p: AtomicNodeViewProps) => React.ReactElement | null)
    | undefined;
  const onEdit = useCallback(() => props.onEdit(), [props]);
  if (View === undefined) return null;
  return <View block={props.block} onEdit={onEdit} position={props.position} total={props.total} />;
}
