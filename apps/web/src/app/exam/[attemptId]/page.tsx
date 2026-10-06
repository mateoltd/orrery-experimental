import { getPrisma } from '@orrery/db';
import { Suspense } from 'react';
import { ExamRunner } from '@/features/exam/ExamRunner';
import { currentUser } from '@/server/auth/session-runtime';
import { loadExamRunnerData } from '@/server/exam-runner';

export const metadata = {
  // A student must not be able to share an exam URL and have it render meaningfully.
  // B7: the attempt id alone is not a secret, and sync used to be unauthenticated.
  robots: { index: false, follow: false, nocache: true },
  title: 'Assessment in progress',
};

export const dynamic = 'force-dynamic';

/**
 * THE EXAM RUNNER PAGE.  (P8-T17)
 *
 * The paragraph that used to live here -- "the question surface lands in P7 and P8" -- is gone,
 * because P7 and P8 are past and the surface is this file now. What it does, in order:
 *
 *   1. resolves the caller from the session and fails closed on null -- an anonymous request gets
 *      the same "not available" as a wrong-owner request, because distinguishing them is an oracle;
 *   2. loads the caller's OWN attempt with public specs only, or nothing at all;
 *   3. hands the resolved paper to `ExamRunner` inside the `ExamShell` the layout already mounts.
 */
export default async function ExamPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const [{ attemptId }, user] = await Promise.all([params, currentUser()]);
  if (user === null) {
    return (
      <main>
        <h1>Assessment unavailable</h1>
        <p>This attempt is not available. Sign in with the account your teacher enrolled.</p>
      </main>
    );
  }
  const paper = await loadExamRunnerData(getPrisma(), user.userId, attemptId);
  if (paper === null) {
    return (
      <main>
        <h1>Assessment unavailable</h1>
        <p>
          This attempt is not available. It may belong to another student, or its questions may not
          have loaded.
        </p>
      </main>
    );
  }
  return (
    <Suspense fallback={<ExamBooting />}>
      <ExamRunner attemptId={paper.attemptId} policy={paper.policy} questions={paper.questions} />
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
