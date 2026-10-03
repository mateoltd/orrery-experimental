/**
 * The protocol half.  (P6-T11, gold sim 3)
 *
 * Structurally identical to the other two gold sims, deliberately: a second simulation written differently
 * is a second thing to learn, and making that cheap is the SDK's job.
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
import {
  celsiusFromKelvin,
  describeGas,
  format,
  type GasParams,
  kelvinFromCelsius,
  R,
  temperature,
} from './model.js';

const SIM_ID = 'chem.ideal-gas-law';
const SIM_VERSION = '1.0.0';
const PANEL = 240;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  p: num({ name: 'p', label: 'Pressure', unit: 'kPa', min: 50, max: 300, default: 101.3 }),
  v: num({ name: 'v', label: 'Volume', unit: 'L', min: 1, max: 60, default: 22.4 }),
  n: num({ name: 'n', label: 'Amount', unit: 'mol', min: 0.1, max: 5, default: 1 }),
  showFormula: bool({ name: 'showFormula', label: 'Show the rearranged law', default: true }),
};

interface SimParams extends GasParams {
  readonly showFormula: boolean;
}

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SimParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return {
    p: Number(values.p),
    v: Number(values.v),
    n: Number(values.n),
    showFormula: values.showFormula === true,
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

  const physics = (): GasParams => ({ p: params.p, v: params.v, n: params.n });

  /**
   * A piston, because the relationship is a volume under a pressure.
   *
   * Drawn from the numbers rather than decorated: the cylinder's height is `n/V` scaled, so a student who
   * changes the amount of gas watches the piston rise. A picture that did not move with the sliders would
   * be a picture of a gas law.
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

    const left = 40;
    const right = width - 40;
    const top = 24;
    const bottom = PANEL - 24;
    context.strokeStyle = '#1f2933';
    context.lineWidth = 3;
    context.strokeRect(left, top, right - left, bottom - top);

    // Piston height from `n / V`, so the drawing and the arithmetic cannot drift.
    const fill = Math.min(Math.max((params.n / params.v) * 400, 0.05), 1);
    context.fillStyle = '#dbe4ee';
    context.fillRect(left, bottom - (bottom - top) * fill, right - left, (bottom - top) * fill);

    const kelvin = temperature(physics());
    context.fillStyle = '#9b2c2c';
    context.beginPath();
    context.arc((left + right) / 2, (top + bottom) / 2, 6, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#1f2933';
    context.font = '14px system-ui, sans-serif';
    context.fillText(`P = ${format(params.p)} kPa`, left, 16);
    context.fillText(`V = ${format(params.v)} L`, right - 120, 16);
    context.fillText(`n = ${format(params.n)} mol`, left, bottom + 18);
    context.fillText(
      `T = ${format(kelvin)} K  (${format(celsiusFromKelvin(kelvin))} °C)`,
      right - 200,
      bottom + 18,
    );
    if (params.showFormula) {
      context.fillText(`T = PV / nR,  R = ${R} J/(mol·K)`, left, top - 6);
    }
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeGas(physics());
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const kelvin = document_.createElement('input');
  kelvin.type = 'number';
  kelvin.step = '0.1';
  kelvin.id = 'sim-kelvin';
  kelvin.setAttribute('aria-label', 'temperature in kelvin');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const warm = document_.createElement('button');
  warm.type = 'button';
  warm.id = 'sim-warm';
  describeControl(warm, 'Show the temperature for 25 °C');
  const cold = document_.createElement('button');
  cold.type = 'button';
  cold.id = 'sim-cold';
  describeControl(cold, 'Show the temperature for 0 °C');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(warm, cold, kelvin, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  const showAt = (celsius: number): void => {
    kelvin.value = String(Math.round(kelvinFromCelsius(celsius) * 100) / 100);
    status.textContent = `${format(celsius)} °C is ${format(kelvinFromCelsius(celsius))} K`;
    announce(status, status.textContent ?? '');
  };
  warm.addEventListener('click', () => {
    showAt(25);
  });
  cold.addEventListener('click', () => {
    showAt(0);
  });
  submit.addEventListener('click', () => {
    const raw = kelvin.value.trim();
    // Empty is an answer of nothing, not a zero: `Number('')` is 0, and 0 K is absolute zero, which is
    // the sort of thing a student should have to mean rather than fall into by leaving a field blank.
    const answer = { kelvin: raw === '' ? Number.NaN : Number(raw) };
    connection?.bridge?.reportAnswer(answer, {
      confidence: 1,
      explanation: describeGas(physics()),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: SimParams): void => {
    params = next;
    kelvin.value = '';
    refresh();
  };

  const snapshot = (): Record<string, unknown> => ({ p: params.p, v: params.v, n: params.n });

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
      // `loadScenario` gets a documented meaning here rather than being ignored: the plan's vocabulary
      // has no `step`, and a straight `p = nRT/V` has no timeline to walk. A scenario sets a known state,
      // which is what a teacher would want from a button.
      if (name === 'loadScenario') {
        restart(paramsFrom({ p: 202.65, v: 22.4, n: 2 }));
        return;
      }
    },
    onSetParams: (next) => {
      restart(paramsFrom(next));
    },
    // Empty on purpose: the SDK answers `sim:requestState` from `getState()`.
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    // THE STUDENT'S SAVED WORK.
    //
    // `sim:init` carries `initialState` and this simulation now reads it, which it did not: a student who
    // saved an attempt, closed the tab and came back found the simulation reset to its opening position,
    // on a page that rendered perfectly. The conformance cell that checks this found sixteen simulations
    // that ignored it, and this is one of them no longer.
    onRestore: (state) => {
      if (state !== null && typeof state === 'object') {
        const s = state as Record<string, unknown>;
        restart(paramsFrom({ p: Number(s.p), v: Number(s.v), n: Number(s.n) }));
      }
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
    // Only what the module really has. An `exports` list is a claim the host can act on, so it is kept in
    // step with reality rather than listing the rearrangements a reader might expect.
    exports: ['temperature', 'kelvinFromCelsius', 'celsiusFromKelvin', 'R'],
  });

  return connection;
}
