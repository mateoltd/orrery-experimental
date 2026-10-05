'use client';

import * as React from 'react';
import type { RegradePreview as RegradePlan } from '../../../../../packages/db/src/grading-regrade.js';

export interface RegradePreviewProps {
  preview: RegradePlan;
  /** The host chooses names or candidate numbers, as it does for `GradingWorkspace`. */
  paperLabels?: Readonly<Record<string, string>>;
  onConfirm: (preview: RegradePlan) => Promise<{ ok: boolean; reason?: string }>;
}
const value = (mark: number | null) => (mark === null ? 'Not computed' : String(mark));

/** Confirmation carries the displayed token. The worker refuses a newer mark or a different calculation. */
export function RegradePreview(props: RegradePreviewProps) {
  const [busy, setBusy] = React.useState(false);
  const running = React.useRef(false);
  const [notice, setNotice] = React.useState({ token: '', text: '' });
  const confirm = async () => {
    if (running.current || props.preview.affectedCount === 0) return;
    running.current = true;
    setBusy(true);
    const shown = props.preview;
    try {
      const result = await props.onConfirm(shown);
      setNotice({
        token: shown.token,
        text: result.ok
          ? 'Regrade request accepted.'
          : (result.reason ?? 'The preview changed. Review a fresh dry run before confirming.'),
      });
    } catch {
      setNotice({
        token: shown.token,
        text: 'The request did not complete. Check its status before trying again.',
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="Regrade dry run">
      <h2>Review the regrade before applying it</h2>
      <p>Reason: {props.preview.request.reason}</p>
      <p>
        {props.preview.affectedCount} affected paper(s); {props.preview.alreadyReleasedCount}{' '}
        already released.
      </p>
      <p>
        Released batches change together. Each changed released result receives a student notice
        with this reason.
      </p>
      <table>
        <caption>Old and proposed results</caption>
        <thead>
          <tr>
            <th scope="col">Paper</th>
            <th scope="col">Old result</th>
            <th scope="col">New result</th>
            <th scope="col">Change</th>
            <th scope="col">Visibility</th>
          </tr>
        </thead>
        <tbody>
          {props.preview.attempts.map((attempt, index) => (
            <tr key={attempt.attemptId}>
              <th scope="row">{props.paperLabels?.[attempt.attemptId] ?? `Paper ${index + 1}`}</th>
              <td>{value(attempt.before.finalScore)}</td>
              <td>
                {attempt.after.isProvisional ? 'Awaiting a mark' : value(attempt.after.finalScore)}
              </td>
              <td>
                {attempt.delta === null
                  ? 'Not comparable'
                  : attempt.delta > 0
                    ? `+${attempt.delta}`
                    : String(attempt.delta)}
              </td>
              <td>{attempt.released ? 'Already released' : 'Withheld'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        disabled={busy || props.preview.affectedCount === 0}
        onClick={() => {
          void confirm();
        }}
      >
        Confirm this regrade
      </button>
      <p role="status">
        {notice.token && notice.token !== props.preview.token
          ? `Previous preview: ${notice.text}`
          : notice.text}
      </p>
    </section>
  );
}
