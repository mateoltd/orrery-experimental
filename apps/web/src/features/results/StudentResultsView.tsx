import type { StudentResults } from '@orrery/db/student-results';
import * as React from 'react';

void React;

/** Feedback bodies carry no id and may repeat; the occurrence count makes the text a stable key. */
function keyed(bodies: readonly string[]): readonly { key: string; body: string }[] {
  const seen = new Map<string, number>();
  return bodies.map((body) => {
    const occurrence = (seen.get(body) ?? 0) + 1;
    seen.set(body, occurrence);
    return { key: `${occurrence}:${body}`, body };
  });
}

export function StudentResultsView({ results }: { readonly results: StudentResults }) {
  return (
    <section aria-label="Your results">
      <h1>
        {results.state === 'RELEASED'
          ? 'Your results'
          : results.receipt.submittedAt === null
            ? 'Your attempt'
            : 'Submitted'}
      </h1>
      {results.state === 'SEALED' ? (
        <p role="status">{results.notice}</p>
      ) : (
        <>
          {results.regradeNotice && <p role="status">{results.regradeNotice}</p>}
          {results.accommodationMarker && <p>{results.accommodationMarker}</p>}
          <dl aria-label="Score breakdown">
            <dt>Marks awarded</dt>
            <dd>
              {results.breakdown.rawTotal} / {results.breakdown.maxTotal}
            </dd>
            <dt>Percentage before late penalty</dt>
            <dd>
              {results.breakdown.percentage === null
                ? 'Not applicable'
                : `${(results.breakdown.percentage * 100).toFixed(2)}%`}
            </dd>
            <dt>Late penalty</dt>
            <dd>{(results.breakdown.latePenaltyApplied * 100).toFixed(2)}%</dd>
            <dt>Result</dt>
            <dd>
              {results.breakdown.finalScore === null
                ? 'Not applicable'
                : `${results.breakdown.finalScore.toFixed(2)}%`}
              {results.breakdown.provisional ? ' (provisional)' : ''}
            </dd>
          </dl>
          {keyed(results.feedback).map(({ key, body }) => (
            <p key={key}>{body}</p>
          ))}
          <ol aria-label="Question outcomes">
            {results.questions.map((q) => (
              <li key={q.questionId}>
                <h2>Question {q.position + 1}</h2>
                <p>
                  {q.outcome === 'AWAITING_REVIEW' ? 'Awaiting review' : q.outcome.toLowerCase()}
                </p>
                <p>
                  {q.score === null ? 'No mark' : q.score} / {q.max}
                </p>
                {keyed(q.feedback).map(({ key, body }) => (
                  <p key={key}>{body}</p>
                ))}
                {q.correctAnswer !== null && <p>Correct answer: {q.correctAnswer}</p>}
              </li>
            ))}
          </ol>
        </>
      )}
      <section aria-label="Submission receipt">
        <h2>Submission receipt</h2>
        <p>{results.receipt.submittedAt ?? 'No submission recorded'}</p>
        <code>{results.receipt.receiptHash ?? 'No receipt issued'}</code>
        <details>
          <summary>Your submitted answers</summary>
          <ol>
            {results.receipt.answers.map((a) => (
              <li key={a.questionId}>
                <pre>
                  {typeof a.answer === 'string' ? a.answer : JSON.stringify(a.answer, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        </details>
      </section>
    </section>
  );
}
