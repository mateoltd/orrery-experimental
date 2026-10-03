/**
 * REPRO: lesson parameters do not reach the simulation in the browser.
 *
 * Run with `node scripts/repro-init-params.mjs`. It mounts the conformance harness twice through the real
 * host -- once with the manifest's declared defaults, once with `buretteCm: 40` -- and prints the value
 * the simulation's own input holds at 200ms, 600ms and 1500ms.
 *
 * ## WHAT IT SHOWS
 *
 * `default` -> 23.4 and `buretteCm=40` -> 23.4. The page's own config reads `{"buretteCm":40}`, so the
 * parameter reaches the host, and the host does stamp it on `sim:init` -- asserted in
 * `apps/web/src/features/sim/hostBridge.test.ts`. It does not arrive at the simulation.
 *
 * ## WHY IT IS A SCRIPT AND NOT A CONFORMANCE CELL
 *
 * This started as a cell asserting that `reset` restores the initial state, which is a real guarantee no
 * simulation had and no cell checked. Making that cell pass requires first being able to CHANGE a
 * simulation's state from the host, which is this bug. Shipping the cell red would make the suite red for
 * a reason that is really one open defect; shipping it green would be a lie. So the finding is a
 * reproducible script plus an OPEN item in the tracker, and the cell returns when the path below works.
 *
 * ## WHAT IS ALREADY FIXED
 *
 * The SDK's `sim:init` handler discarded `frame.params` entirely: it marked the simulation started and
 * returned. So even a correctly stamped frame was ignored. That is fixed, with a unit test. The remaining
 * gap is in the browser path and is NOT fixed.
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startAppOrigin, startSimOrigin } from './conformance/origins.mjs';

const { simAssetUrl } = await import('../packages/sim-registry/dist/index.js');

const registry = JSON.parse(readFileSync('sims/registry/registry.json', 'utf8'));
const entry = registry.entries.find((e) => e.id === 'chem.mole-concentration');
const manifest = JSON.parse(readFileSync('sims/chem.mole-concentration/sim.manifest.json', 'utf8'));

const config = (overrides) =>
  Buffer.from(
    JSON.stringify({
      bundleUrl: simAssetUrl(sim.origin, entry, 'page'),
      simOrigin: sim.origin,
      simId: entry.id,
      simVersion: entry.version,
      defaultHeight: Number(entry.defaultHeight ?? 400),
      minHeight: Number(entry.minHeight ?? 200),
      textAlternative: String(entry.title),
      title: String(entry.title),
      params: {
        buretteCm: manifest.params.properties.buretteCm.default,
        flaskMl: manifest.params.properties.flaskMl.default,
        ...(overrides ?? {}),
      },
      mode: 'lesson',
    }),
  ).toString('base64url');

const app = await startAppOrigin();
const sim = await startSimOrigin();
const browser = await chromium.launch();

for (const [label, overrides] of [
  ['default', null],
  ['buretteCm=40', { buretteCm: 40 }],
]) {
  const page = await browser.newPage();
  await page.goto(`${app.origin}/?cfg=${config(overrides)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
    timeout: 15_000,
  });
  for (const wait of [200, 600, 1500]) {
    await page.waitForTimeout(wait);
    const input = await page
      .frameLocator('iframe')
      .locator('#sim-burette')
      .inputValue()
      .catch(() => 'NO-FIELD');
    const seen = await page.evaluate(() => JSON.stringify(globalThis.__conformance.config?.params));
    console.log(`${label} +${String(wait)}ms -> input=${input} hostParams=${seen}`);
  }
  await page.close();
}

await browser.close();
await sim.close();
await app.close();
