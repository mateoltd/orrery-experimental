'use client';

/**
 * The roster.  (P4-T6)
 *
 * ## `plans/12` §5 asks for dialogs, and this page has none
 *
 * §5: "Remove / change role: confirmation dialogs that name the person. A mis-click that removes
 * 30 students is a support incident and a trust breach."
 *
 * The codebase policy is the opposite. `ResourceLibrary` says, in the file that is the closest
 * thing to a precedent here: "So the blast radius is not a confirmation dialog. A dialog is a
 * modal the teacher clicks through, and a number inside a dialog is a number they did not read."
 * And that policy has a test pinned to it — `shows the blast radius on the row, not in a dialog`
 * asserts `document.querySelector('[role="dialog"]')` is null.
 *
 * So the two are reconciled by noticing that §5's requirement is not "use a dialog". It is "NAME
 * THE PERSON" and "STATE THE COUNT". Both survive an inline disclosure, and a dialog would make
 * them worse, because a modal is a hurdle AFTER the decision and the requirement is about
 * information arriving BEFORE it.
 *
 * What this page therefore does, per person and per bulk action:
 *   · the consequence is on the row, always, with no interaction;
 *   · pressing Remove or "Remove 12" reveals an inline disclosure IN PLACE, which names each
 *     person it will affect and requires the teacher to type the count before it arms;
 *   · a bulk removal of more than one person must be typed out, and the number that must be typed
 *     is the number that will be affected.
 *
 * The typing is not a speed bump. It is the one control that catches a mis-click aimed at one
 * person and dragged across twelve, and it costs nothing for a deliberate action.
 *
 * ## The unknowns are reported as UNKNOWN, not as failures
 *
 * Borrowed from `ResourceLibrary`'s `run()`: a thrown action is an unknown outcome. On a page
 * that can remove 30 students at once, "that did not work" invites an immediate retry, and a
 * retry of a remove is how a removal happens twice.
 *
 * ## An unreleased grade is never in this tree
 *
 * Not a display rule — the read model never selects one, so there is nothing to hide. A component
 * added to this file later cannot leak a grade it was never given.
 */

import { useMemo, useState } from 'react';

export interface RosterUiRow {
  readonly enrollmentId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly accountName: string;
  readonly hasDisplayNameOverride: boolean;
  readonly email: string;
  readonly role: 'OWNER' | 'TEACHER' | 'REVIEWER' | 'STUDENT';
  readonly status: 'ACTIVE' | 'ENDED';
  readonly joinedAtLabel: string;
  readonly isPlaceholder: boolean;
  readonly summary: {
    readonly assignmentsPublished: number;
    readonly attempts: number;
    readonly completed: number;
    readonly inProgress: number;
    readonly releasedGrades: number;
    /** `null` when nothing has been released. Not `0`, and not `'—'`. */
    readonly latestReleasedLabel: string | null;
    readonly accommodations: number;
    readonly lastActivityLabel: string | null;
  };
}

export type RosterUiEmpty =
  | { readonly reason: 'noMembers'; readonly inScope: 0 }
  | { readonly reason: 'searchExcluded'; readonly inScope: number; readonly search: string }
  | {
      readonly reason: 'filterExcluded';
      readonly inScope: number;
      readonly role: RosterUiRow['role'];
    };

