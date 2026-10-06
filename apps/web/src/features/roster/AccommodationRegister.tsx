'use client';

/**
 * THE ACCOMMODATIONS REGISTER: grant during a live exam, see every grant, revoke, export.  (P13-T6)
 *
 * Mounted on the roster page because that is where a teacher already is when the need arises --
 * mid-lesson, one student struggling with fullscreen lock-in, grant before the next question. A
 * separate admin surface would be correct in theory and unvisited in practice.
 *
 * Grant form carries the student (by row button below, filling a hidden field), the relaxations as
 * checkboxes, extra-time percent only when that relaxation is ticked, and a reason with the same
 * minimum the service enforces -- the client minimum is courtesy, the service minimum is the rule.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type AccommodationRow,
  grantAccommodationAction,
  listAccommodations,
  revokeAccommodationAction,
} from '@/server/accommodations';

const RELAXATIONS = [
  { id: 'DISABLE_FULLSCREEN', label: 'No fullscreen lock-in' },
  { id: 'DISABLE_POINTER_LOCK', label: 'No pointer lock requirement' },
  { id: 'DISABLE_TAB_WATCHDOG', label: 'Tab-hide and focus-loss watchdogs stay silent' },
  { id: 'EXTRA_TIME_PERCENT', label: 'Extra time (percent of the paper total)' },
] as const;

export function AccommodationRegister(props: {
  readonly classroomId: string;
  readonly callerUserId: string;
  readonly canGrant: boolean;
}): React.ReactElement | null {
  const [rows, setRows] = useState<readonly AccommodationRow[] | null>(null);
  const [error, setError] = useState('');
  const [studentId, setStudentId] = useState('');
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [extraTime, setExtraTime] = useState('');
  const [reason, setReason] = useState('');

  // useCallback, not an inline closure: the effect keys on this identity, and an inline closure
  // changes every render (which is what the exhaustive-deps rule is complaining about). A disabled
  // rule would be a promise nobody re-checks.
  const refresh = useCallback(async (): Promise<void> => {
    setRows(
      await listAccommodations({
        callerUserId: props.callerUserId,
        classroomId: props.classroomId,
      }),
    );
  }, [props.callerUserId, props.classroomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Not rendered at all for non-teachers: students must never see a grant form, even a disabled one,
  // because a disabled form still teaches the shape of the action it withholds.
  if (!props.canGrant) return null;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    const result = await grantAccommodationAction({
      callerUserId: props.callerUserId,
      classroomId: props.classroomId,
      studentId,
      relaxations: checked,
      ...(extraTime === '' ? {} : { extraTimePercent: Number(extraTime) }),
      reason,
    });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setStudentId('');
    setChecked([]);
    setExtraTime('');
    setReason('');
    await refresh();
  };

  return (
    <section aria-label="Accommodations">
      <h2>Accommodations</h2>
      {error === '' ? null : <p role="alert">{error}</p>}
      <form onSubmit={submit}>
        <label>
          Student user id
          <input
            type="text"
            name="student"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            required
          />
        </label>
        <fieldset>
          <legend>Relaxations</legend>
          {RELAXATIONS.map((relaxation) => (
            <label key={relaxation.id}>
              <input
                type="checkbox"
                checked={checked.includes(relaxation.id)}
                onChange={(e) =>
                  setChecked(
                    e.target.checked
                      ? [...checked, relaxation.id]
                      : checked.filter((r) => r !== relaxation.id),
                  )
                }
              />
              {relaxation.label}
            </label>
          ))}
        </fieldset>
        {checked.includes('EXTRA_TIME_PERCENT') ? (
          <label>
            Extra time percent
            <input
              type="number"
              min={1}
              max={100}
              value={extraTime}
              onChange={(e) => setExtraTime(e.target.value)}
              required
            />
          </label>
        ) : null}
        <label>
          Reason (at least 10 characters, so the student can challenge it)
          <textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={10}
            rows={2}
          />
        </label>
        <button type="submit">Grant accommodation</button>
      </form>
      <h3>Register</h3>
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>No accommodations granted in this classroom.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Student</th>
              <th scope="col">Relaxations</th>
              <th scope="col">Reason</th>
              <th scope="col">Status</th>
              <th scope="col">Granted</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.studentEmail}</td>
                <td>{row.relaxations.join(', ')}</td>
                <td>{row.reason}</td>
                <td>{row.status}</td>
                <td>
                  {row.grantedAt} by {row.grantedBy}
                </td>
                <td>
                  {row.status === 'ACTIVE' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const result = await revokeAccommodationAction({
                          callerUserId: props.callerUserId,
                          classroomId: props.classroomId,
                          accommodationId: row.id,
                        });
                        if (!result.ok) setError(result.reason);
                        else await refresh();
                      }}
                    >
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <a href={`/api/classrooms/${props.classroomId}/accommodations/export`}>
          Download audit export (CSV)
        </a>
      </p>
    </section>
  );
}
