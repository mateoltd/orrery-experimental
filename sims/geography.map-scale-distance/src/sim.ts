/**
 * The protocol half.  (P6-T11, gold sim 14)
 *
 * Declares three named SCENARIOS, because the scale is the thing being taught and a student should be
 * able to be shown the same route at three scales without the simulation being rebuilt.
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
import { describeScale, format, SCALES, type ScaleParams, scaleByName } from './model.js';

const SIM_ID = 'geography.map-scale-distance';
const SIM_VERSION = '1.0.0';
const PANEL = 170;

const CAPABILITIES: SimCapabilities = {
  grading: true,
  scenarios: ['25k', '50k', '250k'],
};

const PARAM_SPECS = {
  mapCm: num({ name: 'mapCm', label: 'On the map', unit: 'cm', min: 0.5, max: 20, default: 4 }),
  ratio: choice({
    name: 'ratio',
    label: 'Scale',
    values: [25_000, 50_000, 250_000],
    default: 50_000,
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

  let params: ScaleParams = { mapCm: 4, ratio: 50_000 };

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

    context.fillStyle = '#1f2933';
    context.font = '14px system-ui, sans-serif';
    context.fillText(`Scale 1:${String(params.ratio)}`, 12, 22);
    context.fillStyle = '#52606d';
    context.font = '12px system-ui, sans-serif';
    context.fillText(`1 cm on this map is ${String(params.ratio)} cm in real life.`, 12, 42);

    // The route, drawn to the measured length, with a ruler under it.
    const pixelsPerCm = Math.min(24, (width - 80) / 20);
    const routeWidth = Math.max(6, Number(params.mapCm) * pixelsPerCm);
    const top = 70;
    context.strokeStyle = '#0b6b8a';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(20, top);
    context.lineTo(20 + routeWidth, top);
    context.stroke();
    context.fillStyle = '#0b6b8a';
    context.beginPath();
    context.arc(20 + routeWidth, top, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#1f2933';
    context.fillText(`${format(params.mapCm)} cm on the map`, 20, top - 10);

    // A ruler, because the measurement is the input and the student should see it being taken.
    const rulerY = PANEL - 34;
    context.strokeStyle = '#9aa5b1';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(20, rulerY);
    context.lineTo(20 + 10 * pixelsPerCm, rulerY);
    context.stroke();
    for (let mark = 0; mark <= 10; mark += 1) {
      const x = 20 + mark * pixelsPerCm;
      context.beginPath();
      context.moveTo(x, rulerY);
      context.lineTo(x, rulerY - (mark % 5 === 0 ? 8 : 4));
      context.stroke();
      if (mark % 5 === 0) context.fillText(String(mark), x - 3, rulerY + 12);
    }
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeScale(params.mapCm, params.ratio);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const scenario = document_.createElement('select');
  scenario.id = 'sim-scenario';
  scenario.setAttribute('aria-label', 'the map scale');
  for (const entry of SCALES) {
    const option = document_.createElement('option');
    option.value = String(entry.ratio);
    option.textContent = entry.label;
    scenario.append(option);
  }
  const measured = document_.createElement('input');
  measured.type = 'number';
  measured.step = '0.1';
  measured.min = '0.5';
  measured.max = '20';
  measured.id = 'sim-mapcm';
  measured.setAttribute('aria-label', 'the distance measured on the map, in centimetres');
  measured.value = String(params.mapCm);
  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '0.01';
  answer.id = 'sim-realdistance';
  answer.setAttribute('aria-label', 'the real distance in kilometres');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit distance';
  describeControl(submit, 'Submit distance');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(scenario, measured, answer, submit);
  root.append(canvas, controls, status, alternative);

  let connection: SimConnection | null = null;

  const applyParams = (next: Partial<ScaleParams>): void => {
    params = { ...params, ...next };
    scenario.value = String(params.ratio);
    measured.value = String(params.mapCm);
    answer.value = '';
    refresh();
  };

  scenario.addEventListener('change', () => applyParams({ ratio: Number(scenario.value) }));
  measured.addEventListener('input', () => {
    const value = Number(measured.value);
    if (Number.isFinite(value) && value > 0) applyParams({ mapCm: value });
  });
  submit.addEventListener('click', () => {
    const raw = answer.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeScale(params.mapCm, params.ratio),
    });
    status.textContent = 'Distance submitted';
    announce(status, 'Distance submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name, args) => {
      // The named scenarios are the SCALES, so a host can move a student between them without knowing the
      // numbers -- which is the whole reason `capabilities.scenarios` carries names and not values.
      if (name === 'loadScenario') {
        // `frame.name` IS the command, so `args.name` can never be the scenario -- reading it is how
        // this simulation looked for a situation called "loadScenario" and correctly refused to find one.
        // The scenario name is `args.scenario`, as `plans/10` §2.3 describes.
        const wanted = String(args.scenario ?? args.id ?? args.value ?? '');
        // Matched BY NAME. The first version stripped the non-digits off both sides to compare numbers,
        // which turns `1:250 000` into `1250000` and `250k` into `250` -- so the scenario the manifest
        // declared was silently refused and the simulation stayed on 1:50 000.
        const entry = scaleByName(wanted);
        if (entry === null || entry === undefined) {
          status.textContent = `There is no map scale called "${wanted}". The scales are ${SCALES.map((s) => s.name).join(', ')}.`;
          announce(status, status.textContent ?? '');
          return;
        }
        applyParams({ ratio: entry.ratio });
        return;
      }
      if (name === 'reset') applyParams({ mapCm: 4, ratio: 50_000 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ mapCm: Number(values.mapCm), ratio: Number(values.ratio) });
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    getState: () => ({ mapCm: params.mapCm, ratio: params.ratio }),
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
    exports: ['realDistanceKm', 'SCALES'],
  });
  return connection;
}
