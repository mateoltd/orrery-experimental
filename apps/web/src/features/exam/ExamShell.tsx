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
 *   · the answer store reducer (P7-T6) — LANDED as `./answerStore`, a PURE reducer with no React in it
 *   · the clock offset (P8-T2) — display only; the server is the authority
 *   · the six watchdogs (P8-T4..T8)
 *   · the IndexedDB outbox (P7-T6) — LANDED as `./outbox` (the policy) and `./outboxIndexedDb` (the adapter)
 *
 * ## WHY THE REDUCER IS NOT A PROVIDER IN HERE, AND THE BAR WAS THE WRONG ONE
 *
 * The note above used to justify the empty file by BYTES, which is the wrong reason and would have been the wrong
 * rule. `answerStore.ts` is a pure reducer with no React and no effects, so putting it behind a context provider
 * here would add a subscription, a re-render boundary and a bundle import to the exam start path in exchange for
 * nothing. It is a function: `reduceAttempt(state, event)`.
 *
 * The file stays empty until something is genuinely unavoidable, and the durable reducer and outbox are reachable
 * by import from the attempt route — which is also what lets them be tested without a DOM, a fact worth more than
 * the bytes.
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
