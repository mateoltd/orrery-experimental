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

/**
 * Grade an answer in bare Node, through the SDK entry point the worker uses.
 *
 * Shared by the matrix cell and the manifest's `expect.grade`, so the declared grade and the graded grade
 * come from the same call rather than from two implementations that can drift.
 */
const gradeInNode = async (entry, answer, state = null, params = null) => {
  // From the sim's OWN dist, because the registry's bundle paths are relative to that directory.
  const grader = join(
    ROOT,
    'sims',
    String(entry.id),
    'dist',
    String(entry.bundle.grader).replace(/^\.\//, ''),
  );
  if (!existsSync(grader)) return null;
  const [{ default: half }, { gradeStoredState }] = await Promise.all([
    import(pathToFileURL(grader).href),
    import(new URL('../packages/sim-sdk/dist/grader.js', import.meta.url).href),
  ]);
  try {
    return await gradeStoredState(half.grader, {
      state,
      // The parameters the SIM WAS RUN WITH, not the registry's defaults. Those differ as soon as a
      // declared `setParams` step changes anything — and the first Newton manifest hit it: `expect.grade`
      // was 4 and the grader awarded 0, because the grader was asked about force 12 N on 3 kg while the
      // script had set 24 N on 4 kg. A wrong answer for the right reason, which is the hardest kind to
      // see.
      params: params ?? defaultParams(entry),
      answer,
    });
  } catch {
    // A state the grader refuses is a legitimate outcome, not a crash: the cell that cares about
    // grading from stored state passes its own.
    return null;
  }
};

/**
 * The manifest's OWN conformance script, executed before the fixed matrix.
 *
 * ## A DECLARED CHECK NOBODY RUNS IS NOT A CHECK
 *
 * Every `sim.manifest.json` carries `conformance.script` and `conformance.expect` — the author's own
 * statement of how to drive their simulation and what it should answer. The runner ignored both, so a sim
 * could declare `expect.grade: 4` and ship without anything ever comparing it. That is the same shape as
 * P5-T9's `emit` that was never called: a promise in a field.
 *
 * Now the script is driven over the real protocol and `expect` is checked. This is also what makes the
 * field useful at scale — twenty-four gold sims cannot each rely on a human reading a manifest to work out
 * whether the thing behaves.
 */
const runManifestScript = async (page, frame, entry, manifest) => {
  const steps = manifest?.conformance?.script ?? [];
  if (steps.length === 0) return { ok: true, note: 'no script declared' };

  const before = await page.evaluate(() => globalThis.__conformance.log.answers.length);
  for (const step of steps) {
    await page.evaluate(async (s) => {
      const frame = globalThis.document.querySelector('iframe');
      const target = frame?.contentWindow;
      const nonce = globalThis.__conformance.log.inbound.find((f) => f.type === 'sim:ready')?.nonce;
      if (target === null || target === undefined || nonce === undefined) return;
      const args = s.args ?? {};
      const outbounds = [];
      switch (s.command) {
        case 'reset':
          target.postMessage({ type: 'sim:command', name: 'reset', args, nonce }, '*');
          break;
        case 'command':
          target.postMessage(
            { type: 'sim:command', name: String(args.name ?? ''), args, nonce },
            '*',
          );
          break;
        case 'setParams':
          target.postMessage({ type: 'sim:setParams', params: args.params ?? args, nonce }, '*');
          break;
        case 'requestState':
          target.postMessage({ type: 'sim:requestState', reason: 'save', nonce }, '*');
          break;
        case 'wait':
          await new Promise((done) => setTimeout(done, Number(args.ms ?? 200)));
          break;
        default:
          outbounds.push(s.command);
      }
    }, step);
    await page.waitForTimeout(120);
  }

  // A script that drives the sim but leaves no answer is a script that found nothing.
  let answers = await page.evaluate((n) => globalThis.__conformance.log.answers.slice(n), before);

  // `plans/10` fixes the host command vocabulary, and NOTHING in it asks a simulation for its answer: an
  // answer is submitted through the simulation's own control, which is right for a lesson and unreachable
  // for a script. Rather than change the protocol for the convenience of a test, the runner submits the
  // way a student does.
  //
  // Every gold sim exposes `#sim-submit`, and one without it now fails with a sentence saying so, rather
  // than an `expect.answer` that quietly never arrives.
  const declared = manifest?.conformance?.expect ?? {};
  // `conformance.type` is what a STUDENT would enter, kept separate from `conformance.expect` because
  // they answer different questions: one is the input, the other is the claim about the output. Typing
  // `expect.answer` into the field and then asserting the sim reports it would be a test that cannot
  // fail for the reason anyone would write it.
  //
  // It exists because two shapes of simulation need different things from a scripted host: one that
  // COMPUTES its answer has nothing to type, and one that asks the student for a number has nothing to
  // submit without it. The first Newton manifest hit exactly this -- `expect.answer.value` wanted 6 and
  // the sim answered `null`, because the field was empty.
  const typed = manifest?.conformance?.type;
  if (typed !== null && typed !== undefined) {
    for (const [key, value] of Object.entries(typed)) {
      // Through Playwright's frame API, not `contentDocument` — the same reason the submit click does:
      // the frame is a sandboxed opaque origin and the parent cannot see inside it. Reaching for
      // `contentDocument` here silently did nothing at all, and the sim answered `null` with no error
      // anywhere to say why.
      const selector = `#sim-${key}`;
      if ((await frame.locator(selector).count()) === 0) {
        return {
          ok: false,
          note: `conformance.type names "${key}", but the sim has no ${selector} field`,
        };
      }
      await frame.locator(selector).fill(value === null ? '' : String(value));
    }
    await page.waitForTimeout(120);
  }
  if (declared.answer !== undefined && answers.length === 0) {
    // Through PLAYWRIGHT'S frame API, not `contentDocument`. The frame is a sandboxed opaque origin --
    // that is the entire point of it -- so the parent document cannot see inside, and the first version
    // of this reported "no #sim-submit control" for a sim that has one. This is the same route the matrix's
    // own interaction cell uses, which is why that cell worked and this one did not.
    let clicked = false;
    try {
      await frame.locator('#sim-submit').click({ timeout: 4000 });
      clicked = true;
    } catch {
      clicked = false;
    }
    if (!clicked) {
      return {
        ok: false,
        note: 'expect.answer is declared but the sim exposes no clickable #sim-submit control',
      };
    }
    const expired = deadline(4000);
    for (;;) {
      answers = await page.evaluate((n) => globalThis.__conformance.log.answers.slice(n), before);
      if (answers.length > 0) break;
      if (expired())
        return { ok: false, note: 'the submit control was activated but no answer arrived' };
      await page.waitForTimeout(100);
    }
  }

  const expect = manifest?.conformance?.expect ?? {};
  const tolerance = Number(manifest?.grading?.tolerance?.absolute ?? 0);

  /**
   * Compare one expected value against what the sim produced.
   *
   * A RANGE is the common case and the first version did not have one: it did `JSON.stringify(want) ===
   * JSON.stringify(got)`, so the projectile sim's declared `expect.answer.range = {min: 55, max: 65}` could
   * never match anything and the cell failed for a reason that had nothing to do with the simulation.
   *
   * A physics answer is not a scalar. Declaring it as an exact number would mean re-tuning the manifest
   * every time gravity changed; declaring a range says what the author actually means, which is "about
   * sixty metres".
   */
  const matches = (want, got) => {
    if (typeof want === 'number' && typeof got === 'number') {
      return Math.abs(want - got) <= tolerance;
    }
    // `{ in: [...] }` -- "the answer is one of these". Added for ENUM-valued answers, where the exact
    // value is an implementation detail but WHICH quantity was answered is the whole point: the first
    // Newton manifest declared `quantity: {in: ['mass']}` and the runner could not express it.
    if (want !== null && typeof want === 'object' && Array.isArray(want.in)) {
      return want.in.some((candidate) => JSON.stringify(candidate) === JSON.stringify(got));
    }
    if (want !== null && typeof want === 'object' && ('min' in want || 'max' in want)) {
      if (typeof got !== 'number' || !Number.isFinite(got)) return false;
      const low = want.min ?? Number.NEGATIVE_INFINITY;
      const high = want.max ?? Number.POSITIVE_INFINITY;
      return got >= low && got <= high;
    }
    return JSON.stringify(want) === JSON.stringify(got);
  };

  if (expect.answer !== undefined) {
    if (answers.length === 0) {
      return { ok: false, note: 'the script produced no answer, but expect.answer was declared' };
    }
    for (const [key, want] of Object.entries(expect.answer)) {
      const got = answers[0]?.[key];
      if (!matches(want, got)) {
        return {
          ok: false,
          note: `expect.answer.${key} was ${JSON.stringify(want)}, the sim answered ${JSON.stringify(got)}`,
        };
      }
    }
  }

  // `expect.grade` is the author's claim about the POINTS, so it is checked against the grade the
  // grader actually returns. A sim that grades 0 while claiming 4 would otherwise pass.
  if (typeof expect.grade === 'number' && answers[0] !== undefined) {
    // From the sim's OWN state, because the claim under test is "graded from stored state" -- grading a
    // `null` state exercises the grader's refusal path, which is a different thing entirely.
    const stored = await captureState(page);
    const graded = await gradeInNode(
      entry,
      answers[0],
      stored?.state ?? null,
      scriptedParams(entry, manifest),
    );
    if (graded === null) return { ok: false, note: 'the grader returned nothing in bare Node' };
    const points =
      typeof graded.points === 'number' ? graded.points : (graded.earned ?? graded.score);
    if (typeof points === 'number' && Math.abs(points - expect.grade) > tolerance) {
      return {
        ok: false,
        note: `expect.grade was ${String(expect.grade)}, the grader awarded ${String(points)}`,
      };
    }
  }

  if (expect.stateChecksumPrefix !== undefined) {
    const states = await page.evaluate(() => globalThis.__conformance.log.states);
    const last = states[states.length - 1];
    if (last?.checksum === null || last?.checksum === undefined) {
      return {
        ok: false,
        note: 'expect.stateChecksumPrefix was declared but no state was reported',
      };
    }
    if (!String(last.checksum).startsWith(expect.stateChecksumPrefix)) {
      return {
        ok: false,
        note: `the state checksum ${String(last.checksum)} does not start with ${expect.stateChecksumPrefix}`,
      };
    }
  }

  return { ok: true, note: `${String(steps.length)} declared steps run` };
};

/**
 * The parameters a sim was actually RUN WITH, for grading in Node.
 *
 * The registry carries each sim's declared DEFAULTS. A conformance script that calls `setParams` changes
 * them, and a grader asked about the defaults will disagree with the screen for reasons that have nothing
 * to do with the student's answer. Merged here rather than in each caller, so the two grading paths cannot
 * drift.
 */
const scriptedParams = (entry, manifest) => {
  const merged = new Map();
  for (const parameter of entry.parameters ?? []) {
    merged.set(parameter.name, parameter.default);
  }
  for (const step of manifest?.conformance?.script ?? []) {
    if (step.command !== 'setParams') continue;
    const supplied = step.args?.params ?? step.args ?? {};
    if (typeof supplied !== 'object' || supplied === null) continue;
    for (const [name, value] of Object.entries(supplied)) merged.set(name, value);
  }
  // A RECORD, not the registry's array of `{name, default}`. `gradeStoredState` runs the parameters
  // through `clampParams`, which reads them by name — given the array, every value came back
  // `undefined`, every parameter fell to its fallback, and the grader confidently reported that the
  // student had been asked for the acceleration. Two shapes for one concept, and only one of them
  // reaches the grader.
  return Object.fromEntries(merged);
};

/** The registry's declared defaults, in the shape the grader actually reads. */
const defaultParams = (entry) =>
  Object.fromEntries(
    (entry.parameters ?? []).map((parameter) => [parameter.name, parameter.default]),
  );

const CELLS = [
  {
    name: "the manifest's OWN conformance script runs and its `expect` holds",
    why: 'a declared check nobody runs is not a check',
    run: async ({ page, frame, entry, manifest }) => {
      const outcome = await runManifestScript(page, frame, entry, manifest);
      return outcome.ok ? null : outcome.note;
    },
  },
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
    name: "every registered sim's grader honours grade(state, params, answer)",
    why: 'a two-argument grader is handed the parameters as its answer and scores every student 0',
    run: async ({ entry }) => {
      const grader = join(
        ROOT,
        'sims',
        String(entry.id),
        'dist',
        String(entry.bundle.grader).replace(/^\.\//, ''),
      );
      if (!existsSync(grader)) return `grader bundle missing: ${String(entry.bundle.grader)}`;
      const half = (await import(pathToFileURL(grader).href)).default.grader;
      // Arity, checked per SIM as well as in `defineSim`. The load-time check is the fix; this is the
      // matrix making it visible for a simulation someone published without building locally.
      if (typeof half?.grade !== 'function') return 'the bundle exports no grade function';
      return half.grade.length === 3
        ? null
        : `grade takes ${String(half.grade.length)} argument(s), not 3`;
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
      const captured = await captureState(page);
      if (captured === null) return 'the sim reported no state to grade from';
      const first = await gradeInNode(entry, answer, captured.state);
      const second = await gradeInNode(entry, answer, captured.state);
      if (first === null || second === null) return 'the grader returned nothing in bare Node';
      // Determinism in a browser is one claim; determinism in Node is the claim the grader rests on.
      if (JSON.stringify(first) !== JSON.stringify(second)) return 'two Node grades disagreed';
      const points =
        typeof first.points === 'number' ? first.points : (first.earned ?? first.score);
      if (points === undefined) return 'the grade carried no score';
      process.stdout.write(`       ${c.dim(`graded ${String(points)} in bare Node`)}\n`);
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
  // The manifests, because each sim DECLARES its own conformance script and expectations and the runner
  // has to honour them rather than apply one matrix to everything.
  const manifests = new Map();
  for (const entry of entries) {
    const path = join(ROOT, 'sims', String(entry.id), 'sim.manifest.json');
    if (existsSync(path)) manifests.set(String(entry.id), JSON.parse(await readFile(path, 'utf8')));
  }
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
    // Frame errors too. `pageerror` covers the top document only, so a throw inside the SIM -- which is
    // where a broken `sim:setParams` or an unknown command lands -- was invisible, and the cell reported
    // "no uncaught errors" for a simulation that had thrown on every frame it was sent.
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
    });
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

    // The sim's own `Frame`, for the declared-script cell. Taken here rather than inside a cell so a
    // missing frame is caught once, with the sim's name attached, instead of once per cell.
    const simFrame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (simFrame === undefined) {
      process.stderr.write(`${c.red(`no frame for ${String(entry.id)}`)}\n`);
      process.exitCode = 1;
      await page.close();
      continue;
    }

    process.stdout.write(`\n${c.bold(String(entry.id))} ${c.dim(String(entry.version))}\n`);
    for (const cell of CELLS) {
      let failure = null;
      try {
        failure = await cell.run({
          page,
          frame: simFrame,
          simOrigin: sim.origin,
          entry,
          manifest: manifests.get(String(entry.id)),
        });
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
