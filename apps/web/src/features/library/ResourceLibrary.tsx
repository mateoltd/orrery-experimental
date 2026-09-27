'use client';

/**
 * The resource library: mine, blast radius, transfer, duplicate.  (P2-T9)
 *
 * ## The only thing this page has to get right
 *
 * **A teacher must be able to see what they are about to break, before they break it.**
 *
 * So the blast radius is not a confirmation dialog. A dialog is a modal the teacher clicks
 * through, and a number inside a dialog is a number they did not read. Here the numbers are on
 * the row, always, and the destructive button is DISABLED with the reason next to it — so the
 * information is available before the intent, not after it.
 *
 * ## Four accessibility decisions, each for a specific failure
 *
 *   · **The blocked action names its reason in the accessible name.** A disabled button with
 *     `title="1 attempt in progress"` is announced as "dimmed" on some readers and skipped
 *     entirely on others, and the reason is the whole content of the message. The reason is
 *     therefore real text next to the control, not an attribute.
 *
 *   · **The reason is `aria-describedby`, not `aria-label`.** A label REPLACES the visible text;
 *     a description supplements it. Overwriting "Transfer" with "Transfer — 1 attempt in
 *     progress" means a screen reader never hears the word "Transfer" as the name of the thing.
 *
 *   · **The blast radius is a `<dl>`.** It is a set of labelled quantities, which is what a
 *     definition list is, and it is announced as "3 classrooms, 3" rather than as a run of
 *     numbers in a row of divs.
 *
 *   · **The row count is announced.** A list that changes under you with no announcement is the
 *     single most disorienting thing a filtered list can do.
 *
 * ## Why a blocked transfer is a 409 and not a 403
 *
 * Surfaced as a recoverable condition, because it is one. A 403 says "never"; a live attempt
 * says "not yet". The copy says "wait for it to finish, or publish a corrected version instead"
 * because a teacher blocked by this should have a next move, and "publish a corrected version"
 * is the one that preserves the version chain.
 */

import { useState } from 'react';

export interface LibraryRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly visibility: string;
  readonly classroomCount: number;
  readonly attemptsInFlight: number;
  readonly updatedLabel: string;
  /** Server-computed. `null` when there is no live attempt. */
  readonly blockedReason: string | null;
}

export interface LibraryActions {
  transfer(input: {
    resourceId: string;
    toUserId: string;
    reason: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  duplicate(
    resourceId: string,
  ): Promise<{ ok: true; resourceId: string } | { ok: false; reason: string }>;
}

const STATUS_LABEL: Readonly<Record<string, string>> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
  WITHDRAWN: 'Withdrawn',
};

export function ResourceLibrary(props: { rows: readonly LibraryRow[]; actions: LibraryActions }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openTransfer, setOpenTransfer] = useState<string | null>(null);

  const run = async (
    id: string,
    fn: () => Promise<{ ok: boolean; reason?: string }>,
    success: string,
  ) => {
    setPending(id);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result.ok) setNotice(success);
      else setError(result.reason ?? 'that did not work');
    } catch {
      // A thrown action is an unknown outcome, and on a page that can move a resource between
      // people an unknown outcome must be reported as unknown rather than as a failure that
      // invites an immediate retry. Retrying a transfer is harmless; retrying a delete is not.
      setError(
        'Something went wrong and we do not know whether it worked. Reload before retrying.',
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="library-heading">
      <h2 id="library-heading">Your resources</h2>

      {/* A live region, so a filter changing the list is announced rather than merely felt. */}
      <p aria-live="polite" className="muted">
        {props.rows.length} resource{props.rows.length === 1 ? '' : 's'}
      </p>

      {error !== null && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}

      {props.rows.length === 0 ? (
        <p>You have not written anything yet.</p>
      ) : (
        <ul className="library">
          {props.rows.map((row) => {
            const busy = pending === row.id;
            const blocked = row.blockedReason !== null;
            return (
              <li key={row.id} className="library-row">
                <h3>{row.title}</h3>
                <p className="muted">
                  {STATUS_LABEL[row.status] ?? row.status} &middot; {row.kind} &middot;{' '}
                  {row.visibility.toLowerCase()} &middot; updated {row.updatedLabel}
                </p>

                <BlastRadius
                  rowId={row.id}
                  classroomCount={row.classroomCount}
                  attemptsInFlight={row.attemptsInFlight}
                />

                <div className="row-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(row.id, () => props.actions.duplicate(row.id), 'Duplicated.')
                    }
                  >
                    Duplicate
                  </button>

                  {openTransfer !== row.id ? (
                    <button
                      type="button"
                      disabled={blocked || busy}
                      aria-describedby={blocked ? `blocked-${row.id}` : undefined}
                      onClick={() => setOpenTransfer(row.id)}
                    >
                      Transfer
                    </button>
                  ) : (
                    <TransferForm
                      row={row}
                      busy={busy}
                      onCancel={() => setOpenTransfer(null)}
                      onSubmit={(toUserId, reason) =>
                        run(
                          row.id,
                          () => props.actions.transfer({ resourceId: row.id, toUserId, reason }),
                          'Transferred.',
                        )
                      }
                    />
                  )}

                  {blocked && (
                    <p id={`blocked-${row.id}`} className="warn">
                      Cannot transfer yet: {row.blockedReason}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BlastRadius(props: { rowId: string; classroomCount: number; attemptsInFlight: number }) {
  return (
    <dl className="blast" aria-label="What depends on this resource">
      <div>
        <dt>Used in</dt>
        <dd>
          {props.classroomCount} classroom{props.classroomCount === 1 ? '' : 's'}
        </dd>
      </div>
      <div>
        <dt>Attempts in progress</dt>
        <dd>{props.attemptsInFlight}</dd>
      </div>
    </dl>
  );
}

function TransferForm(props: {
  row: LibraryRow;
  busy: boolean;
  onCancel(): void;
  onSubmit(toUserId: string, reason: string): void;
}) {
  const [toUserId, setToUserId] = useState('');
  const [reason, setReason] = useState('');
  // The same minimum the db layer enforces. Mirrored rather than shared because the server is
  // the authority and this is only there to explain the refusal before it happens.
  const reasonTooShort = reason.trim().length < 10;

  return (
    <form
      className="transfer"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(toUserId.trim(), reason);
      }}
    >
      <label htmlFor={`to-${props.row.id}`}>New owner (user id)</label>
      <input
        id={`to-${props.row.id}`}
        value={toUserId}
        onChange={(e) => setToUserId(e.target.value)}
        required
      />

      <label htmlFor={`why-${props.row.id}`}>Why</label>
      <input
        id={`why-${props.row.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        aria-invalid={reasonTooShort || undefined}
        aria-describedby={reasonTooShort ? `why-help-${props.row.id}` : undefined}
      />
      {reasonTooShort && (
        <p id={`why-help-${props.row.id}`} className="warn">
          A transfer needs a reason. Nobody notices a lesson quietly changing hands, so this is the
          only record of why.
        </p>
      )}

      <button type="submit" disabled={props.busy || reasonTooShort || toUserId.trim() === ''}>
        Transfer
      </button>
      <button type="button" onClick={props.onCancel} disabled={props.busy}>
        Cancel
      </button>
    </form>
  );
}
