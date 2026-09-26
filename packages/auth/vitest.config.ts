import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 100% branch coverage is a DONE criterion for P1-T6, not a nice-to-have, so it is
    // enforced as a threshold. The kernel is pure, so coverage is fully attainable.
    coverage: {
      provider: 'v8',
      include: [
        'src/can.ts',
        'src/matrix.ts',
        'src/types.ts',
        'src/decide.ts',
        'src/session.ts',
        'src/token.ts',
        'src/lifecycle.ts',
      ],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
