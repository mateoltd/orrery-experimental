/**
 * The protocol half.  (P12-T2, card 135 `maths.integral-area`)
 *
 * ## MODALITY `canvas`, AND THE NON-VISUAL ROW IS THE LOAD-BEARING ONE
 *
 * The card: "Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that
 * produced it is a focusable `<input>`/`<button>` rather than a hit-test." So the rectangles are drawn and the
 * rectangles are also a table of `(x from, x to, f at left, f at right, width, area)`, and the running
 * accumulated area is a `<tfoot>` row. The canvas is decorative (`aria-hidden`) and the table is the truth.
 *
 * ## NOTHING HERE READS A CLOCK
 *
 * The curve animates by REFINING THE RECTANGLE COUNT, which is a declared integer, not an elapsed time. A
 * `requestAnimationFrame` loop with a `performance.now()` start would make the drawing a function of the host
 * clock, and the drawing and the grading request have to be the same picture (`INV-SIM-2`).
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  int,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  clamp,
  describeSums,
  exactIntegral,
  f,
  format,
  type IntegralParams,
  LOWER,
  leftSum,
  normaliseNumber,
  rightSum,
  UPPER,
} from './model.js';

const SIM_ID = 'maths.integral-area';
const SIM_VERSION = '1.0.0';
const PANEL = 260;

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  randomised: false,
  audio: false,
  webgl: false,
  stepper: false,
  scenarios: [],
};

const PARAM_SPECS = {
  rectangles: int({ name: 'rectangles', label: 'Rectangles', min: 2, max: 64, default: 8 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): IntegralParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({ rectangles: Number(values.rectangles) });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root_ = document_.getElementById('sim-root') ?? document_.body;
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => errors.push(String(event.message)));

  let params = paramsFrom({});

  const heading = document_.createElement('h2');
  heading.id = 'sim-question';
  const canvas = document_.createElement('canvas');
  canvas.id = 'sim-canvas';
  const table = document_.createElement('table');
  table.id = 'sim-rectangles';
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  root_.append(heading, canvas, table, controls, status, alternative);
  // THE CANVAS IS DECORATIVE. Everything it draws is in the table below it, so hiding it from assistive
  // technology removes a duplicate reading rather than removing the content.
  canvas.setAttribute('aria-hidden', 'true');

  const field = (id: string, labelText: string): HTMLInputElement => {
    const input = document_.createElement('input');
    input.type = 'text';
    input.id = id;
    const label = document_.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const wrapper = document_.createElement('div');
    wrapper.append(label, input);
    return input;
  };

  const leftField = field('sim-left-sum', 'Left-endpoint sum');
  const rightField = field('sim-right-sum', 'Right-endpoint sum');
  const areaField = field('sim-signed-area', 'Signed area');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');

  const refine = document_.createElement('button');
  refine.type = 'button';
  refine.id = 'sim-refine';
  describeControl(refine, 'Double the number of rectangles');

  controls.append(leftField, rightField, areaField, refine, submit);
  let connection: SimConnection | null = null;

  const draw = (): void => {
    const width = root_.clientWidth || 640;
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PANEL);
    const n = params.rectangles;
    const width_ = (UPPER - LOWER) / n;
    const pad = 24;
    const plotWidth = width - pad * 2;
    const plotHeight = PANEL - pad * 2;
    const scaleY = plotHeight / 2.5;
    const xAt = (x: number): number => pad + ((x - LOWER) / (UPPER - LOWER)) * plotWidth;
    const yAt = (y: number): number => PANEL - pad - (y + 1.25) * scaleY;

    // THE AXIS, drawn at y = 0, because the whole point is that most of the curve is BELOW it.
    context.strokeStyle = '#9b2c2c';
    context.beginPath();
    context.moveTo(pad, yAt(0));
    context.lineTo(width - pad, yAt(0));
    context.stroke();

    context.strokeStyle = '#1f2933';
    context.beginPath();
    for (let i = 0; i <= 200; i += 1) {
      const x = LOWER + ((UPPER - LOWER) * i) / 200;
      if (i === 0) context.moveTo(xAt(x), yAt(f(x)));
      else context.lineTo(xAt(x), yAt(f(x)));
    }
    context.stroke();

    // RECTANGLES DRAWN FROM THE ZERO LINE, signed: a rectangle below the axis is drawn downwards, because a
    // positive-height rectangle in that place would be a different drawing of the same number.
    for (let i = 0; i < n; i += 1) {
      const height = f(LOWER + i * width_) * scaleY;
      context.fillStyle = height >= 0 ? '#dbe4ee' : '#f6d7d7';
      context.fillRect(
        xAt(LOWER + i * width_),
        Math.min(yAt(0), yAt(LOWER + i * width_) - height),
        plotWidth / n - 1,
        Math.abs(height),
      );
      context.strokeStyle = '#2b6cb0';
      context.strokeRect(
        xAt(LOWER + i * width_),
        Math.min(yAt(0), yAt(LOWER + i * width_) - height),
        plotWidth / n - 1,
        Math.abs(height),
      );
    }
  };

  const renderTable = (): void => {
    const n = params.rectangles;
    const width_ = (UPPER - LOWER) / n;
    table.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent =
      `Every rectangle, left to right, for ${String(n)} rectangles of width ${format(width_)}. The ` +
      'height is the value of the curve at the LEFT end, which is what makes the first sum a left-endpoint ' +
      'sum rather than a rectangle area.';
    table.append(caption);
    const head = document_.createElement('tr');
    for (const label of ['Rectangle', 'From x', 'To x', 'Height (left end)', 'Signed area']) {
      const cell = document_.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.append(cell);
    }
    const thead = document_.createElement('thead');
    const headRow = document_.createElement('tr');
    headRow.append(head);
    thead.append(headRow);
    table.append(thead);
    const tbody = document_.createElement('tbody');
    for (let i = 0; i < n; i += 1) {
      const tr = document_.createElement('tr');
      const from = LOWER + i * width_;
      for (const value of [
        String(i + 1),
        format(from),
        format(from + width_),
        format(f(from)),
        format(f(from) * width_),
      ]) {
        const cell = document_.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    const foot = document_.createElement('tfoot');
    const total = document_.createElement('tr');
    const label = document_.createElement('th');
    label.scope = 'row';
    label.textContent = 'Left sum';
    const value = document_.createElement('td');
    value.colSpan = 4;
    value.textContent = format(leftSum(n));
    total.append(label, value);
    foot.append(total);
    table.append(foot);
  };

  const refresh = (): void => {
    heading.textContent = `y = x² − 2 on [${String(LOWER)}, ${String(UPPER)}] with ${String(params.rectangles)} rectangles`;
    draw();
    renderTable();
    alternative.textContent = describeSums(params);
    status.textContent = `Left ${format(leftSum(params.rectangles))}, right ${format(rightSum(params.rectangles))}, exact ${format(exactIntegral())}`;
  };

  refine.addEventListener('click', () => {
    const next = Math.min(64, params.rectangles * 2);
    restart({ rectangles: next });
    announce(
      status,
      `Now ${String(next)} rectangles. Left sum ${format(leftSum(next))}, right sum ${format(rightSum(next))}.`,
    );
  });

  submit.addEventListener('click', () => {
    // REPORTED AS NUMBERS, so the conformance cell can declare a RANGE for each field. `matches` in
    // `scripts/sim-conformance.mjs:381` returns false for a numeric expectation against a string answer,
    // which would have made a checked expectation impossible for this simulation.
    const number = (field_: HTMLInputElement): number => {
      const raw = normaliseNumber(field_.value.trim());
      // AN EMPTY BOX IS NOT A ZERO. `parseFloat('')` is NaN, which is what an unanswered field should be.
      return typeof raw === 'number' ? raw : Number.parseFloat(raw);
    };
    connection?.bridge?.reportAnswer(
      { leftSum: number(leftField), rightSum: number(rightField), signedArea: number(areaField) },
      { confidence: 1, explanation: describeSums(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: IntegralParams): void => {
    params = next;
    for (const input of [leftField, rightField, areaField]) input.value = '';
    refresh();
  };

  const handlers: BridgeHandlers = {
    onResize: () => refresh(),
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'focus') focusEntryPoint(root_);
    },
    onSetParams: (next) => restart(paramsFrom(next)),
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    onRestore: (state) => {
      if (state !== null && typeof state === 'object')
        restart(paramsFrom(state as Record<string, unknown>));
    },
    getState: () => ({ rectangles: params.rectangles }),
  };

  const transport = {
    post: (frame: unknown): void => parent?.postMessage(frame, '*'),
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
  focusEntryPoint(root_);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['leftSum', 'rightSum', 'midpointSum', 'exactIntegral', 'truncationError'],
  });

  return connection;
}
