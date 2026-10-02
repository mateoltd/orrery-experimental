/**
 * The render layer. Browser only, inside the sandboxed frame.
 *
 * ## THE TEXT ALTERNATIVE IS NOT OPTIONAL AND NOT A COMMENT
 *
 * It is an element the host styles and the conformance suite checks is in the DOM. A canvas with no
 * text is invisible to a screen-reader user, to a student on a blocked network, and to anyone reading a
 * printed worksheet — and `defineSim` refuses a text alternative shorter than 20 characters.
 */

import {
  announce,
  clampParams,
  defineSim,
  focusEntryPoint,
  num,
  type ParamValues,
  type RenderContext,
  tolerance,
} from '@orrery/sim-sdk';
import {
  expected,
  initialState,
  MAX_TIME,
  type ModelParams,
  type ModelState,
  simulate,
} from './model.js';

export default defineSim({
  meta: { id: 'SUBJECT.slug', title: 'SUBJECT Title', version: '0.1.0', subjects: ['maths'] },
  params: { value: num({ min: 0, max: 100, default: 10, unit: 'm' }) },
  controls: { stepper: false, scenarios: [], maxTime: MAX_TIME },
  accessibility: {
    textAlternative:
      'REPLACE: the numbers this sentence quotes, which must match what the sim displays.',
    summary: 'REPLACE: one or two sentences for the catalogue and for a screen reader.',
    readyAnnouncement: 'SUBJECT Title ready.',
  },
  simulate: (params, state: ModelState) => simulate(params as ModelParams, state, state.t),
  grade: (_state: ModelState, params: ModelParams, answer: unknown) => {
    const submitted = answer as { value?: unknown } | null;
    const value = typeof submitted?.value === 'number' ? submitted.value : Number.NaN;
    return tolerance(value, expected(params as ModelParams), {
      abs: 0.5,
      rel: 0.02,
      maxPoints: 4,
      partialCredit: true,
    });
  },

  render: (ctx: RenderContext<ModelState>) => {
    const root = document.querySelector('.orrery-sim');
    if (root === null) return;
    // Params arrive from the host and are attacker-controlled in the same way any request body is.
    // `clampParams` is the only place they are trusted.
    const { values, coerced } = clampParams(PARAMS, ctx.params as ParamValues);
    const params = values as unknown as ModelParams;
    const point = simulate(params, initialState(), ctx.t);

    const readout = root.querySelector<HTMLElement>('.orrery-sim__readout');
    if (readout !== null)
      readout.textContent = `t = ${ctx.t.toFixed(2)} s · x = ${point.x.toFixed(1)} m`;
    // The alternative QUOTES the numbers on screen. A generic description stops being true the moment
    // a student moves a slider.
    const text = root.querySelector<HTMLElement>('.orrery-sim__text');
    if (text !== null)
      text.textContent = `At ${params.value} m the value reaches ${expected(params).toFixed(0)} m.`;

    const live = root.querySelector<HTMLElement>('.orrery-sim__live');
    // Announced on whole seconds only. A requestAnimationFrame loop announcing at 60 Hz is the
    // documented way to make a canvas unusable with a screen reader.
    if (live !== null && Math.floor(ctx.t) !== Math.floor(ctx.t - 1 / 60)) {
      announce(live, `${String(Math.floor(ctx.t))} seconds`);
    }
    void coerced;
  },

  mount: (ctx: RenderContext<ModelState>) => {
    const root = document.querySelector('.orrery-sim');
    if (root === null) return;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas');
    if (canvas !== null) {
      // Canvas is not focusable and announces nothing. `data-sim-entry` is what `focusEntryPoint`
      // looks for when `sim:readyForInput` arrives.
      canvas.setAttribute('data-sim-entry', '');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'A graph of value against time');
      draw(canvas, ctx.params as ParamValues);
    }
    focusEntryPoint(root);
  },
});

const PARAMS = { value: num({ min: 0, max: 100, default: 10, unit: 'm' }) };

const draw = (canvas: HTMLCanvasElement, raw: ParamValues): void => {
  const context = canvas.getContext('2d');
  if (context === null) return;
  const { values } = clampParams(PARAMS, raw);
  const params = values as unknown as ModelParams;
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#1f2933';
  context.beginPath();
  for (let i = 0; i <= 60; i += 1) {
    const t = (MAX_TIME * i) / 60;
    const point = simulate(params, initialState(), t);
    const x = 10 + (point.x / Math.max(1, params.value * MAX_TIME)) * (width - 20);
    const y = height - 20 - (point.y / Math.max(1, params.value * MAX_TIME)) * (height - 40);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
};
