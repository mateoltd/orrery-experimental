/**
 * REPRO: a gradePreview sent during a GRADED mount leaves no trace on the host.
 *
 * Run with `node scripts/repro-graded-preview.mjs`.
 *
 * ## WHAT IT DOES
 *
 * Mounts the conformance harness twice through the real host — once `lesson`, once `graded` — posts a
 * `sim:gradePreview` into the frame from inside it with the mount's own nonce, and prints what the host
 * recorded: its frame counter, its dropped-frame counter, and the teacher detail.
 *
 * ## WHY IT EXISTS
 *
 * The graded-mode conformance cell fails for all sixteen simulations with `a gradePreview during a graded
 * mount left no record, so nothing discarded it`. `hostBridge.ts` has an explicit `sim:gradePreview` case
 * that sets `teacherDetail` when `mode === 'graded'`, and `hostBridge.test.ts` asserts that handler
 * directly — so either the browser path never reaches it, or the mode is not what the cell thinks it is.
 * Those are very different bugs and a unit test cannot tell them apart.
 *
 * `plans/10` §2.3 and the cell both treat a leaked grade during an exam as something the host must catch.
 * Until this prints the reason, that claim is untested in a browser.
 */

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startAppOrigin, startSimOrigin } from './conformance/origins.mjs';

const { simAssetUrl } = await import('../packages/sim-registry/dist/index.js');

const registry = JSON.parse(readFileSync('sims/registry/registry.json', 'utf8'));
const entry = registry.entries.find((e) => e.id === 'maths.pythagoras');

const app = await startAppOrigin();
const sim = await startSimOrigin();
const browser = await chromium.launch();

const configFor = (mode) =>
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
      params: {},
      mode,
    }),
  ).toString('base64url');

for (const mode of ['lesson', 'graded']) {
  const page = await browser.newPage();
  await page.goto(`${app.origin}/?cfg=${configFor(mode)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
    timeout: 15_000,
  });
  // WAIT FOR THE HANDSHAKE, not just for the harness to render. `__conformance.ready` is set when the
  // React tree mounts, which is BEFORE the simulation has said `sim:ready` -- and a probe that posts into
  // a frame that has not authenticated yet sees no frame counter and no nonce, and concludes the host is
  // broken. The first run of this probe did exactly that, in BOTH modes, alternately.
  await page
    .waitForFunction(
      () => globalThis.__conformance.log.inbound.some((frame) => frame.type === 'sim:ready'),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {});
  // The host's `sim:gradePreview` case is on its INBOUND listener, so the FRAME has to send.
  // `iframe.contentWindow.postMessage(...)` from here is host -> frame, and the host never sees it --
  // which is why this probe reported "no record" in both modes and looked like a broken host rule.
  const read = () =>
    page.evaluate(() => {
      const host = globalThis.document.querySelector('.sim-host');
      return {
        frames: host?.getAttribute('data-sim-frames') ?? null,
        dropped: host?.getAttribute('data-sim-dropped') ?? null,
        detail: host?.getAttribute('data-sim-teacher-detail') ?? null,
        detailRendered:
          globalThis.document.querySelector('[data-testid="sim-teacher-detail"]')?.textContent ??
          null,
      };
    });

  const nonce = await page.evaluate(
    () =>
      [...globalThis.__conformance.log.inbound].reverse().find((f) => f.type === 'sim:ready')
        ?.nonce ?? null,
  );
  const simFrame = page.frames().find((frame) => frame.url().startsWith(sim.origin));
  const before = await read();
  if (nonce === null || simFrame === undefined) {
    console.log(mode, JSON.stringify({ before, error: 'no nonce or sim frame' }));
    await page.close();
    continue;
  }
  await simFrame.evaluate((n) => {
    globalThis.parent.postMessage(
      { type: 'sim:gradePreview', nonce: n, points: 4, correct: true, rationale: 'leaked' },
      '*',
    );
  }, nonce);
  await page.waitForTimeout(600);
  console.log(mode, JSON.stringify({ before, after: await read() }));
  await page.close();
}

await browser.close();
await sim.close();
await app.close();
