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
import { join } from 'node:path';
import process, { hrtime } from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildHarness } from './conformance/harness.mjs';
import { ROOT, startAppOrigin, startSimOrigin } from './conformance/origins.mjs';

/** The registry module, imported for its URL composition so there is one base, not three. */
const { simAssetUrl: assetUrl } = await import(
  new URL('../packages/sim-registry/dist/index.js', import.meta.url).href
);
const REGISTRY = join(ROOT, 'sims/registry/registry.json');
// Screenshots are evidence a human reads, so they are visible. The BUNDLE is generated output and
// belongs in a cache: under `.tmp` it was linted as source and contributed ~1900 errors to every
// `pnpm lint`, which is the cost of a build artefact living where a tool expects code.
const SHOTS = join(ROOT, '.tmp/conformance');

const c = {
  dim: (t) => `[2m${t}[0m`,
  red: (t) => `[31m${t}[0m`,
  green: (t) => `[32m${t}[0m`,
  bold: (t) => `[1m${t}[0m`,
};

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

/**
 * Ask the sim for a state, at the protocol level, and return what it said.
 *
 * Used by the grading cell, which needs a real state to grade. NOT used by the blur-capture cell, which
 * must go through the HOST: posting into the frame ourselves would prove the sim responds, not that the
 * host asks.
 */
const captureState = async (page) => {
  const nonce = await page.evaluate(
    () => globalThis.__conformance.log.inbound.find((f) => f.type === 'sim:ready')?.nonce ?? null,
  );
  if (nonce === null) return null;
  await page.evaluate((n) => {
    const frame = globalThis.document.querySelector('iframe');
    frame?.contentWindow?.postMessage({ type: 'sim:requestState', nonce: n, reason: 'save' }, '*');
  }, nonce);
  const expired = deadline(6000);
  for (;;) {
    const states = await page.evaluate(() => globalThis.__conformance.log.states);
    if (states.length > 0) return states[states.length - 1];
    if (expired()) return null;
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
    name: 'the HOST ACCEPTED frames, dropped none and saw no spoof',
    why: 'the first host rendered LOADING forever while a perfect handshake arrived beside it',
    run: async ({ page }) => {
      const counters = await page.evaluate(() => {
        const host = globalThis.document.querySelector('.sim-host');
        return {
          accepted: Number(host?.getAttribute('data-sim-frames') ?? '-1'),
          dropped: Number(host?.getAttribute('data-sim-dropped') ?? '-1'),
          spoofs: Number(host?.getAttribute('data-sim-spoofs') ?? '-1'),
        };
      });
      if (counters.accepted < 1) return `accepted ${String(counters.accepted)} frames`;
      // A spoof count above zero means something in the page is trying to forge a frame, which is a
      // page-level incident rather than a simulation bug.
      if (counters.spoofs > 0) return `${String(counters.spoofs)} spoof attempts`;
      return counters.dropped > 0 ? `dropped ${String(counters.dropped)} frames` : null;
    },
  },
  {
    name: 'sim:ready came back from the SIM, ECHOING THE NONCE',
    why: 'a handshake that succeeds without the sim answering proves nothing',
    run: async ({ page }) => {
      // Read from what the PAGE saw, recorded by a listener installed before React mounted. The first
      // version attached its listener afterwards and then waited two seconds for a frame that had
      // already arrived.
      const ready = await page.evaluate(
        () => globalThis.__conformance.log.inbound.find((f) => f.type === 'sim:ready') ?? null,
      );
      if (ready === null) return 'no sim:ready was ever received by the page';
      return ready.nonce === null || ready.nonce === '' ? 'sim:ready carried no nonce' : null;
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
      // From the sim's OWN dist, for the same reason the registry's paths are relative to it: reading
      // the grader out of the registry directory 404s every simulation with a "missing grader".
      const grader = join(
        ROOT,
        'sims',
        String(entry.id),
        'dist',
        String(entry.bundle.grader).replace(/^\.\//, ''),
      );
      if (!existsSync(grader)) return `grader bundle missing: ${String(entry.bundle.grader)}`;
      // Through the SDK's `gradeStoredState`, not by calling `grade` off the module: the entry point is
      // what the worker uses, so exercising it here means conformance grades the same way production
      // does. Calling `default.grader.grade` directly -- the first attempt -- tested a shape nothing
      // else in the repository calls.
      const [{ default: module_ }, { gradeStoredState }] = await Promise.all([
        import(pathToFileURL(grader).href),
        import(new URL('../packages/sim-sdk/dist/grader.js', import.meta.url).href),
      ]);
      // From the sim's OWN reported state, because the claim under test is "auto-graded from stored
      // state". Passing `state: null` and calling it a day tested the grader's error path.
      const captured = await captureState(page);
      if (captured === null) return 'the sim reported no state to grade from';
      const input = { state: captured.state, params: entry.parameters, answer };
      const first = await gradeStoredState(module_.grader, input);
      const second = await gradeStoredState(module_.grader, input);
      // Determinism in a browser is one claim; determinism in Node is the claim the grader rests on.
      if (JSON.stringify(first) !== JSON.stringify(second)) return 'two Node grades disagreed';
      if (first === undefined || first === null) return 'the grader returned nothing';
      // A grade with no earned/max pair is not a grade, and a grader that always returns zero would pass
      // this cell happily.
      const points =
        typeof first.points === 'number' ? first.points : (first.earned ?? first.score);
      const max = typeof first.maxPoints === 'number' ? first.maxPoints : (first.max ?? 100);
      // A score is reported, not returned as a failure. The first version returned `graded 4/4` and the
      // runner printed it under FAIL, which is the worst possible way to be wrong: the message reads as
      // a defect and the operator has to work out that it is not one.
      if (points === undefined) return 'the grade carried no score';
      process.stdout.write(
        `       ${c.dim(`graded ${String(points)}/${String(max)} in bare Node`)}\n`,
      );
      return null;
    },
  },
  {
    name: 'the STATE is CAPTURED on blur and carries a real checksum',
    why: "a ten-minute exploration reported nothing on unload, so the student's work was gone",
    run: async ({ page }) => {
      // The count BEFORE the dispatch, and the cell requires an INCREMENT. The grading cell runs first
      // and populates the same log, so a cell that only asked "is the log non-empty" passed on another
      // cell's evidence -- green for the wrong reason, which is the one kind of green worth refusing.
      const before = await page.evaluate(() => globalThis.__conformance.log.states.length);
      // Driven through the HOST, not by posting into the frame: a hand-built `sim:requestState` carries
      // the wrong nonce and is correctly dropped, which is the protocol working rather than failing.
      await page.evaluate(() => {
        Object.defineProperty(globalThis.document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        globalThis.document.dispatchEvent(new Event('visibilitychange'));
      });
      const expired = deadline(6000);
      for (;;) {
        const states = await page.evaluate(() => globalThis.__conformance.log.states);
        if (states.length > before) {
          const { checksum, state } = states[states.length - 1];
          if (checksum === null || checksum === '') return 'the state carried no checksum';
          // Re-derived in the PAGE from the state itself, so a fabricated checksum cannot pass.
          return checksum ===
            (await page.evaluate((value) => globalThis.__conformance.checksumOf(value), state))
            ? null
            : `the checksum does not match the state it describes (${String(checksum)})`;
        }
        if (expired()) return 'hiding the tab produced no NEW state';
        await page.waitForTimeout(100);
      }
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
