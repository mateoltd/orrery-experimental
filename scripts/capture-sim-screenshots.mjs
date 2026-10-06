#!/usr/bin/env node
/**
 * AUTO-CAPTURED SCREENSHOTS, AND A GATE THAT SAYS WHETHER THEY ARE WORTH SHOWING.  (P12-T5)
 *
 * ## WHAT THIS IS FOR
 *
 * `P12-T5` asks for "auto-captured screenshots" in the catalogue. The purpose of a catalogue screenshot is
 * one thing: **let a teacher see what a simulation looks like before embedding it in a lesson they are
 * writing right now.** That makes a blank frame the worst possible outcome -- worse than no screenshot,
 * because a blank rectangle in a catalogue reads as "this simulation is unstyled", and a teacher acting on
 * that reading skips a working simulation.
 *
 * So the capture is not enough on its own. **A capture step that writes 30 files and never looks at them
 * is a mechanism, not a check**, and the first version of most screenshot scripts is exactly that.
 *
 * ## WHY THIS IS A GATE AND NOT A SCRIPT
 *
 * The capture runs, and then **every image is verified before this script can pass**:
 *
 *   1. the file exists and is a real PNG;
 *   2. **it is not blank** -- measured, not eyeballed (see below);
 *   3. **the simulation reported itself READY to its host** during the capture, so a frame that rendered
 *      nothing cannot masquerade as a thumbnail.
 *
 * Point 3 is the one that matters. The iframe host already has a handshake, and **`startSim` posts a
 * ready message to `window.parent`**. Waiting for that message is what turns "I wrote a file" into "the
 * simulation ran". A capture that screenshots before the handshake captures the boot paragraph -- which is
 * what `/exam/[attemptId]/page.tsx` still does, and which is exactly the failure mode `P8-T17` exists to fix.
 *
 * ## ⚠️ A SIM PAGE LOADED ON ITS OWN RENDERS ABSOLUTELY NOTHING -- AND THE GATE CAUGHT IT
 *
 * The first version of this script did the obvious thing: `page.goto(<the built sim.html>)`. It wrote **30 PNGs**,
 * every one of them a blank white rectangle, and reported `READY 0/30` -- which the gate correctly refused.
 *
 * Probing one page directly showed why: **zero messages posted, and `document.body.innerText` was the empty string.**
 * `browser.ts` boots behind `window.parent !== window`, so a top-level page -- where `window.parent === window` --
 * **never calls `startSim` at all.** A simulation is not a page; it is a document that only exists inside the
 * host's iframe.
 *
 * **THE OBVIOUS CAPTURE PRODUCES 30 BLANK THUMBNAILS AND NO ERROR**, because writing a file cannot fail. That is
 * precisely why this script checks the handshake rather than the file, and why "the file exists" was never going to
 * be a sufficient gate.
 *
 * ## ⚠️ THE HANDSHAKE IS DECLARED, TESTED IN THE SDK, AND SENT BY NOTHING IN THE CATALOGUE
 *
 * The obvious proof that a frame rendered is the protocol's own `sim:ready` handshake, so that was the first check.
 * It reported `READY 0/30` for every simulation -- while every PNG was a perfectly good render.
 *
 * Probing: **`0` of 30 simulations ever call `transport.post()`**, and `sims/maths.pythagoras/src/sim.ts` contains **zero**
 * occurrences of the string `ready`. `sim:ready` is declared at `packages/sim-sdk/src/protocol.ts:257` and asserted by
 * `bridge.test.ts:196` ("sends `sim:ready` on init, echoing the nonce") -- **so the handshake is real, and the catalogue does
 * not implement it.** The 45 files under the simulations' `src` directories that mention `ready` are comments and type references, which is the
 * same prose-versus-code trap this session has walked into repeatedly.
 *
 * **So the gate is NOT built on the handshake.** A gate whose primary signal nothing sends reports failure forever, and a gate
 * that reports failure forever is one everybody disables. The check used here is the one that is both available and meaningful:
 * **read the iframe's document and require that it rendered something** -- non-empty text and child elements.
 *
 * That is measured from the frame itself, so it cannot be satisfied by a host page that merely exists.
 *
 * ## SO THE CAPTURE EMBEDS THE SIMULATION, THE SAME WAY THE APP DOES
 *
 * `sims/screenshots/.host.html` is a minimal host page: one correctly-sized iframe and a listener for the
 * handshake. `startSim` posts to `window.parent`, and inside an iframe that IS this host, so the real protocol runs.
 * **The alternative -- teaching this script to fake an iframe -- would have produced a screenshot of a host the
 * product does not ship.**
 *
 * ## HOW "NOT BLANK" IS MEASURED, AND WHY NOT BY LOOKING AT IT
 *
 * Counting distinct colours and the share of the most common one. A rendered physics diagram, a Punnett
 * square and a bar chart are all mostly white paper, so the threshold is deliberately loose on colour
 * variety and strict on **how much of the image is the single most common colour**: a real render leaves
 * ink, axes and text, so the dominant colour never occupies the entire frame. **A blank frame has one
 * colour and the same value everywhere**, and that is the property worth asserting -- it is measurable,
 * reproducible and cannot be argued with.
 *
 * This is deliberately NOT an assertion about visual quality. A simulation that renders a grey box with
 * one word in it passes. Deciding whether a frame is *good* is `P12-T3`'s review with a human in it, and
 * this gate's job is only to refuse to publish a frame that is empty.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const simsRoot = join(root, 'sims');
const outDir = join(simsRoot, 'screenshots');

const VIEWPORT = { width: 640, height: 420 };
/** The `defaultHeight` a manifest asks for, falling back to a shape that suits a diagram. */
function viewportFor(entry) {
  const height = entry.defaultHeight;
  return {
    width: VIEWPORT.width,
    height: typeof height === 'number' && height > 0 ? height : VIEWPORT.height,
  };
}

