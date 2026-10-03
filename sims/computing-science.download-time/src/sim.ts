/**
 * The protocol half.  (P6-T11, gold sim 15)
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
import {
  bitsPerSecond,
  bytes,
  type DownloadParams,
  describeDownload,
  format,
  seconds,
} from './model.js';

const SIM_ID = 'computing-science.download-time';
const SIM_VERSION = '1.0.0';
const PANEL = 150;

const CAPABILITIES: SimCapabilities = { grading: true };

const PARAM_SPECS = {
  sizeMb: num({
    name: 'sizeMb',
    label: 'File size',
    unit: 'MB',
    min: 0.1,
    max: 10_000,
    default: 100,
  }),
  speedMbps: num({
    name: 'speedMbps',
    label: 'Connection speed',
    unit: 'Mbit/s',
    min: 0.1,
    max: 10_000,
    default: 100,
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

  let params: DownloadParams = { sizeMb: 100, speedMbps: 100 };

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

    const total = seconds(params.sizeMb, params.speedMbps);
    context.font = '13px system-ui, sans-serif';
    context.fillStyle = '#1f2933';
    context.fillText(`${format(params.sizeMb)} MB at ${format(params.speedMbps)} Mbit/s`, 12, 20);
    // The two conversions, shown separately, because the whole question is the gap between them.
    context.fillStyle = '#52606d';
    context.fillText(
      `${format(bytes(params.sizeMb))} bytes = ${format(bytes(params.sizeMb) * 8)} bits`,
      12,
      38,
    );
    context.fillText(`${format(bitsPerSecond(params.speedMbps))} bits per second`, 12, 54);

    // A progress bar, empty. It is NOT filled to the answer -- the answer is the time, and filling the bar
    // would show the student the number they are being asked for.
    const barTop = 74;
    context.strokeStyle = '#9aa5b1';
    context.lineWidth = 1;
    context.strokeRect(12, barTop, width - 24, 22);
    context.fillStyle = '#e4e7eb';
    context.fillRect(13, barTop + 1, width - 26, 20);
    context.fillStyle = '#0b6b8a';
    context.fillText(
      Number.isFinite(total) ? `${format(total)} s of data to move` : 'undefined',
      12,
      barTop + 44,
    );
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeDownload(params.sizeMb, params.speedMbps);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const size = document_.createElement('input');
  size.type = 'number';
  size.step = '0.1';
  size.id = 'sim-size';
  size.setAttribute('aria-label', 'file size in megabytes');
  size.value = String(params.sizeMb);
  const speed = document_.createElement('input');
  speed.type = 'number';
  speed.step = '0.1';
  speed.id = 'sim-speed';
  speed.setAttribute('aria-label', 'connection speed in megabits per second');
  speed.value = String(params.speedMbps);
  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '1';
  answer.id = 'sim-seconds';
  answer.setAttribute('aria-label', 'the download time in seconds');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit time';
  describeControl(submit, 'Submit time');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(size, speed, answer, submit);
  root.append(canvas, controls, status, alternative);

  let connection: SimConnection | null = null;

  const applyParams = (next: Partial<DownloadParams>): void => {
    params = { ...params, ...next };
    size.value = String(params.sizeMb);
    speed.value = String(params.speedMbps);
    answer.value = '';
    refresh();
  };

  size.addEventListener('input', () => {
    const value = Number(size.value);
    if (Number.isFinite(value) && value > 0) applyParams({ sizeMb: value });
  });
  speed.addEventListener('input', () => {
    const value = Number(speed.value);
    if (Number.isFinite(value) && value > 0) applyParams({ speedMbps: value });
  });
  submit.addEventListener('click', () => {
    const raw = answer.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeDownload(params.sizeMb, params.speedMbps),
    });
    status.textContent = 'Time submitted';
    announce(status, 'Time submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'reset') applyParams({ sizeMb: 100, speedMbps: 100 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ sizeMb: Number(values.sizeMb), speedMbps: Number(values.speedMbps) });
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    // THE STUDENT'S SAVED WORK.
    //
    // `sim:init` carries `initialState` and this simulation now reads it, which it did not: a student who
    // saved an attempt, closed the tab and came back found the simulation reset to its opening position,
    // on a page that rendered perfectly. The conformance cell that checks this found sixteen simulations
    // that ignored it, and this is one of them no longer.
    onRestore: (state) => {
      if (state !== null && typeof state === 'object') {
        applyParams(state as Partial<DownloadParams>);
      }
    },
    getState: () => ({ sizeMb: params.sizeMb, speedMbps: params.speedMbps }),
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
    exports: ['seconds', 'bytes', 'bitsPerSecond'],
  });
  return connection;
}
