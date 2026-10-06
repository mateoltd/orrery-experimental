// @vitest-environment jsdom
/**
 * THE CONTENT QA SWEEP: EVERY SIMULATION MUST LOAD.  (P12-T7)
 *
 * ## WHAT WAS MISSING, AND IT IS THE WHOLE RENDERING HALF OF THE CATALOGUE
 *
 * `P12-T7` asks for "all 220 load, grade, and pass accessibility". Measured against the 30 that exist:
 *
 *   - **GRADE: 29 of 30** test files call a grader. Real coverage.
 *   - **A11Y: 9 of 30** test anything named `accessibility`. Thin.
 *   - **LOAD: 0 of 30.**
 *
 * **NOT ONE TEST FILE IN THE CATALOGUE IMPORTS `browser.ts` OR CALLS `startSim`.** The suite ran in Node, where `document`
 * does not exist. So the grading half of every simulation had been tested and **the half a student actually looks at had
 * never been executed once.**
 *
 * That is worse than a missing test, because everything around it was green: the simulation typechecked, its unit tests
 * passed, the registry audit passed, the bundle gate passed. **A simulation whose `draw` throws on the first frame shipped
 * through all of them**, because none of them ran the frame.
 *
 * ## WHY IT WAS NEVER WRITTEN, AND WHY THAT IS EXCUSABLE ONCE
 *
 * `browser.ts` boots itself behind `window.parent !== window` -- it is written for an IFRAME, and jsdom's `window.parent` is
 * its own `window`. So importing `browser.ts` in a test does nothing at all, which is presumably why nobody wrote one.
 *
 * **`startSim(document_, window_, parent)` takes the host as an ARGUMENT**, which is what makes this testable at all, and it
 * publishes `window_.__simReceived` and `window_.__simErrors` for exactly this purpose. **The design was testable and nothing
 * tested it** -- the same shape as `renderQuestion` having 100% coverage and no callers.
 *
 * ## WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
 *
 * Asserted per simulation: **`startSim` returns without throwing, reports no window errors, and puts something in the
 * document.** That is "it loads", and it is the property nothing else covered.
 *
 * NOT asserted: that the drawing is *correct*. `canvas.getContext('2d')` returns null without the `canvas` package, so `draw`
 * returns early -- which means **this sweep proves boot, not pixels, and a simulation that boots but draws nothing passes
 * here.** Pixels are `P12-T3`'s review, and pretending otherwise would make this gate a false reassurance.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const simsRoot = join(import.meta.dirname, '..');

const simulationIds = readdirSync(simsRoot)
  .filter((name) => name !== 'registry' && !name.startsWith('_'))
  .filter((name) => existsSync(join(simsRoot, name, 'src', 'sim.ts')))
  .sort();

/**
 * A fresh document per simulation.
 *
 * Fresh matters: `startSim` mutates the document it is given and installs listeners on the window, so a shared document would
 * let one simulation's leftover DOM satisfy the next one's assertion -- **a shared fixture is a way for a sweep to pass
 * without any of its subjects running.**
 */
function blankDocument(): Document {
  document.body.innerHTML = '<div id="sim-root"></div>';
  document.head.innerHTML = '<title>blank</title>';
  return document;
}

describe('every simulation LOADS', () => {
  it(`finds the catalogue (${String(simulationIds.length)} simulations)`, () => {
    // If this is zero the whole file is vacuously green, which is the failure this sweep exists to end.
    expect(simulationIds.length).toBeGreaterThan(0);
  });

  for (const id of simulationIds) {
    it(`${id} boots, reports no error, and renders something`, async () => {
      const module_ = (await import(join(simsRoot, id, 'src', 'sim.ts'))) as {
        startSim: (document_: Document, window_: Window, parent: Window | null) => unknown;
      };
      expect(typeof module_.startSim).toBe('function');

      const view = blankDocument();
      const mutableWindow = window as unknown as {
        __simReceived?: string[];
        __simErrors?: string[];
      };
      mutableWindow.__simReceived = [];
      mutableWindow.__simErrors = [];

      // `parent: null` because there is no host frame. `startSim` takes the host as an argument precisely so
      // this works; the iframe assumption lives in `browser.ts`, not here.
      expect(() => module_.startSim(view, window, null)).not.toThrow();

      // The hook `startSim` publishes for exactly this purpose.
      expect(mutableWindow.__simErrors ?? []).toEqual([]);

      // SOMETHING rendered. Not "it drew correctly" -- see the header.
      expect(view.getElementById('sim-root')?.childElementCount ?? 0).toBeGreaterThan(0);
    });
  }
});
