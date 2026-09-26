import type { ReactNode } from 'react';

/**
 * The ROOT layout. Deliberately minimal.
 *
 * The exam surface must be isolatable from everything else (plans/03 §4.1): a marketing
 * page, a studio widget or a dashboard component throwing must not be able to reach a
 * student mid-exam. So the root provides no providers, no theme wrapper with effects, and
 * nothing that can throw during render.
 *
 * Anything shared goes in `ExamProviders` (src/features/exam/providers.tsx), which only the
 * exam route mounts. If you are adding a provider that the exam does not need, do not put
 * it here.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
