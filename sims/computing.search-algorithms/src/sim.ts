/**
 * The protocol half.  (P12-T2, card 70 `computing.search-algorithms`)
 *
 * ## THE CARD'S MODALITY IS `canvas`, AND IT SAYS WHAT THE NON-VISUAL PATH IS
 *
 * "Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it
 * is a focusable `<input>`/`<button>` rather than a hit-test." So the boxes are a canvas and the COMPARISON
 * MARKS — which is the answer — are also a table, and both come from the same `steps` array. The count on
 * screen and the count in the marking key are the same array, not two implementations of one idea.
 *
 * ## THE STEP STRIP, NOT A TIMER
 *
 * Advancing the search is a stepper, not a clock: the card says "ArrowLeft/ArrowRight to step one whole
 * step". There is no `requestAnimationFrame` here and no elapsed time, because a search has no duration —
 * it has a count, and a count advanced by a timer is a different quantity.
 */

import {
  announce,
  type BridgeHandlers,
  choice,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  int,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  asBoolean,
  clamp,
  describeSearch,
  haystack,
  type SearchParams,
  type SearchStep,
  search,
  worstCase,
} from './model.js';

const SIM_ID = 'computing.search-algorithms';
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

const PARAM_SPECS = {
  algorithm: choice({
    name: 'algorithm',
    label: 'Search',
    values: ['binary', 'linear'],
    default: 'binary',
  }),
  size: int({ name: 'size', label: 'List length', min: 4, max: 64, default: 16 }),
  target: int({ name: 'target', label: 'Search for', min: -999, max: 999, default: 9 }),
  ascending: {
    type: 'boolean' as const,
    name: 'ascending',
    label: 'List is in ascending order',
    default: true,
  },
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SearchParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    algorithm: values.algorithm === 'linear' ? 'linear' : 'binary',
    size: Number(values.size),
    target: Number(values.target),
    ascending: values.ascending === true,
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
  let shown = 0;

  const heading = document_.createElement('h2');
  heading.id = 'sim-question';
  const canvas = document_.createElement('canvas');
  canvas.id = 'sim-canvas';
  const stepper = document_.createElement('div');
  stepper.id = 'sim-stepper';
  const table = document_.createElement('table');
  table.id = 'sim-marks';
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  root_.append(heading, stepper, canvas, table, controls, status, alternative);

  // Canvas is not focusable and announces nothing, so it carries the entry point and a name and nothing else.
  canvas.setAttribute('data-sim-entry', '');
  canvas.setAttribute('role', 'img');

  const advance = document_.createElement('button');
  advance.type = 'button';
  advance.id = 'sim-advance';
  describeControl(advance, 'Compare one more element');
  const resetSteps = document_.createElement('button');
  resetSteps.type = 'button';
  resetSteps.id = 'sim-rewind';
  describeControl(resetSteps, 'Start the search again');
  stepper.append(advance, resetSteps);

  const field = (id: string, labelText: string): HTMLInputElement => {
    const input = document_.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.id = id;
    const label = document_.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const wrapper = document_.createElement('div');
    wrapper.append(label, input);
    return input;
  };

  const countField = field('sim-comparisons', 'Number of comparisons');
  const foundField = field('sim-found', 'Was the target found? 1 for yes, 0 for no');
  const indexField = field('sim-index', 'Position it was found at, or -1 if not found');
  const worstField = field('sim-worst-case', 'Worst-case comparisons on this list');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  controls.append(countField, foundField, indexField, worstField, submit);

  let connection: SimConnection | null = null;

  const draw = (steps: SearchStep[]): void => {
    const width = root_.clientWidth || 640;
    canvas.width = width;
    canvas.height = PANEL;
    canvas.style.width = '100%';
    canvas.style.height = `${String(PANEL)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, PANEL);
    const list = haystack(params);
    const box = Math.max(8, Math.min(26, (width - 40) / Math.max(1, list.length)));
    const left = 20;
    const top = 60;
    list.forEach((value, index) => {
      const step = steps.find((candidate) => candidate.index === index);
      const isLast = index === steps[steps.length - 1]?.index;
      context.strokeStyle = '#1f2933';
      context.fillStyle = step === undefined ? '#ffffff' : isLast ? '#f6d7d7' : '#dbe4ee';
      context.fillRect(left + index * box, top, box - 2, 40);
      context.fillStyle = '#1f2933';
      context.font = '11px system-ui, sans-serif';
      context.fillText(String(value), left + index * box + 3, top + 16);
      if (step !== undefined) {
        context.fillStyle = '#9b2c2c';
        context.fillText(String(step.comparisons), left + index * box + 3, top + 32);
      }
    });
    context.fillStyle = '#1f2933';
    context.font = '13px system-ui, sans-serif';
    const result = search(params);
    context.fillText(
      result.refusal === null
        ? `${params.algorithm} search · ${String(shown)} of ${String(result.comparisons)} comparisons shown · worst case ${String(worstCase(params))}`
        : `${params.algorithm} search REFUSED`,
      left,
      24,
    );
    context.fillText(
      result.refusal === null
        ? `target ${String(params.target)}`
        : 'the list is not in ascending order',
      left,
      42,
    );
  };

  const renderTable = (steps: SearchStep[]): void => {
    const rows = steps.slice(0, shown);
    table.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent =
      'Every comparison the search has made, in order. This is the same list the boxes above show, and the ' +
      "count on screen is this table's last row.";
    table.append(caption);
    const head = document_.createElement('tr');
    for (const label of ['Step', 'Position', 'Value compared', 'Outcome', 'Comparisons so far']) {
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
    rows.forEach((step, index) => {
      const tr = document_.createElement('tr');
      for (const value of [
        String(index + 1),
        String(step.index),
        String(step.value),
        step.outcome,
        String(step.comparisons),
      ]) {
        const cell = document_.createElement('td');
        cell.textContent = value;
        tr.append(cell);
      }
      tbody.append(tr);
    });
    table.append(tbody);
  };

  const refresh = (): void => {
    const result = search(params);
    const steps = result.steps;
    shown = Math.min(shown, steps.length);
    canvas.setAttribute(
      'aria-label',
      result.refusal === null
        ? `A list of ${String(params.size)} numbers with ${String(shown)} of ${String(result.comparisons)} comparisons marked`
        : 'A list of numbers which is not in ascending order, so a binary search refuses to run on it',
    );
    heading.textContent = `${params.algorithm === 'binary' ? 'Binary' : 'Linear'} search of ${String(params.size)} numbers for ${String(params.target)}`;
    draw(steps);
    renderTable(steps);
    if (result.refusal !== null) {
      status.textContent = result.refusal;
      announce(status, result.refusal);
    } else {
      status.textContent = `${String(shown)} of ${String(result.comparisons)} comparisons shown.`;
    }
    alternative.textContent = describeSearch(params);
  };

  advance.addEventListener('click', () => {
    const steps = search(params).steps;
    if (shown >= steps.length) {
      announce(status, 'Every comparison has been made already.');
      return;
    }
    shown += 1;
    refresh();
    const step = steps[shown - 1];
    announce(
      status,
      `Comparison ${String(shown)}: position ${String(step?.index)}, outcome ${String(step?.outcome)}.`,
    );
  });
  resetSteps.addEventListener('click', () => {
    shown = 0;
    refresh();
    announce(status, 'The search has started again.');
  });

  submit.addEventListener('click', () => {
    const number = (field_: HTMLInputElement): number => {
      const raw = field_.value.trim();
      // AN EMPTY BOX IS NOT A ZERO. `Number('')` is 0, and 0 comparisons is a claim about the algorithm.
      return raw === '' ? Number.NaN : Number(raw);
    };
    connection?.bridge?.reportAnswer(
      {
        comparisons: number(countField),
        found: asBoolean(number(foundField)),
        index: number(indexField),
        worstCase: number(worstField),
      },
      { confidence: 1, explanation: describeSearch(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: SearchParams): void => {
    params = next;
    shown = 0;
    for (const input of [countField, foundField, indexField, worstField]) input.value = '';
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
    getState: () => ({
      algorithm: params.algorithm,
      size: params.size,
      target: params.target,
      ascending: params.ascending,
      shown,
    }),
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
    exports: ['linearSearch', 'binarySearch', 'worstCase', 'isAscending', 'describeSearch'],
  });

  return connection;
}

/** Kept exported so the browser bundle's capability list and the model's exports cannot drift silently. */
