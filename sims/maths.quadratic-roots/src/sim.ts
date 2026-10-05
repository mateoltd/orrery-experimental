/**
 * The protocol half.  (P6-T11, gold sim 7)
 *
 * TWO boxes, because the answer has two parts — and leaving both empty is how a student says "there are no
 * real roots". An empty pair is an ANSWER here, not an unfinished question, and the grader is written to
 * agree.
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
  describeQuadratic,
  discriminant,
  format,
  type QuadraticParams,
  roots,
  vertex,
} from './model.js';

const SIM_ID = 'maths.quadratic-roots';
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
  a: num({ name: 'a', label: 'x² coefficient', unit: '', min: -5, max: 5, default: 1 }),
  b: num({ name: 'b', label: 'x coefficient', unit: '', min: -12, max: 12, default: -4 }),
  c: num({ name: 'c', label: 'constant', unit: '', min: -12, max: 12, default: 3 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): QuadraticParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return { a: Number(values.a), b: Number(values.b), c: Number(values.c) };
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

  /** Drawn from the same numbers the grader uses, so the picture cannot show a different curve. */
  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.id = 'sim-canvas';
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null || params.a === 0) return;
    context.clearRect(0, 0, width, PANEL);

    const span = 6;
    const toX = (x: number): number => ((x + span) / (2 * span)) * width;
    const toY = (y: number): number => PANEL / 2 - (y / (span * 1.5)) * (PANEL / 2);

    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, toY(0));
    context.lineTo(width, toY(0));
    context.moveTo(toX(0), 0);
    context.lineTo(toX(0), PANEL);
    context.stroke();

    context.strokeStyle = '#9b2c2c';
    context.lineWidth = 3;
    context.beginPath();
    for (let step = -span; step <= span; step += 0.05) {
      const x = toX(step);
      const y = toY(params.a * step * step + params.b * step + params.c);
      if (step === -span) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();

    const found = roots(params);
    if (found !== null) {
      context.fillStyle = '#0b6b8a';
      for (const root of found) {
        if (Math.abs(root) > span) continue;
        context.beginPath();
        context.arc(toX(root), toY(0), 5, 0, Math.PI * 2);
        context.fill();
      }
    }
    const top = vertex(params);
    context.fillStyle = '#52606d';
    context.font = '13px system-ui, sans-serif';
    context.fillText(`discriminant ${format(discriminant(params))}`, 10, 18);
    context.fillText(`vertex (${format(top.x)}, ${format(top.y)})`, 10, 36);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeQuadratic(params);
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const first = document_.createElement('input');
  first.type = 'number';
  first.step = '0.1';
  first.id = 'sim-root-one';
  first.setAttribute('aria-label', 'the first root');
  const second = document_.createElement('input');
  second.type = 'number';
  second.step = '0.1';
  second.id = 'sim-root-two';
  second.setAttribute('aria-label', 'the second root, or leave empty if there is only one');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const clear = document_.createElement('button');
  clear.type = 'button';
  clear.id = 'sim-clear';
  describeControl(clear, 'Clear both boxes');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(first, second, submit, clear);
  root.append(controls);

  let connection: SimConnection | null = null;

  clear.addEventListener('click', () => {
    first.value = '';
    second.value = '';
    status.textContent = 'Both boxes cleared — leave them empty if there are no real roots.';
    announce(status, status.textContent ?? '');
  });
  submit.addEventListener('click', () => {
    const one = first.value.trim();
    const two = second.value.trim();
    const entered = [one, two].filter((part) => part.length > 0);
    // Both empty means "no real roots", which is an answer. One empty means one root, which is also an
    // answer. A `Number('')` here would be 0, and 0 is a plausible-looking root nobody gave.
    const answer = entered.length === 0 ? null : { roots: entered.map((part) => Number(part)) };
    connection?.bridge?.reportAnswer(answer, {
      confidence: 1,
      explanation: describeQuadratic(params),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: QuadraticParams): void => {
    params = next;
    first.value = '';
    second.value = '';
    refresh();
  };

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
      if (name === 'loadScenario') {
        // A parabola that never crosses: the case where leaving BOTH boxes empty is correct.
        restart(paramsFrom({ a: 1, b: 0, c: 4 }));
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
    // THE STUDENT'S SAVED WORK.
    //
    // `sim:init` carries `initialState` and this simulation now reads it, which it did not: a student who
    // saved an attempt, closed the tab and came back found the simulation reset to its opening position,
    // on a page that rendered perfectly. The conformance cell that checks this found sixteen simulations
    // that ignored it, and this is one of them no longer.
    onRestore: (state) => {
      if (state !== null && typeof state === 'object') {
        const s = state as Record<string, unknown>;
        restart(paramsFrom({ a: Number(s.a), b: Number(s.b), c: Number(s.c) }));
      }
    },
    getState: () => ({ a: params.a, b: params.b, c: params.c }),
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
    exports: ['roots', 'discriminant', 'vertex'],
  });

  return connection;
}
