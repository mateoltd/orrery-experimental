/**
 * `pnpm sim:playground` — a host you can watch, on a real second origin.  (P6-T10)
 *
 * ## WHY A SERVER RATHER THAN A FILE
 *
 * The playground exists to show a simulation talking to a host, and a `file://` page cannot do that: the
 * frame would be same-origin with the page, so `sandbox`, CORP and the opaque origin would all have
 * nothing to enforce, and the playground would report success for arrangements that fail in production.
 * Two real origins, one real sandbox.
 *
 * ## `--once` IS A SMOKE TEST, NOT A DEMO
 *
 * Without it the command starts a server and blocks, which is right for a human and useless in CI. With
 * it, the playground is asserted: the page boots, a real bundle mounts, the handshake completes, and the
 * inspector has recorded frames in BOTH directions. A dev tool that no test exercises is a dev tool that
 * quietly stops working.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { ROOT, startSimOrigin } from './conformance/origins.mjs';
import { buildPlayground } from './conformance/playground-build.mjs';

const REGISTRY = join(ROOT, 'sims/registry/registry.json');
const c = {
  dim: (t) => `\u001b[2m${t}\u001b[0m`,
  red: (t) => `\u001b[31m${t}\u001b[0m`,
  green: (t) => `\u001b[32m${t}\u001b[0m`,
  bold: (t) => `\u001b[1m${t}\u001b[0m`,
};

/**
 * The playground page.
 *
 * Deliberately plain: a developer tool that renders through the app's design system is a developer tool
 * that has to keep up with the design system.
 */
const playgroundPage = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Simulation playground</title>
    <style>
      body { font: 13px/1.45 ui-monospace, monospace; margin: 0; padding: 16px; color: #1f2933; }
      h1 { font-size: 15px; margin: 0 0 4px; }
      #bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
      button { font: inherit; padding: 4px 9px; cursor: pointer; }
      #verdict { padding: 6px 8px; border: 1px solid #cbd2d9; }
      #verdict.ok { background: #e3f9e5; border-color: #3f8f4a; }
      #verdict.bad { background: #ffe3e3; border-color: #a12b2b; }
      #log { white-space: pre; overflow: auto; height: 46vh; border: 1px solid #cbd2d9; padding: 8px; }
      #sim { width: 100%; height: 240px; border: 1px solid #cbd2d9; }
      textarea { width: 100%; height: 70px; font: inherit; }
    </style>
  </head>
  <body>
    <h1>simulation playground</h1>
    <div id="verdict">booting…</div>
    <div id="bar"></div>
    <textarea id="params" spellcheck="false"></textarea>
    <div id="root">
      <iframe id="sim" title="simulation" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    </div>
    <pre id="log"></pre>
    <script src="/playground.js"></script>
  </body>
</html>`;

const main = async () => {
  const once = process.argv.includes('--once');
  const simId = (() => {
    const at = process.argv.indexOf('--sim');
    return at >= 0 ? process.argv[at + 1] : undefined;
  })();

  if (!existsSync(REGISTRY)) {
    process.stderr.write(`${c.red('no registry')} — run \`pnpm sim:build\` first\n`);
    process.exit(1);
  }
  await buildPlayground();
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const entry = registry.entries.find((candidate) => candidate.id === simId) ?? registry.entries[0];
  if (entry === undefined) {
    process.stderr.write(`${c.red('no simulations in the registry')}\n`);
    process.exit(1);
  }

  const sim = await startSimOrigin();
  const bundle = `${sim.origin}/${entry.id}/${entry.version}/${String(entry.bundle.page).replace(/^\.\//, '')}`;
  const script = await readFile(
    join(ROOT, 'node_modules/.cache/orrery-conformance/playground.js'),
    'utf8',
  );

  const { createServer } = await import('node:http');
  const app = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://app.local').pathname;
    if (path === '/playground.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(playgroundPage());
  });
  await new Promise((done) => {
    app.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = app.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const config = Buffer.from(
    JSON.stringify({
      bundleUrl: bundle,
      simId: entry.id,
      simVersion: entry.version,
      simOrigin: sim.origin,
      params: Object.fromEntries(
        (entry.parameters ?? []).map((parameter) => [parameter.name, parameter.default]),
      ),
      mode: 'lesson',
    }),
  ).toString('base64url');
  const url = `http://127.0.0.1:${String(port)}/?cfg=${config}`;

  if (!once) {
    process.stdout.write(
      `${c.bold('simulation playground')}\n` +
        `  ${c.green(url)}\n` +
        `  ${c.dim(`sim ${entry.id}@${entry.version} · ${entry.bundle.page} · app ${url.split('/?')[0]}`)}\n` +
        `${c.dim('  every frame both ways, with the verdict on each. Ctrl-C to stop.')}\n`,
    );
    await new Promise(() => {});
    return;
  }

  // `--once`: assert the playground actually works, rather than merely rendering.
  const browser = await chromium.launch();
  const browserPage = await browser.newPage();
  const pageErrors = [];
  browserPage.on('pageerror', (error) => pageErrors.push(String(error)));
  await browserPage.goto(url, { waitUntil: 'load' });
  await browserPage.waitForFunction(() => globalThis.__playground !== undefined, undefined, {
    timeout: 20_000,
  });

  const verdict = String(await browserPage.evaluate(() => globalThis.__playground.verdict()));
  // Send one host frame deliberately, so the inspector is exercised in BOTH directions.
  // Button 4 is `request state`: sent deliberately so the inspector is exercised in BOTH directions,
  // which is the thing `--once` is really checking.
  await browserPage.evaluate(() => {
    globalThis.document
      .querySelectorAll('#bar button')[4]
      ?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  });
  await browserPage.waitForTimeout(800);

  const directions = await browserPage.evaluate(() => {
    const entries = globalThis.__playground.log;
    return [...new Set(entries.map((entry) => entry.direction))];
  });

  await browser.close();
  app.close();
  sim.close();

  const failures = [];
  if (!verdict.startsWith('handshake OK')) failures.push(`handshake: ${verdict}`);
  if (!directions.includes('host -> sim')) failures.push('no host -> sim frames recorded');
  if (!directions.includes('sim -> host')) failures.push('no sim -> host frames recorded');
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join(' | ')}`);

  if (failures.length > 0) {
    process.stderr.write(`${c.red('playground smoke test FAILED')}\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${c.green(`playground smoke test passed — ${verdict}, frames recorded both ways`)}\n`,
  );
};

await main();
