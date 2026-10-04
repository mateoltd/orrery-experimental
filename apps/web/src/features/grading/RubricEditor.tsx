'use client';

/**
 * The rubric editor.  (P9-T3)
 *
 * ## THE BOUND IS VISIBLE WHILE TYPING AND ENFORCED AT SAVE
 *
 * `rubric.ts` holds the rule: a band is worth between 0 and the question's points. This editor states it above the
 * bands, shows each band's problem next to the band as it is typed, and refuses to save while any `BLOCKS_SAVE`
 * issue stands. It does not correct a value for the teacher -- a `-2` stays `-2` in the field, with the sentence
 * that says why it cannot be saved, because rewriting it to `0` would hide the fact that a penalty was asked for and
 * refused.
 *
 * ## REORDERING IS BUTTONS, AND THERE IS NO DRAG
 *
 * `plans/15` and WCAG 2.5.7 require every drag to have a keyboard equivalent with the SAME OUTCOME. The cheapest way
 * to guarantee two paths have the same outcome is to have one path. Bands move with "Move band up" and "Move band
 * down", which a mouse can click and a keyboard can press, and both call `moveBand`.
 *
 * ## FOCUS IS PUT SOMEWHERE AFTER EVERY ACT THAT REMOVES OR MOVES WHAT HAD IT
 *
 * `plans/15` rule 3. Three acts here take the focused element away or carry it elsewhere: moving a band (the button
 * pressed travels with it, and a browser may drop focus when a node is reinserted), removing a band (the button is
 * gone), and adding one (the new band is the thing to type into). Each sets an explicit target. The move buttons at
 * the ends are `aria-disabled` rather than `disabled`, because a focused button that becomes `disabled` loses focus
 * to the page and the keyboard user is left nowhere.
 *
 * ## THE SHORTCUT KEYS ARE OFF IN HERE
 *
 * The whole editor carries `data-grading-keys="off"`. Its buttons are not text fields, but `E` on "Move band up"
 * excusing the response behind the editor would be the kind of surprise that makes a teacher stop using a keyboard.
 */

import * as React from 'react';

import {
  BAND_COMMENT_HINT,
  BAND_COMMENT_LABEL,
  BAND_DESCRIPTOR_LABEL,
  BAND_POINTS_LABEL,
  bandAdded,
  bandCannotMove,
  bandMoved,
  bandRemoved,
  REQUEST_DID_NOT_COMPLETE,
  RUBRIC_ADD,
  RUBRIC_BLOCKED,
  RUBRIC_DOES_NOT_REGRADE,
  RUBRIC_EMPTY,
  RUBRIC_SAVE,
  RUBRIC_SAVED,
  RUBRIC_UNSAVED,
  rubricBound,
  rubricNotSaved,
} from './copy';
import { KEYS_OFF_ATTRIBUTE } from './keymap';
import {
  addBand,
  blocksSave,
  type MarkingRubric,
  moveBand,
  type RubricIssue,
  removeBand,
  updateBand,
  validateRubric,
} from './rubric';

export type SaveRubricResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface RubricEditorProps {
  readonly rubric: MarkingRubric;
  /** Called only with a rubric that has no `BLOCKS_SAVE` issue. The server must still check: see `rubric.ts`. */
  readonly onSave: (rubric: MarkingRubric) => Promise<SaveRubricResult>;
}

type EditorStatus =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'UNSAVED' }
  | { readonly kind: 'BLOCKED' }
  | { readonly kind: 'SAVING' }
  | { readonly kind: 'SAVED' }
  | { readonly kind: 'FAILED'; readonly reason: string };

/** A plain decimal as typed, or NaN. NaN flows into `validateRubric` and comes back as "has to be a number". */
const pointsFrom = (text: string): number =>
  /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;

const issuesFor = (issues: readonly RubricIssue[], bandId: string | null): readonly RubricIssue[] =>
  issues.filter((issue) => issue.bandId === bandId);

