import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@orrery/clock': fileURLToPath(new URL('../../packages/clock/src/index.ts', import.meta.url)),
      '@orrery/config/logging': fileURLToPath(
        new URL('../../packages/config/src/logging.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
