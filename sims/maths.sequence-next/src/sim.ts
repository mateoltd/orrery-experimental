/**
 * The protocol half.  (P6-T11, gold sim 6)
 *
 * The first gold sim whose content DEPENDS ON THE SEED. Two students with different seeds see different
 * sequences, and the same student sees the same one on every re-sit — so a teacher asking "what did they
 * actually get?" has an answer.
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
import { describeSequence, paramsFromSeed, type SequenceParams, terms } from './model.js';

const SIM_ID = 'maths.sequence-next';
const SIM_VERSION = '1.0.0';

// `grading` and `stepper` only. The simulation's content comes from the seed, and that is expressed by
// the manifest's `capabilities.randomised` and by the state carrying the seed -- not by inventing a
// scenario, because this one has none.
const CAPABILITIES: SimCapabilities = { grading: true, stepper: false, scenarios: [] };

const PARAM_SPECS = {
  shown: num({ name: 'shown', label: 'Terms shown', unit: '', min: 3, max: 8, default: 5 }),
};

const paramsOf = (seed: string, raw: Readonly<Record<string, unknown>>): SequenceParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  const hashed = Number.parseInt(seed, 16);
  return paramsFromSeed(Number.isFinite(hashed) ? hashed : 0, Number(values.shown));
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const row = document_.createElement('p');
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let seed = '0';
  let shown = 5;

  const physics = (): SequenceParams => paramsOf(seed, { shown });

  const refresh = (): void => {
    const params = physics();
    row.id = 'sim-sequence';
    row.textContent = terms(params).join(',  ');
    alternative.textContent = describeSequence(params);
  };

  row.id = 'sim-sequence';
  row.className = 'sim-sequence';
  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(row, status, alternative);

  const field = document_.createElement('input');
  field.type = 'number';
  field.step = '1';
  field.id = 'sim-next';
  field.setAttribute('aria-label', 'the next term');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const more = document_.createElement('button');
  more.type = 'button';
  more.id = 'sim-more';
  describeControl(more, 'Show one more term');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(more, field, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  more.addEventListener('click', () => {
    shown = Math.min(shown + 1, 8);
    field.value = '';
    refresh();
    status.textContent = `Showing ${String(shown)} terms`;
    announce(status, status.textContent ?? '');
  });
  submit.addEventListener('click', () => {
    const raw = field.value.trim();
    // A whole number or nothing. `Number('')` is 0, and 0 is a plausible-looking answer a student did
    // not give.
    connection?.bridge?.reportAnswer(raw === '' ? Number.NaN : Number(raw), {
      confidence: 1,
      explanation: describeSequence(physics()),
    });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  /**
   * WHETHER THE SEED CAME FROM THE HOST, OR FROM THIS SIMULATION'S OWN DEFAULT.
   *
   * ## WHY THE VALUE ALONE IS NOT ENOUGH
   *
   * `seed` is `parseInt(seed, 16)`, and a simulation that IGNORED `init.seed` would still report a seed -- the
   * one from its manifest default. When the two coincide, which they do whenever the host's derived seed
   * happens to match, a harness reading only the value cannot tell an honoured seed from an ignored one.
   *
   * That is not hypothetical: `maths.monte-carlo-pi` declared `randomised: true`, ignored the host's seed
   * entirely, and would have passed a value-only check while handing a whole cohort one paper. So the
   * provenance is carried explicitly, beside the value it describes.
   */
  let seedFromHost = false;

  const snapshot = (): Record<string, unknown> => ({
    seed: Number.parseInt(seed, 16),
    shown,
    seedFromHost,
  });

  const handlers: BridgeHandlers = {
    onSetParams: (next) => {
      const { values } = clampParams(PARAM_SPECS, next as Partial<ParamValues>);
      shown = Number(values.shown);
      field.value = '';
      refresh();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        shown = Number((args as { shown?: unknown }).shown ?? 5);
        field.value = '';
        refresh();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      if (name === 'loadScenario') {
        shown = Math.min(shown + 1, 8);
        refresh();
      }
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
        // THE SEED IS THE QUESTION. Two students with different seeds see different sequences, so a
        // student who came back to a different one was not looking at their own work -- and no error was
        // possible, because the page rendered a perfectly valid sequence.
        //
        // The seed is stored as the NUMBER `parseInt(seed, 16)` produces, so restoring it is the inverse of
        // storing it: back to hex, zero-padded to the width `parseInt` was given.
        const restored = Number(s.seed);
        if (Number.isFinite(restored) && restored >= 0) {
          seed = restored.toString(16);
          shown = typeof s.shown === 'number' ? s.shown : shown;
          field.value = '';
          refresh();
        }
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
        // `sim:init` carries the seed, and it arrives exactly once. Reading it here rather than from a
        // prop means the simulation has no seed until the host has actually told it one.
        if (type === 'sim:init') {
          const init = event.data as { nonce?: unknown; seed?: unknown };
          if (typeof init.seed === 'string') {
            seed = init.seed;
            // RECORDED ALONGSIDE THE SEED, not inferred from it. See `snapshot`.
            seedFromHost = true;
          }
          if (typeof init.nonce === 'string')
            (window_ as unknown as { __nonce?: string }).__nonce = init.nonce;
        }
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
    exports: ['terms', 'nextTerm', 'paramsFromSeed'],
  });

  return connection;
}
