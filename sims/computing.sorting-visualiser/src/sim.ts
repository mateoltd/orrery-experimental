/**
 * The protocol half.  (P6-T11, gold sim 23)
 *
 * ## THE STEPPER SCRUBS PASSES, NOT COMPARISONS
 *
 * The obvious choice is a comparison slider, since the question is about comparisons. That is the wrong
 * granularity: one comparison moves two blocks and changes the counter by one, so the slider spends most of
 * its travel on states differing by a single exchange, and the student cannot tell which pair moved. Scrubbing
 * by PASS makes each step a legible event — one sweep down the list, and a counter that jumps by `n-1`.
 *
 * The running counter is still on screen, because watching it climb past the last swap is how the student
 * finds the number they are asked to type.
 *
 * ## AND `runTo` IS RECOMPUTED ON EVERY DRAW, NEVER ACCUMULATED
 *
 * `stateAt(passes)` is a pure function of `(params, passes)`, so scrubbing to pass 3 twice gives the same
 * twenty-odd comparisons both times, and a restored attempt recomputes its blocks rather than replaying them.
 * That is the same discipline as the orrery's `positionAt(t)` and the pendulum's `runTo(params, n)`, and it is
 * the only reason the slider can exist at all.
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
  clampParams as clampModelParams,
  describeAlternative,
  describeTask,
  MAX_SEED,
  MAX_SIZE,
  MIN_SIZE,
  maxPassesFor,
  runTo,
  type SortParams,
  type SortState,
} from './model.js';

const SIM_ID = 'computing.sorting-visualiser';
const SIM_VERSION = '1.0.0';

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  stepper: true,
  scenarios: [],
};

const PARAM_SPECS = {
  size: num({ name: 'size', label: 'numbers', unit: '', min: MIN_SIZE, max: MAX_SIZE, default: 9 }),
  seed: num({ name: 'seed', label: 'list', unit: '', min: 0, max: MAX_SEED, default: 7 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SortParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues> as never);
  return clampModelParams({ size: Number(values.size), seed: Number(values.seed) });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const list = document_.createElement('div');
  const counter = document_.createElement('p');
  const controls = document_.createElement('div');
  const task = document_.createElement('p');
  const alternative = document_.createElement('p');
  const slider = document_.createElement('input');
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});
  let passes = 0;
  let connection: SimConnection | null = null;

  const last = (): number => maxPassesFor(params.size);
  const stateAt = (n: number): SortState => runTo(params, n);

  /**
   * THE BLOCKS ARE DRAWN IN POSITION ORDER, AND THE VALUE IS THE LABEL.
   *
   * Drawn by index rather than by value, because the sort MOVES items: the whole point of the picture is that
   * the order changes while the labels travel with them. A version that placed each block at `value * scale`
   * would animate nothing — the bars would stand still and only the labels would swap, which looks like a
   * sorting algorithm that does not move anything.
   */
  const refresh = (): void => {
    const state = stateAt(passes);
    list.textContent = '';
    state.items.forEach((item, index) => {
      const block = document_.createElement('div');
      block.className = 'sort-block';
      block.setAttribute('data-value', String(item.value));
      block.style.height = `${String(12 + item.value * 4)}px`;
      block.textContent = String(item.value);
      /**
       * THE POSITION IN THE LIST IS THE BLOCK'S PLACE IN THE DOM, so the order a screen reader reads IS the
       * order the sort has reached. `aria-label` names the position rather than the value, because the value
       * alone is the question's input and the position is what the student is watching change.
       */
      block.setAttribute(
        'aria-label',
        `position ${String(index + 1)}: value ${String(item.value)}`,
      );
      list.append(block);
    });

    const end = state.finished;
    counter.textContent =
      `comparisons so far: ${String(state.comparisons.length)}` +
      ` — of which ${String(state.swaps.length)} swapped a pair` +
      (end ? '. The sort has stopped: the last pass swapped nothing.' : '');
    alternative.textContent = describeAlternative(params);
    task.textContent = describeTask(params);
  };

  const setPasses = (next: number): void => {
    const bounded = Math.min(Math.max(Math.round(next), 0), last());
    if (bounded === passes) return;
    passes = bounded;
    slider.value = String(passes);
    refresh();
    announce(
      window_,
      `Pass ${String(passes)}, ${String(stateAt(passes).comparisons.length)} comparisons so far.`,
    );
  };

  const setParams = (next: Readonly<Record<string, unknown>>): void => {
    params = paramsFrom(next);
    // A NEW LIST RESETS THE PASS COUNT. Keeping the old step number would show a shuffled list part-sorted
    // by a sort that never ran on it, and the counter would be counting comparisons of a list nobody has seen.
    passes = 0;
    slider.max = String(last());
    slider.value = '0';
    refresh();
  };

  // The three controls are the same three the stepper offers, so keyboard and pointer cannot disagree.
  const stepButton = document_.createElement('button');
  stepButton.id = 'sim-step';
  stepButton.type = 'button';
  stepButton.textContent = 'Next pass';
  describeControl(stepButton, 'Run one pass of bubble sort');

  const backButton = document_.createElement('button');
  backButton.id = 'sim-back';
  backButton.type = 'button';
  backButton.textContent = 'Previous pass';
  describeControl(backButton, 'Go back one pass');

  slider.id = 'sim-pass';
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(last());
  slider.value = '0';
  describeControl(slider, 'Pass number');
  slider.addEventListener('input', () => {
    setPasses(Number(slider.value));
  });

  /**
   * THE ANSWER IS TYPED, because a count is not something a pointer can read off a picture.
   *
   * There is no marker to drag and no region to click, so the box IS the whole answer surface. It was missing
   * from the first version of this file, which had a working stepper, a working counter and no way to submit:
   * four conformance cells failed at once, and the least informative one said "no answer to grade".
   */
  const answerBox = document_.createElement('input');
  answerBox.type = 'number';
  answerBox.id = 'sim-answer';
  answerBox.min = '0';
  answerBox.step = '1';
  answerBox.setAttribute('aria-label', 'total comparisons the sort makes');
  describeControl(answerBox, 'Total comparisons');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit';
  describeControl(submit, 'Submit answer');

  const status = document_.createElement('p');

  controls.append(answerBox, submit, stepButton, backButton, slider);
  task.id = 'sim-task';
  alternative.id = 'sim-alternative';
  counter.id = 'sim-counter';
  list.id = 'sim-list';
  root.append(task, list, counter, controls, alternative, status);
  focusEntryPoint(document_, stepButton);
  refresh();

  /**
   * THE ANSWER GOES OUT THROUGH `reportAnswer`, NOT A HAND-BUILT `postMessage`.
   *
   * Posting `{type: 'sim:grade'}` by hand looks equivalent and is not: the host listens on the bridge's own
   * channel, so a raw frame is invisible to it. The first version of this file posted directly and the sim
   * submitted "successfully" while the host received nothing at all.
   *
   * `confidence: 1` because the box is exact -- the student typed a number, not estimated one -- and the
   * explanation carries the question so the feedback can be shown beside the thing it is about.
   */
  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      answerBox.value.trim() === '' ? null : Number(answerBox.value),
      { confidence: 1, explanation: describeTask(params) },
    );
    status.textContent = 'Answer submitted';
  });

  stepButton.addEventListener('click', () => {
    setPasses(passes + 1);
  });
  backButton.addEventListener('click', () => {
    setPasses(passes - 1);
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      refresh();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        setParams((args.params as Record<string, unknown>) ?? {});
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(document_, stepButton);
        return;
      }
      if (name === 'step') {
        setPasses(passes + (Number(args.direction) >= 0 ? 1 : -1));
        return;
      }
      if (name === 'scrubTo') {
        setPasses(Number(args.t));
        return;
      }
      if (name === 'play' || name === 'pause' || name === 'toggle') {
        /**
         * AUTO-PLAY IS REFUSED, rather than implemented badly.
         *
         * A sort's interesting event is a swap, and swaps happen at irregular intervals — a long stretch of
         * no change, then several at once. Animated at a fixed rate it either flashes through the interesting
         * parts or crawls through the dull ones, and either way the student cannot count anything. The
         * stepper exists so the student drives the pace, so `stepper.mayAutoPlay()` is false and the host's
         * play button does nothing here.
         */
        announce(
          window_,
          'Use the pass buttons or the arrow keys — this sort does not play on its own.',
        );
      }
    },
    onSetParams: (next) => {
      setParams(next);
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    onRestore: (state) => {
      /**
       * A RESTORED PASS COUNT, NOT A RESTORED HISTORY.
       *
       * The blocks are recomputed from `(params, passes)` rather than read back from the save, so there is no
       * stored picture that could disagree with the recomputed one. The count is all the state this
       * simulation has, and that is a direct consequence of deriving the history instead of accumulating it.
       */
      if (state === null || typeof state !== 'object') return;
      const s = state as Record<string, unknown>;
      params = paramsFrom({
        size: Number(s.size),
        seed: Number(s.seed),
      });
      passes = Math.min(Math.max(Math.round(Number(s.passes) || 0), 0), last());
      answerBox.value = typeof s.answer === 'string' ? s.answer : '';
      slider.max = String(last());
      slider.value = String(passes);
      refresh();
    },
    getState: () => {
      const state = stateAt(passes);
      return {
        size: params.size,
        seed: params.seed,
        passes,
        comparisons: state.comparisons.length,
        swaps: state.swaps.length,
        finished: state.finished,
        // The typed answer is part of the student's work: restoring the list and the counter without it would
        // leave a box empty next to a fully-answered question.
        answer: answerBox.value,
      };
    },
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

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['runTo', 'totalComparisons'],
  });

  return connection;
}
