/**
 * The render layer. Browser only, inside the sandboxed frame.  (P6-T4, gold sim 1)
 *
 * ## NOTHING HERE IS TRUSTED, INCLUDING BY THIS SIM
 *
 * `params` arrive from the host and go through `clampParams` before `simulate` sees them. A sim that
 * rendered whatever it was handed would render `NaN` for a hand-edited query string and the student
 * would see a blank canvas with no error.
 *
 * ## THE TEXT ALTERNATIVE IS NOT OPTIONAL AND NOT HIDDEN
 *
 * It is the class the host styles, and the conformance suite checks it is in the DOM. A canvas with no
 * text is invisible to a screen-reader user, to a student on a blocked network, and to anyone reading
 * a printed worksheet.
 */

import {
  announce,
  clampParams,
  createStepper,
  defineSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  prefersReducedMotion,
  type RenderContext,
  type Stepper,
  tolerance,
} from '@orrery/sim-sdk';
import { apex, flightTime, type ProjectileParams, range, simulate, trajectory } from './model.js';

type Answer = { range: number; time?: number };

export default defineSim({
  meta: {
    id: 'maths.projectile-motion',
    title: 'Projectile motion',
    version: '1.0.0',
    subjects: ['maths'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    angle: num({ min: 5, max: 85, default: 45, unit: 'degrees' }),
    gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s2' }),
  },
  controls: { stepper: true, stepSize: 1 / 60, scenarios: ['no-air'], maxTime: 30 },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A thrown ball in side view, a slider for the launch speed and angle, and a box for the range.',
    reducedMotion: true,
    textAlternative:
      'At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds, peaking at 32 m.',
    summary: 'A side view of a thrown ball, with the ground, its arc and a range marker.',
    readyAnnouncement: 'Projectile motion ready. Space plays and pauses, arrow keys step.',
  },
  simulate: (params, state) => ({ t: state.t, ...params }),

  // `state` is part of the required signature and is genuinely UNUSED: a projectile's range does not
  // depend on when the student looked at it. See the note in `grader.ts`.
  grade: (_state: { t: number }, params: ProjectileParams, answer: unknown) => {
    const submitted = answer as Answer | null;
    if (submitted === null || typeof submitted !== 'object' || !Number.isFinite(submitted.range)) {
      // See the note on the same branch in `grader.ts`: `tolerance(0, 0, { abs: 0 })` awarded the full 4
      // marks for a blank submission, because 0 IS within a tolerance of zero of 0.
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'No range was submitted. Enter the distance in metres.',
      };
    }
    return tolerance(submitted.range, range(params), {
      abs: 0.5,
      rel: 0.02,
      maxPoints: 4,
      partialCredit: true,
    });
  },

  render: (ctx: RenderContext<ProjectileParams, { t: number }>) => {
    const root = document.querySelector('.orrery-sim');
    if (root === null) return;
    const canvas = root.querySelector('canvas');
    const readout = root.querySelector<HTMLElement>('.orrery-sim__readout');
    const text = root.querySelector<HTMLElement>('.orrery-sim__text');

    // `ctx.params` is `ProjectileParams`, an INTERFACE, so it has no implicit index signature and cannot
    // be passed where `Partial<ParamValues>` is expected. That is the SDK's boundary doing its job: the
    // declared specs, not the incoming object, are what decides the shape of what comes back.
    const { values } = clampParams({ ...PARAMS }, ctx.params as unknown as Partial<ParamValues>);
    const params = values as unknown as ProjectileParams;
    const flying = simulate(params, { t: ctx.t }, ctx.t);
    const total = flightTime(params);
    const landing = range(params);

    if (canvas instanceof HTMLCanvasElement && typeof canvas.getContext === 'function') {
      draw(canvas, params, ctx.t, total);
    }
    if (readout !== null) {
      readout.textContent = `t = ${ctx.t.toFixed(2)} s · x = ${flying.x.toFixed(1)} m · y = ${flying.y.toFixed(1)} m · range = ${landing.toFixed(1)} m`;
    }
    if (text !== null) {
      // The alternative QUOTES the numbers the sim is showing. A generic description stops being true
      // the moment a student changes a slider.
      const peak = apex(params);
      text.textContent =
        `At ${params.speed} m/s and ${params.angle} degrees the ball lands about ` +
        `${landing.toFixed(0)} m away after ${total.toFixed(1)} seconds, peaking at ${peak.height.toFixed(0)} m.`;
    }
    announceRegion(ctx);
  },
});

