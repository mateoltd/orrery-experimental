/**
 * The protocol half.  (P6-T11, gold sim 10)
 *
 * Declares the stepper, because the question IS the trace: the student needs to step through the search
 * to count, and a sim they can only watch cannot be counted by hand.
 */

import {
  announce,
  type BridgeHandlers,
  clampParams,
  connectSim,
  createStepper,
  describeControl,
  focusEntryPoint,
  num,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
  type Stepper,
} from '@orrery/sim-sdk';
import { describeSearch, haystack, type SearchParams, trace } from './model.js';

const SIM_ID = 'computing.binary-search';
const SIM_VERSION = '1.0.0';
const PANEL = 220;

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  randomised: false,
  audio: false,
  webgl: false,
  stepper: true,
  scenarios: [],
};

/**
 * BUILT WITH `num()`, LIKE EVERY OTHER SIMULATION.
 *
 * The first version declared these as bare object literals, and `clampParams` threw on them. It was
 * invisible while `sim:init` params were discarded -- nothing called the handler -- and now that the
 * handler runs during the handshake, a throw there stops the simulation before it ever becomes READY, so
 * the whole matrix failed on a sim whose MODEL was correct. A param declaration is not a description; it
 * is an input to a validator.
 */
const PARAM_SPECS = {
  target: num({ name: 'target', label: 'Search for', unit: '', min: -99, max: 99, default: 8 }),
  length: num({ name: 'length', label: 'List length', unit: '', min: 1, max: 64, default: 8 }),
} as const;

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

  let params: SearchParams = { target: 8, length: 8 };
  let stepper: Stepper = createStepper({
    maxTime: 64,
    stepSize: 1,
    allowMotion: true,
  });

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

    const cells = haystack(params.length);
    const seen = trace(params.target, params.length).slice(0, Math.round(stepper.get().t));
    const gap = 3;
    const cellWidth = Math.max(12, (width - 20) / cells.length - gap);
    const top = 60;

    context.font = '12px system-ui, sans-serif';
    context.fillStyle = '#1f2933';
    context.fillText(
      `Searching for ${String(params.target)} in 1…${String(params.length)}`,
      10,
      20,
    );
    // The convention, DRAWN. An even-length range has two defensible midpoints and the student cannot be
    // expected to guess which one this simulation uses.
    context.fillStyle = '#52606d';
    context.fillText('Middle of the remaining range: the lower one when there are two.', 10, 40);

    cells.forEach((value, index) => {
      const x = 10 + index * (cellWidth + gap);
      const step = seen.find((entry) => entry.index === index);
      context.fillStyle =
        step === undefined ? '#f0f4f8' : step.outcome === 'found' ? '#b7e4c7' : '#f7d9d9';
      context.fillRect(x, top, cellWidth, 34);
      context.strokeStyle = '#9aa5b1';
      context.lineWidth = 1;
      context.strokeRect(x, top, cellWidth, 34);
      context.fillStyle = '#1f2933';
      const label = String(value);
      context.fillText(label, x + cellWidth / 2 - label.length * 3, top + 21);
    });

    // The narrowing, as two surviving halves -- the reason the count grows so slowly.
    if (seen.length > 0) {
      const last = seen[seen.length - 1];
      if (last) {
        context.fillStyle = '#0b6b8a';
        context.font = '13px system-ui, sans-serif';
        context.fillText(
          `Compared ${String(last.comparisons)} time${last.comparisons === 1 ? '' : 's'} so far`,
          10,
          top + 60,
        );
      }
    }
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeSearch(params.target, params.length);
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');

  const buildButton = (id: string, label: string, onClick: () => void): HTMLButtonElement => {
    const button = document_.createElement('button');
    button.type = 'button';
    button.id = id;
    button.textContent = label;
    describeControl(button, label);
    button.addEventListener('click', onClick);
    return button;
  };
  const scrub = document_.createElement('input');
  scrub.type = 'range';
  scrub.id = 'sim-scrub';
  scrub.min = '0';
  scrub.max = String(trace(params.target, params.length).length);
  scrub.step = '1';
  scrub.value = '0';
  scrub.setAttribute('aria-label', 'how many steps of the search to reveal');

  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '1';
  answer.id = 'sim-comparisons';
  answer.setAttribute('aria-label', 'number of comparisons');

  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(
    buildButton('sim-step-back', 'Step back', () =>
      stepper.dispatch({ type: 'step', direction: -1 }),
    ),
    buildButton('sim-step', 'Step', () => stepper.dispatch({ type: 'step', direction: 1 })),
    buildButton('sim-play', 'Play', () => stepper.dispatch({ type: 'toggle' })),
    scrub,
    answer,
    buildButton('sim-submit', 'Submit answer', () => {
      const raw = answer.value.trim();
      connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
        confidence: 1,
        explanation: describeSearch(params.target, params.length),
      });
      status.textContent = 'Answer submitted';
      announce(status, 'Answer submitted.');
    }),
  );
  root.append(canvas, controls, status, alternative);

  let connection: SimConnection | null = null;
  let unsub = stepper.subscribe(() => {
    scrub.value = String(Math.round(stepper.get().t));
    refresh();
  });
  scrub.addEventListener('input', () =>
    stepper.dispatch({ type: 'scrubTo', t: Number(scrub.value) }),
  );

  const applyParams = (next: Partial<SearchParams>): void => {
    params = { ...params, ...next };
    // The trace length is the timeline, so a changed list means a changed `maxTime` -- a stepper whose
    // range no longer matches its content can be scrubbed past the end of the search.
    unsub();
    stepper = createStepper({
      maxTime: Math.max(1, trace(params.target, params.length).length),
      stepSize: 1,
      allowMotion: true,
    });
    unsub = stepper.subscribe(() => {
      scrub.value = String(Math.round(stepper.get().t));
      refresh();
    });
    scrub.max = String(Math.max(1, trace(params.target, params.length).length));
    scrub.value = '0';
    answer.value = '';
    refresh();
  };

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'step') stepper.dispatch({ type: 'step', direction: 1 });
      if (name === 'play') stepper.dispatch({ type: 'play' });
      if (name === 'pause') stepper.dispatch({ type: 'pause' });
      if (name === 'reset') applyParams({ target: 8, length: 8 });
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      applyParams({ target: Number(values.target), length: Number(values.length) });
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
        applyParams({ target: Number(s.target), length: Number(s.length) });
        // The stepper is part of the state, not a function of the parameters: a student who scrubbed to
        // step four and came back to step zero had their place taken away.
        stepper.dispatch({ type: 'scrubTo', t: Number(s.step) });
      }
    },
    getState: () => ({
      target: params.target,
      length: params.length,
      step: Math.round(stepper.get().t),
    }),
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
    exports: ['trace', 'comparisonCount'],
  });
  return connection;
}
