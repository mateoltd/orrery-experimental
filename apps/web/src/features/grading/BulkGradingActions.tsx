'use client';

import * as React from 'react';
import type { GradingAction } from '../../../../../packages/db/src/grading-policy.js';

export type BulkActionRequest = GradingAction | { kind: 'RELEASE'; reason: string };
export interface BulkGradingActionsProps {
  targets: readonly { attemptId: string; responseId: string; basedOn: string }[];
  releaseBatchId?: string;
  onApply: (input: {
    targets: BulkGradingActionsProps['targets'];
    action: BulkActionRequest;
    releaseBatchId?: string;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

/** Capture the selection with the action; a changing queue filter must not change an in-flight command. */
export function BulkGradingActions(props: BulkGradingActionsProps) {
  const [kind, setKind] = React.useState<BulkActionRequest['kind']>('SCORE');
  const [score, setScore] = React.useState('');
  const [feedback, setFeedback] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [visibility, setVisibility] = React.useState<'TEACHER_ONLY' | 'STUDENT_AFTER_RELEASE'>(
    'STUDENT_AFTER_RELEASE',
  );
  const [reviewedSelection, setReviewedSelection] = React.useState<string | null>(null);
  const [contextSelection, setContextSelection] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const running = React.useRef(false);
  const [status, setStatus] = React.useState('');
  const id = React.useId();
  const selectionKey = JSON.stringify(
    props.targets.map((target) => [target.attemptId, target.responseId, target.basedOn]),
  );
  const humanConfirmed = reviewedSelection === selectionKey;
  const context = contextSelection === selectionKey;
  const count = new Set(props.targets.map((target) => target.attemptId)).size;
  const reasonNeeded = kind === 'EXCUSE' || kind === 'VOID' || kind === 'RELEASE';
  const submit = async () => {
    if (running.current || count === 0) return;
    if (reasonNeeded && !reason.trim()) {
      setStatus('Enter a reason for this action.');
      return;
    }
    let action: BulkActionRequest;
    switch (kind) {
      case 'SCORE': {
        const points = score.trim() === '' ? NaN : Number(score);
        if (
          !Number.isFinite(points) ||
          points < 0 ||
          Math.abs(points * 100 - Math.round(points * 100)) > 1e-7
        ) {
          setStatus('Enter a nonnegative mark with at most two decimal places.');
          return;
        }
        action = { kind, points, feedback };
        break;
      }
      case 'FEEDBACK':
        if (!feedback.trim()) {
          setStatus('Enter feedback for the selection.');
          return;
        }
        action = { kind, body: feedback, visibility, isDraft: false };
        break;
      case 'EXCUSE':
        action = { kind, reason: reason.trim() };
        break;
      case 'VOID':
        if (!humanConfirmed) {
          setStatus('A human must uphold the integrity concern before voiding.');
          return;
        }
        action = {
          kind,
          reason: reason.trim(),
          humanConfirmed,
          consideredAccessibilityContext: context,
        };
        break;
      case 'RELEASE':
        if (!props.releaseBatchId) {
          setStatus('Choose a release batch for this selection.');
          return;
        }
        action = { kind, reason: reason.trim() };
        break;
    }
    running.current = true;
    setBusy(true);
    const command = { targets: [...props.targets], action, releaseBatchId: props.releaseBatchId };
    try {
      const result = await props.onApply(command);
      setStatus(
        result.ok
          ? 'The action was applied to the entire selection.'
          : (result.reason ?? 'The action was refused. No selected paper was changed.'),
      );
    } catch {
      setStatus('The request did not complete. Refresh the selection before trying again.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="Bulk grading actions">
      <p>
        {count} paper(s) selected. Every selected paper changes together or the action is refused.
      </p>
      <label htmlFor={`${id}-action`}>Action</label>
      <select
        id={`${id}-action`}
        value={kind}
        disabled={busy}
        onChange={(event) => {
          setKind(event.target.value as BulkActionRequest['kind']);
          setStatus('');
        }}
      >
        <option value="SCORE">Set score</option>
        <option value="FEEDBACK">Add feedback</option>
        <option value="EXCUSE">Excuse selected questions</option>
        <option value="VOID">Void papers</option>
        <option value="RELEASE">Release batch</option>
      </select>
      {kind === 'SCORE' && (
        <>
          <label htmlFor={`${id}-score`}>Mark for each selected response</label>
          <input
            id={`${id}-score`}
            value={score}
            disabled={busy}
            onChange={(event) => setScore(event.target.value)}
          />
        </>
      )}
      {(kind === 'SCORE' || kind === 'FEEDBACK') && (
        <>
          <label htmlFor={`${id}-feedback`}>Feedback for the selection</label>
          <textarea
            id={`${id}-feedback`}
            value={feedback}
            disabled={busy}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </>
      )}
      {kind === 'FEEDBACK' && (
        <>
          <label htmlFor={`${id}-visibility`}>Who can read this feedback</label>
          <select
            id={`${id}-visibility`}
            value={visibility}
            disabled={busy}
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
          >
            <option value="TEACHER_ONLY">Teachers only</option>
            <option value="STUDENT_AFTER_RELEASE">Student after release</option>
          </select>
        </>
      )}
      {reasonNeeded && (
        <>
          <label htmlFor={`${id}-reason`}>Reason</label>
          <textarea
            id={`${id}-reason`}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      )}
      {kind === 'VOID' && (
        <>
          <p>Voiding discards attempt totals and retains the evidence and audit history.</p>
          <label>
            <input
              type="checkbox"
              checked={humanConfirmed}
              disabled={busy}
              onChange={(event) => setReviewedSelection(event.target.checked ? selectionKey : null)}
            />
            I reviewed the evidence and uphold the integrity concern
          </label>
          <label>
            <input
              type="checkbox"
              checked={context}
              disabled={busy}
              onChange={(event) => setContextSelection(event.target.checked ? selectionKey : null)}
            />
            I considered the student's accessibility context
          </label>
        </>
      )}
      {kind === 'RELEASE' && (
        <p>Releasing makes the whole selected batch visible to its students.</p>
      )}
      <button
        type="button"
        disabled={busy || count === 0}
        onClick={() => {
          void submit();
        }}
      >
        Apply to {count} paper(s)
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
