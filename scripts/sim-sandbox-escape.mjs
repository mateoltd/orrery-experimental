/**
 * The sandbox escape gate.  (P6-T13)
 *
 * ## WHY A GATE AND NOT A TEST
 *
 * `plans/10` §7 makes this a permanent CI gate, and that is the right shape. A unit test asserting
 * `sandbox === 'allow-scripts'` proves we WROTE an attribute; this proves a real browser ENFORCED it,
 * against a real second origin, by having a real third-party program try every escape we can think of and
 * failing the build if any of them works.
 *
 * The difference matters because every one of these escapes is invisible in a jsdom test — jsdom
 * implements no sandbox, no cross-origin isolation and no CSP, so an assertion there is an assertion
 * about a string.
 *
 * ## THE ESCAPES ARE ATTEMPTED FROM INSIDE THE FRAME, NOT INFERRED
 *
 * A hostile simulation does not read the sandbox attribute; it calls `parent.document` and sees what
 * happens. So every attempt below is executed by code in the frame and the RESULT is what the gate reads.
 * An attempt that throws, returns null, or is refused is a pass; an attempt that yields the host's DOM,
 * its cookie, its storage, a navigation, or a popup is a failure.
 *
 * ## A GATE THAT CANNOT FAIL IS NOT A GATE
 *
 * Two self-checks run first, and the gate refuses to report success without them:
 *  - the frame must be a DIFFERENT ORIGIN, or nothing below proves anything;
 *  - at least one attempt must be observed to be BLOCKED, which proves the attempts are really executing
 *    rather than silently short-circuiting on a typo in an expression.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { buildHarness } from './conformance/harness.mjs';
import { ROOT, startAppOrigin, startSimOrigin } from './conformance/origins.mjs';

const REGISTRY = join(ROOT, 'sims/registry/registry.json');
const c = {
  dim: (t) => `\u001b[2m${t}\u001b[0m`,
  red: (t) => `\u001b[31m${t}\u001b[0m`,
  green: (t) => `\u001b[32m${t}\u001b[0m`,
  bold: (t) => `\u001b[1m${t}\u001b[0m`,
};

/**
 * Each escape is a named expression evaluated inside the frame.
 *
 * `probe` runs in the sim's realm and returns a plain description of what happened. A probe that THROWS is
 * reported as `BLOCKED:<error name>`, which is a pass: the sandbox refusing an operation is the sandbox
 * working. Only a probe that returns actual host data fails the gate.
 */
