/**
 * The protocol half.  (P6-T11, gold sim 8)
 *
 * The SCENARIO is the point of this simulation, so it is a visible control rather than a hidden default,
 * and `loadScenario` is implemented properly — including REFUSING a name the manifest does not list.
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
import {
  describeKinematics,
  displacement,
  findScenario,
  format,
  SCENARIOS,
  type Scenario,
} from './model.js';

const SIM_ID = 'physics.kinematics';
const SIM_VERSION = '1.0.0';
const PANEL = 200;

/** Declared because it is TRUE: the host chooses the situation, and the answers differ. */
const CAPABILITIES: SimCapabilities = {
  grading: true,
  stepper: false,
  scenarios: SCENARIOS.map((scenario) => scenario.name),
};

const PARAM_SPECS = {
  t: num({ name: 't', label: 'Time', unit: 's', min: 0.1, max: 5, default: 2 }),
  scenario: choice({
    name: 'scenario',
    label: 'Situation',
    values: ['dropped', 'thrown', 'rolled'],
    default: 'dropped',
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
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let scenario: Scenario = SCENARIOS[0] as Scenario;
  let t = 2;

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

    // Displacement against time, to the point the student has set. Negative means below the start.
    const span = Math.max(Math.abs(displacement(scenario, t)), Math.abs(scenario.u * 5), 1);
    const toX = (time: number): number => (time / 5) * width;
    const toY = (value: number): number => PANEL / 2 - (value / span) * (PANEL / 2.2);

    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, toY(0));
    context.lineTo(width, toY(0));
    context.stroke();

    context.strokeStyle = '#9b2c2c';
    context.lineWidth = 3;
    context.beginPath();
    for (let step = 0; step <= 5; step += 0.05) {
      const x = toX(step);
      const y = toY(displacement(scenario, step));
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();

    // The marker at the student's time, so the picture and the answer refer to the same instant.
    context.fillStyle = '#0b6b8a';
    context.beginPath();
    context.arc(toX(t), toY(displacement(scenario, t)), 5, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#1f2933';
    context.font = '13px system-ui, sans-serif';
    context.fillText(scenario.label, 10, 18);
    context.fillText(`t = ${format(t)} s`, 10, 36);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeKinematics(scenario, t);
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const picker = document_.createElement('select');
  picker.id = 'sim-scenario';
  picker.setAttribute('aria-label', 'the situation');
  for (const entry of SCENARIOS) {
    const option = document_.createElement('option');
    option.value = entry.name;
    option.textContent = entry.label;
    picker.append(option);
  }
  const time = document_.createElement('input');
  time.type = 'number';
  time.step = '0.1';
  time.min = '0.1';
  time.max = '5';
  time.id = 'sim-time';
  time.setAttribute('aria-label', 'time in seconds');
  const field = document_.createElement('input');
  field.type = 'number';
  field.step = '0.1';
  field.id = 'sim-distance';
  field.setAttribute('aria-label', 'how far it has moved, in metres');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(picker, time, field, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  const applyScenario = (name: unknown): boolean => {
    const found = findScenario(name);
    // `plans/10` §2.3: an unknown scenario name is a REFUSAL, not a fallback to a default. Silently
    // choosing one would put a student in a situation nobody asked for, with numbers that are wrong in a
    // way nothing reports.
    if (found === null) {
      status.textContent = `There is no situation called "${String(name)}". The choices are ${SCENARIOS.map((entry) => entry.name).join(', ')}.`;
      announce(status, status.textContent ?? '');
      return false;
    }
    scenario = found;
    picker.value = found.name;
    field.value = '';
    refresh();
    status.textContent = found.label;
    announce(status, found.label);
    return true;
  };

  picker.addEventListener('change', () => {
    applyScenario(picker.value);
  });
  time.addEventListener('input', () => {
    const parsed = Number(time.value);
    if (Number.isFinite(parsed) && parsed > 0) {
      t = parsed;
      refresh();
    }
  });
  submit.addEventListener('click', () => {
    const raw = field.value.trim();
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeKinematics(scenario, t),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'loadScenario') {
        applyScenario(args.name ?? args.scenario);
        return;
      }
      if (name === 'reset') {
        applyScenario('dropped');
        t = Number((args as { t?: unknown }).t ?? 2);
        time.value = String(t);
        refresh();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
      }
    },
    onSetParams: (next) => {
      // The scenario arrives here too, not only through `loadScenario`. A situation a teacher cannot set
      // as a parameter is a situation a server cannot grade from a stored state, and the two are the same
      // requirement seen from different ends.
      const record = next as Record<string, unknown>;
      if (record.scenario !== undefined) applyScenario(record.scenario);
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      const parsed = Number(values.t);
      if (Number.isFinite(parsed) && parsed > 0) t = parsed;
      time.value = String(t);
      field.value = '';
      refresh();
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    getState: () => ({ scenario: scenario.name, t }),
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

  picker.value = scenario.name;
  time.value = String(t);
  refresh();
  focusEntryPoint(root);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['displacement', 'SCENARIOS'],
  });

  return connection;
}
