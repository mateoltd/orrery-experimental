/**
 * Building the browser harness.  (P6-T9)
 *
 * ## WHY BOTH SUITES CALL THIS, AND WHY IT MATTERED
 *
 * `sim:sandbox-escape` originally served the bundle that `sim:conformance` happened to have left in the
 * cache. Run on its own -- which is how a CI gate runs -- it tested whatever was there, including nothing
 * at all. The negative control that proved it: weakening the sandbox attribute to
 * `allow-scripts allow-same-origin allow-forms allow-popups allow-modals` still reported "12/12 escapes
 * blocked", because the bundle under test was the previous build.
 *
 * A gate that silently tests a stale artefact is worse than no gate, because it is believed. Both suites
 * build it, from source, every run.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build as esbuild } from 'esbuild';
import { ROOT } from './origins.mjs';

export const CACHE = join(ROOT, 'node_modules/.cache/orrery-conformance');
export const HARNESS_BUNDLE = join(CACHE, 'harness.js');

/**
 * Bundle the harness page's script.
 *
 * Built HERE rather than by a sibling npm script, because `sim:new` tells an author to run
 * `pnpm sim:conformance` and a command that fails with "first run the other command" is a command
 * nobody runs.
 */
export const buildHarness = async () => {
  await mkdir(CACHE, { recursive: true });
  await esbuild({
    entryPoints: [join(ROOT, 'scripts/conformance/harness.tsx')],
    outfile: HARNESS_BUNDLE,
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2022',
    // The harness renders the REAL component, so React and ReactDOM come along; the workspace
    // aliases are the same ones `sim:build` uses, kept in step deliberately.
    // React is a dependency of `apps/web`, not of the root, and pnpm does not hoist. Resolution is
    // pointed at both trees rather than duplicating React into the root for one harness.
    nodePaths: [join(ROOT, 'node_modules'), join(ROOT, 'apps/web/node_modules')],
    loader: { '.tsx': 'tsx' },
    alias: {
      '@orrery/sim-sdk': join(ROOT, 'packages/sim-sdk/src/index.ts'),
      '@orrery/sim-sdk/protocol': join(ROOT, 'packages/sim-sdk/src/protocol.ts'),
      '@orrery/sim-sdk/state': join(ROOT, 'packages/sim-sdk/src/state.ts'),
      '@orrery/clock': join(ROOT, 'packages/clock/src/index.ts'),
      '@orrery/rng': join(ROOT, 'packages/rng/src/index.ts'),
    },
    logLevel: 'error',
    // A build that silently drops a failed import produces a harness that mounts nothing and passes
    // every assertion that does not touch the frame.
    logLimit: 0,
  });
};
