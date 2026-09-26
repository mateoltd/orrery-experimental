import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Workspace packages point their `exports` at `dist`, which does not exist until a build
// runs. Tests run against SOURCE, so `@orrery/clock` resolves here without a build step in
// the unit loop. The build pipeline (Turbo `dependsOn: ["^build"]`) handles the real one.
export default defineConfig({
  resolve: {
    alias: {
      '@orrery/clock': fileURLToPath(new URL('../clock/src/index.ts', import.meta.url)),
      '@orrery/ids': fileURLToPath(new URL('../ids/src/index.ts', import.meta.url)),
      '@orrery/rng': fileURLToPath(new URL('../rng/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
