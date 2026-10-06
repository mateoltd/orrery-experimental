/**
 * The protocol half.  (P12-T2, card 8 `astronomy.tides`)
 *
 * ## MODALITY `canvas`, AND THE TABLE CARRIES THE SAME NUMBERS THE GRADER READS
 *
 * The card: "Every drawn quantity is mirrored in a real `<table>` beside the canvas". So the canvas is
 * `aria-hidden` and the high and low waters, the range and the resonance verdict are a real table with a
 * caption. The range on the table is `tidalRange(params)` from the model, not a measurement off the drawing,
 * so a picture that clips and a table that does not cannot disagree about the answer.
 *
 * ## THE SPRING AND NEAP TIDES ARE MARKED BY WHERE THEY FALL, NOT BY A LOOKUP
 *
 * The renderer finds the largest and smallest envelopes by sampling the same `height()` the marking key uses.
 * There is no `phase === 'new moon'` branch anywhere in this file or in the model, which is the point of the
 * card: the beat is what two close constituents do, and a rule would hide that.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  amplification,
  beatPeriodDays,
  clamp,
  describeTides,
  format,
  height,
  MAX_NATURAL,
  MIN_NATURAL,
  resonant,
  semidiurnalPeriod,
  T_M2,
  type TideParams,
  tidalRange,
} from './model.js';

const SIM_ID = 'astronomy.tides';
const SIM_VERSION = '1.0.0';
const PANEL = 240;

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
  natural: {
    type: 'number' as const,
    name: 'natural',
    label: 'Basin natural period',
    unit: 'h',
    min: MIN_NATURAL,
    max: MAX_NATURAL,
    default: T_M2,
  },
  hours: {
    type: 'number' as const,
    name: 'hours',
    label: 'Hours to plot',
    unit: 'h',
    min: 1,
    max: 720,
    default: 168,
  },
  phase: {
    type: 'number' as const,
    name: 'phase',
    label: 'Lunar phase, day of cycle',
    unit: 'd',
    min: 0,
    max: 29.53,
    default: 0,
  },
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): TideParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    natural: Number(values.natural),
    hours: Number(values.hours),
    phase: Number(values.phase),
  });
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
  canvas.setAttribute('aria-hidden', 'true');
  const table = document_.createElement('table');
  table.id = 'sim-extremes';
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  root_.append(heading, canvas, table, controls, status, alternative);

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

  const rangeField = field('sim-range', 'Tidal range, in metres');
  const periodField = field('sim-period', 'Semidiurnal period, in hours');
  const amplificationField = field(
    'sim-amplification',
    'Amplification of the dominant constituent',
  );
  const resonantField = field('sim-resonant', 'Is the basin near resonance? yes or no');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  controls.append(rangeField, periodField, amplificationField, resonantField, submit);
  let connection: SimConnection | null = null;

  /** The extremes, from the same `height()` the marking key uses, on a whole-minute grid. */
  const extremes = (): {
    high: { hours: number; level: number }[];
    low: { hours: number; level: number }[];
  } => {
    const step = 1 / 60;
    const high: { hours: number; level: number }[] = [];
    const low: { hours: number; level: number }[] = [];
    const count = Math.floor(params.hours / step);
    for (let i = 0; i <= count; i += 1) {
      const hours = i * step;
      const level = height({ ...params, hours });
      if (i === 0 || level >= levelOfLast(high, level)) {
        high.push({ hours, level });
        if (high.length > 4) high.shift();
      }
      if (i === 0 || level <= levelOfLast(low, level)) {
        low.push({ hours, level });
        if (low.length > 4) low.shift();
      }
    }
    return { high, low };
  };
  const levelOfLast = (list: { level: number }[], fallback: number): number =>
    list.length === 0 ? fallback : (list[list.length - 1]?.level ?? fallback);

  const draw = (found: ReturnType<typeof extremes>): void => {
    const width = root_.clientWidth || 640;
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PANEL);
    const pad = 24;
    const plotWidth = width - pad * 2;
    const plotHeight = PANEL - pad * 2;
    const levels = [...found.high, ...found.low].map((point) => point.level);
    const top = levels.length === 0 ? 1 : Math.max(...levels, 0.01);
    const bottom = levels.length === 0 ? -1 : Math.min(...levels, -0.01);
    const yAt = (level: number): number =>
      PANEL - pad - ((level - bottom) / (top - bottom || 1)) * plotHeight;

    context.strokeStyle = '#1f2933';
    context.beginPath();
    const steps = 400;
    for (let i = 0; i <= steps; i += 1) {
      const hours = (params.hours * i) / steps;
      const level = height({ ...params, hours });
      if (i === 0) context.moveTo(pad, yAt(level));
      else context.lineTo(pad + (plotWidth * i) / steps, yAt(level));
    }
    context.stroke();

    context.fillStyle = '#9b2c2c';
    for (const point of found.high) {
      context.beginPath();
      context.arc(
        pad + (plotWidth * point.hours) / Math.max(1, params.hours),
        yAt(point.level),
        3,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.fillStyle = '#2b6cb0';
    for (const point of found.low) {
      context.beginPath();
      context.arc(
        pad + (plotWidth * point.hours) / Math.max(1, params.hours),
        yAt(point.level),
        3,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  };

  const renderTable = (found: ReturnType<typeof extremes>): void => {
    table.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent =
      'The last four high waters and the last four low waters on the curve above, with their times and ' +
      'heights. The range is the difference between the highest and the lowest of them, and it is the ' +
      'number the grading key uses.';
    table.append(caption);
    const head = document_.createElement('tr');
    for (const label of ['Water', 'Time, hours', 'Height, metres']) {
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
    for (const [name, points] of [
      ['High water', found.high],
      ['Low water', found.low],
    ] as const) {
      for (const point of points) {
        const tr = document_.createElement('tr');
        for (const value of [name, format(point.hours, 2), format(point.level, 4)]) {
          const cell = document_.createElement('td');
          cell.textContent = value;
          tr.append(cell);
        }
        tbody.append(tr);
      }
    }
    table.append(tbody);
  };

  const refresh = (): void => {
    heading.textContent = `A basin's tide, natural period ${format(params.natural, 3)} h, over ${format(params.hours, 0)} h`;
    const found = extremes();
    draw(found);
    renderTable(found);
    alternative.textContent = describeTides(params);
    status.textContent = `Range ${format(tidalRange(params))} m, period ${format(semidiurnalPeriod(), 4)} h, amplification ${format(amplification(params.natural))}, resonant ${String(resonant(params.natural))}, spring/neap beat ${format(beatPeriodDays(), 2)} days.`;
  };

  submit.addEventListener('click', () => {
    const number = (field_: HTMLInputElement): number => {
      const raw = field_.value.trim();
      return raw === '' ? Number.NaN : Number(raw);
    };
    const yes = (field_: HTMLInputElement): boolean | null => {
      const text = field_.value.trim().toLowerCase();
      if (['yes', 'true', '1'].includes(text)) return true;
      if (['no', 'false', '0'].includes(text)) return false;
      return null;
    };
    connection?.bridge?.reportAnswer(
      {
        range: number(rangeField),
        period: number(periodField),
        amplification: number(amplificationField),
        resonant: yes(resonantField),
      },
      { confidence: 1, explanation: describeTides(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: TideParams): void => {
    params = next;
    for (const input of [rangeField, periodField, amplificationField, resonantField])
      input.value = '';
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
    getState: () => ({ natural: params.natural, hours: params.hours, phase: params.phase }),
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
    exports: ['height', 'tidalRange', 'amplification', 'resonant', 'beatPeriodDays'],
  });

  return connection;
}
