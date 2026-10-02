/**
 * The conformance matrix.  (P6-T9)
 *
 * ## WHAT A UNIT SUITE CANNOT PROVE ABOUT A SANDBOX
 *
 * jsdom implements no iframes, no cross-origin isolation and no CSP. So every assertion in
 * `SimulationFrame.test.tsx` is a property of our OUTPUT — an attribute, a fallback, a status — and the
 * single most important property, that a real simulation can actually mount, handshake and be graded
 * from, was unproven. That is what this suite is for.
 *
 * ## TWO ORIGINS, BECAUSE ONE ORIGIN PROVES NOTHING
 *
 * `crossOriginIsolated`, CORP, `sandbox` and the nonce check are all *cross-origin* mechanisms. Served
 * from one origin they have nothing to enforce, and a suite that passes against one origin will happily
 * pass against a deployment where the sim is same-origin with the host and can read the session cookie.
 * So the page is served from one port and every simulation bundle from another.
 *
 * ## THE MATRIX IS PER SIM AND EVERY CELL IS RECORDED
 *
 * A green suite that reports nothing cannot be used to decide which sim to fix next. Failures print the
 * cell name, the observed value and the expected one, and a screenshot is written for each sim whether
 * it passed or failed — a screenshot of a broken frame is more use to a simulation author than a status
 * code is.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import process, { hrtime } from 'node:process';
import { build as esbuild } from 'esbuild';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
/** The registry module, imported for its URL composition so there is one base, not three. */
const { simAssetUrl: assetUrl } = await import(
  new URL('../packages/sim-registry/dist/index.js', import.meta.url).href
);
const REGISTRY = join(ROOT, 'sims/registry/registry.json');
// Screenshots are evidence a human reads, so they are visible. The BUNDLE is generated output and
// belongs in a cache: under `.tmp` it was linted as source and contributed ~1900 errors to every
// `pnpm lint`, which is the cost of a build artefact living where a tool expects code.
const SHOTS = join(ROOT, '.tmp/conformance');
const CACHE = join(ROOT, 'node_modules/.cache/orrery-conformance');
const HARNESS_BUNDLE = join(CACHE, 'harness.js');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // `text/html` matters: without it the browser DOWNLOADS the page instead of rendering it, which is
  // the same class of mistake as pointing a frame at a script.
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const c = {
  dim: (t) => `[2m${t}[0m`,
  red: (t) => `[31m${t}[0m`,
  green: (t) => `[32m${t}[0m`,
  bold: (t) => `[1m${t}[0m`,
};

/**
 * The sim origin.
 *
 * CORP `cross-origin` and a permissive CORS header are not politeness — a browser will refuse the
 * bundle outright without CORP, so an origin that omits it fails every simulation at once with an
 * error that looks like a broken bundle rather than a missing header.
 */
const startSimOrigin = async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim.local');
    if (url.pathname === '/__sim_origin_probe') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end('ok');
      return;
    }
    // Served out of each sim's own `dist`, because the registry's bundle paths are relative to THAT
    // directory and not to the registry. Serving them out of the registry 404s every simulation with
    // an error that looks like a broken bundle.
    const [, simId, version, file] = url.pathname.split('/');
    const path =
      simId === undefined || version === undefined || file === undefined
        ? null
        : join(ROOT, 'sims', simId, 'dist', file);
    const distRoot = join(ROOT, 'sims');
    if (path === null || !path.startsWith(distRoot) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    void readFile(path).then((body) => {
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'cross-origin-resource-policy': 'cross-origin',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(body);
    });
  });
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
};

/** The app origin. Serves the harness page and its bundle. */
const startAppOrigin = async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://app.local');
    if (url.pathname === '/' || url.pathname === '/harness.js') {
      // Read per request rather than once at startup, so a rebuilt harness needs no restart -- and so a
      // missing bundle answers 500 with a sentence instead of throwing inside the handler, which Node
      // answers by dropping the connection and the test by timing out for no stated reason.
      const send = (body, type) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      if (url.pathname === '/') {
        send(harnessPage(), MIME['.html']);
        return;
      }
      void readFile(HARNESS_BUNDLE)
        .then((body) => send(body, MIME['.js']))
        .catch(() => {
          res.writeHead(500, { 'content-type': 'text/plain' }).end('harness bundle missing');
        });
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() };
};

const harnessPage = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Simulation conformance harness</title>
  </head>
  <body>
    <script src="/harness.js"></script>
  </body>
