import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Argon2id at the OWASP baseline costs ~40ms and 19 MiB per call, and the suite
    // deliberately hashes at PRODUCTION parameters — a test that lowers the cost is a test
    // that cannot catch a production problem. The default 5s timeout is not enough for the
    // twenty-hash concurrency test, and it should not be: if hashing gets slower that is a
    // finding, not something to paper over with a bigger number.
    testTimeout: 60_000,
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
        'src/password.ts',
        'src/throttle.ts',
      ],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
