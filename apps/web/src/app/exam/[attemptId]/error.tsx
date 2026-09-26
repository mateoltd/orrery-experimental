'use client';

/**
 * The EXAM error boundary, which is not the root one on purpose.
 *
 * A student whose exam just crashed under time pressure needs three things, in this order:
 * that their work is safe, how much time is left, and who to tell. The root boundary
 * offers a generic "try again", which would be a lie here — the attempt is still running
 * server-side and the clock has NOT stopped.
 *
 * Note what this does not do: it does not offer a retry that could lose an answer, and it
 * does not claim the exam was submitted. `INV-LATE-1` and the autosave contract mean the
 * server holds whatever was acknowledged, and the client says exactly that.
 */
export default function ExamError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{
        padding: '2rem',
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '44rem',
        lineHeight: 1.5,
      }}
      role="alert"
      aria-live="assertive"
    >
      <h1>The exam could not be displayed</h1>

      <p>
        <strong>Your answers are safe.</strong> Everything you saved has been recorded on the
        server. Your exam is still running and the clock has not stopped.
      </p>

      <p>Do not close this tab. Select &ldquo;Try again&rdquo; to reload the exam.</p>

      {error.digest ? (
        <p style={{ color: '#444', fontSize: '0.9375rem' }}>
          If this keeps happening, quote reference <code>{error.digest}</code> to your teacher.
          Answers you did not see saved may not have been recorded — this is explained before you
          start an exam, and your teacher can extend your time.
        </p>
      ) : null}

      <button type="button" onClick={reset} autoFocus>
        Try again
      </button>
    </main>
  );
}