export interface RosterActions {
  changeRole(input: {
    enrollmentId: string;
    role: RosterUiRow['role'];
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(input: {
    enrollmentIds: readonly string[];
  }): Promise<{ ok: true; removed: number } | { ok: false; reason: string }>;
  /** Undo is offered for a removal, because `addMember` is the inverse. */
  restore(input: {
    enrollmentIds: readonly string[];
  }): Promise<{ ok: true; restored: number } | { ok: false; reason: string }>;
  setSearch(input: { search: string }): Promise<void>;
  setRoleFilter(input: { role: RosterUiRow['role'] | null }): Promise<void>;
  clearSearch(): Promise<void>;
  showEnded(): Promise<void>;
}

const ROLE_LABEL: Readonly<Record<RosterUiRow['role'], string>> = {
  OWNER: 'Owner',
  TEACHER: 'Teacher',
  REVIEWER: 'Reviewer',
  STUDENT: 'Student',
};

/** `OWNER` is not offered: `addMember` and `changeMemberRole` both refuse it. */
const ASSIGNABLE_ROLES: readonly RosterUiRow['role'][] = ['STUDENT', 'TEACHER', 'REVIEWER'];

export function RosterTable(props: {
  rows: readonly RosterUiRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  empty: RosterUiEmpty | null;
  endedCount: number | null;
  search: string;
  roleFilter: RosterUiRow['role'] | null;
  showEnded: boolean;
  actions: RosterActions;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [removing, setRemoving] = useState<readonly string[] | null>(null);
  const [searchDraft, setSearchDraft] = useState(props.search);
  const [lastRemoved, setLastRemoved] = useState<readonly string[] | null>(null);

  // The bulk set is derived from the SEARCH, not stored. Storing a selection means it survives a
  // re-render after the underlying rows changed, and the teacher removes a set of ids they cannot
  // see. `null` means "nobody selected", `[]` means "everyone on this page" — two different
  // intents that a single `string[] | null` would otherwise blur.
  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const everyoneSelected = selected !== null && selected.length === 0;
  const removableIds = useMemo(
    () =>
      props.rows
        .filter((r) => r.status === 'ACTIVE' && r.role !== 'OWNER')
        .map((r) => r.enrollmentId),
    [props.rows],
  );
  const bulkIds = selected === null ? [] : everyoneSelected ? removableIds : selected;
  const bulkNames = useMemo(
    () =>
      bulkIds
        .map((id) => props.rows.find((r) => r.enrollmentId === id))
        .filter((r): r is RosterUiRow => r !== undefined)
        .map((r) => r.displayName),
    [bulkIds, props.rows],
  );

  const run = async (
    key: string,
    fn: () => Promise<{ ok: boolean; reason?: string }>,
    success: string,
  ): Promise<{ ok: boolean; reason?: string }> => {
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result.ok) setNotice(success);
      else setError(result.reason ?? 'that did not work');
      return result;
    } catch {
      setError(
        'Something went wrong and we do not know whether it worked. Reload before retrying — ' +
          'retrying a removal is how a removal happens twice.',
      );
      return { ok: false, reason: 'unknown outcome' };
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="roster-heading" className="orrery-roster">
      <h2 id="roster-heading">Roster</h2>

      {/* One live region for the whole page, so a bulk change is announced once rather than
          once per affected row. A screen reader hearing "Removed" twelve times learns nothing. */}
      <div role="status" aria-live="polite" data-testid="roster-status">
        {error ?? notice ?? ''}
      </div>

      <form
        className="orrery-roster__filters"
        onSubmit={(e) => {
          e.preventDefault();
          void props.actions.setSearch({ search: searchDraft });
        }}
      >
        <label htmlFor="roster-search">Search this class</label>
        <input
          id="roster-search"
          name="search"
          type="search"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Name, class name, or email"
          autoComplete="off"
        />
        <button type="submit">Search</button>
        {props.search !== '' && (
          <button
            type="button"
            onClick={() => {
              setSearchDraft('');
              void props.actions.clearSearch();
            }}
          >
            Clear search
          </button>
        )}

        <label htmlFor="roster-role">Role</label>
        <select
          id="roster-role"
          value={props.roleFilter ?? ''}
          onChange={(e) =>
            void props.actions.setRoleFilter({
              role: e.target.value === '' ? null : (e.target.value as RosterUiRow['role']),
            })
          }
        >
          <option value="">Everyone</option>
          {(['OWNER', 'TEACHER', 'REVIEWER', 'STUDENT'] as const).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </form>

      <p className="orrery-roster__count" data-testid="roster-count">
        {props.total} member{props.total === 1 ? '' : 's'}
        {props.search !== '' && ' matching your search'}
        {props.roleFilter !== null && ` with the role ${ROLE_LABEL[props.roleFilter]}`}
      </p>

      {props.endedCount !== null && props.endedCount > 0 && !props.showEnded && (
        <p data-testid="roster-ended-note">
          {props.endedCount} student{props.endedCount === 1 ? '' : 's'} no longer in this class.{' '}
          <button type="button" onClick={() => void props.actions.showEnded()}>
            Show {props.endedCount === 1 ? 'them' : 'them'}
          </button>
        </p>
      )}

      {bulkIds.length > 0 && (
        <div className="orrery-roster__bulk" data-testid="roster-bulk">
          <p>
            {bulkIds.length} selected. Removing {bulkIds.length} student
            {bulkIds.length === 1 ? '' : 's'} is undoable here, and nothing else on the page is
            undone by it.
          </p>
          {removing === null ? (
            <button type="button" onClick={() => setRemoving(bulkIds)} disabled={pending !== null}>
              Remove {bulkIds.length}
            </button>
          ) : (
            <RemoveDisclosure
              names={bulkNames}
              count={removing.length}
              busy={pending === 'bulk-remove'}
              onCancel={() => setRemoving(null)}
              onConfirm={async () => {
                const result = await run(
                  'bulk-remove',
                  () => props.actions.remove({ enrollmentIds: removing }),
                  `Removed ${removing.length}.`,
                );
                if (result.ok) {
                  setLastRemoved(removing);
                  setSelected(null);
                  setRemoving(null);
                }
              }}
            />
          )}
        </div>
      )}

      {props.rows.length === 0 ? (
        <EmptyRoster empty={props.empty} />
      ) : (
        <table className="orrery-roster__table">
          <caption className="visually-hidden">
            Members of this class, with progress and released grades
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  checked={everyoneSelected}
                  aria-label="Select everyone on this page"
                  onChange={() => setSelected(everyoneSelected ? null : [])}
                />
              </th>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
              <th scope="col">Progress</th>
              <th scope="col">Last activity</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <RosterLine
                key={row.enrollmentId}
                row={row}
                busy={pending === row.enrollmentId}
                open={openRow === row.enrollmentId}
                onToggle={() => setOpenRow(openRow === row.enrollmentId ? null : row.enrollmentId)}
                selected={bulkIds.includes(row.enrollmentId)}
                onSelect={(on) =>
                  setSelected((current) => {
                    const base = current === null ? [] : current;
                    return on
                      ? [...base, row.enrollmentId]
                      : base.filter((i) => i !== row.enrollmentId);
                  })
                }
                onChangeRole={async (role) => {
                  await run(
                    row.enrollmentId,
                    () => props.actions.changeRole({ enrollmentId: row.enrollmentId, role }),
                    `${row.displayName} is now ${ROLE_LABEL[role]}.`,
                  );
                }}
                onRemove={async () => {
                  const result = await run(
                    row.enrollmentId,
                    () => props.actions.remove({ enrollmentIds: [row.enrollmentId] }),
                    `Removed ${row.displayName}.`,
                  );
                  if (result.ok) {
                    setLastRemoved([row.enrollmentId]);
                    setOpenRow(null);
                  }
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {props.hasMore && props.nextCursor !== null && (
        <p data-testid="roster-more">
          <a
            href={`?cursor=${encodeURIComponent(props.nextCursor)}${
              props.search === '' ? '' : `&search=${encodeURIComponent(props.search)}`
            }`}
          >
            Next {Math.min(50, props.total)} members
          </a>
        </p>
      )}

      {lastRemoved !== null && lastRemoved.length > 0 && (
        <p data-testid="roster-undo">
          <button
            type="button"
            disabled={pending === 'undo'}
            onClick={async () => {
              const result = await run(
                'undo',
                () => props.actions.restore({ enrollmentIds: lastRemoved }),
                `Restored ${lastRemoved.length}.`,
              );
              if (result.ok) setLastRemoved(null);
            }}
          >
            Undo the last removal
          </button>
        </p>
      )}
    </section>
  );
}

function RosterLine(props: {
  row: RosterUiRow;
  busy: boolean;
  open: boolean;
  selected: boolean;
  onToggle(): void;
  onSelect(next: boolean): void;
  onChangeRole(role: RosterUiRow['role']): Promise<void>;
  onRemove(): Promise<void>;
}) {
  const { row } = props;
  const [removing, setRemoving] = useState(false);
  const isOwner = row.role === 'OWNER';
  const ended = row.status === 'ENDED';

  return (
    <>
      <tr className={ended ? 'orrery-roster__row orrery-roster__row--ended' : 'orrery-roster__row'}>
        <td>
          <input
            type="checkbox"
            checked={props.selected}
            disabled={isOwner || ended}
            aria-label={`Select ${row.displayName}`}
            onChange={(e) => props.onSelect(e.target.checked)}
          />
        </td>
        <th scope="row">
          {row.displayName}
          {/* "shown distinctly" is a REQUIREMENT of §6, so the override says so in words rather
              than relying on a visual difference nobody can hear. */}
          {row.hasDisplayNameOverride && (
            <span className="orrery-roster__alias">
              {' '}
              shown as “{row.displayName}”, account name “{row.accountName}”
            </span>
          )}
          {row.isPlaceholder && (
            <span className="orrery-roster__placeholder">
              {' '}
              awaiting registration — this is a placeholder, not an account they have used
            </span>
          )}
          {ended && <span className="orrery-roster__ended"> no longer in this class</span>}
        </th>
        <td>{row.email}</td>
        <td>{ROLE_LABEL[row.role]}</td>
        <td>{row.joinedAtLabel}</td>
        <td>
          <ProgressCell row={row} />
        </td>
        <td>{row.summary.lastActivityLabel ?? 'never'}</td>
        <td>
          {isOwner ? (
            // An owner leaves by TRANSFERRING, not by being removed, and offering a Remove button
            // that always refuses is a button that teaches the teacher the page is broken.
            <span className="muted">transfer ownership to leave</span>
          ) : ended ? (
            <span className="muted">no actions</span>
          ) : (
            <button
              type="button"
              onClick={props.onToggle}
              aria-expanded={props.open}
              aria-busy={props.busy}
            >
              {props.open ? 'Close' : 'Actions'}
            </button>
          )}
        </td>
      </tr>
      {props.open && !isOwner && !ended && (
        <tr className="orrery-roster__disclosure">
          <td colSpan={8}>
            <div className="orrery-roster__row-actions">
              <div>
                <label htmlFor={`role-${row.enrollmentId}`}>
                  Change {row.displayName}&rsquo;s role
                </label>
                <select
                  id={`role-${row.enrollmentId}`}
                  value={row.role}
                  disabled={props.busy}
                  onChange={(e) => void props.onChangeRole(e.target.value as RosterUiRow['role'])}
                >
                  {ASSIGNABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>

              {removing ? (
                <RemoveDisclosure
                  names={[row.displayName]}
                  count={1}
                  busy={props.busy}
                  onCancel={() => setRemoving(false)}
                  onConfirm={async () => {
                    await props.onRemove();
                    setRemoving(false);
                  }}
                />
              ) : (
                <button type="button" disabled={props.busy} onClick={() => setRemoving(true)}>
                  Remove {row.displayName}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The confirmation that `plans/12` §5 asks for, without the dialog.
 *
 * Three things are on screen before the button arms:
 *   · who, BY NAME, and every one of them if there is more than one;
 *   · how many;
 *   · what is NOT undone — because the thing teachers fear is not the removal, it is the removal
 *     taking something with it that cannot be put back.
 *
 * For more than one person the count must be TYPED. A single person's removal needs only the
 * names, because there is no way to mis-aim a one-person action by dragging.
 */
function RemoveDisclosure(props: {
  names: readonly string[];
  count: number;
  busy: boolean;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const needsTyping = props.count > 1;
  const typedEnough = !needsTyping || typed.trim() === String(props.count);
  const many = props.count > 12;
  const listed = props.names.slice(0, 12);

  return (
    // A real `<fieldset>`, not `role="group"` on a div. The lint rule is right and so is
    // `ConflictPanel`, which reached the same conclusion independently: this is a set of controls
    // about one thing, and a fieldset is how a form says so. The legend is visually hidden because
    // the visible question below already reads as the heading — but it is the legend that gives
    // the group its accessible name.
    <fieldset className="orrery-roster__confirm">
      <legend className="visually-hidden">Confirm removal</legend>
      <p>
        {props.count === 1
          ? `Remove ${props.names[0] ?? 'this student'} from the class?`
          : `Remove these ${props.count} students from the class?`}
      </p>
      <ul>
        {listed.map((n) => (
          <li key={n}>{n}</li>
        ))}
        {many && <li>and {props.count - listed.length} more</li>}
      </ul>
      <p className="muted">
        Their own work and results stay theirs — a student who left keeps everything they did.
      </p>
      {needsTyping && (
        <>
          <label htmlFor={`confirm-${props.names.join('-')}`}>Type {props.count} to confirm</label>
          <input
            id={`confirm-${props.names.join('-')}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            aria-describedby={`confirm-help-${props.names.join('-')}`}
          />
          <p id={`confirm-help-${props.names.join('-')}`} className="hint">
            A number you did not type is a number you did not look at.
          </p>
        </>
      )}
      <button
        type="button"
        disabled={props.busy || !typedEnough}
        onClick={() => void props.onConfirm()}
      >
        Remove {props.count}
      </button>
      <button type="button" onClick={props.onCancel} disabled={props.busy}>
        Cancel
      </button>
    </fieldset>
  );
}

/**
 * Progress as a DEFINITION LIST, not a run of numbers.
 *
 * Same reasoning as `BlastRadius` in the library: these are labelled quantities, which is what a
 * `<dl>` is, and a screen reader announces "3 of 4 complete, 3" rather than "3 / 4 3".
 */
function ProgressCell(props: { row: RosterUiRow }) {
  const { summary } = props.row;
  return (
    <dl className="orrery-roster__progress" aria-label={`Progress for ${props.row.displayName}`}>
      <div>
        <dt>Published work</dt>
        <dd>{summary.assignmentsPublished}</dd>
      </div>
      <div>
        <dt>Completed</dt>
        <dd>
          {summary.completed} of {summary.assignmentsPublished}
        </dd>
      </div>
      <div>
        <dt>In progress</dt>
        <dd>{summary.inProgress}</dd>
      </div>
      <div>
        <dt>Released grades</dt>
        {/* `null` and `0` are different states and the copy says which is which: no work has been
            released yet, versus work released that they scored nothing on. */}
        <dd>
          {summary.latestReleasedLabel === null
            ? summary.releasedGrades === 0
              ? 'none released yet'
              : `${summary.releasedGrades} released`
            : summary.latestReleasedLabel}
        </dd>
      </div>
      {summary.accommodations > 0 && (
        <div>
          <dt>Accommodations on file</dt>
          <dd>{summary.accommodations}</dd>
        </div>
      )}
    </dl>
  );
}

function EmptyRoster(props: { empty: RosterUiEmpty | null }) {
  const { empty } = props;
  if (empty === null) return <p>Loading the class.</p>;
  switch (empty.reason) {
    case 'noMembers':
      return <p data-testid="roster-empty">Nobody is in this class yet. Invite people to begin.</p>;
    case 'searchExcluded':
      return (
        <p data-testid="roster-empty">
          {empty.inScope} member{empty.inScope === 1 ? '' : 's'} in this class, none matching
          &ldquo;{empty.search}&rdquo;. Clear the search to see everyone.
        </p>
      );
    case 'filterExcluded':
      return (
        <p data-testid="roster-empty">
          {empty.inScope} member{empty.inScope === 1 ? '' : 's'} in this class, none with the role{' '}
          {ROLE_LABEL[empty.role]}. Choose Everyone to see them.
        </p>
      );
  }
}
