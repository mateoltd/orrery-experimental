/**
 * The protocol half.  (P12-T2, card 14 `biology.genetics-punnett`)
 *
 * ## THE SQUARE IS A `<table>`, NOT A CANVAS, AND THE CARD DECIDES THAT
 *
 * The card's modality is `form`: "The form is the whole interaction — there is no canvas to mirror." A
 * Punnett square drawn on a canvas would also be the only thing on the page a screen reader could not read,
 * for no gain: the square is four cells of text. So it is a real table with a caption and scoped headers,
 * and the grader reads the same four cells the table describes.
 *
 * ## THE INNER CELLS ARE LEFT BLANK, AND THAT IS THE QUESTION
 *
 * The table prints the GAMETES — which is the information a cross is made of — and leaves the four inner
 * cells as `?`. A square with its answers printed in it is a diagram, and a student reading it has been
 * told the answer rather than asked for it. The gamete headers are derived from `cells()` in the model, so
 * the headers on screen and the genotypes in the marking key cannot drift apart.
 */

import {
  announce,
  type BridgeHandlers,
  choice,
  clampParams,
  connectSim,
  describeControl,
  focusEntryPoint,
  type ParamValues,
  type SimCapabilities,
  type SimConnection,
} from '@orrery/sim-sdk';
import {
  clamp,
  DOMINANT_ALLELE,
  describeCross,
  GENOTYPES,
  gametes,
  type PunnettParams,
  trimEntries,
} from './model.js';

const SIM_ID = 'biology.genetics-punnett';
const SIM_VERSION = '1.0.0';

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
  parentA: choice({
    name: 'parentA',
    label: 'First parent',
    values: [...GENOTYPES],
    default: 'Aa',
  }),
  parentB: choice({
    name: 'parentB',
    label: 'Second parent',
    values: [...GENOTYPES],
    default: 'Aa',
  }),
};

/**
 * The trust boundary. Everything reaching the simulation has been through a browser, a manifest, a pinned
 * version and a URL, so `clampParams` is the only place any of it is believed (`params.ts:7`).
 */
const paramsFrom = (raw: Readonly<Record<string, unknown>>): PunnettParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({ parentA: String(values.parentA), parentB: String(values.parentB) });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => errors.push(String(event.message)));

  let params = paramsFrom({});

  const heading = document_.createElement('h2');
  heading.id = 'sim-question';
  const grid = document_.createElement('table');
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';

  const offspringField = document_.createElement('input');
  offspringField.type = 'text';
  offspringField.id = 'sim-offspring';
  offspringField.setAttribute('aria-describedby', 'sim-offspring-hint');
  const offspringLabel = document_.createElement('label');
  offspringLabel.htmlFor = 'sim-offspring';
  offspringLabel.textContent = 'Offspring genotypes, separated by commas';
  const offspringHint = document_.createElement('p');
  offspringHint.id = 'sim-offspring-hint';
  offspringHint.textContent =
    'Four entries for a monohybrid cross, and case matters: AA and aa differ.';

  const ratioField = document_.createElement('input');
  ratioField.type = 'text';
  ratioField.id = 'sim-ratio';
  const ratioLabel = document_.createElement('label');
  ratioLabel.htmlFor = 'sim-ratio';
  ratioLabel.textContent = 'Ratio as three counts separated by colons, for example 1:2:1';

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');

  controls.append(offspringLabel, offspringField, offspringHint, ratioLabel, ratioField, submit);
  root.append(heading, grid, controls, status, alternative);

  let connection: SimConnection | null = null;

  const drawSquare = (): void => {
    const across = gametes(params.parentA);
    const down = gametes(params.parentB);
    grid.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent =
      `Punnett square for ${params.parentA} × ${params.parentB}, with ${DOMINANT_ALLELE} the dominant ` +
      'allele. The column and row headings are the gametes each parent produces; the inner cells are what ' +
      'you have to work out.';
    grid.append(caption);

    const head = document_.createElement('tr');
    const corner = document_.createElement('th');
    corner.scope = 'row';
    corner.textContent = 'Parent 2 ↓ / Parent 1 →';
    head.append(corner);
    across.forEach((allele, index) => {
      const cell = document_.createElement('th');
      cell.scope = 'col';
      cell.textContent = `${allele} (gamete ${String(index + 1)})`;
      head.append(cell);
    });
    const thead = document_.createElement('thead');
    const headRow = document_.createElement('tr');
    headRow.append(head);
    thead.append(headRow);
    grid.append(thead);

    const tbody = document_.createElement('tbody');
    down.forEach((side, rowIndex) => {
      const row = document_.createElement('tr');
      const label = document_.createElement('th');
      label.scope = 'row';
      label.textContent = `${side} (gamete ${String(rowIndex + 1)})`;
      row.append(label);
      across.forEach((_top, columnIndex) => {
        const cell = document_.createElement('td');
        cell.textContent = `${String(rowIndex + 1)} × ${String(columnIndex + 1)} = ?`;
        row.append(cell);
      });
      tbody.append(row);
    });
    grid.append(tbody);
  };

  const refresh = (): void => {
    heading.textContent = `Cross: ${params.parentA} × ${params.parentB}`;
    drawSquare();
    alternative.textContent = describeCross(params);
  };

  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      // TRIMMED HERE, ON THE WAY IN, so the reported answer is the LIST the student meant rather than the
      // raw text field. The grader still parses defensively, because a host may submit an answer from
      // somewhere other than this form — but whitespace is the keyboard, and stripping it is the
      // simulation's job rather than the marking key's.
      { offspring: trimEntries(offspringField.value), ratio: ratioField.value },
      { confidence: 1, explanation: describeCross(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: PunnettParams): void => {
    params = next;
    // CLEARED, NOT RESTORED. A rehydrated answer the student has not re-read is a mark they cannot account
    // for, and the host's saved state carries the question rather than the response to it.
    offspringField.value = '';
    ratioField.value = '';
    refresh();
  };

  const handlers: BridgeHandlers = {
    onResize: () => refresh(),
    onCommand: (name, args) => {
      if (name === 'reset') {
        restart(paramsFrom((args.params as Record<string, unknown>) ?? {}));
        return;
      }
      if (name === 'focus') focusEntryPoint(root);
    },
    onSetParams: (next) => restart(paramsFrom(next)),
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => connection?.dispose(),
    onRestore: (state) => {
      if (state !== null && typeof state === 'object')
        restart(paramsFrom(state as Record<string, unknown>));
    },
    getState: () => ({ parentA: params.parentA, parentB: params.parentB }),
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
  focusEntryPoint(root);

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['cells', 'offspring', 'ratio', 'describeCross'],
  });

  return connection;
}