type FocusTarget =
  | { readonly kind: 'MOVE'; readonly bandId: string; readonly direction: 'UP' | 'DOWN' }
  | { readonly kind: 'DESCRIPTOR'; readonly bandId: string }
  | { readonly kind: 'ADD' };

export function RubricEditor({ rubric, onSave }: RubricEditorProps) {
  const baseId = React.useId();
  const [working, setWorking] = React.useState<MarkingRubric>(rubric);
  /**
   * THE MARKS AS TYPED, beside the numbers. `2.` on the way to `2.5` is not a number, and a field bound to
   * `band.points` would turn it into `2` under the cursor.
   */
  const [pointsText, setPointsText] = React.useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(rubric.bands.map((band) => [band.id, String(band.points)])),
  );
  const [status, setStatus] = React.useState<EditorStatus>({ kind: 'CLEAN' });
  const [announcement, setAnnouncement] = React.useState('');
  const pendingFocus = React.useRef<FocusTarget | null>(null);
  const root = React.useRef<HTMLDivElement>(null);

  const issues = validateRubric(working);

  // After every render, put focus where the last act said it should go. A ref and not state: setting state to move
  // focus would render twice and could fire the move against a stale tree.
  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const selector =
      target.kind === 'ADD'
        ? '[data-rubric-add]'
        : target.kind === 'DESCRIPTOR'
          ? `[data-band="${target.bandId}"] [data-band-descriptor]`
          : `[data-band="${target.bandId}"] [data-band-move="${target.direction}"]`;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  });

  const change = (next: MarkingRubric): void => {
    setWorking(next);
    setStatus({ kind: 'UNSAVED' });
  };

  const move = (bandId: string, direction: 'UP' | 'DOWN'): void => {
    const from = working.bands.findIndex((band) => band.id === bandId);
    const next = moveBand(working, bandId, direction);
    pendingFocus.current = { kind: 'MOVE', bandId, direction };
    if (next === working) {
      // Nothing moved. Say so, rather than announcing a move or saying nothing at all.
      setAnnouncement(bandCannotMove(from + 1, direction));
      return;
    }
    change(next);
    setAnnouncement(bandMoved(from + 1, direction === 'UP' ? from : from + 2));
  };

  const remove = (bandId: string): void => {
    const from = working.bands.findIndex((band) => band.id === bandId);
    change(removeBand(working, bandId));
    pendingFocus.current = { kind: 'ADD' };
    setAnnouncement(bandRemoved(from + 1));
  };

  const add = (): void => {
    const next = addBand(working);
    const added = next.bands[next.bands.length - 1];
    if (added === undefined) return;
    setPointsText((text) => ({ ...text, [added.id]: String(added.points) }));
    change(next);
    pendingFocus.current = { kind: 'DESCRIPTOR', bandId: added.id };
    setAnnouncement(bandAdded(next.bands.length));
  };

  const save = async (): Promise<void> => {
    if (status.kind === 'SAVING') return;
    if (blocksSave(issues)) {
      // REFUSED HERE, before `onSave` is reached. The bands at fault are already marked where they stand.
      setStatus({ kind: 'BLOCKED' });
      return;
    }
    setStatus({ kind: 'SAVING' });
    let result: SaveRubricResult;
    try {
      result = await onSave(working);
    } catch {
      result = { ok: false, reason: REQUEST_DID_NOT_COMPLETE };
    }
    setStatus(result.ok ? { kind: 'SAVED' } : { kind: 'FAILED', reason: result.reason });
  };

  const rubricIssues = issuesFor(issues, null);

  return (
    <div ref={root} {...{ [KEYS_OFF_ATTRIBUTE]: 'off' }}>
      <p>{rubricBound(working.maxPoints)}</p>
      <p>{RUBRIC_DOES_NOT_REGRADE}</p>

      {working.bands.length === 0 ? <p>{RUBRIC_EMPTY}</p> : null}

      <ol>
        {working.bands.map((band, index) => {
          const position = index + 1;
          const bandIssues = issuesFor(issues, band.id);
          const pointsId = `${baseId}-${band.id}-points`;
          const descriptorId = `${baseId}-${band.id}-descriptor`;
          const commentId = `${baseId}-${band.id}-comment`;
          const hintId = `${baseId}-${band.id}-hint`;
          const issuesId = `${baseId}-${band.id}-issues`;
          const invalid = bandIssues.some((issue) => issue.severity === 'BLOCKS_SAVE');
          const atTop = index === 0;
          const atBottom = index === working.bands.length - 1;
          return (
            <li key={band.id} data-band={band.id}>
              <fieldset>
                <legend>Band {String(position)}</legend>

                <label htmlFor={pointsId}>{BAND_POINTS_LABEL}</label>
                <input
                  id={pointsId}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={pointsText[band.id] ?? ''}
                  aria-invalid={invalid}
                  aria-describedby={bandIssues.length > 0 ? issuesId : undefined}
                  onChange={(event) => {
                    const text = event.target.value;
                    setPointsText((current) => ({ ...current, [band.id]: text }));
                    change(updateBand(working, band.id, { points: pointsFrom(text) }));
                  }}
                />

                <label htmlFor={descriptorId}>{BAND_DESCRIPTOR_LABEL}</label>
                <textarea
                  id={descriptorId}
                  data-band-descriptor=""
                  rows={2}
                  value={band.descriptor}
                  aria-invalid={invalid}
                  aria-describedby={bandIssues.length > 0 ? issuesId : undefined}
                  onChange={(event) => {
                    change(updateBand(working, band.id, { descriptor: event.target.value }));
                  }}
                />

                <label htmlFor={commentId}>{BAND_COMMENT_LABEL}</label>
                <textarea
                  id={commentId}
                  rows={3}
                  value={band.feedback}
                  aria-describedby={hintId}
                  onChange={(event) => {
                    change(updateBand(working, band.id, { feedback: event.target.value }));
                  }}
                />
                <p id={hintId}>{BAND_COMMENT_HINT}</p>

                {bandIssues.length > 0 ? (
                  <ul id={issuesId}>
                    {bandIssues.map((issue) => (
                      <li key={issue.code}>{issue.message}</li>
                    ))}
                  </ul>
                ) : null}

                <button
                  type="button"
                  data-band-move="UP"
                  aria-disabled={atTop}
                  onClick={() => {
                    move(band.id, 'UP');
                  }}
                >
                  Move band {String(position)} up
                </button>
                <button
                  type="button"
                  data-band-move="DOWN"
                  aria-disabled={atBottom}
                  onClick={() => {
                    move(band.id, 'DOWN');
                  }}
                >
                  Move band {String(position)} down
                </button>
                <button
                  type="button"
                  onClick={() => {
                    remove(band.id);
                  }}
                >
                  Remove band {String(position)}
                </button>
              </fieldset>
            </li>
          );
        })}
      </ol>

      {rubricIssues.map((issue) => (
        <p key={issue.code}>{issue.message}</p>
      ))}

      <button type="button" data-rubric-add="" onClick={add}>
        {RUBRIC_ADD}
      </button>
      <button
        type="button"
        onClick={() => {
          void save();
        }}
      >
        {RUBRIC_SAVE}
      </button>

      {/*
        A refusal and a failure are ALERTS; everything else is a polite status. A rubric that silently did not save
        is a teacher marking forty scripts against bands that are not the ones stored.
      */}
      {status.kind === 'BLOCKED' || status.kind === 'FAILED' ? (
        <p role="alert">
          {status.kind === 'BLOCKED' ? RUBRIC_BLOCKED : rubricNotSaved(status.reason)}
        </p>
      ) : (
        <p role="status">
          {status.kind === 'UNSAVED' ? RUBRIC_UNSAVED : status.kind === 'SAVED' ? RUBRIC_SAVED : ''}
        </p>
      )}

      {/* Moves, additions and removals. Separate from the save status so one does not overwrite the other. */}
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
    </div>
  );
}
