/**
 * The protocol half.  (P6-T11, gold sim 2)
 *
 * Same shape as `maths.projectile-motion`: `browser.ts` renders and boots, this file converses. Kept
 * deliberately identical in structure, because a second sim written differently is a second thing to learn,
 * and the SDK's job is to make the second one free.
 */

import {
  announce,
  type BridgeHandlers,
  bool,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import { describeLine, format, type LineParams, linePath, xIntercept, yAt } from './model.js';

const SIM_ID = 'maths.linear-functions';
const SIM_VERSION = '1.0.0';
const PLOT = 260;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  m: num({ name: 'm', label: 'Gradient', unit: '', min: -5, max: 5, default: 2 }),
  c: num({ name: 'c', label: 'y-intercept', unit: '', min: -5, max: 5, default: 1 }),
  span: num({ name: 'span', label: 'Axis range', unit: '', min: 2, max: 10, default: 5 }),
  showGrid: bool({ name: 'showGrid', label: 'Show grid', default: true }),
};

interface SimParams {
  readonly m: number;
  readonly c: number;
  readonly span: number;
  readonly showGrid: boolean;
}

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SimParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return {
    m: Number(values.m),
    c: Number(values.c),
    span: Number(values.span),
    showGrid: values.showGrid === true,
  };
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
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});
  let markerX: number | null = null;
  let revealed = false;

  const physics = (): LineParams => ({ m: params.m, c: params.c, span: params.span });

  const toX = (x: number): number =>
    ((x + params.span) / (2 * params.span)) * root.clientWidth || 0;
  const toY = (y: number): number => PLOT / 2 - (y / params.span) * (PLOT / 2);

  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.id = 'sim-canvas';
    canvas.width = width;
    canvas.height = PLOT;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PLOT)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PLOT);

    if (params.showGrid) {
      context.strokeStyle = '#e4e7eb';
      context.lineWidth = 1;
      for (let value = -params.span; value <= params.span; value += 1) {
        context.beginPath();
        context.moveTo(toX(value), 0);
        context.lineTo(toX(value), PLOT);
        context.moveTo(0, toY(value));
        context.lineTo(width, toY(value));
        context.stroke();
      }
    }

    // The axes, drawn heavier than the grid so "where is zero" is never a puzzle.
    context.strokeStyle = '#1f2933';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, toY(0));
    context.lineTo(width, toY(0));
    context.moveTo(toX(0), 0);
    context.lineTo(toX(0), PLOT);
    context.stroke();

    context.strokeStyle = '#9b2c2c';
    context.lineWidth = 3;
    context.beginPath();
    for (const point of linePath(physics())) {
      const px = toX(point.x);
      const py = toY(point.y);
      if (point.x === -params.span) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.stroke();

    const intercept = revealed ? xIntercept(physics()) : null;
    if (intercept !== null && Math.abs(intercept) <= params.span) {
      context.fillStyle = '#1f2933';
      context.beginPath();
      context.arc(toX(intercept), toY(0), 5, 0, Math.PI * 2);
      context.fill();
    }
    if (markerX !== null) {
      context.fillStyle = '#0b6b8a';
      context.beginPath();
      context.arc(toX(markerX), toY(yAt(physics(), markerX)), 6, 0, Math.PI * 2);
      context.fill();
    }
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeLine(physics());
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const intercept = document_.createElement('input');
  intercept.type = 'number';
  intercept.step = '0.1';
  intercept.id = 'sim-intercept';
  intercept.setAttribute('aria-label', 'x-intercept');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const step = document_.createElement('button');
  step.type = 'button';
  step.id = 'sim-step';
  describeControl(step, 'Mark the next point');
  const reveal = document_.createElement('button');
  reveal.type = 'button';
  reveal.id = 'sim-reveal';
  describeControl(reveal, 'Reveal the x-intercept');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(step, reveal, intercept, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  // "Step" walks the marker along the line. A straight line has no timeline, so a stepper would be a
  // decoration; what the student needs is to walk the line and read values off it.
  let cursor = -params.span;
  step.addEventListener('click', () => {
    cursor = Math.min(cursor + params.span / 4, params.span);
    markerX = cursor;
    status.textContent = `At x = ${format(cursor)}, y = ${format(yAt(physics(), cursor))}`;
    announce(status, status.textContent ?? '');
    refresh();
  });
  reveal.addEventListener('click', () => {
    revealed = !revealed;
    const value = xIntercept(physics());
    status.textContent =
      revealed && value !== null ? `Crosses at x = ${format(value)}` : 'Crossing hidden';
    announce(status, status.textContent ?? '');
    refresh();
  });
  submit.addEventListener('click', () => {
    const raw = intercept.value.trim();
    const answer = { xIntercept: raw === '' ? null : Number(raw) };
    connection?.bridge?.reportAnswer(answer, {
      confidence: 1,
      explanation: describeLine(physics()),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: SimParams): void => {
    params = next;
    markerX = null;
    revealed = false;
    cursor = -params.span;
    intercept.value = '';
    refresh();
  };

  const snapshot = (): Record<string, unknown> => ({ m: params.m, c: params.c, markerX, revealed });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'step') {
        cursor = Math.min(cursor + params.span / 4, params.span);
        markerX = cursor;
        refresh();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      // play, pause, loadScenario and setTheme have nothing to do to a straight line, and ignoring them
      // is the correct response: `plans/10` §2.3 rule 2 says a newer host against an older sim degrades.
    },
    onSetParams: (next) => {
      restart(paramsFrom(next));
    },
    // Empty on purpose: the SDK answers `sim:requestState` from `getState()`, and a handler that also
    // reported sent TWO `sim:state` frames per request.
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    getState: () => snapshot(),
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
    exports: ['xIntercept', 'yAt', 'linePath'],
  });

  return connection;
}
