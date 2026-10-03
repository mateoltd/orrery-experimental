/**
 * The protocol half.  (P6-T11, gold sim 9)
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import { type ConcentrationParams, describeConcentration, format } from './model.js';

const SIM_ID = 'chem.mole-concentration';
const SIM_VERSION = '1.0.0';
const PANEL = 190;

const CAPABILITIES: SimCapabilities = { grading: true };

const PARAM_SPECS = {
  buretteCm: num({
    name: 'buretteCm',
    label: 'Burette reading',
    unit: 'cm',
    min: 0,
    max: 50,
    default: 23.4,
  }),
  flaskMl: num({
    name: 'flaskMl',
    label: 'Flask volume',
    unit: 'mL',
    min: 1,
    max: 1000,
    default: 250,
  }),
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const canvas = document_.createElement('canvas');
  const alternative = document_.createElement('p');
  const status = document_.createElement('p');
  const received: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;

  let params: ConcentrationParams = { buretteCm: 23.4, flaskMl: 250 };

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

    // The burette, drawn to scale so the reading is something the student LOOKS at.
    const tubeLeft = 40;
    const tubeWidth = 34;
    context.fillStyle = '#e4e7eb';
    context.fillRect(tubeLeft, 10, tubeWidth, PANEL - 40);
    context.strokeStyle = '#52606d';
    context.lineWidth = 1;
    context.strokeRect(tubeLeft, 10, tubeWidth, PANEL - 40);
    // The liquid, filled from the bottom of the tube.
    const level = 10 + (PANEL - 40) * (1 - params.buretteCm / 50);
    context.fillStyle = '#7b9acc';
    context.fillRect(tubeLeft + 1, level, tubeWidth - 2, PANEL - 30 - level);
    // Graduations every 5 cm, labelled every 10, because a burette is read against its own scale.
    context.fillStyle = '#1f2933';
    context.font = '11px system-ui, sans-serif';
    for (let mark = 0; mark <= 50; mark += 5) {
      const y = 10 + (PANEL - 40) * (1 - mark / 50);
      context.fillRect(tubeLeft - 6, y, 6, 1);
      if (mark % 10 === 0) context.fillText(String(mark), tubeLeft - 30, y + 4);
    }
    context.fillText('cm', tubeLeft - 30, 8);

    // The flask, so the dilution is visible as a volume and not only stated.
    const flaskX = width - 150;
    context.strokeStyle = '#52606d';
    context.beginPath();
    context.moveTo(flaskX + 40, 24);
    context.lineTo(flaskX + 40, 70);
    context.lineTo(flaskX + 96, PANEL - 26);
    context.lineTo(flaskX + 6, PANEL - 26);
    context.lineTo(flaskX + 62, 70);
    context.lineTo(flaskX + 62, 24);
    context.stroke();
    context.fillStyle = '#f0f4f8';
    context.fill();
    context.fillStyle = '#1f2933';
    context.fillText(`${format(params.flaskMl)} mL flask`, flaskX + 8, PANEL - 8);
    context.fillText('0.1 mol/L stock', flaskX + 8, 34);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeConcentration(params.buretteCm, params.flaskMl, 0.1);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const reading = document_.createElement('input');
  reading.type = 'number';
  reading.step = '0.1';
  reading.id = 'sim-burette';
  reading.setAttribute('aria-label', 'burette reading in centimetres');
  reading.value = String(params.buretteCm);
  const flask = document_.createElement('input');
  flask.type = 'number';
  flask.step = '1';
  flask.id = 'sim-flask';
  flask.setAttribute('aria-label', 'flask volume in millilitres');
  flask.value = String(params.flaskMl);
  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '0.000001';
  answer.id = 'sim-concentration';
  answer.setAttribute('aria-label', 'concentration in moles per litre');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(reading, flask, answer, submit);
  root.append(canvas, status, controls, alternative);

  let connection: SimConnection | null = null;

  const applyParams = (next: Partial<ConcentrationParams>): void => {
    params = { ...params, ...next };
    reading.value = String(params.buretteCm);
    flask.value = String(params.flaskMl);
    answer.value = '';
    refresh();
  };

  const numeric = (element_: HTMLInputElement, apply: (value: number) => void): void => {
    element_.addEventListener('input', () => {
      const value = Number(element_.value);
      if (Number.isFinite(value)) apply(value);
    });
  };
  numeric(reading, (value) => applyParams({ buretteCm: value }));
  numeric(flask, (value) => applyParams({ flaskMl: value }));
  submit.addEventListener('click', () => {
    const raw = answer.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeConcentration(params.buretteCm, params.flaskMl, 0.1),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'reset') applyParams({ buretteCm: 23.4, flaskMl: 250 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ buretteCm: Number(values.buretteCm), flaskMl: Number(values.flaskMl) });
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    getState: () => ({ buretteCm: params.buretteCm, flaskMl: params.flaskMl }),
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

  refresh();
  focusEntryPoint(root);
  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['concentration', 'toMillilitres'],
  });
  return connection;
}
