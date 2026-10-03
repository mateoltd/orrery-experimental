/**
 * The protocol half.  (P6-T11, gold sim 4)
 *
 * The first gold sim whose answer CHANGES SHAPE with a parameter: `solveFor` is an enum, so the field the
 * student fills in is a different quantity from one moment to the next. The answer therefore carries its
 * own name, and the grader checks the name as well as the value.
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
  describeNewton,
  format,
  ignoredParam,
  isSolveFor,
  type NewtonParams,
  SOLVE_FOR,
  solve,
} from './model.js';

const SIM_ID = 'physics.newtons-second-law';
const SIM_VERSION = '1.0.0';
const PANEL = 200;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  force: num({ name: 'force', label: 'Net force', unit: 'N', min: 0, max: 60, default: 12 }),
  mass: num({ name: 'mass', label: 'Mass', unit: 'kg', min: 0.5, max: 20, default: 3 }),
  accel: num({ name: 'accel', label: 'Acceleration', unit: 'm/s²', min: 0.5, max: 20, default: 4 }),
  solveFor: choice({
    name: 'solveFor',
    label: 'Find the',
    values: ['acceleration', 'force', 'mass'],
    default: 'acceleration',
  }),
  showArrow: {
    name: 'showArrow',
    type: 'boolean' as const,
    label: 'Show the force arrow',
    default: true,
  },
};

const paramsFrom = (
  raw: Readonly<Record<string, unknown>>,
): NewtonParams & { showArrow: boolean } => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return {
    force: Number(values.force),
    mass: Number(values.mass),
    accel: Number(values.accel),
    solveFor: isSolveFor(values.solveFor) ? values.solveFor : 'acceleration',
    showArrow: values.showArrow === true,
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

  const physics = (): NewtonParams => ({
    force: params.force,
    mass: params.mass,
    accel: params.accel,
    solveFor: params.solveFor,
  });

  /**
   * A block and an arrow. Drawn from the numbers, so it cannot drift.
   *
   * Deliberately not a free-body diagram: this is one force on one mass, and drawing gravity as well
   * would need a second arrow and a "net" that the student has to work out. The point of the simulation
   * is `F = ma`, not free-body conventions.
   */
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

    const baseY = PANEL - 50;
    context.fillStyle = '#dbe4ee';
    context.fillRect(width / 2 - 50, baseY - 40, 100, 40);
    context.strokeStyle = '#1f2933';
    context.lineWidth = 3;
    context.strokeRect(width / 2 - 50, baseY - 40, 100, 40);
    context.fillStyle = '#1f2933';
    context.font = '14px system-ui, sans-serif';
    context.fillText(`${format(params.mass)} kg`, width / 2 - 22, baseY - 16);

    if (params.showArrow && params.force > 0) {
      const length = Math.min(30 + params.force * 2, width / 2 - 70);
      context.strokeStyle = '#9b2c2c';
      context.lineWidth = 5;
      context.beginPath();
      context.moveTo(width / 2 + 50, baseY - 20);
      context.lineTo(width / 2 + 50 + length, baseY - 20);
      context.stroke();
      context.fillStyle = '#9b2c2c';
      context.beginPath();
      context.moveTo(width / 2 + 50 + length, baseY - 20);
      context.lineTo(width / 2 + 50 + length - 12, baseY - 28);
      context.lineTo(width / 2 + 50 + length - 12, baseY - 12);
      context.closePath();
      context.fill();
      context.fillText(`${format(params.force)} N`, width / 2 + 56, baseY - 30);
    }

    const wanted = solve(physics());
    const ignored = ignoredParam(params.solveFor);
    context.fillStyle = '#1f2933';
    context.fillText(`F = ma  ·  find the ${wanted.name.toLowerCase()}`, 12, 20);
    // Which dial is NOT needed, said plainly. A panel showing three numbers with no indication of which
    // two are the givens is a panel that invites the student to use the wrong pair.
    context.fillText(
      ignored === 'mass'
        ? `given: ${format(params.force)} N and ${format(params.accel)} m/s²`
        : ignored === 'force'
          ? `given: ${format(params.mass)} kg and ${format(params.accel)} m/s²`
          : `given: ${format(params.force)} N and ${format(params.mass)} kg`,
      12,
      40,
    );
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeNewton(physics());
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  // One field and one select. The select is the parameter made visible, so a student can see WHICH
  // quantity they are being asked for rather than inferring it from a label.
  const selector = document_.createElement('select');
  selector.id = 'sim-solve-for';
  selector.setAttribute('aria-label', 'which quantity to find');
  for (const option of SOLVE_FOR) {
    const element = document_.createElement('option');
    element.value = option;
    element.textContent = option;
    selector.append(element);
  }
  const field = document_.createElement('input');
  field.type = 'number';
  field.step = '0.1';
  field.id = 'sim-value';
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(selector, field, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  const relabel = (): void => {
    const wanted = solve(physics());
    field.setAttribute('aria-label', `${wanted.name} in ${wanted.unit}`);
    field.id = 'sim-value';
    status.textContent = `Find the ${wanted.name.toLowerCase()} (${wanted.unit})`;
  };
  selector.addEventListener('change', () => {
    params = { ...params, solveFor: isSolveFor(selector.value) ? selector.value : params.solveFor };
    field.value = '';
    relabel();
    announce(status, status.textContent ?? '');
    refresh();
  });
  submit.addEventListener('click', () => {
    const wanted = solve(physics());
    const raw = field.value.trim();
    // The answer names its quantity. A grader that assumed one shape would award full marks for a
    // correctly-computed acceleration when the question was about mass.
    const answer = { quantity: params.solveFor, value: raw === '' ? Number.NaN : Number(raw) };
    connection?.bridge?.reportAnswer(answer, {
      confidence: 1,
      explanation: `${wanted.name}: ${wanted.value === null ? 'no value' : format(wanted.value)} ${wanted.unit}`,
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: ReturnType<typeof paramsFrom>): void => {
    params = next;
    selector.value = params.solveFor;
    field.value = '';
    relabel();
    refresh();
  };

  const snapshot = (): Record<string, unknown> => ({
    force: params.force,
    mass: params.mass,
    accel: params.accel,
    solveFor: params.solveFor,
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      // `loadScenario` gets a real meaning: "find the mass", which is the rearrangement a textbook
      // problem usually wants and the one this sim exists to demonstrate.
      if (name === 'loadScenario') {
        restart(paramsFrom({ force: 24, mass: 4, accel: 6, solveFor: 'mass' }));
        return;
      }
    },
    onSetParams: (next) => {
      restart(paramsFrom(next));
    },
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

  selector.value = params.solveFor;
  relabel();
  refresh();
  focusEntryPoint(root);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['acceleration', 'force', 'mass', 'solve'],
  });

  return connection;
}
