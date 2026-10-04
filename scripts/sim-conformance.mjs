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
/**
 * THE NONCE OF THE CURRENT MOUNT, NOT THE FIRST ONE EVER.
 *
 * Every inbound frame is authenticated against the nonce the host minted for the mount it belongs to, and
 * a re-mount mints a new one. The runner took `log.inbound.find(f => f.type === 'sim:ready')` -- the
 * FIRST ready frame in the log -- so after any re-mount it sent a STALE nonce and the bridge silently
 * dropped every frame. Every lookup below therefore scans BACKWARDS.
 *
 * It looked like the simulations were broken: `setParams` did nothing, so no cell could perturb one and
 * the new reset cell could not see a reset. But `__simReceived` showed `sim:setParams` ARRIVING, because
 * the sims record the frame type in their own listener, which runs BEFORE the bridge authenticates it --
 * so the evidence that looked like proof of delivery was evidence of the opposite.
 *
 * Nothing caught it across nine simulations, because every one of them declares a conformance script that
 * sets its parameters to their DEFAULTS. A frame that does nothing and a frame that sets a value to what
 * it already was are indistinguishable, and the suite only ever asked for the second.
 */
const captureState = async (page) => {
  const nonce = await page.evaluate(
    () =>
      [...globalThis.__conformance.log.inbound].reverse().find((f) => f.type === 'sim:ready')
        ?.nonce ?? null,
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
/**
 * The grader half's own `controls`, read from the built bundle.
 *
 * Loaded from `dist` for the same reason `gradeInNode` does: the registry's paths are relative to that
 * directory, and reading the SOURCE would check a declaration the bundle does not actually ship.
 */
const declaredControls = async (entry) => {
  const grader = join(
    ROOT,
    'sims',
    String(entry.id),
    'dist',
    String(entry.bundle.grader).replace(/^\.\//, ''),
  );
  if (!existsSync(grader)) return null;
  const { default: half } = await import(pathToFileURL(grader).href);
  return half?.grader?.controls ?? null;
};

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

  // WAIT FOR THE HANDSHAKE BEFORE SCRIPTING ANYTHING.
  //
  // A frame that arrives before `sim:init` is dropped without comment -- there is no nonce to
  // authenticate it with, and `sim:init` is what establishes one. A script that starts posting the moment
  // the page loads therefore races the handshake, and the loser is silent: the `sim:setParams` vanishes
  // and the simulation goes on with its `sim:init` defaults.
  //
  // That is what made `physics.newtons-second-law` answer `"acceleration"` for a script that had just set
  // `"mass"`, in roughly one run in three. It was invisible while `sim:init` params were discarded,
  // because then the simulation started from the same defaults the script set and the race had nothing to
  // decide. Now that a host's parameters are honoured, the ordering matters -- and a conformance script
  // that depends on winning a race is not a conformance script.
  await waitForStatus(page, ['READY', 'DEGRADED']);

  const before = await page.evaluate(() => globalThis.__conformance.log.answers.length);
  for (const step of steps) {
    // REAL UI INTERACTIONS, driven from Node. `page.evaluate` serialises its function into the browser,
    // so a Playwright call placed in there is not a Playwright call at all -- it is a `ReferenceError`
    // that would be reported as the simulation misbehaving. Clicking is also the only way to exercise an
    // interaction the simulation implements itself: every other step speaks the protocol, and a scripted
    // answer injected through `type` would test the grader rather than the simulation.
    if (step.command === 'click') {
      const inside = page.frameLocator('iframe');
      const selector = String(step.args?.selector ?? '');
      if (step.what === 'fill') {
        await inside.locator(selector).fill(String(step.args?.value ?? ''));
      } else if (step.what === 'select') {
        await inside.locator(selector).selectOption(String(step.args?.value ?? ''));
      } else {
        await inside.locator(selector).click();
      }
      await page.waitForTimeout(120);
      continue;
    }
    await page.evaluate(async (s) => {
      const frame = globalThis.document.querySelector('iframe');
      const target = frame?.contentWindow;
      const nonce = [...globalThis.__conformance.log.inbound]
        .reverse()
        .find((f) => f.type === 'sim:ready')?.nonce;
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
  // A GRADE CLAIM WITH NO ANSWER CHECKS NOTHING.
  //
  // `expect.grade` is only evaluated once an answer exists, and an answer only exists once something has
  // submitted one — which happens only when `expect.answer` is declared. So a manifest declaring
  // `expect.grade: 4` and no `expect.answer` passed vacuously, having verified nothing at all. The first
  // randomised gold sim did exactly that, and its cell went green while the runner had no idea what the
  // simulation answered.
  if (
    declared.grade !== undefined &&
    declared.answer === undefined &&
    declared.value === undefined
  ) {
    return {
      ok: false,
      note:
        'expect.grade is declared but neither expect.answer nor expect.value is, so there is no ' +
        'answer to grade and the claim is never checked. Declare the answer, or drop the grade claim.',
    };
  }

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
  if ((declared.answer !== undefined || declared.value !== undefined) && answers.length === 0) {
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
    // `{ exact: "..." }` -- a TEXT answer, compared verbatim.
    //
    // Added for the first simulation whose answer is a sentence rather than a value. Every other form of
    // expectation here compares numbers, sets or sequences, so a simulation graded on a line of chemical
    // algebra could not declare a checked expectation at all.
    if (want !== null && typeof want === 'object' && typeof want.exact === 'string') {
      return want.exact === got;
    }
    if (typeof want === 'number' && typeof got === 'number') {
      return Math.abs(want - got) <= tolerance;
    }
    // `{ set: [...] }` -- an order-independent collection. Needed for the first MULTI-PART gold answer:
    // the two roots of a quadratic are the same answer whichever order they are typed in, and a
    // positional expectation would mark a correct pair wrong half the time.
    if (want !== null && typeof want === 'object' && Array.isArray(want.set)) {
      const expected = want.set.map((candidate) => JSON.stringify(candidate));
      const actual = Array.isArray(got) ? got.map((candidate) => JSON.stringify(candidate)) : null;
      if (actual === null) return false;
      if (actual.length !== expected.length) return false;
      const remaining = [...expected];
      for (const value of actual) {
        const at = remaining.indexOf(value);
        if (at < 0) return false;
        remaining.splice(at, 1);
      }
      return true;
    }
    // `{ sequence: [...] }` -- an ORDERED collection, where position is part of the answer.
    //
    // The mirror of `{ set: [...] }`, and needed for the same reason in the opposite direction: ordering
    // stages is the question, so every item being present is not evidence of anything. Without this, a
    // simulation graded `ORDER` could not declare a checked expectation at all -- which is the state the
    // platform was in for scalar answers before `expect.value` and for enums before `in`.
    if (want !== null && typeof want === 'object' && Array.isArray(want.sequence)) {
      const actual = Array.isArray(got) ? got : null;
      if (actual === null || actual.length !== want.sequence.length) return false;
      return want.sequence.every(
        (value, index) => JSON.stringify(value) === JSON.stringify(actual[index]),
      );
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
    // `{ prefix: "..." }` -- "the answer STARTS WITH this", for an answer that is a longer piece of text than
    // the part worth asserting: a formatted string with units, or a working shown alongside its result.
    //
    // THE SCHEMA HAS ALLOWED THIS SINCE THE VOCABULARY WAS WRITTEN, AND NOTHING HERE CONSUMED IT, which is the
    // worst of the two failure modes this task covers. A manifest declaring `{prefix: "..."}` passed schema
    // validation and every other gate, then fell through to the `JSON.stringify` line below, which compared the
    // WRAPPER `{prefix: "..."}` against the VALUE. It could never match, so the cell failed for a reason that
    // had nothing to do with the simulation -- and the note it printed talked about the student's answer.
    //
    // Implementing the branch is better than deleting the schema entry, because "does the answer begin with
    // this" is a real assertion that no other form can make: `exact` demands the whole string, which no
    // simulation whose answer carries units could ever satisfy.
    if (want !== null && typeof want === 'object' && typeof want.prefix === 'string') {
      // The answer must be a string for a prefix to mean anything. A number has no beginning, and coercing it
      // with `String()` would make `{prefix: "2"}` silently pass on the answer 2 while reading as a text check.
      if (typeof got !== 'string') return false;
      return got.startsWith(want.prefix);
    }
    return JSON.stringify(want) === JSON.stringify(got);
  };

  // `expect.value` for an answer that IS a number, which is most of them. `expect.answer` is for a keyed
  // object like `{roots: [...]}` or `{quantity, value}`, and there was no way to say "the answer is
  // 9.38" -- so the first scalar-answer simulation could not declare a checked expectation at all.
  if (expect.value !== undefined) {
    if (answers.length === 0) {
      return { ok: false, note: 'expect.value is declared but the script produced no answer' };
    }
    if (!matches(expect.value, answers[0])) {
      return {
        ok: false,
        note: `expect.value was ${JSON.stringify(expect.value)}, the sim answered ${JSON.stringify(answers[0])}`,
      };
    }
  }

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
        note:
          `expect.grade was ${String(expect.grade)}, the grader awarded ${String(points)} ` +
          `(answer ${JSON.stringify(answers[0])}, params ${JSON.stringify(scriptedParams(entry, manifest))})`,
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

/**
 * THE THREE MOUNTS OF THE PER-STUDENT CELL, SEPARATED OUT SO THE PAGE CAN BE RESTORED REGARDLESS OF HOW THEY END.
 *
 * Declared at module scope rather than inside the cell because the cell's `finally` needs to CALL it, and a
 * helper defined in the middle of an array literal is not a function anyone can reach. The first version tried
 * to define it inline and the file did not even parse, which is a louder failure than the silent one it
 * replaced -- but still a failure that should not have been written.
 *
 * Returns the conformance cell's own result: `null` for a pass, a string describing the failure otherwise.
 */
const compareSeeds = async (seedUsed) => {
  const firstResult = await seedUsed('attempt-alpha');
  if (firstResult.seed === null) {
    return (
      `this simulation declares randomised: true but ${String(firstResult.reason)}. A seed-dependent ` +
      'simulation has to carry its seed in the state -- the only place a cross-origin harness can see it -- ' +
      'and say that the seed came from the host rather than from its own default'
    );
  }
  const first = firstResult.seed;

  // ONE IDENTITY, TWICE. A re-sit has to reproduce, or a teacher cannot say what the student was given.
  const againResult = await seedUsed('attempt-alpha');
  if (againResult.seed === null)
    return `the second mount reported no seed: ${String(againResult.reason)}`;
  if (againResult.seed !== first) {
    return `the same student was given seed ${first} and then ${String(againResult.seed)}, so a re-sit does not reproduce`;
  }

  // A DIFFERENT IDENTITY, and an ADJACENT one on purpose. `deriveSeed` hashes its input, so a raw value
  // would put a neighbouring student on 'attempt-alpha1' -- sequential and trivially guessable, which is
  // the failure the hashing exists to prevent.
  const otherResult = await seedUsed('attempt-beta');
  if (otherResult.seed === null)
    return `the third mount reported no seed: ${String(otherResult.reason)}`;
  if (otherResult.seed === first) {
    return (
      `two different students were both given seed ${first}. A cohort sharing one paper is the failure ` +
      'nobody notices until the results come in'
    );
  }
  return null;
};

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
      const ready = await page.evaluate(() =>
        [...globalThis.__conformance.log.inbound].reverse().find((f) => f.type === 'sim:ready'),
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
  {
    name: "the manifest's CAPABILITIES match what the grader declares",
    why:
      'a manifest can claim a capability the simulation never declared, and the browser cannot tell. ' +
      'computing.binary-search shipped `stepper: true` in its manifest and said nothing about a stepper ' +
      "in its grader, so defineSim's own check -- the one that refuses a stepper with no maxTime -- never " +
      'fired, and two declarations of one fact had only one of them enforced',
    run: async ({ entry, manifest }) => {
      const controls = await declaredControls(entry);
      if (controls === null) return 'the grader bundle could not be read';
      const claimed = manifest?.capabilities ?? {};
      const problems = [];

      if (Boolean(claimed.stepper) !== Boolean(controls.stepper)) {
        problems.push(
          `stepper is ${String(Boolean(claimed.stepper))} in the manifest and ` +
            `${String(Boolean(controls.stepper))} in the grader`,
        );
      }
      // A stepper with no range cannot be stepped, and `defineSim` refuses that combination -- which is
      // only a useful guard if the manifest and the grader agree that there IS a stepper.
      if (controls.stepper === true && !(Number(controls.maxTime) > 0)) {
        problems.push(`stepper is declared but maxTime is ${String(controls.maxTime)}`);
      }

      const claimedScenarios = Array.isArray(claimed.scenarios)
        ? [...claimed.scenarios].sort()
        : [];
      const declaredScenarios = Array.isArray(controls.scenarios)
        ? [...controls.scenarios].sort()
        : [];
      if (JSON.stringify(claimedScenarios) !== JSON.stringify(declaredScenarios)) {
        problems.push(
          `scenarios are [${claimedScenarios.join(', ')}] in the manifest and ` +
            `[${declaredScenarios.join(', ')}] in the grader`,
        );
      }

      if (claimed.audio === true && !('audio' in controls)) {
        problems.push('the manifest claims audio and the grader declares nothing about it');
      }

      return problems.length === 0 ? null : problems.join('; ');
    },
  },

  {
    /**
     * THE PER-STUDENT SEED PATH, WHICH NOTHING EXERCISED IN A BROWSER BEFORE THIS CELL.
     *
     * `deriveSeed` has three branches and the browser matrix only ever reached one. The harness pinned
     * `seedPolicy={{ kind: 'FIXED', seed: 'conformance-seed' }}`, which is right for a determinism cell and
     * left `PER_STUDENT` dead. That branch is the ANTI-COLLUSION claim, and it caught a real defect: a
     * `randomised: true` simulation that read its seed only from the manifest default, so a cohort would have
     * received one paper while every number on screen looked correct.
     *
     * ## WHY IT READS THE STATE, NOT THE INIT FRAME
     *
     * The first version looked for the seed on `sim:init` and reported "the sim:init frame carried no seed" on
     * every simulation it ran. That was not a platform defect: `sim:init` travels HOST TO SIM and the harness
     * records only INBOUND frames, for a structural reason it documents at length -- patching `postMessage`
     * on a cross-origin frame window throws a `SecurityError`, so outbound frames cannot be observed at all
     * without defeating the sandbox this suite exists to check.
     *
     * So the seed is observed where it is genuinely visible: in the simulation's own state, because a
     * seed-dependent simulation is required to carry it there.
     *
     * ## AND WHY IT INSISTS ON `seedFromHost`
     *
     * The seed VALUE cannot distinguish "the host chose this" from "the manifest default happened to be this",
     * and while the bug above was live the two were EQUAL -- so a harness reading only the value would have
     * reported a simulation that ignored per-student seeding as correct. A simulation must say where its seed
     * came from.
     */
    name: 'a PER-STUDENT seed gives two students different questions and one student the same one',
    why:
      "the harness pinned seedPolicy to FIXED, so deriveSeed's PER_STUDENT branch never ran in a browser. " +
      'It is the anti-collusion claim, and a cohort sharing one paper is the failure nobody notices until the ' +
      'results come in',
    run: async ({ page, entry, manifest, appOrigin }) => {
      // BOTH SOURCES. The first version consulted only `entry.randomised`, which is undefined for all
      // twenty-three sims -- so every simulation skipped, including the two that declare `randomised: true`,
      // because the flag lives in the manifest. The determinism cell below already checks both.
      if (entry.randomised !== true && (manifest?.capabilities?.randomised ?? false) !== true) {
        return {
          skip: 'the simulation does not declare randomness, so there is no seed for it to derive',
        };
      }

      const baselineConfig = new URL(page.url()).searchParams.get('cfg');
      if (baselineConfig === null) return 'no baseline config to vary';

      /**
       * MOUNT GRADED UNDER A PER_STUDENT POLICY AND REPORT THE SEED THE SIMULATION ENDED UP USING.
       *
       * Graded, because per-student seeding is what an EXAM does and a lesson mount is not the case anyone is
       * defending against. The seed is read from the captured state rather than recomputed here: deriving it
       * again in the runner would test `deriveSeed` against itself, and both would agree even if both were
       * wrong about what was actually sent.
       */
      const seedUsed = async (attemptId) => {
        const config = {
          ...JSON.parse(Buffer.from(baselineConfig, 'base64url').toString('utf8')),
          seedPolicy: { kind: 'PER_STUDENT', derivation: 'ATTEMPT_ID' },
          identity: { attemptId },
          mode: 'graded',
        };
        const encoded = Buffer.from(JSON.stringify(config)).toString('base64url');
        await page.goto(`${appOrigin}/?cfg=${encoded}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });
        await waitForStatus(page, ['READY', 'DEGRADED']);
        // Long enough for a seeded shuffle to have run and a state to have been captured, which is the same
        // allowance the determinism cell below makes.
        await page.waitForTimeout(400);
        const captured = await captureState(page);
        const state = captured?.state;
        if (state === null || typeof state !== 'object')
          return { seed: null, reason: 'no state was captured' };
        if (state.seedFromHost !== true) {
          return {
            seed: null,
            reason: 'the simulation did not report that its seed came from the host',
          };
        }
        const seed = state.seed;
        // A NUMBER OR A STRING, because the two seeded simulations disagree and both are legitimate:
        // `maths.sequence-next` parses its hex seed to a number because its generator wants arithmetic on it,
        // and `maths.monte-carlo-pi` keeps the string because `createRng` hashes a string. Demanding a number
        // passed on one and failed the other with a message about the SIMULATION that was about the CELL.
        const text =
          typeof seed === 'number' && Number.isFinite(seed)
            ? `#${String(Math.trunc(seed))}`
            : typeof seed === 'string' && seed !== ''
              ? `#${seed}`
              : null;
        return text === null
          ? { seed: null, reason: 'the state carries no usable `seed`' }
          : { seed: text };
      };

      /**
       * EVERY MOUNT HAPPENS INSIDE A `try`, AND THE BASELINE PAGE IS RESTORED IN A `finally`.
       *
       * This cell navigates three times, each under `mode: 'graded'` with a `PER_STUDENT` policy. Without the
       * restore it left the page mounted graded with a derived seed, and EVERY CELL AFTER IT INHERITED THAT --
       * which is how two unrelated RESET cells started failing with a checksum that did not match the declared
       * defaults. The cells after this one were not broken; they were measuring the wrong page.
       *
       * The existing graded-mount cell documents the same trap at length, including that restoring only on the
       * success path guarantees the code after the `return` is the code that runs -- which is the code that
       * cannot. `finally` is what "on every path" has to mean.
       */
      let outcome;
      try {
        outcome = await compareSeeds(seedUsed);
      } finally {
        await page.goto(`${appOrigin}/?cfg=${String(baselineConfig)}`, { waitUntil: 'load' });
        await page
          .waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
            timeout: 15_000,
          })
          .catch(() => {});
        await waitForStatus(page, ['READY', 'DEGRADED']).catch(() => {});
      }
      return outcome;
    },
  },

  {
    name: 'a RANDOMISED simulation gives the same student the same question',
    why:
      'a simulation that calls Math.random() puts a different question in front of every student, breaks ' +
      'save and restore, and makes its own tests impossible -- and it declares `randomised: true` while ' +
      'doing it, so nothing anywhere reports the difference',
    run: async ({ page, entry, manifest, appOrigin }) => {
      // Only for simulations that claim randomness. One without it has nothing to be deterministic about,
      // and a simulation whose state legitimately advances with elapsed time would fail a cell about
      // randomness for no reason at all.
      if (entry.randomised !== true && (manifest?.capabilities?.randomised ?? false) !== true) {
        return {
          skip: 'the simulation does not declare randomness, so there is nothing to be deterministic',
        };
      }
      const baselineConfig = new URL(page.url()).searchParams.get('cfg');
      const mount = async () => {
        await page.goto(`${appOrigin}/?cfg=${String(baselineConfig)}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });
        await waitForStatus(page, ['READY', 'DEGRADED']);
        // Long enough for a seeded shuffle to have run and a frame to have been painted, and short enough
        // that a simulation with a play/pause timeline has not advanced far enough to differ for that
        // reason rather than this one.
        await page.waitForTimeout(400);
        return captureState(page);
      };
      const first = await mount();
      if (first === null || typeof first.checksum !== 'string') return 'no state to compare';
      const second = await mount();
      if (second === null || typeof second.checksum !== 'string')
        return 'the second mount reported no state';
      return first.checksum === second.checksum
        ? null
        : `two mounts with the same seed gave ${String(first.checksum)} and ${String(second.checksum)}, ` +
            'so the randomness is not seeded';
    },
  },
  // LAST, DELIBERATELY. This cell remounts the page three times through the host, and every cell that
  // follows it inherits whatever it leaves behind -- which is how "a SCRIPTED INTERACTION produces an
  // answer" and "the answer is GRADEABLE" started failing the moment this cell sat second in the list.
  // A cell that owns the page gets the last word on it.
  {
    name: 'RESET puts the student back where they started',
    why:
      'reset is the button a student presses after a wrong answer, and no simulation had a check for ' +
      'it: every conformance script drove `setParams` only, and `expect.grade` is computed in Node from ' +
      "the manifest's own params, so the suite proved the grader agreed with the manifest and never that " +
      'the simulation obeyed anything',
    run: async ({ page, entry, simOrigin, appOrigin }) => {
      const baselineConfig = new URL(page.url()).searchParams.get('cfg');
      const parameter = (entry.parameters ?? []).find((p) => p.default !== undefined);
      // A simulation with NO PARAMETERS is a legitimate thing, not a gap in the test. chemistry's
      // equation-balancing takes no parameters at all, and refusing to check its `reset` because there was
      // nothing to perturb would have left the one button every student presses unchecked on exactly the
      // simulation with the least state to get wrong.
      if (parameter === undefined) {
        const baseline = await (async () => {
          await page.goto(`${appOrigin}/?cfg=${baselineConfig}`, { waitUntil: 'load' });
          await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
            timeout: 15_000,
          });
          await waitForStatus(page, ['READY', 'DEGRADED']);
          return captureState(page);
        })();
        if (baseline === null || typeof baseline.checksum !== 'string') {
          return 'this simulation declares no parameters and reported no state to reset to';
        }
        const afterReset = await page.evaluate(async () => {
          const target = globalThis.document.querySelector('iframe')?.contentWindow;
          const log = globalThis.__conformance.log;
          const nonce = [...log.inbound].reverse().find((f) => f.type === 'sim:ready')?.nonce;
          const before = log.states.length;
          if (target === null || target === undefined || nonce === undefined) return null;
          target.postMessage({ type: 'sim:command', name: 'reset', args: {}, nonce }, '*');
          await new Promise((done) => setTimeout(done, 200));
          target.postMessage({ type: 'sim:requestState', reason: 'save', nonce }, '*');
          const until = Date.now() + 6000;
          for (;;) {
            if (log.states.length > before) return log.states[log.states.length - 1];
            if (Date.now() > until) return null;
            await new Promise((done) => setTimeout(done, 100));
          }
        });
        if (afterReset === null) return 'reset produced no state';
        return afterReset.checksum === baseline.checksum
          ? null
          : `reset left ${String(afterReset.checksum)}; a fresh mount is ${String(baseline.checksum)}`;
      }

      const perturbedValue =
        parameter.type === 'number'
          ? Number(parameter.default) +
            (Number(parameter.default) === Number(parameter.maximum) ? -1 : 1)
          : Array.isArray(parameter.enumValues) && parameter.enumValues.length > 1
            ? parameter.enumValues.find((v) => v !== parameter.default)
            : null;
      if (perturbedValue === null) return 'no way to perturb a parameter with exactly one value';

      // THE PERTURBATION GOES THROUGH THE HOST, by remounting with a different `cfg`.
      //
      // Posting `sim:setParams` into the frame cannot see this: the reply came back with the UNCHANGED
      // state for all nine simulations, and `expect.grade` passed regardless, because that grade never
      // reads the browser. A cell that cannot see a change cannot test that a change was undone.
      const configFor = (overrides) => {
        const config = harnessConfig(entry, simOrigin);
        return Buffer.from(
          JSON.stringify(
            overrides ? { ...config, params: { ...config.params, ...overrides } } : config,
          ),
        ).toString('base64url');
      };
      const mount = async (cfg) => {
        await page.goto(`${appOrigin}/?cfg=${cfg}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });
        await waitForStatus(page, ['READY', 'DEGRADED']);
        return captureState(page);
      };

      // LEAVE THE PAGE AS IT WAS FOUND. This cell reloads it three times, and a cell that leaves a
      // perturbed simulation behind changes the verdicts of every cell that runs after it -- which is
      // how "a SCRIPTED INTERACTION produces an answer" and "the answer is GRADEABLE" started failing
      // the moment this cell landed. A cell owns its own effects and returns the world as it found it.
      const restore = async () => {
        await mount(baselineConfig ?? configFor(null));
      };

      const perturbedCfg = configFor({ [parameter.name]: perturbedValue });
      const perturbed = await mount(perturbedCfg);
      if (perturbed === null || typeof perturbed.checksum !== 'string') {
        await restore();
        return 'the perturbed simulation reported no state';
      }
      const defaults = await mount(baselineConfig ?? configFor(null));
      if (defaults === null || typeof defaults.checksum !== 'string') {
        return 'the default simulation reported no state';
      }
      if (perturbed.checksum === defaults.checksum) {
        await restore();
        return (
          `${parameter.name}=${JSON.stringify(perturbedValue)} produced the same state as the default, so ` +
          'the host is not configuring the simulation and this cell would pass for the wrong reason'
        );
      }

      // A SECOND perturbed mount, so "reset restored it" compares two states rather than three guesses.
      const again = await mount(perturbedCfg);
      if (again === null || again.checksum !== perturbed.checksum) {
        await restore();
        return 'mounting the same configuration twice produced different states';
      }

      const afterReset = await page.evaluate(async () => {
        const target = globalThis.document.querySelector('iframe')?.contentWindow;
        const log = globalThis.__conformance.log;
        const nonce = [...log.inbound].reverse().find((f) => f.type === 'sim:ready')?.nonce;
        const before = log.states.length;
        if (target === null || target === undefined || nonce === undefined) return null;
        target.postMessage({ type: 'sim:command', name: 'reset', args: {}, nonce }, '*');
        await new Promise((done) => setTimeout(done, 200));
        target.postMessage({ type: 'sim:requestState', reason: 'save', nonce }, '*');
        const until = Date.now() + 6000;
        for (;;) {
          if (log.states.length > before) {
            return log.states[log.states.length - 1];
          }
          if (Date.now() > until) return null;
          await new Promise((done) => setTimeout(done, 100));
        }
      });
      if (afterReset === null) return 'reset produced no state';

      const verdict =
        afterReset.checksum === defaults.checksum
          ? null
          : `reset left ${String(afterReset.checksum)}; the declared defaults are ${String(defaults.checksum)}`;
      await restore();
      return verdict;
    },
  },
  {
    name: 'a GRADED mount works, and a gradePreview during one is DISCARDED',
    why:
      'every conformance run mounts `lesson`, so the mode an EXAM runs in was never exercised in sixteen ' +
      'simulations. The host-side rule is unit-tested; the mount itself is not',
    run: async ({ page, entry, simOrigin, appOrigin }) => {
      const config = harnessConfig(entry, simOrigin);
      // `gradingSupplied` follows `mode`, so mounting graded is what puts a grading block on `sim:init`.
      const gradedConfig = Buffer.from(JSON.stringify({ ...config, mode: 'graded' })).toString(
        'base64url',
      );
      const lessonConfig = Buffer.from(JSON.stringify(config)).toString('base64url');

      // RESTORE THE PAGE ON EVERY PATH, INCLUDING EVERY FAILURE.
      //
      // A cell that remounts and then returns early leaves the page mounted in GRADED mode, and every
      // cell after it inherits a page that is not a lesson mount. The first attempt restored only on
      // success -- so the one thing guaranteed to run was the code after the `return` that reports a
      // failure, which is the code that cannot run. That is how a failing cell became a suite that looked
      // broken: sixteen identical failures, each handing the next cell a page in the wrong mode.
      //
      // `try`/`finally`, because "on every path" has to include the paths nobody wrote down.
      const problem = await (async () => {
        await page.goto(`${appOrigin}/?cfg=${gradedConfig}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });

        // 1. The handshake completes with a grading block on the init frame.
        const status = await waitForStatus(page, ['READY', 'DEGRADED']);
        if (status !== 'READY') return `a graded mount stayed at ${status}`;

        // 2. The sandbox is UNCHANGED. The extra init field is data, and data cannot widen a sandbox; if
        //    it ever could, the gradeable mode would be the one running the loosest frame.
        const sandbox = await page.getAttribute('iframe', 'sandbox');
        if (sandbox !== 'allow-scripts') return `sandbox="${String(sandbox)}" in graded mode`;

        // 3. A gradePreview FROM INSIDE THE FRAME is discarded, and recorded.
        //
        // THE FIRST ATTEMPT POSTED FROM THE PARENT, which proves nothing about the frame at all:
        // `iframe.contentWindow.postMessage(...)` runs in the HOST's realm and sends host -> frame. The
        // host's `sim:gradePreview` case is on the INBOUND listener, so a message the host sends to
        // itself is a message the host never sees. All sixteen cells failed with `a gradePreview during a
        // graded mount left no record`, which reads like the discard rule is broken and is in fact the
        // test never producing a gradePreview to discard.
        //
        // The frame is CROSS-ORIGIN by sandbox, so the only way to speak as the sim is to evaluate inside
        // it. Then `parent.postMessage` carries the frame's own `event.source` and origin, which is what
        // the host authenticates -- so this is the real path, not a shortcut around it.
        const outcome = await page.evaluate(() => {
          const log = globalThis.__conformance.log;
          const nonce = [...log.inbound].reverse().find((f) => f.type === 'sim:ready')?.nonce;
          if (nonce === undefined) return null;
          const before =
            globalThis.document
              .querySelector('.sim-host')
              ?.getAttribute('data-sim-teacher-detail') ?? '';
          return { before, answersBefore: log.answers.length, nonce };
        });
        if (outcome === null) return 'the graded mount never completed its handshake';
        const simFrame = page.frames().find((frame) => frame.url().startsWith(simOrigin));
        if (simFrame === undefined) return 'the simulation frame was unreachable';

        await simFrame.evaluate((nonce) => {
          globalThis.parent.postMessage(
            { type: 'sim:gradePreview', nonce, points: 4, correct: true, rationale: 'leaked' },
            '*',
          );
        }, outcome.nonce);

        const expired = deadline(5000);
        let after = outcome.before;
        for (;;) {
          after = await page.evaluate(
            () =>
              globalThis.document
                .querySelector('.sim-host')
                ?.getAttribute('data-sim-teacher-detail') ?? '',
          );
          if (after !== outcome.before || expired()) break;
          await page.waitForTimeout(100);
        }
        const newAnswers = await page.evaluate(
          (n) => globalThis.__conformance.log.answers.length - n,
          outcome.answersBefore,
        );
        if (after === outcome.before) {
          return 'a gradePreview during a graded mount left no record, so nothing discarded it';
        }
        if (!after.includes('gradePreview')) {
          return `the host recorded "${after}" rather than the discarded preview`;
        }

        // 4. And it was not mistaken for an answer. A preview is a mark claim, not a submission.
        if (newAnswers !== 0) return `${String(newAnswers)} answer(s) appeared from a gradePreview`;
        return null;
      })();

      // The page is a SHARED resource. Every cell after this one gets the one it leaves behind, so a cell
      // that remounts owes the next cell a page in the mode the next cell expects.
      try {
        await page.goto(`${appOrigin}/?cfg=${lessonConfig}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });
        await waitForStatus(page, ['READY', 'DEGRADED']);
      } catch (error) {
        // A restore that fails must not mask the finding that got us here.
        return problem ?? `the page could not be restored after the graded cell: ${String(error)}`;
      }
      return problem;
    },
  },
  // LAST OF ALL, AND IT OWNS THE PAGE.
  //
  // This cell leaves a simulation mounted from a RESTORED state -- a perfectly good page for the next
  // cell to inherit and a misleading one. The reset cell then perturbed parameters against a baseline
  // that was no longer the opening position, and reported `a=2 produced the same state as the default`
  // for fourteen simulations that were perfectly fine. Two cells that both remount the page have to come
  // LAST, in a known order, and this one goes after that one.
  {
    name: "the student's SAVED WORK comes back",
    why:
      'a simulation that ignores `initialState` loses everything the student did, silently: the protocol ' +
      'carries it, the host stamps it, and before this cell existed nothing checked that a simulation ' +
      'looked at it -- sixteen of sixteen did not',
    run: async ({ page, entry, simOrigin, appOrigin }) => {
      const baselineConfig = new URL(page.url()).searchParams.get('cfg');

      // Ask the simulation to change something, so the state is a state the student would have produced.
      // `loadScenario` is not used: it is a protocol command and the point here is the SIMULATION's work.
      const parameter = (entry.parameters ?? []).find((p) => p.default !== undefined);
      const perturbed =
        parameter === undefined
          ? {}
          : parameter.type === 'number'
            ? {
                [parameter.name]:
                  Number(parameter.default) +
                  (Number(parameter.default) === Number(parameter.maximum) ? -1 : 1),
              }
            : Array.isArray(parameter.enumValues) && parameter.enumValues.length > 1
              ? { [parameter.name]: parameter.enumValues.find((v) => v !== parameter.default) }
              : {};
      const workedConfig = Buffer.from(
        JSON.stringify({
          ...harnessConfig(entry, simOrigin),
          params: { ...harnessConfig(entry, simOrigin).params, ...perturbed },
        }),
      ).toString('base64url');

      const mount = async (cfg) => {
        await page.goto(`${appOrigin}/?cfg=${cfg}`, { waitUntil: 'load' });
        await page.waitForFunction(() => globalThis.__conformance?.ready === true, undefined, {
          timeout: 15_000,
        });
        await waitForStatus(page, ['READY', 'DEGRADED']);
        await page.waitForTimeout(300);
        return captureState(page);
      };

      // 1. A fresh mount, and the state it produces on its own.
      const opening = await mount(String(baselineConfig));
      if (opening === null || typeof opening.state !== 'object' || opening.state === null) {
        return { skip: 'the simulation reports no structured state to save' };
      }
      const openingChecksum = opening.checksum;

      // 2. Work: perturb it, and take the state the student would have saved.
      const worked = await mount(workedConfig);
      if (worked === null || typeof worked.checksum !== 'string') return 'no state after working';
      if (worked.checksum === openingChecksum && Object.keys(perturbed).length > 0) {
        return { skip: 'no parameter could be perturbed, so there is no work to restore' };
      }
      const saved = worked.state;

      // 3. A mount carrying that state back. The host is told to restore it, exactly as a returning
      //    attempt would be, and the parameters go back to their DEFAULTS -- so a simulation that merely
      //    echoed the host's parameters would not match, and only one that read `initialState` can.
      const restoreConfig = Buffer.from(
        JSON.stringify({
          ...harnessConfig(entry, simOrigin),
          initialState: saved,
        }),
      ).toString('base64url');
      const restored = await mount(restoreConfig);
      if (restored === null || typeof restored.checksum !== 'string')
        return 'the restored mount reported no state';

      return restored.checksum === worked.checksum
        ? null
        : `restoring ${JSON.stringify(saved).slice(0, 120)} gave ${String(restored.checksum)}, but the ` +
            `saved state was ${String(worked.checksum)} -- the simulation did not read \`initialState\``;
    },
  },
];

/**
 * The slowest cells, printed at the end.
 *
 * A conformance run that has quietly gone from two minutes to fifteen is a problem nobody will notice by
 * reading the output, because every cell prints the same single line whether it took forty milliseconds or
 * forty seconds. The numbers are here so the next cell someone adds can be costed before it is written.
 */
const slowestCells = (timings, count = 6) => {
  const rows = [...timings.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, count);
  if (rows.length === 0) return '';
  const total = [...timings.values()].reduce((sum, entry) => sum + entry.ms, 0);
  process.stdout.write(`\n  slowest cells (of ${String(total / 1000).padStart(6)} s total):\n`);
  for (const [name, entry] of rows) {
    const seconds = entry.ms / 1000;
    const perSim = entry.ms / Math.max(1, entry.n);
    process.stdout.write(
      `    ${seconds.toFixed(1).padStart(7)} s  ${String(Math.round(perSim)).padStart(5)} ms/sim  ` +
        `${c.dim(name)}\n`,
    );
  }
  return '';
};

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
  let skipped = 0;
  /** Accumulated milliseconds per cell name, across every simulation. */
  const timings = new Map();
  /** Wall clock for the whole per-simulation iteration, cells included. */
  let iterationMs = 0;

  process.stdout.write(`${c.dim(`app ${app.origin} · sim ${sim.origin}\n`)}`);

  for (const entry of entries) {
    // THE WHOLE PER-SIMULATION ITERATION, timed from OUTSIDE the cells.
    //
    // Cells account for ~58 s and mounting for ~2 s, against a run several minutes long, so most of the
    // time is in per-simulation work that is neither. Rather than instrument inside the loop again -- an
    // attempt at that broke the run -- this measures the iteration whole and subtracts the cells, which
    // locates the missing time WITHOUT touching the code path that is already fragile.
    const iterationStarted = hrtime.bigint();
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
    // NOT TIMED YET, and deliberately: the per-cell numbers showed the whole cell set costs 57 s against a
    // wall clock several times that, so the cost is in mounting sixteen simulations rather than in the
    // assertions. Splitting `newPage`, the navigation and the ready-wait says which of the three -- but a
    // timer added and never read is instrumentation theatre, so it waits until someone acts on it.
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

      // `hrtime`, NOT `Date.now()`: `INV-TIME-1` bans the wall clock outside `@orrery/clock`, and it is the
      // wrong tool anyway -- these are DURATIONS, and a clock adjustment mid-cell should not make a cell
      // look instant or endless. The file already has `deadline()` for exactly this reason.
      const startedAt = hrtime.bigint();
      try {
        failure = await cell.run({
          page,
          appOrigin: app.origin,
          frame: simFrame,
          simOrigin: sim.origin,
          entry,
          manifest: manifests.get(String(entry.id)),
        });
      } catch (error) {
        failure = `threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      // HOW LONG EACH CELL TOOK, because "the suite got slower" is not actionable and this is.
      //
      // Three cells remount the page per simulation -- the reset check, the saved-work check, and (before
      // it was reverted) the graded-mode check -- and the run went from about two minutes to about fifteen.
      // Nobody could say which cell was responsible, because every cell printed the same one line whether
      // it took 40 ms or 40 s. The slowest few are printed at the end, so the next person adding a cell
      // knows what a cell COSTS before adding twenty of them.
      const elapsed = Number(hrtime.bigint() - startedAt) / 1e6;
      const seen = timings.get(cell.name) ?? { ms: 0, n: 0 };
      seen.ms += elapsed;
      seen.n += 1;
      timings.set(cell.name, seen);
      // A CELL THAT SKIPPED MUST NOT LOOK LIKE A CELL THAT PASSED.
      //
      // Returning `null` for "not applicable" and `null` for "verified" printed the same green line, so a
      // matrix full of skips reads exactly like a matrix full of proofs. The determinism cell skips for
      // every simulation that does not declare randomness, which is all but one -- and I could not tell
      // from the output whether it had actually checked anything.
      if (failure !== null && typeof failure === 'object' && failure.skip !== undefined) {
        skipped += 1;
        process.stdout.write(
          `  ${c.dim('SKIP')} ${cell.name} ${c.dim(`(${String(failure.skip)})`)}\n`,
        );
      } else if (failure === null) {
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
    iterationMs += Number(hrtime.bigint() - iterationStarted) / 1e6;
  }

  await browser.close();
  sim.close();
  app.close();

  const total = entries.length * (CELLS.length + 1);
  process.stdout.write('\n');

  // WHERE THE TIME WENT, because a suite that got fifteen times slower and prints one line per cell
  // cannot tell you which cell did it. Printed on SUCCESS as well as on failure -- a run that is green AND
  // slow is exactly the run nobody investigates, because nothing is wrong.
  const slowest = [...timings.entries()]
    .sort((a, b) => (b[1].ms ?? 0) - (a[1].ms ?? 0))
    .slice(0, 6);
  const totalMs = [...timings.values()].reduce((sum, entry) => sum + (entry.ms ?? 0), 0);
  if (totalMs > 0) {
    process.stdout.write(c.dim('slowest cells (total across every simulation):\n'));
    for (const [name, seen] of slowest) {
      const share = Math.round(((seen.ms ?? 0) / totalMs) * 100);
      process.stdout.write(
        `  ${String(Math.round((seen.ms ?? 0) / 1000)).padStart(4)}s  ${String(share).padStart(3)}%  ${name}\n`,
      );
    }
    process.stdout.write(c.dim(`  total cell time: ${String(Math.round(totalMs / 1000))}s\n`));
    // THE GAP, which is the number that matters: what the iterations cost minus what the cells inside them
    // cost. It is `newPage`, the navigation, the handshake, the screenshot, the console sweep and the
    // `page.close()`, none of which any cell can see.
    process.stdout.write(
      c.dim(
        `  per-simulation iterations: ${String(Math.round(iterationMs / 1000))}s total, ` +
          `${String(Math.round(iterationMs / Math.max(1, entries.length)))} ms each; ` +
          `${String(Math.round((iterationMs - totalMs) / 1000))}s of that is OUTSIDE the cells\n`,
      ),
    );
  }

  if (failures.length === 0) {
    process.stdout.write(
      `${c.green(`sim:conformance passed — ${String(total)}/${String(total)} cells`)}\n` +
        (skipped > 0
          ? `  ${String(skipped)} cell${skipped === 1 ? '' : 's'} SKIPPED — green lines count only what was checked\n`
          : ''),
    );
    slowestCells(timings);
    return;
  }
  process.stdout.write(
    `${c.red(`sim:conformance failed — ${String(failures.length)} of ${String(total)} cells`)}\n`,
  );
  slowestCells(timings);
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