const ESCAPES = [
  {
    name: 'read the host DOM through `parent.document`',
    why: 'a sim could rewrite the grade, read the lesson, or cover the page with its own UI',
    probe: `(() => { try { return parent.document.querySelector('#host-secret') === null ? 'BLOCKED' : 'REACHED-HOST-DOM'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'read the host cookie jar',
    why: 'the session cookie is the whole authentication boundary',
    probe: `(() => { try { return document.cookie === '' ? 'BLOCKED-EMPTY' : 'LEAKED:' + document.cookie; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'write to the host origin localStorage',
    why: 'a sim that can persist on the app origin can impersonate the student on the next load',
    probe: `(() => { try { localStorage.setItem('x', '1'); return localStorage.getItem('x') === '1' ? 'WROTE-STORAGE' : 'BLOCKED'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'navigate the top window',
    why: 'a sim that can redirect the tab can take a student to a page that looks like the school portal',
    probe: `(() => { try { top.location.href = 'about:blank'; return 'NAVIGATED'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'open a popup',
    why: 'a popup under the school origin is a convincing credential prompt',
    probe: `(() => { try { const w = window.open('about:blank'); return w === null ? 'BLOCKED-NULL' : 'OPENED-POPUP'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'submit a form to another origin',
    why: 'a form post carries the ambient credentials, and `submit()` throwing proves nothing',
    // `f.submit()` does NOT throw when the sandbox blocks it, so asking the frame whether it managed to
    // submit measures the wrong thing. What counts is whether a REQUEST left the browser -- observed at
    // the page, below, where a real navigation attempt is visible whatever the frame thinks.
    probe: `(() => { try { const f = document.createElement('form'); f.method = 'POST'; f.action = 'http://127.0.0.1:9/steal'; document.body.append(f); f.submit(); return 'ATTEMPTED'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
    observe: 'REQUEST-TO-127.0.0.1:9',
    expect: 'no request was attempted',
  },
  {
    name: 'trigger a download',
    why: 'the download shelf is a way off the page that no CSP directive governs',
    probe: `(() => { try { const a = document.createElement('a'); a.href = 'data:text/plain,stolen'; a.download = 'x.txt'; document.body.append(a); a.click(); return 'ATTEMPTED'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
    observe: 'DOWNLOAD',
    expect: 'no download began',
  },
  {
    name: 'open a modal dialog',
    why: 'a modal is unmissable and undismissable from the page behind it',
    // `typeof alert === 'function'` is true inside a sandboxed frame REGARDLESS: the API is present and
    // the CALL is suppressed. Measuring the API's existence reported an escape that does not exist.
    probe: `(() => { try { alert('escape'); return 'ATTEMPTED'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
    observe: 'DIALOG',
    expect: 'no dialog opened',
  },
  {
    name: 'read the clipboard',
    why: 'a sim that can read the clipboard gets whatever the student copied to paste a question',
    probe: `(async () => { try { await navigator.clipboard.readText(); return 'CLIPBOARD-READ'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'fetch the host origin and read the response',
    why: 'CORS is what stops a sim reading an authenticated endpoint as the student',
    probe: `(async () => { try { const r = await fetch(location.origin + '/host-secret.json'); const t = await r.text(); return t.includes('host-secret') ? 'READ-HOST-ENDPOINT' : 'BLOCKED-OPAQUE'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'reach the host through `window.top`',
    why: 'a different route to the same parent, and a classic bypass',
    probe: `(() => { try { return top.document === null ? 'BLOCKED-NULL' : 'REACHED-TOP-DOCUMENT'; } catch (e) { return 'BLOCKED:' + e.name; } })()`,
  },
  {
    name: 'read its own origin',
    why: 'an opaque origin is the sandbox doing its job; a real one means allow-same-origin leaked in',
    probe: `(() => { try { return String(globalThis.origin); } catch (e) { return 'BLOCKED:' + e.name; } })()`,
    /* Expected to RETURN 'null', not throw: an opaque origin is the sandbox working, and this is the
       cell that would catch `allow-same-origin` quietly reappearing in the sandbox attribute. */
  },
];

/**
 * Results that mean the sandbox REFUSED, and are therefore a pass.
 *
 * `null` is here on purpose and it is not an escape: an OPAQUE origin is the sandbox working, and it is
 * the outcome `allow-same-origin` being withheld produces. The first version omitted it, so the gate
 * reported the sandbox's single most important success as a breach.
 */
const blocked = (outcome) =>
  outcome.startsWith('BLOCKED') ||
  outcome === 'BLOCKED-EMPTY' ||
  outcome === 'BLOCKED-OPAQUE' ||
  outcome === 'null';

const run = async () => {
  if (!existsSync(REGISTRY)) {
    process.stderr.write(`${c.red('no registry')} — run \`pnpm sim:build\` first\n`);
    process.exit(1);
  }
  // Built HERE, every run. Serving whatever `sim:conformance` last left in the cache is how this gate
  // came to report "12/12 escapes blocked" against a deliberately weakened sandbox: it was testing the
  // previous build. A gate that silently tests a stale artefact is worse than no gate, because it is
  // believed.
  await buildHarness();
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const entry = registry.entries[0];
  if (entry === undefined) {
    process.stderr.write(`${c.red('no simulations in the registry')}\n`);
    process.exit(1);
  }

  const sim = await startSimOrigin();
  const app = await startAppOrigin();

  // A MISSING BROWSER IS A FAILURE, NOT A SKIP.
  //
  // This gate is deliberately NOT in `pnpm gates`: the Docker image build runs `gates`, the image has no
  // Chromium, and adding the browser to the image would cost ~150 MB and a network fetch at build time.
  // The tempting alternative — exiting 0 when the binary is absent — would have been a gate that passes
  // by not running, which is the exact failure mode this file exists to prevent.
  //
  // So it exits 1 with the command to run, and `gate:browser` groups it with the conformance matrix as the
  // browser-requiring half of the checks.
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    process.stderr.write(
      `${c.red('no Chromium available')}\n` +
        `  The sandbox escape gate needs a real browser: it proves a browser ENFORCED the sandbox, which\n` +
        `  no other check in this repository can do.\n` +
        `  ${c.dim('run `pnpm exec playwright install chromium`, then `pnpm run gate:browser`')}\n` +
        `  ${c.dim(String(error instanceof Error ? error.message.split('\n')[0] : error))}\n`,
    );
    sim.close();
    app.close();
    process.exit(1);
  }
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();

  // A SECRET ON THE HOST SIDE, so a successful escape is visible rather than theoretical: the cookie
  // probe can then print the value it stole. Set through the context, because `document.cookie` in
  // `addInitScript` runs before any document exists.
  await browserContext.addCookies([
    { name: 'session', value: 'host-secret-value', domain: '127.0.0.1', path: '/' },
  ]);

  const config = Buffer.from(
    JSON.stringify({
      bundleUrl: `${sim.origin}/${entry.id}/${entry.version}/${String(entry.bundle.page).replace(/^\.\//, '')}`,
      simOrigin: sim.origin,
      simId: entry.id,
      simVersion: entry.version,
      defaultHeight: entry.defaultHeight,
      minHeight: entry.minHeight,
      textAlternative: `${String(entry.title)}: sandbox escape gate.`,
      title: String(entry.title),
      params: {},
      mode: 'lesson',
    }),
  ).toString('base64url');

  await page.goto(`${app.origin}/?cfg=${config}`, { waitUntil: 'load' });
  await page.evaluate(() => {
    const secret = globalThis.document.createElement('div');
    secret.id = 'host-secret';
    secret.textContent = 'host-secret-value';
    globalThis.document.body.append(secret);
  });
  await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
    timeout: 20_000,
  });

  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (frame === undefined) {
    process.stderr.write(`${c.red('no simulation frame')} — the gate cannot prove anything\n`);
    process.exit(1);
  }

  // Self-check 1: the frame must be genuinely cross-origin, or every attempt below is theatre.
  let origin = 'UNKNOWN';
  try {
    origin = await frame.evaluate(() => String(globalThis.origin));
  } catch {
    origin = 'BLOCKED';
  }
  const crossOrigin = origin !== String(app.origin).replace(/\/$/u, '');

  process.stdout.write(
    `${c.bold(`sandbox escape gate`)} ${c.dim(`${entry.id}@${entry.version}`)}\n`,
  );
  process.stdout.write(
    `  frame origin: ${origin}${crossOrigin ? c.dim('  (distinct from the app)') : c.red('  SAME ORIGIN — the gate is theatre')}\n`,
  );

  // Page-level observation. An escape that the frame cannot see -- a request that left, a download that
  // began, a dialog that opened -- is only visible from here, which is the whole reason this is a gate
  // and not a unit test.
  const observed = { requests: [], downloads: 0, dialogs: 0 };
  page.on('request', (request) => observed.requests.push(request.url()));
  page.on('download', () => {
    observed.downloads += 1;
  });
  page.on('dialog', (dialog) => {
    observed.dialogs += 1;
    // Dismissed so one blocked-looking dialog cannot wedge the run.
    void dialog.dismiss();
  });

  const results = [];
  for (const attempt of ESCAPES) {
    const baseline = {
      requests: observed.requests.length,
      downloads: observed.downloads,
      dialogs: observed.dialogs,
    };
    let outcome;
    try {
      // The probe string already INVOKES itself. The first version wrapped it again --
      // `((...)())()` -- which called the result of the call, threw a TypeError on every probe, and
      // reported twelve confident `BLOCKED` results for twelve expressions that never ran. A gate that
      // cannot fail is not a gate, which is why the self-checks below exist.
      //
      // `evaluate` awaits a promise, so the async probes (clipboard, fetch) work unchanged.
      outcome = String(await frame.evaluate(attempt.probe));
    } catch (error) {
      outcome = `BLOCKED:${error instanceof Error ? error.name : 'threw'}`;
    }

    // The observed EFFECT overrides what the frame claims about itself.
    if (attempt.observe !== undefined) {
      await page.waitForTimeout(400);
      const fired =
        attempt.observe === 'DOWNLOAD'
          ? observed.downloads > baseline.downloads
          : attempt.observe === 'DIALOG'
            ? observed.dialogs > baseline.dialogs
            : observed.requests.slice(baseline.requests).some((url) => url.includes('127.0.0.1:9'));
      // The observation is AUTHORITATIVE for these probes, in both directions. If nothing left the
      // browser, the sandbox stopped it, whatever the frame reported about its own attempt -- so the
      // frame's `ATTEMPTED` is discarded rather than counted as a breach. Reading it the other way round
      // reported three escapes where the sandbox was working perfectly.
      outcome = fired ? `ESCAPED:${attempt.observe}` : `BLOCKED:${attempt.observe.toLowerCase()}`;
    }

    const ok = blocked(outcome);
    results.push({ attempt, outcome, ok });
    process.stdout.write(
      `  ${ok ? c.green('BLOCKED') : c.red('ESCAPED ')} ${attempt.name}\n         ${c.dim(`${attempt.why} — ${outcome}`)}\n`,
    );
  }

  await page.evaluate(() => globalThis.close());
  await browser.close();
  sim.close();
  app.close();

  // Self-check 2: if nothing was refused, the attempts are not running and a green gate means nothing.
  const anyBlocked = results.some((r) => r.ok);
  const breaches = results.filter((r) => !r.ok);
  process.stdout.write('\n');
  if (!crossOrigin || !anyBlocked) {
    process.stderr.write(
      `${c.red('sandbox escape gate INVALID')} — the gate cannot report a pass:\n` +
        `  cross-origin frame: ${String(crossOrigin)}\n` +
        `  at least one attempt observed BLOCKED: ${String(anyBlocked)}\n`,
    );
    process.exit(1);
  }
  if (breaches.length > 0) {
    process.stderr.write(
      `${c.red(`sandbox escape gate FAILED — ${String(breaches.length)} escape(s)`)}\n`,
    );
    for (const breach of breaches) {
      process.stderr.write(
        `  ${breach.attempt.name}\n    ${breach.attempt.why}\n    got: ${breach.outcome}\n`,
      );
    }
    process.exit(1);
  }
  process.stdout.write(
    `${c.green(`sandbox escape gate passed — ${String(results.length)}/${String(results.length)} escapes blocked`)}\n`,
  );
};

await run();
