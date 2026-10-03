/**
 * The protocol half.  (P6-T11, gold sim 13)
 */

import {
  announce,
  type BridgeHandlers,
  choice,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import { describeParallax, format, type ParallaxParams, parsecs } from './model.js';

const SIM_ID = 'astronomy.parallax-distance';
const SIM_VERSION = '1.0.0';
const PANEL = 190;

const CAPABILITIES: SimCapabilities = { grading: true };

const PARAM_SPECS = {
  parallax: num({
    name: 'parallax',
    label: 'Annual parallax',
    unit: 'arcsec',
    min: 0.05,
    max: 2,
    default: 0.1,
  }),
  inLightYears: choice({
    name: 'inLightYears',
    label: 'Answer in light years',
    values: [false, true],
    default: false,
  }),
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const canvas = document_.createElement('canvas');
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');
  const received: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;

  let params: ParallaxParams = { parallax: 0.1, inLightYears: false };

  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.id = 'sim-canvas';
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PANEL);

    // The two OBSERVATIONS, and the angle between them. The star is drawn to the side; the Earth is not
    // drawn twice, because the whole measurement is the CHANGE in apparent position over half a year.
    const baseline = 40;
    const earthY = PANEL - 40;
    const span = width - 120;
    context.strokeStyle = '#9aa5b1';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(baseline, baseline);
    context.lineTo(baseline + span, earthY);
    context.stroke();

    context.fillStyle = '#1f2933';
    context.font = '13px system-ui, sans-serif';
    context.fillText(`Annual parallax: ${format(params.parallax)} arcsec`, baseline, 20);
    // "Larger parallax means closer", drawn as well as said.
    context.fillStyle = '#52606d';
    context.fillText('A bigger angle means a CLOSER star.', baseline, earthY + 24);

    // The angle, exaggerated: a real parallax is a fraction of a degree and would be invisible.
    const exaggerated = Math.min(1, Number(params.parallax) / 2) * 0.5 + 0.02;
    context.strokeStyle = '#0b6b8a';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(baseline + 20, baseline + 20);
    context.lineTo(baseline + 20 + span * exaggerated, baseline + 20 + 30 * exaggerated);
    context.stroke();
    context.beginPath();
    context.moveTo(baseline + 20, baseline + 20);
    context.lineTo(baseline + 20 + span * exaggerated, baseline + 20 - 30 * exaggerated);
    context.stroke();
    context.fillStyle = '#0b6b8a';
    context.beginPath();
    context.arc(baseline + 20, baseline + 20, 4, 0, Math.PI * 2);
    context.fill();
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeParallax(params.parallax, params.inLightYears === true);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const parallax = document_.createElement('input');
  parallax.type = 'number';
  parallax.step = '0.01';
  parallax.min = '0.05';
  parallax.max = '2';
  parallax.id = 'sim-parallax';
  parallax.setAttribute('aria-label', 'annual parallax in arcseconds');
  parallax.value = String(params.parallax);

  const units = document_.createElement('select');
  units.id = 'sim-units';
  units.setAttribute('aria-label', 'the unit to answer in');
  for (const [value, label] of [
    ['pc', 'parsecs'],
    ['ly', 'light years'],
  ]) {
    const option = document_.createElement('option');
    option.value = value;
    option.textContent = label;
    units.append(option);
  }

  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '0.01';
  answer.id = 'sim-distance';
  answer.setAttribute('aria-label', 'the distance');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit distance';
  describeControl(submit, 'Submit distance');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(parallax, units, answer, submit);
  root.append(canvas, controls, status, alternative);

  let connection: SimConnection | null = null;

  const applyParams = (next: Partial<ParallaxParams>): void => {
    params = { ...params, ...next };
    parallax.value = String(params.parallax);
    units.value = params.inLightYears === true ? 'ly' : 'pc';
    answer.value = '';
    refresh();
  };

  parallax.addEventListener('input', () => {
    const value = Number(parallax.value);
    if (Number.isFinite(value) && value > 0) applyParams({ parallax: value });
  });
  units.addEventListener('change', () => applyParams({ inLightYears: units.value === 'ly' }));
  submit.addEventListener('click', () => {
    const raw = answer.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeParallax(params.parallax, params.inLightYears === true),
    });
    status.textContent = 'Distance submitted';
    announce(status, 'Distance submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'reset') applyParams({ parallax: 0.1, inLightYears: false });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({
        parallax: Number(values.parallax),
        inLightYears: values.inLightYears === true || values.inLightYears === 'true',
      });
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    getState: () => ({
      parallax: parsecs(params.parallax),
      measured: params.parallax,
      unit: params.inLightYears === true ? 'light years' : 'parsecs',
    }),
  };

  const transport = {
    post: (frame: unknown): void => {
      parent?.postMessage(frame, '*');
    },
    subscribe: (handler: (frame: unknown, source: unknown) => void): (() => void) => {
      const listener = (event: MessageEvent): void => {
        const type = (event.data as { type?: unknown } | null)?.type;
        if (typeof type === 'string') received.push(type);
        handler(event.data, event.source);
      };
      window_.addEventListener('message', listener);
      return () => window_.removeEventListener('message', listener);
    },
  };

  applyParams({});
  focusEntryPoint(root);
  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['parsecs', 'lightYears'],
  });
  return connection;
}
