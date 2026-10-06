/**
 * The protocol half.  (P12-T2, card 48 `chemistry.solution-concentration`)
 *
 * ## MODALITY `form`: THE FORM IS THE WHOLE INTERACTION
 *
 * The card says so, and it is right here — a beaker diagram adds nothing a pair of labelled numbers does not
 * say, and a diagram would then be the one thing a screen-reader user could not read. So there is no canvas:
 * two `<table>`s of the two states, the method stated in words above them, and three labelled inputs.
 *
 * ## THE METHOD IS SHOWN IN VERBS BEFORE ANY NUMBER
 *
 * "Adding 100 cm³ of water" and "making up to 100 cm³" are different experiments, so the two states are
 * labelled with the VERB and the sentence naming which is happening is the first thing on the page. A
 * student who has misread the verb has then got every number wrong, and the feedback says which verb they
 * should have used.
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
  describeSolution,
  dilutedMolarity,
  feasible,
  finalVolumeOf,
  format,
  molarMassOf,
  moles,
  ppm,
  type SolutionParams,
} from './model.js';

const SIM_ID = 'chemistry.solution-concentration';
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
  molarity: {
    type: 'number' as const,
    name: 'molarity',
    label: 'Starting molarity',
    unit: 'mol/L',
    min: 0.01,
    max: 2,
    default: 0.1,
  },
  volume: {
    type: 'number' as const,
    name: 'volume',
    label: 'Starting volume',
    unit: 'cm3',
    min: 10,
    max: 500,
    default: 50,
  },
  water: {
    type: 'number' as const,
    name: 'water',
    label: 'Water added',
    unit: 'cm3',
    min: 0,
    max: 500,
    default: 50,
  },
  finalVolume: {
    type: 'number' as const,
    name: 'finalVolume',
    label: 'Volume made up to',
    unit: 'cm3',
    min: 10,
    max: 500,
    default: 100,
  },
  method: choice({
    name: 'method',
    label: 'Method',
    values: ['add', 'make-up'],
    default: 'make-up',
  }),
  molarMass: {
    type: 'number' as const,
    name: 'molarMass',
    label: 'Molar mass',
    unit: 'g/mol',
    min: 1,
    max: 200,
    default: 58.44,
  },
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SolutionParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    molarity: Number(values.molarity),
    volume: Number(values.volume),
    water: Number(values.water),
    finalVolume: Number(values.finalVolume),
    method: String(values.method) === 'add' ? 'add' : 'make-up',
    molarMass: Number(values.molarMass),
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

  const verb = document_.createElement('h2');
  verb.id = 'sim-question';
  const before = document_.createElement('table');
  const after = document_.createElement('table');
  const controls = document_.createElement('div');
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  root_.append(verb, before, after, controls, status, alternative);

  const field = (id: string, labelText: string): HTMLInputElement => {
    const input = document_.createElement('input');
    input.type = 'text';
    input.id = id;
    const label = document_.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    const wrapper = document_.createElement('div');
    wrapper.append(label, input);
    return input;
  };

  const molarityField = field('sim-molarity', 'Diluted molarity, in mol per litre');
  const ppmField = field('sim-ppm', 'Concentration in ppm');
  const molesField = field('sim-moles', 'Amount of solute, in moles');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  controls.append(molarityField, ppmField, molesField, submit);
  let connection: SimConnection | null = null;

  const stateTable = (
    table: HTMLTableElement,
    captionText: string,
    rows: [string, string][],
  ): void => {
    table.replaceChildren();
    const caption = document_.createElement('caption');
    caption.textContent = captionText;
    table.append(caption);
    const tbody = document_.createElement('tbody');
    for (const [label, value] of rows) {
      const tr = document_.createElement('tr');
      const th = document_.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      const td = document_.createElement('td');
      td.textContent = value;
      tr.append(th, td);
      tbody.append(tr);
    }
    table.append(tbody);
  };

  const refresh = (): void => {
    const final = finalVolumeOf(params);
    verb.textContent =
      params.method === 'add'
        ? `Add ${format(params.water, 0)} cm³ of water to ${format(params.volume, 0)} cm³ of solution`
        : `Make ${format(params.volume, 0)} cm³ of solution up to a total of ${format(params.finalVolume, 0)} cm³`;
    stateTable(before, 'Before the dilution.', [
      ['Molarity', `${format(params.molarity, 3)} mol/L`],
      ['Volume', `${format(params.volume, 0)} cm³`],
      ['Amount', `${format(moles(params))} mol`],
      ['Solute', `${format(moles(params) * molarMassOf(params))} g`],
    ]);
    stateTable(after, `After: ${params.method === 'add' ? 'water added' : 'made up to a total'}.`, [
      ['Final volume', `${format(final, 0)} cm³`],
      ['Amount', `${format(moles(params))} mol`],
      ['Diluted molarity', `${format(dilutedMolarity(params))} mol/L`],
      ['Concentration', `${format(ppm(params), 1)} ppm`],
    ]);
    alternative.textContent = describeSolution(params);
    status.textContent = feasible(params)
      ? `The two verbs give different final volumes: ${format(final, 0)} cm³ here.`
      : 'Making up to a smaller volume than you started with would remove solution, which is not a dilution.';
  };

  submit.addEventListener('click', () => {
    const number = (field_: HTMLInputElement): number => {
      const raw = field_.value.trim();
      return raw === '' ? Number.NaN : Number(raw);
    };
    connection?.bridge?.reportAnswer(
      { molarity: number(molarityField), ppm: number(ppmField), moles: number(molesField) },
      { confidence: 1, explanation: describeSolution(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: SolutionParams): void => {
    params = next;
    for (const input of [molarityField, ppmField, molesField]) input.value = '';
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
      molarity: params.molarity,
      volume: params.volume,
      water: params.water,
      finalVolume: params.finalVolume,
      method: params.method,
      molarMass: params.molarMass,
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
    exports: ['moles', 'dilutedMolarity', 'ppm', 'finalVolumeOf', 'describeSolution'],
  });

  return connection;
}
