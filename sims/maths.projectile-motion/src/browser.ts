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
  },
  params: {
    speed: num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    angle: num({ min: 5, max: 85, default: 45, unit: 'degrees' }),
    gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s2' }),
  },
  controls: { stepper: true, stepSize: 1 / 60, scenarios: ['no-air'], maxTime: 30 },
  accessibility: {
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
      return tolerance(0, 0, { abs: 0, maxPoints: 4, rationale: 'no range was submitted' });
    }
    return tolerance(submitted.range, range(params), {
      abs: 0.5,
      rel: 0.02,
      maxPoints: 4,
      partialCredit: true,
    });
  },

  render: (ctx: RenderContext<{ t: number }>) => {
    const root = document.querySelector('.orrery-sim');
    if (root === null) return;
    const canvas = root.querySelector('canvas');
    const readout = root.querySelector<HTMLElement>('.orrery-sim__readout');
    const text = root.querySelector<HTMLElement>('.orrery-sim__text');

    const { values } = clampParams({ ...PARAMS }, ctx.params as ParamValues);
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

const announceRegion = (ctx: RenderContext<{ t: number }>): void => {
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
