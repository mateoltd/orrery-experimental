'use client';

/**
 * The ROOT error boundary. This is the app's blast radius for a render failure.
 *
 * It is intentionally a dead end with an explanation and a way out — never a stack trace,
 * and never a silent white screen. The exam route does NOT use this boundary: it has its
 * own (src/app/exam/error.tsx) so that an exam failure is presented differently, with the
 * student's work explicitly called out as safe.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '40rem' }}
      role="alert"
    >
      <h1>Something went wrong</h1>
      <p>This page could not be displayed. Nothing you have submitted has been lost.</p>
      {error.digest ? (
        <p style={{ color: '#666', fontSize: '0.875rem' }}>
          Reference: <code>{error.digest}</code> — quote this if you report the problem.
        </p>
      ) : null}
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
