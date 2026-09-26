'use client';

import type { ReactNode } from 'react';

/**
 * The exam's entire provider tree. Intentionally almost empty.
 *
 * The temptation, always, is to add something here because every other feature has it.
 * Resist it. Each addition is bytes on the exam start path (budget: 250 KB gz) and a
 * failure mode that can reach a student under time pressure. The bar is "the exam cannot
 * function without it".
 *
 * What belongs here, when these phases land:
 *   · the answer store reducer (P7-T6) — the only writer of answers
 *   · the clock offset (P8-T2) — display only; the server is the authority
 *   · the six watchdogs (P8-T4..T8)
 *   · the IndexedDB outbox (P7-T6)
 *
 * What does NOT belong here, ever: theme providers with effects, analytics that can throw,
 * toasts, modals, anything reading a query cache. All of it can reach a student mid-exam.
 */

export interface ExamShellProps {
  /** The attempt. Rendered into the DOM for a teacher watching a screen-share, and used by tests. */
  attemptId: string;
  children: ReactNode;
}

export function ExamShell({ attemptId, children }: ExamShellProps) {
  return (
    <div
      data-exam-surface="true"
      data-attempt-id={attemptId}
      // Zero layout shift after start is a release gate (plans/03 §8). Fixed chrome only.
      style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </div>
  );
}