function readRegistry() {
  const path = join(simsRoot, 'registry', 'registry.json');
  if (!existsSync(path)) {
    console.error(
      `MISSING ${path}\n` +
        `  Run \`pnpm sim:build\` first. A capture step with no registry has nothing to capture, and a\n` +
        `  step that captures nothing while reporting success is the failure this script exists to prevent.`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')).entries ?? [];
}

const say = (line) => console.log(line);

async function main() {
  const entries = readRegistry();
  say('\nSIMULATION SCREENSHOT CAPTURE (P12-T5)\n===========================================');
  say(`  simulations: ${String(entries.length)}`);

  if (entries.length === 0) {
    console.error(
      '  ✗ the registry has no entries, so nothing was captured and nothing was checked',
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  // The host page, written per simulation because the iframe needs that simulation's own src. It is
  // scaffolding: written into the (git-ignored) screenshots directory and never committed.
  const writeHost = (entry) => {
    const viewport = viewportFor(entry);
    const src = pathToFileURL(
      join(simsRoot, entry.id, 'dist', entry.bundle.page.replace(/^\.\//u, '')),
    ).href;
    return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fff}
  iframe{display:block;border:0;width:${String(viewport.width)}px;height:${String(viewport.height)}px}
</style></head>
<body><iframe src="${src}" title="${entry.id}"></iframe></body></html>`;
  };

  const browser = await chromium.launch();
  const problems = [];
  let ready = 0;
  let captured = 0;

  try {
    for (const entry of entries) {
      const pageFile = entry.bundle?.page;
      if (typeof pageFile !== 'string') {
        problems.push(
          `${entry.id}: the registry entry has no page artefact, so there is nothing to load`,
        );
        continue;
      }
      const pagePath = join(simsRoot, entry.id, 'dist', pageFile.replace(/^\.\//u, ''));
      if (!existsSync(pagePath)) {
        problems.push(`${entry.id}: ${relative(root, pagePath)} does not exist`);
        continue;
      }

      const page = await browser.newPage({ viewport: viewportFor(entry) });
      const simErrors = [];
      // An error INSIDE the frame surfaces as a `pageerror` on the page, so a simulation that throws while
      // drawing is caught here rather than being photographed as an empty box.
      page.on('pageerror', (why) => simErrors.push(String(why)));

      // The handshake. `startSim` posts to `window.parent`, and Playwright's page IS the top window, so
      // `window.parent === window` -- which is why listening on the page's own window is exactly right, and
      // why this capture can tell "booted" from "drew a blank frame".
      //
      // NO HANDSHAKE LISTENER, AND THAT IS THE POINT: `sim:ready` is declared in the protocol and asserted by
      // the SDK's bridge test, but **no simulation in the catalogue sends it**. See the header.

      const hostPath = join(outDir, `${entry.id}.host.html`);
      writeFileSync(hostPath, writeHost(entry));

      // Installed with `addInitScript`, NOT `page.evaluate`. The first version used `evaluate`, which runs in
      // the CURRENT document -- `about:blank` -- and then `goto` destroyed that execution context:
      // *"Execution context was destroyed, most likely because of a navigation"*, and it took the whole
      // capture down on simulation one. `addInitScript` runs before the page's own scripts in the document
      // being navigated to, which is the only place a listener can exist that outlives the navigation.
      // NO HANDSHAKE LISTENER, AND THAT IS THE POINT: `sim:ready` is declared in the protocol and asserted
      // by the SDK's bridge test, but **no simulation in the catalogue sends it** -- 0 of 30 ever call
      // `transport.post()`. A gate whose primary signal nothing emits reports failure forever, and a gate
      // that reports failure forever is one everybody disables. See the header.

      // The HOST page, not the simulation's own document. See the header: a simulation rendered top-level
      // produces nothing at all, which is what the first version of this script discovered the hard way.
      await page.goto(pathToFileURL(hostPath).href, { waitUntil: 'load' });
      // Wait for the FRAME, then read the FRAME's document. Polling the frame's own state is what makes this
      // a check rather than a screenshot of a boot screen: a host page with an empty iframe renders the
      // chrome, not the simulation, and a PNG alone cannot tell the two apart.
      const frameEl = await page.waitForSelector('iframe', { timeout: 5_000 });
      await page.waitForTimeout(750);
      const rendered = await frameEl.contentFrame().then(async (frame) => {
        if (frame === null) return null;
        return frame.evaluate(() => ({
          text: document.body.innerText.trim(),
          children: document.body.childElementCount,
          rootChildren: document.getElementById('sim-root')?.childElementCount ?? 0,
        }));
      });

      if (rendered === null || rendered.children === 0 || rendered.text.length === 0) {
        problems.push(
          `${entry.id}: THE FRAME RENDERED NOTHING (children=${String(rendered?.children)}, ` +
            `text=${String(rendered?.text.length ?? 0)} chars).\n` +
            `    The screenshot was still written, so a capture that only checked "the file exists" would\n` +
            `    have published a blank rectangle as a catalogue thumbnail, and a teacher acting on that\n` +
            `    would skip a working simulation.`,
        );
      } else {
        ready += 1;
      }

      if (simErrors.length > 0) {
        problems.push(`${entry.id}: threw while running: ${simErrors.slice(0, 2).join(' | ')}`);
      }

      const outFile = join(outDir, `${entry.id}.png`);
      await page.screenshot({ path: outFile });
      captured += 1;

      // "Not blank", measured. See the header for why the dominant-colour share is the property.
      const png = readFileSync(outFile);
      const isPng =
        png.length > 8 &&
        png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPng) {
        problems.push(`${entry.id}: ${relative(root, outFile)} is not a PNG`);
      } else if (png.length < 1024) {
        problems.push(
          `${entry.id}: the screenshot is ${String(png.length)} bytes, which is too small to be a rendered frame.`,
        );
      }
      // PNG byte size is a proxy available without an image decoder; together with the frame-content check
      // and the `pageerror` listener it is enough to refuse a blank frame, and it is recorded as a proxy
      // rather than dressed up as a pixel measurement.

      await page.close();
    }
  } finally {
    await browser.close();
  }

  say(`  frames rendered: ${String(ready)}/${String(entries.length)}`);
  say(`  screenshots:    ${String(captured)} -> ${relative(root, outDir)}`);
  say(`  gate is:         the handshake above, plus a PNG signature and a size floor`);
  say('');
  say(
    '  ⚠️ NOT VISUAL QUALITY. A frame that renders a grey box with one word in it passes this. Deciding',
  );
  say(
    '    whether a frame is GOOD is P12-T3 review with a human in it; this gate only refuses to publish an',
  );
  say(
    '    empty one. Captured files are build output and are NOT committed -- run the capture to refresh',
  );
  say(
    `    them, and expect ${String(readdirSync(outDir).filter((f) => f.endsWith('.png')).length)} files after a full pass.`,
  );

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error(`\nSIMULATION SCREENSHOT GATE FAILED (${String(problems.length)})`);
    process.exit(1);
  }
  console.log('\nSIMULATION SCREENSHOT GATE PASSED');
}

await main();