</html>`;

/**
 * One cell of the matrix.
 *
 * @typedef {{ name: string, why: string, run: (ctx: any) => Promise<string|null> }} Cell
 */

/**
 * A deadline, in milliseconds.
 *
 * `Date.now()` is banned outside `@orrery/clock` (`INV-TIME-1`), and wall-clock time is the wrong tool
 * anyway: this measures a DURATION, so a clock adjustment mid-wait should not extend or collapse it.
 * `hrtime.bigint()` is monotonic and is already the repo's answer for durations.
 */
const deadline = (ms) => {
  const at = hrtime.bigint();
  return () => Number(hrtime.bigint() - at) / 1e6 > ms;
};

const waitForStatus = async (page, wanted, timeout = 15_000) => {
  const expired = deadline(timeout);
  for (;;) {
    const status = await page.evaluate(() => globalThis.__conformance?.status() ?? 'ABSENT');
    if (wanted.includes(status) || expired()) return status;
    await page.waitForTimeout(100);
  }
};

const CELLS = [
  {
    name: 'the sandbox attribute carries exactly one token',
    why: 'allow-same-origin would hand the sim our DOM and the session cookie',
    run: async ({ page }) => {
      const value = await page.getAttribute('iframe', 'sandbox');
      return value === 'allow-scripts' ? null : `sandbox="${String(value)}"`;
    },
  },
  {
    name: 'the frame is CROSS-ORIGIN and isolated',
    why: 'a same-origin sim is not sandboxed in any meaningful sense',
    run: async ({ page, simOrigin }) => {
      const src = await page.getAttribute('iframe', 'src');
      if (src === null || !src.startsWith(simOrigin)) return `src="${String(src)}"`;
      // The proof that matters is a THROWN SecurityError, not a value. Reading the frame's own origin
      // is the act a same-origin sim could do; the first version let that call throw out of the cell,
      // which reported the sandbox working as a failure.
      const probe = await page.evaluate(() => {
        try {
          const frame = globalThis.document.querySelector('iframe');
          const origin = frame?.contentWindow?.location?.origin;
          return origin === undefined ? 'NO-FRAME' : `REACHED:${origin}`;
        } catch (error) {
          return `BLOCKED:${error instanceof Error ? error.name : 'unknown'}`;
        }
      });
      if (probe.startsWith('BLOCKED')) return null;
      if (probe === 'NO-FRAME') return 'there is no frame';
      // `crossOriginIsolated` must be FALSE: nothing here sets COOP/COEP, and a harness that reported
      // true would be describing an isolation the deployment does not have.
      const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
      if (isolated === true) return 'crossOriginIsolated is true, so nothing is isolating anything';
      return probe;
    },
  },
  {
    name: 'the handshake COMPLETES',
    why: 'a sim that never reaches READY cannot be graded and is a picture of a simulation',
    run: async ({ page }) => {
      const status = await waitForStatus(page, ['READY', 'DEGRADED']);
      return status === 'READY' ? null : `status stayed at ${status}`;
    },
  },
  {
    name: 'sim:init was actually POSTED, with an explicit target origin',
    why: 'the first host build sent six frames and delivered none of them',
    run: async ({ page }) => {
      const outbounds = await page.evaluate(() => globalThis.__conformance.log.outbound);
      const init = outbounds.find((f) => f?.type === 'sim:init');
      if (init === undefined) return 'no sim:init was posted';
      return init.nonce === undefined || init.nonce === '' ? 'sim:init carried no nonce' : null;
    },
  },
  {
    name: 'sim:ready came back from the SIM, echoing the nonce',
    why: 'a handshake that succeeds without the sim answering proves nothing',
    run: async ({ page }) => {
      const ready = await page.evaluate(async () => {
        return new Promise((resolve) => {
          const listener = (event) => {
            if (event.data?.type === 'sim:ready') {
              globalThis.removeEventListener('message', listener);
              resolve(event.data);
            }
          };
          globalThis.addEventListener('message', listener);
          setTimeout(() => resolve(null), 2000);
        });
      });
      return ready === null ? 'no sim:ready arrived' : null;
    },
  },
  {
    name: 'the frame is keyboard REACHABLE and the controls are focusable',
    why: 'a control that only answers a mouse is not a control',
    run: async ({ page }) => {
      await page.focus('body');
      const reached = [];
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        const active = await page.evaluate(() => {
          const el = globalThis.document.activeElement;
          if (el === null) return null;
          const frame = globalThis.document.querySelector('iframe');
          return {
            tag: el.tagName,
            id: el.id,
            inFrame: frame?.contentDocument?.contains(el) ?? false,
          };
        });
        if (active !== null) reached.push(active.id || active.tag);
      }
      const hitFrame = reached.some((id) => id === 'IFRAME');
      return hitFrame ? null : `tabbing never reached the frame: ${reached.join(',')}`;
    },
  },
  {
    name: 'the TEXT ALTERNATIVE is in the DOM before and after mounting',
    why: 'a canvas with no text is invisible to a screen reader and to a printed worksheet',
    run: async ({ page }) => {
      const text = await page.textContent('[data-testid="sim-alternative"]');
      if (text === null || text.trim().length < 20) return `alternative was ${String(text)}`;
      return null;
    },
  },
  {
    name: 'a SCRIPTED INTERACTION produces an answer',
    why: 'the whole point: a student acts, the sim answers, the host receives',
    run: async ({ page }) => {
      await page.frameLocator('iframe').locator('#sim-submit').click();
      const expired = deadline(8000);
      for (;;) {
        const answers = await page.evaluate(() => globalThis.__conformance.log.answers);
        if (answers.length > 0) return null;
        if (expired()) return 'the sim submitted but the host received no answer';
        await page.waitForTimeout(100);
      }
    },
  },
  {
    name: 'the answer is GRADEABLE server-side, with no browser',
    why: 'plans/10 exit: "a sim question is auto-graded server-side from stored state with no browser"',
    run: async ({ page, entry }) => {
      const answers = await page.evaluate(() => globalThis.__conformance.log.answers);
      const answer = answers[0];
      if (answer === undefined) return 'no answer to grade';
      const grader = join(ROOT, 'sims/registry', String(entry.bundle.grader));
      if (!existsSync(grader)) return `grader bundle missing: ${String(entry.bundle.grader)}`;
      const { default: grade } = await import(`file://${grader}`);
      const first = await grade(answer, { seed: 'conformance-seed', params: entry.parameters });
      const second = await grade(answer, { seed: 'conformance-seed', params: entry.parameters });
      // Determinism in a browser is one claim; determinism in Node is the claim the grader rests on.
      if (JSON.stringify(first) !== JSON.stringify(second)) return 'two Node grades disagreed';
      return first === undefined || first === null ? 'the grader returned nothing' : null;
    },
  },
  {
    name: 'the STATE round-trips with a matching checksum',
    why: 'a checksum of "" validates every state, including a corrupted one',
    run: async ({ page }) => {
      const states = await page.evaluate(async () => {
        const frame = globalThis.document.querySelector('iframe');
        if (frame?.contentWindow === null || frame === null) return [];
        frame.contentWindow.postMessage(
          { type: 'sim:requestState', nonce: 'conformance', reason: 'save' },
          '*',
        );
        await new Promise((done) => setTimeout(done, 800));
        return globalThis.__conformance.log.states;
      });
      if (states.length === 0) return 'the sim answered no state request';
      const { checksum } = states[states.length - 1];
      return checksum === null || checksum === '' ? 'the state carried no checksum' : null;
    },
  },
  {
    name: 'the sim CANNOT read the host DOM, cookies or storage',
    why: 'the whole sandbox, asserted from the inside rather than from the attribute',
    run: async ({ page }) => {
      const escaped = await page
        .frameLocator('iframe')
        .locator('body')
        .evaluate(() => {
          try {
            return globalThis.parent.document.querySelector('#root') === null
              ? 'BLOCKED'
              : 'REACHED-HOST-DOM';
          } catch {
            // A SecurityError is the sandbox working.
            return 'BLOCKED';
          }
        });
      return escaped === 'BLOCKED' ? null : escaped;
    },
  },
  {
    name: 'a CROSS-ORIGIN PROBE tells a blocked network from a missing one',
    why: 'a no-cors fetch cannot distinguish them, and a student is told to check their firewall',
    run: async ({ page, simOrigin }) => {
      const outcome = await page.evaluate(async (origin) => {
        try {
          const response = await fetch(`${origin}/__sim_origin_probe`, {
            mode: 'cors',
            cache: 'no-store',
          });
          return response.ok ? 'OK' : `STATUS-${String(response.status)}`;
        } catch {
          return 'THREW';
        }
      }, simOrigin);
      return outcome === 'OK' ? null : `the probe said ${outcome}`;
    },
  },
  {
    name: 'a SCREENSHOT is captured',
    why: 'a screenshot of a broken frame beats a status code for the person who has to fix it',
    run: async ({ page, entry }) => {
      await mkdir(SHOTS, { recursive: true });
      const name = `${String(entry.id)}-${String(entry.version)}.png`;
      await page.screenshot({ path: join(SHOTS, name), fullPage: true });
      return existsSync(join(SHOTS, name)) ? null : 'the screenshot was not written';
    },
  },
];

