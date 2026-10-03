/**
 * The protocol half.  (P6-T11, gold sim 5)
 *
 * The answer is a NAME rather than a number, which is the first sim to ask a student to type a word. The
 * field therefore accepts a side letter, a side name, or several separated by commas — because refusing
 * "12" or "hyp" would be pedantry dressed as rigour.
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
  angles,
  describeTriangle,
  format,
  isTriangle,
  rightAngles,
  type TriangleParams,
} from './model.js';

const SIM_ID = 'maths.pythagoras';
const SIM_VERSION = '1.0.0';
const PANEL = 240;

const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  a: num({ name: 'a', label: 'Side a', unit: '', min: 1, max: 20, default: 3 }),
  b: num({ name: 'b', label: 'Side b', unit: '', min: 1, max: 20, default: 4 }),
  c: num({ name: 'c', label: 'Side c', unit: '', min: 1, max: 30, default: 5 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): TriangleParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return { a: Number(values.a), b: Number(values.b), c: Number(values.c), giveLengths: true };
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

  /**
   * A labelled triangle, drawn to scale.
   *
   * To scale because a triangle drawn NOT to scale is the single most common way a diagram teaches the
   * opposite of the truth — and this simulation exists to be looked at.
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

    if (!isTriangle(params)) {
      context.fillStyle = '#9b2c2b';
      context.font = '14px system-ui, sans-serif';
      context.fillText('These lengths cannot make a triangle.', 12, 24);
      return;
    }

    const scale = Math.min(width - 60, PANEL - 50) / Math.max(params.a + params.b + params.c, 1);
    const x0 = 20;
    const y0 = PANEL - 24;
    // Angle `A` at the origin, `B` along the base, `C` wherever the side lengths put it.
    const xb = x0 + params.b * scale;
    const ac = params.c * scale;
    const ab = params.a * scale;
    const theta = Math.acos(
      Math.min(
        1,
        Math.max(-1, (params.b ** 2 + params.c ** 2 - params.a ** 2) / (2 * params.b * params.c)),
      ),
    );
    const xc = x0 + ac * Math.cos(theta);
    const yc = y0 - ac * Math.sin(theta);
    void ab;

    context.strokeStyle = '#1f2933';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(x0, y0);
    context.lineTo(xb, y0);
    context.lineTo(xc, yc);
    context.closePath();
    context.stroke();

    const right = rightAngles(params);
    context.fillStyle = '#0b6b8a';
    context.font = '14px system-ui, sans-serif';
    context.fillText(`a = ${format(params.a)}`, x0 - 4, y0 - 12);
    context.fillText(`b = ${format(params.b)}`, xb - 12, y0 + 16);
    context.fillText(`c = ${format(params.c)}`, xc + 6, yc - 6);
    for (const entry of right) {
      const at = entry.angle === 'a' ? [x0, y0] : entry.angle === 'b' ? [xb, y0] : [xc, yc];
      context.fillStyle = '#0b6b8a';
      context.fillRect(at[0] ?? 0, (at[1] ?? 0) - 12, 8, 8);
    }
    const deg = angles(params);
    context.fillStyle = '#52606d';
    context.fillText(`A ${format(deg.a)}°   B ${format(deg.b)}°   C ${format(deg.c)}°`, 12, 20);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeTriangle(params);
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const field = document_.createElement('input');
  field.type = 'text';
  field.id = 'sim-longest';
  field.setAttribute('aria-label', 'the longest side: a letter or a name, comma separated');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const help = document_.createElement('button');
  help.type = 'button';
  help.id = 'sim-help';
  describeControl(help, 'Show an example answer');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(field, submit, help);
  root.append(controls);

  let connection: SimConnection | null = null;

  help.addEventListener('click', () => {
    field.value = 'c';
    status.textContent = 'An answer looks like "c" or "hypotenuse".';
    announce(status, status.textContent ?? '');
  });
  submit.addEventListener('click', () => {
    // Split on commas AND spaces, so "a or b", "a, b" and "a b" are all the same two answers.
    const raw = field.value.trim();
    const names = raw
      .split(/[\s,]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    connection?.bridge?.reportAnswer(
      { name: names.length === 1 ? names[0] : names },
      {
        confidence: 1,
        explanation: describeTriangle(params),
      },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: TriangleParams): void => {
    params = next;
    field.value = '';
    refresh();
  };

  const snapshot = (): Record<string, unknown> => ({ a: params.a, b: params.b, c: params.c });

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
        // Two sides of 6 against one of 5, so there are TWO longest and either answer is correct — the
        // case set grading exists for. An isosceles RIGHT triangle (5, 5, 7.07) was the first choice and
        // is not that case at all: the hypotenuse is longest on its own.
        restart(paramsFrom({ a: 6, b: 6, c: 5 }));
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
    exports: ['isTriangle', 'isRightTriangle', 'rightAngles', 'angles', 'order'],
  });

  return connection;
}
