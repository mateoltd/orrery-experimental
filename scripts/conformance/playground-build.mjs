/**
 * Bundling the playground page's script.  (P6-T10)
 *
 * Separate from the conformance harness's build because they are different programs: the harness renders
 * the REAL `SimulationFrame` component, and the playground deliberately does not — it is a hand-written
 * host so an author can see the raw protocol without React in the way. Sharing one bundle would have made
 * the harness quietly test the playground, or the other way round.
 *
 * Built on every run, for the same reason the escape gate builds its own: a dev tool that serves whatever
 * happened to be in the cache is a dev tool that lies.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { ROOT } from './origins.mjs';

const CACHE = join(ROOT, 'node_modules/.cache/orrery-conformance');
export const PLAYGROUND_BUNDLE = join(CACHE, 'playground.js');

export const buildPlayground = async () => {
  await mkdir(CACHE, { recursive: true });
  await esbuild({
    entryPoints: [join(ROOT, 'scripts/conformance/playground.ts')],
    outfile: PLAYGROUND_BUNDLE,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    // The protocol module is aliased to SOURCE for the same reason the sim build does it: a playground
    // built against a stale `dist` would disagree with the simulation it is debugging.
    alias: {
      '@orrery/sim-sdk/protocol': join(ROOT, 'packages/sim-sdk/src/protocol.ts'),
      '@orrery/sim-sdk': join(ROOT, 'packages/sim-sdk/src/index.ts'),
      '@orrery/rng': join(ROOT, 'packages/rng/src/index.ts'),
    },
    logLevel: 'error',
    logLimit: 0,
  });
};