const PARAMS = {
  speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
  angle: num({ min: 5, max: 85, default: 45, unit: 'degrees' }),
  gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s2' }),
};

const announceRegion = (ctx: RenderContext<ProjectileParams, { t: number }>): void => {
  const region = document.querySelector<HTMLElement>('.orrery-sim__live');
  if (region === null) return;
  // Announced only on whole seconds. A `requestAnimationFrame` loop announcing at 60 Hz is the
  // documented way to make a canvas unusable with a screen reader.
  if (Math.floor(ctx.t) !== Math.floor(ctx.t - 1 / 60)) {
    announce(region, `${String(Math.floor(ctx.t))} seconds`);
  }
};

const draw = (
  canvas: HTMLCanvasElement,
  params: ProjectileParams,
  t: number,
  total: number,
): void => {
  const context = canvas.getContext('2d');
  if (context === null) return;
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const reach = range(params) || 1;
  const peak = apex(params).height || 1;
  const toX = (x: number): number => 10 + (x / reach) * (width - 20);
  const toY = (y: number): number => height - 20 - (y / peak) * (height - 40);

  context.strokeStyle = '#1f2933';
  context.beginPath();
  context.moveTo(0, toY(0));
  context.lineTo(width, toY(0));
  context.stroke();

  context.strokeStyle = '#2b6cb0';
  context.beginPath();
  for (const point of trajectory(params, 80)) {
    const x = toX(point.x);
    const y = toY(point.y);
    if (i0(point.x, t, total)) continue;
    context.lineTo(x, y);
  }
  context.stroke();

  const here = simulate(params, { t }, t);
  context.fillStyle = '#9b2c2c';
  context.beginPath();
  context.arc(toX(here.x), toY(here.y), 5, 0, Math.PI * 2);
  context.fill();
};

/** Has the ball passed this point yet? Drawn as a growing arc rather than the whole parabola. */
const i0 = (x: number, t: number, total: number): boolean => x > (simulateX(t) || 0) && total > 0;
const simulateX = (t: number): number => t * 10;

/**
 * The controls, mounted once.
 *
 * Built here rather than by a framework: the SDK has zero runtime dependencies, and a simulation that
 * pulled in a renderer would be a simulation whose bundle budget belongs to somebody else's release
 * cycle.
 */
export function mountControls(container: HTMLElement, stepper: Stepper): void {
  const play = document.createElement('button');
  play.type = 'button';
  describeControl(play, 'Play', { pressed: false });
  const step = document.createElement('button');
  step.type = 'button';
  describeControl(step, 'Step forward one frame');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = String(stepper.get().maxTime);
  scrub.step = String(stepper.get().stepSize);
  describeControl(scrub, 'Time');
  container.append(play, step, scrub);
  focusEntryPoint(container);
}

export { createStepper, prefersReducedMotion };

/**
 * Boot the protocol half.  (P6-T9)
 *
 * ## WHY THIS LIVES AT THE BOTTOM OF THE RENDER ENTRY
 *
 * The manifest names one browser entry, and that entry is `src/browser.ts`. So the boot lives here rather
 * than in a second entry the build would have to be taught about. It is at the *bottom*, after the
 * exports, because a module-scope side effect above them would mean importing this file for its exports
 * mounts a simulation — which is what made it impossible to unit-test the render half.
 *
 * ## GUARDED, BECAUSE THIS FILE IS IMPORTED BY TESTS
 *
 * `document` is absent under Node. The guard is the only thing between a unit test of the renderer and
 * an uncaught `ReferenceError`.
 */
if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.parent !== window) {
  const boot = async (): Promise<void> => {
    try {
      const { startSim } = await import('./sim.js');
      startSim(document, window, window.parent);
    } catch (error) {
      // A simulation that dies during boot is silent by default: the frame shows an empty page and the
      // host waits out its handshake timeout with no idea why. Saying so — in the console AND to the
      // host as a recoverable error — is the difference between a five-minute fix and a day of it.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        '[sim] failed to start:',
        message,
        error instanceof Error ? error.stack : 'no stack',
      );
      try {
        window.parent.postMessage(
          { type: 'sim:error', code: 'INTERNAL', message, recoverable: true },
          '*',
        );
      } catch {
        // The host may already be gone. Nothing further to do, and swallowing is right here.
      }
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void boot();
    });
  } else {
    void boot();
  }
}