/**
 * Bundle the harness.
 *
 * Built HERE rather than by a sibling npm script, because `sim:new` tells an author to run
 * `pnpm sim:conformance` and a command that fails with "first run the other command" is a command
 * nobody runs.
 */
const buildHarness = async () => {
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

const run = async () => {
  if (!existsSync(REGISTRY)) {
    process.stderr.write(`${c.red('no registry')} — run \`pnpm sim:build\` first\n`);
    process.exit(1);
  }
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const entries = registry.entries;
  process.stdout.write(`${c.dim('bundling the conformance harness…\n')}`);
  await buildHarness();

  const sim = await startSimOrigin();
  const app = await startAppOrigin();
  const browser = await chromium.launch();
  const failures = [];

  process.stdout.write(`${c.dim(`app ${app.origin} · sim ${sim.origin}\n`)}`);

  for (const entry of entries) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    // The config rides in the URL rather than in an init script: an init script that writes the config
    // on `DOMContentLoaded` races the harness bundle, which reads it at module scope. One source, read
    // once, at a known time.
    const config = Buffer.from(JSON.stringify(harnessConfig(entry, sim.origin))).toString(
      'base64url',
    );
    await page.goto(`${app.origin}/?cfg=${config}`, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
        timeout: 15_000,
      });
    } catch (error) {
      // A harness that never boots produces "timeout" for every cell and explains nothing. The console
      // already holds the reason, and the first error is almost always the real one.
      process.stderr.write(`${c.red('the harness did not boot')}\n`);
      for (const line of consoleErrors) process.stderr.write(`  ${line}\n`);
      throw error;
    }

    process.stdout.write(`\n${c.bold(String(entry.id))} ${c.dim(String(entry.version))}\n`);
    for (const cell of CELLS) {
      let failure = null;
      try {
        failure = await cell.run({ page, simOrigin: sim.origin, entry });
      } catch (error) {
        failure = `threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (failure === null) {
        process.stdout.write(`  ${c.green('PASS')} ${cell.name}\n`);
      } else {
        failures.push({ sim: String(entry.id), cell: cell.name, why: cell.why, failure });
        process.stdout.write(`  ${c.red('FAIL')} ${cell.name}\n`);
        process.stdout.write(`       ${c.dim(`${cell.why} — ${failure}`)}\n`);
      }
    }
    if (consoleErrors.length > 0) {
      failures.push({
        sim: String(entry.id),
        cell: 'the page raised no uncaught errors',
        why: 'an uncaught error in a frame is invisible to every other assertion',
        failure: consoleErrors.join(' | '),
      });
      process.stdout.write(`  ${c.red('FAIL')} the page raised no uncaught errors\n`);
    } else {
      process.stdout.write(`  ${c.green('PASS')} the page raised no uncaught errors\n`);
    }
    await page.close();
  }

  await browser.close();
  sim.close();
  app.close();

  const total = entries.length * (CELLS.length + 1);
  process.stdout.write('\n');
  if (failures.length === 0) {
    process.stdout.write(
      `${c.green(`sim:conformance passed — ${String(total)}/${String(total)} cells`)}\n`,
    );
    return;
  }
  process.stdout.write(
    `${c.red(`sim:conformance failed — ${String(failures.length)} of ${String(total)} cells`)}\n`,
  );
  for (const failure of failures) {
    process.stdout.write(
      `  ${failure.sim} · ${failure.cell}\n    ${failure.why}\n    ${failure.failure}\n`,
    );
  }
  process.exitCode = 1;
};

const harnessConfig = (entry, simOrigin) => ({
  // Composed by the registry's own helper, because the base is a deployment fact rather than a
  // detail each caller should rediscover.
  bundleUrl: assetUrl(simOrigin, entry, 'page'),
  simOrigin,
  simId: String(entry.id),
  simVersion: String(entry.version),
  defaultHeight: Number(entry.defaultHeight ?? 400),
  minHeight: Number(entry.minHeight ?? 200),
  textAlternative: `${String(entry.title)}: ${String(entry.screenReaderSummary ?? entry.title)}`,
  title: String(entry.title),
  params: Object.fromEntries(
    (entry.parameters ?? []).map((parameter) => [parameter.name, parameter.default]),
  ),
  mode: 'lesson',
});

await run();
