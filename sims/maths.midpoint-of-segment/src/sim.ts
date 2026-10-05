/**
 * The protocol half.  (P6-T11, gold sim 17)
 *
 * ## THE TWO BOXES ARE ORDERED, AND THE LABEL SAYS SO
 *
 * `x` comes first and `y` second, and each box is labelled with its own coordinate rather than "first
 * number". A student who has to work out which box is which is being asked two questions, and a
 * coordinate grid is what makes the pair legible.
 *
 * ## THE SEGMENT IS DRAWN WITH ITS MIDPOINT MARKED, BUT NOT ITS NAME
 *
 * The midpoint dot is drawn, because a picture of a segment with no mark on it makes the student
 * reconstruct the geometry before doing any arithmetic. It is drawn WITHOUT a coordinate label, because the
 * label is the answer and the answer is what is being assessed. The dot is a drawing of the task, not a
 * solution to it.
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
import { describeSegment, format, midpoint, type Segment } from './model.js';

const SIM_ID = 'maths.midpoint-of-segment';
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
  x1: num({ name: 'x1', label: 'first x', unit: '', min: -20, max: 20, default: -4 }),
  y1: num({ name: 'y1', label: 'first y', unit: '', min: -20, max: 20, default: 7 }),
  x2: num({ name: 'x2', label: 'second x', unit: '', min: -20, max: 20, default: 2 }),
  y2: num({ name: 'y2', label: 'second y', unit: '', min: -20, max: 20, default: -1 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): Segment => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return {
    x1: Number(values.x1),
    y1: Number(values.y1),
    x2: Number(values.x2),
    y2: Number(values.y2),
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

  /** Drawn from the same numbers the grader uses, so the picture cannot show a different segment. */
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

    // The span is chosen from the SEGMENT, not fixed at 6, so a segment near (-20, 20) is still drawn
    // across the panel instead of as a dot in one corner. A fixed span worked for every previous simulation
    // because every previous one grew its answer outward from the origin.
    const xs = [params.x1, params.x2];
    const ys = [params.y1, params.y2];
    // THE SPREAD IS LAST, deliberately. `Math.max(...xs, 4)` puts a spread before a positional argument,
    // which is not a legal call -- a rest parameter has to end the argument list -- so this is one of the
    // few places where reordering the arguments is the whole fix rather than a preference.
    const halfX = Math.max(4, ...xs.map(Math.abs)) * 1.35;
    const halfY = Math.max(4, ...ys.map(Math.abs)) * 1.35;
    const toX = (x: number): number => width / 2 + (x / halfX) * (width / 2);
    const toY = (y: number): number => PANEL / 2 - (y / halfY) * (PANEL / 2);

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
    context.moveTo(toX(params.x1), toY(params.y1));
    context.lineTo(toX(params.x2), toY(params.y2));
    context.stroke();

    const centre = midpoint(params);
    // THE DOT IS THE TASK, NOT THE ANSWER. No coordinate is printed beside it: a labelled dot hands over
    // both halves of the answer and the simulation would be marking reading, not averaging.
    context.fillStyle = '#0b6b8a';
    context.beginPath();
    context.arc(toX(centre.x), toY(centre.y), 5, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#52606d';
    context.font = '13px system-ui, sans-serif';
    context.fillText('P and Q', 10, 18);
    context.fillText('the dot is halfway', 10, 36);

    // The two endpoints ARE labelled. Their coordinates are given in the question, so showing them is
    // showing the student its own input back, and without them the picture carries no usable scale.
    for (const [x, y, tag] of [
      [params.x1, params.y1, 'P'],
      [params.x2, params.y2, 'Q'],
    ] as const) {
      context.fillStyle = '#9b2c2c';
      context.beginPath();
      context.arc(toX(x), toY(y), 4, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#52606d';
      context.fillText(`${tag} (${format(x)}, ${format(y)})`, toX(x) + 8, toY(y) - 8);
    }
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeSegment(params);
  };

  alternative.id = 'sim-text-alternative';
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const xBox = document_.createElement('input');
  xBox.type = 'number';
  xBox.step = '0.1';
  xBox.id = 'sim-midpoint-x';
  xBox.setAttribute('aria-label', 'the x coordinate of the midpoint');
  const yBox = document_.createElement('input');
  yBox.type = 'number';
  yBox.step = '0.1';
  yBox.id = 'sim-midpoint-y';
  yBox.setAttribute('aria-label', 'the y coordinate of the midpoint');
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
  // The pair reads as a pair: brackets around the two boxes, so the ORDER is visible in the layout and not
  // only in the aria-labels.
  const brackets = document_.createElement('span');
  brackets.id = 'sim-pair-brackets';
  brackets.textContent = '(';
  const comma = document_.createElement('span');
  comma.textContent = ',';
  const close = document_.createElement('span');
  close.textContent = ')';
  controls.append(brackets, xBox, comma, yBox, close, submit, clear);
  root.append(controls);

  let connection: SimConnection | null = null;

  clear.addEventListener('click', () => {
    xBox.value = '';
    yBox.value = '';
    status.textContent = 'Both boxes cleared.';
    announce(status, status.textContent ?? '');
  });

  submit.addEventListener('click', () => {
    const x = xBox.value.trim();
    const y = yBox.value.trim();
    // THE ORDER IS THE ANSWER, so the pair goes out as an ordered list and never as a set. A half-filled
    // pair is still sent: the grader awards the half that is right and says which half is missing, and
    // dropping the submission here would discard real work instead of marking it.
    const answer: [number, number] | number[] = [Number(x), Number(y)];
    connection?.bridge?.reportAnswer(answer, {
      confidence: 1,
      explanation: describeSegment(params),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: Segment): void => {
    params = next;
    xBox.value = '';
    yBox.value = '';
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
        // A vertical segment: x is unchanged by the averaging, so the two coordinates cannot be confused
        // and a student who swaps them gets half marks rather than none. The platform needs a scenario
        // that is not the default position, and every previous simulation used its default.
        restart(paramsFrom({ x1: -6, y1: -6, x2: -6, y2: 4 }));
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
    // `sim:init` carries `initialState` and this simulation reads it: a student who saved an attempt and
    // came back must find the segment they were working on, not the default one.
    onRestore: (state) => {
      if (state !== null && typeof state === 'object') {
        const s = state as Record<string, unknown>;
        restart(
          paramsFrom({
            x1: Number(s.x1),
            y1: Number(s.y1),
            x2: Number(s.x2),
            y2: Number(s.y2),
          }),
        );
      }
    },
    getState: () => ({ x1: params.x1, y1: params.y1, x2: params.x2, y2: params.y2 }),
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
    exports: ['midpoint', 'liesBetween'],
  });

  return connection;
}
