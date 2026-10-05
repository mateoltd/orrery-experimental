'use client';

import type { LedgerRow } from '../../../../../packages/db/src/report-gradebook.js';
import type { IntegrityReport } from './integrity-report.js';

/** Legacy timeline entries lack IDs; duplicate occurrences are indistinguishable facts. */
function keyed<T>(values: readonly T[], identity: (value: T) => string) {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const id = identity(value);
    const occurrence = (counts.get(id) ?? 0) + 1;
    counts.set(id, occurrence);
    return { value, key: `${id}:${occurrence}` };
  });
}

export function Gradebook({ rows }: { readonly rows: readonly LedgerRow[] }) {
  return (
    <section aria-label="Gradebook">
      <p>
        This ledger lists active students. Each assignment uses its latest assessment attempt;
        practice attempts are excluded. Course totals include all published assignments, even in a
        filtered view. Excused work leaves the denominator. Missing, sealed, void, and provisional
        work leave the total unavailable.
      </p>
      <table>
        <caption>Assignment ledger — resolved questions and release state</caption>
        <thead>
          <tr>
            <th scope="col">Student</th>
            <th scope="col">Assignment</th>
            <th scope="col">Attempt</th>
            <th scope="col">Weight</th>
            <th scope="col">Status</th>
            <th scope="col">Score</th>
            <th scope="col">Resolved variant</th>
            <th scope="col">Form information</th>
            <th scope="col">Freshness</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row) =>
            row.cells.map((cell) => (
              <tr key={`${row.studentId}:${cell.assignmentId}`}>
                <th scope="row">{row.student}</th>
                <td>{cell.assignment}</td>
                <td>{cell.attemptId ?? 'No attempt'}</td>
                <td>{cell.weight}</td>
                <td>
                  {cell.flag} · {cell.state}
                  {cell.score?.isProvisional ? ' · provisional' : ''}
                </td>
                <td>
                  {cell.score?.finalScore === null || cell.score === null
                    ? 'Unavailable'
                    : `${cell.score.finalScore}%`}
                  {cell.scoreNotice && <p>{cell.scoreNotice}</p>}
                </td>
                <td>
                  {cell.variant.label}
                  <ol>
                    {keyed(cell.variant.questionIds, (id) => id).map(({ value: id, key }) => (
                      <li key={key}>{id}</li>
                    ))}
                  </ol>
                </td>
                <td>{cell.formNotice}</td>
                <td>{new Date(cell.computedAt).toISOString()}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <ul>
        {rows.map((row) => (
          <li key={row.studentId}>
            {row.student}: weighted total{' '}
            {row.total.percentage === null ? 'unavailable' : `${row.total.percentage}%`}; included
            weight {row.total.includedWeight}; unresolved weight {row.total.pendingWeight}; excused
            weight {row.total.excusedWeight}; computed at{' '}
            {new Date(row.total.computedAt).toISOString()}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Integrity({ report }: { readonly report: IntegrityReport }) {
  return (
    <section aria-label="Integrity evidence report">
      <p role="note">{report.banner}</p>
      <p>RN-01: {report.help}</p>
      <p>{report.similarityNotice}</p>
      <p>Computed at {new Date(report.computedAt).toISOString()}</p>
      <ul>
        {report.sourceNotices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
      <h2>Preflight</h2>
      <dl>
        {Object.entries(report.preflight).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
      </dl>
      <p>Events lost to telemetry shedding: {report.droppedEventCount}</p>
      <ul>
        {report.missingForDecision.map((missing) => (
          <li key={missing}>{missing}</li>
        ))}
      </ul>
      <h2>Evidence timeline</h2>
      <ul>
        {report.counts.map((count) => (
          <li key={count}>{count}</li>
        ))}
      </ul>
      <ol>
        {keyed(report.entries, (e) => `${e.at}:${e.type}:${e.phrase}`).map(({ value: e, key }) => (
          <li key={key}>
            {new Date(e.at).toISOString()} · {e.severity} · {e.phrase}
            {e.crossedThreshold !== undefined
              ? ` · threshold ${e.crossedThreshold} · dropped events ${e.droppedEventCount ?? 0}`
              : ''}
          </li>
        ))}
      </ol>
      <h2>Force-exit reports</h2>
      <ul>
        {keyed(report.forceExits, (exit) => `${exit.at}:${exit.phase}`).map(
          ({ value: exit, key }) => (
            <li key={key}>
              {new Date(exit.at).toISOString()} · {exit.phase}
            </li>
          ),
        )}
      </ul>
      <h2>Similarity membership</h2>
      <ul>
        {report.similarityClusters.map((c) => (
          <li key={c.id}>
            Cluster {c.id}: response IDs {c.responseIds.join(', ')}
          </li>
        ))}
      </ul>
      <h2>Teacher verdict</h2>
      <p>{report.verdictNotice}</p>
      {report.verdict && (
        <dl>
          <dt>Decision</dt>
          <dd>{report.verdict.conclusion}</dd>
          <dt>Reason</dt>
          <dd>{report.verdict.reason}</dd>
          <dt>Author</dt>
          <dd>{report.verdict.authorId}</dd>
          <dt>Recorded at</dt>
          <dd>{new Date(report.verdict.at).toISOString()}</dd>
          <dt>Accessibility context considered</dt>
          <dd>{String(report.verdict.consideredAccessibilityContext)}</dd>
        </dl>
      )}
    </section>
  );
}
