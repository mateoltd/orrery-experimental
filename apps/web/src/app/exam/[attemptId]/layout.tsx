import type { ReactNode } from 'react';
import { ExamShell } from '@/features/exam/ExamShell';

/**
 * THE EXAM SURFACE.
 *
 * Everything architectural about the exam lives in this subtree and nowhere else:
 *
 *   • Its own error boundary (`error.tsx` beside this file) — a student mid-exam is told
 *     their work is safe, which is true and is the single most reassuring sentence we can
 *     offer someone under time pressure.
 *   • Its own provider tree (`ExamShell`), with no dependency on studio, library or
 *     dashboard code. If a dashboard component throws, it cannot reach here.
 *   • A deliberately small client bundle (plans/03 §8: < 250 KB gz), enforced by
 *     `scripts/check-bundle-budget.mjs`.
 *
 * INVARIANT: no route outside `/exam/*` may be able to crash this subtree. A marketing
 * page throwing at 10:00 on exam day must not touch a student. When adding a provider here,
 * ask what it costs the exam start; the answer is usually "don't".
 */
export default async function ExamLayout({
  children,
  params,
}: {
  children: ReactNode;
  // Next 15 made `params` a Promise (RN-10). Awaiting it is a compile error if forgotten,
  // which is exactly the kind of mistake worth having the compiler catch.
  params: Promise<{ attemptId: string }>;
}) {
  const { attemptId } = await params;
  return <ExamShell attemptId={attemptId}>{children}</ExamShell>;
}
