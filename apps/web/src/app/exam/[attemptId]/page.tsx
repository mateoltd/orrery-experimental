import { Suspense } from 'react';

export const metadata = {
  // A student must not be able to share an exam URL and have it render meaningfully.
  // B7: the attempt id alone is not a secret, and sync used to be unauthenticated.
  robots: { index: false, follow: false, nocache: true },
  title: 'Assessment in progress',
};

export const dynamic = 'force-dynamic';

export default async function ExamPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  return (
    <Suspense fallback={<ExamBooting />}>
      <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Assessment</h1>
        <p>
          Attempt <code>{attemptId.slice(0, 8)}</code> is ready. The question surface, the clock and
          the six watchdogs land in P7 and P8.
        </p>
      </main>
    </Suspense>
  );
}

/**
 * The preflight placeholder. It states what is loading rather than showing a spinner,
 * because the first thing a nervous student needs is to know nothing is wrong.
 */
function ExamBooting() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }} aria-busy="true">
      <h1>Preparing your assessment</h1>
      <p role="status">Checking your device. This normally takes a few seconds.</p>
    </main>
  );
}
