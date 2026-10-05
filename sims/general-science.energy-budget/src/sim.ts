/**
 * The protocol half.  (P6-T11, gold sim 16)
 *
 * The bar is drawn as a SPLIT rather than as a fill, and the split is checked against conservation before
 * it is drawn: an impossible machine is refused rather than rendered.
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
  type Budget,
  budget,
  describeEnergy,
  type EnergyParams,
  format,
  isConserved,
} from './model.js';

const SIM_ID = 'general-science.energy-budget';
const SIM_VERSION = '1.0.0';
const PANEL = 150;

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
  inputJ: num({
    name: 'inputJ',
    label: 'Energy supplied',
    unit: 'J',
    min: 1,
    max: 1000000,
    step: 1,
    default: 1000,
  }),
  efficiency: num({
    name: 'efficiency',
    label: 'Efficiency',
    unit: '%',
    min: 5,
    max: 100,
    step: 1,
    default: 25,
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

  let params: EnergyParams = { inputJ: 1000, efficiency: 25 };

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

    const b = budget(params.inputJ, params.efficiency);

    // REFUSE TO DRAW AN IMPOSSIBLE MACHINE. A bar whose two halves do not fill it is a diagram of
    // something that cannot happen, and a student who trusts the diagram learns that energy is not
    // conserved -- which is the one thing this simulation exists to say that it is.
    if (!isConserved(b)) {
      context.fillStyle = '#9b2c2c';
      context.font = '13px system-ui, sans-serif';
      context.fillText('This budget does not conserve energy, so it is not drawn.', 12, 30);
      return;
    }

    const barX = 12;
    const barWidth = width - 24;
    const barY = 46;
    const barHeight = 28;
    const usefulWidth = barWidth * b.fraction;

    context.font = '13px system-ui, sans-serif';
    context.fillStyle = '#1f2933';
    context.fillText(`${format(b.inputJ)} J in, ${format(params.efficiency)}% useful`, barX, 26);

    // Useful work, then heat, filling the bar exactly between them.
    context.fillStyle = '#2f6f4f';
    context.fillRect(barX, barY, usefulWidth, barHeight);
    context.fillStyle = '#b45309';
    context.fillRect(barX + usefulWidth, barY, barWidth - usefulWidth, barHeight);
    context.strokeStyle = '#1f2933';
    context.lineWidth = 1;
    context.strokeRect(barX, barY, barWidth, barHeight);

    // The labels, and only where they fit: at 5% the useful label would not, and drawing it anyway means
    // writing text outside its own bar.
    context.fillStyle = '#ffffff';
    if (usefulWidth > 70) {
      context.fillText('useful work', barX + 6, barY + 18);
    }
    if (barWidth - usefulWidth > 70) {
      context.fillText('heat', barX + usefulWidth + 6, barY + 18);
    }
    context.fillStyle = '#52606d';
    context.fillText(
      `${format(b.usefulJ)} J useful + ${format(b.wastedJ)} J heat = ${format(b.usefulJ + b.wastedJ)} J`,
      barX,
      barY + 46,
    );
    context.fillStyle = '#1f2933';
    context.fillText('Energy is conserved: what goes in is what comes out.', barX, barY + 66);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeEnergy(params.inputJ, params.efficiency);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const input = document_.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.min = '1';
  input.id = 'sim-input';
  input.setAttribute('aria-label', 'energy supplied in joules');
  input.value = String(params.inputJ);
  const efficiency = document_.createElement('input');
  efficiency.type = 'number';
  efficiency.step = '1';
  efficiency.min = '5';
  efficiency.max = '100';
  efficiency.id = 'sim-efficiency';
  efficiency.setAttribute('aria-label', 'efficiency percentage');
  efficiency.value = String(params.efficiency);
  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '0.01';
  answer.id = 'sim-useful';
  answer.setAttribute('aria-label', 'useful energy in joules');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit energy';
  describeControl(submit, 'Submit energy');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(input, efficiency, answer, submit);
  root.append(canvas, controls, status, alternative);

  let connection: SimConnection | null = null;

  const applyParams = (next: Partial<EnergyParams>): void => {
    params = { ...params, ...next };
    input.value = String(params.inputJ);
    efficiency.value = String(params.efficiency);
    answer.value = '';
    refresh();
  };

  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (Number.isFinite(value) && value > 0) applyParams({ inputJ: value });
  });
  efficiency.addEventListener('input', () => {
    const value = Number(efficiency.value);
    if (Number.isFinite(value) && value > 0) applyParams({ efficiency: value });
  });
  submit.addEventListener('click', () => {
    const raw = answer.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeEnergy(params.inputJ, params.efficiency),
    });
    status.textContent = 'Energy submitted';
    announce(status, 'Energy submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'reset') applyParams({ inputJ: 1000, efficiency: 25 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ inputJ: Number(values.inputJ), efficiency: Number(values.efficiency) });
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
        const s = state as Record<string, unknown>;
        // The budget's own `fraction` is the efficiency, so a restored state carries the split the
        // student was looking at rather than a second, parallel notion of it.
        applyParams({ inputJ: Number(s.inputJ), efficiency: Number(s.fraction) * 100 });
      }
    },
    getState: (): Budget => budget(params.inputJ, params.efficiency),
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
    exports: ['budget', 'isConserved'],
  });
  return connection;
}
