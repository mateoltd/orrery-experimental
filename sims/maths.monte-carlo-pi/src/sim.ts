/**
 * The protocol half.  (P6-T11, gold sim 21)
 *
 * ## THE SEED IS THE SEAT OF THE STUDENT'S QUESTION
 *
 * Everything here is a function of `(seed, dropped)`. There is no mutable random state anywhere in the
 * simulation, so `getState` is a pure getter of two numbers and `onRestore` is a pure setter of two numbers —
 * and that is the only reason a saved attempt can be reopened on a different machine and show the same cloud.
 *
 * The tempting alternative is to keep a generator in a closure and draw from it as the student presses the
 * button. That works until the tab is reloaded, the host restores a checkpoint, or a teacher opens the
 * student's work for review — at which point the student has a different experiment and no way to tell.
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
  clamp,
  convergence,
  countInside,
  describeAlternative,
  describeTask,
  estimatePi,
  format,
  MAX_SAMPLES,
  type MonteParams,
  sample,
  toleranceFor,
} from './model.js';

const SIM_ID = 'maths.monte-carlo-pi';
const SIM_VERSION = '1.0.0';
const SIZE = 340;

const CAPABILITIES: SimCapabilities = {
  // THIS DISAGREED WITH ITS OWN sim.manifest.json, WHICH IS THE AUTHORITATIVE COPY.
  // OMITTED randomised, which the manifest sets: the sampling is seeded and its seed is the
  // student-visible one, so a host had no way to know not to re-seed it.
  // The frame and the manifest must not make different claims about the same file.
  state: true,
  grading: true,
  randomised: true,
  audio: false,
  webgl: false,
  stepper: false,
  scenarios: [],
};

const PARAM_SPECS = {
  samples: num({ name: 'samples', label: 'points', unit: '', min: 100, max: 20000, default: 2000 }),
  dropped: num({
    name: 'dropped',
    label: 'points drawn',
    unit: '',
    min: 0,
    max: 20000,
    default: 2000,
  }),
  seed: num({ name: 'seed', label: 'seed', unit: '', min: 0, max: 999999, default: 4242 }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): MonteParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return clamp({
    samples: Number(values.samples),
    dropped: Number(values.dropped),
    /**
     * A NUMBER SEED BECOMES A STRING, ONCE, HERE.
     *
     * The seed is a string everywhere in the model, because `createRng` hashes a string into its state and a
     * bare number would hash differently. The manifest declares it as a number, which is right — a number is
     * what a host can author — so the conversion belongs at the boundary rather than being repeated at every
     * use. `String(4242)` is stable across mounts, which is the entire requirement.
     */
    seed: String(Number(values.seed)),
  });
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
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});
  /**
   * THE SEED THE HOST CHOSE FOR THIS MOUNT, OR NULL.
   *
   * ## WHY THIS SIMULATION WAS GIVING A WHOLE COHORT THE SAME ESTIMATE
   *
   * This is a `randomised: true` simulation whose content is entirely a function of its seed, and it read the
   * seed ONLY from the manifest's parameter default. `sim:init` carries a per-student `seed` that the host
   * derives from the attempt, and it was ignored -- so under a `PER_STUDENT` policy every student in a cohort
   * was handed the same Monte Carlo estimate. Nothing crashed, the answer was correct, and the picture was
   * plausible; a class simply received one paper.
   *
   * ## WHY IT IS HELD SEPARATELY RATHER THAN WRITTEN INTO `params`
   *
   * Three attempts, in order, and each failed in a way worth recording:
   *
   * 1. Apply it in the transport listener on `sim:init`. WRONG: `sim:init` carries `params` too, and the
   *    bridge dispatches those through `onSetParams` immediately afterwards, overwriting the seed a moment
   *    later. The two students came back identical and the cell said they shared a paper.
   * 2. Apply it in `onSetParams`, which is handed `frame.seed`. ALSO WRONG: the bridge routes BOTH `sim:init`
   *    and `sim:setParams` through that one handler, so the host's FIXED seed overrode the manifest default on
   *    every mount and the simulation's own conformance expectation stopped matching.
   *
   * What is actually wanted is precedence, and precedence needs both facts: the host's choice, and whether an
   * AUTHOR has since overridden it. So the seed is held here, and a `sim:setParams` clears it -- because a
   * parameter change is a deliberate instruction and outranks whatever the host chose at mount time.
   */
  let hostSeed: string | null = null;

  /**
   * THE SEED IN FORCE: the host's if it chose one and no author has overridden it, otherwise the manifest's.
   *
   * Four places read the seed -- the drawing, the convergence series, the captured state and the value the
   * server-side grader is told -- and each was reading `params.seed` directly. That is four chances to
   * disagree about which question the student is looking at, and the grader is handed the answer key rather
   * than the question, so a disagreement there marks a correct answer wrong with no visible symptom.
   */
  const seedInForce = (): string => hostSeed ?? params.seed;

  const canvas = document_.createElement('canvas');
  canvas.id = 'sim-canvas';
  const readout = document_.createElement('p');
  readout.id = 'sim-readout';
  const status = document_.createElement('p');
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const alternative = document_.createElement('p');
  alternative.id = 'sim-text-alternative';
  alternative.className = 'sim-alternative';

  /**
   * THE DOT CLOUD, DRAWN FROM THE SAME FUNCTION THE GRADER USES.
   *
   * `sample(seed, dropped)` is called by the drawing, by `getState` and by the server-side grader, so the
   * picture a student looks at and the answer they are marked against are the same cloud. A drawing with its
   * own generator would be a picture of a different experiment, and the discrepancy would surface only in a
   * release report nobody reads.
   */
  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.width = width;
    canvas.height = SIZE;
    canvas.style.width = '100%';
    canvas.style.height = `${String(SIZE)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, SIZE);

    const toX = (u: number): number => u * width;
    const toY = (v: number): number => SIZE - v * SIZE;

    context.strokeStyle = '#0b6b8a';
    context.lineWidth = 2.5;
    context.beginPath();
    // A QUARTER CIRCLE OF RADIUS 1 FILLING THE SQUARE, so pi is the area ratio the student is estimating.
    context.arc(toX(0), toY(0), width, Math.PI / 2, 0);
    context.stroke();

    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.strokeRect(toX(0), toY(1), width, SIZE);

    /**
     * TWO COLOURS, AND THE COLOUR IS THE WHOLE ARGUMENT.
     *
     * Points inside are one colour and points outside are another, which turns the ratio into something a
     * student can SEE instead of count. The first version drew every dot the same colour and asked the
     * student to do the visual bookkeeping across 2,000 of them — and that bookkeeping is the part of this
     * exercise that is genuinely hard, so it should be done once, not per dot.
     */
    const points = sample(seedInForce(), params.dropped);
    context.fillStyle = 'rgba(11, 107, 138, 0.6)';
    for (const point of points) {
      if (!point.inside) continue;
      context.fillRect(toX(point.x) - 1, toY(point.y) - 1, 2, 2);
    }
    context.fillStyle = 'rgba(155, 44, 44, 0.35)';
    for (const point of points) {
      if (point.inside) continue;
      context.fillRect(toX(point.x) - 1, toY(point.y) - 1, 2, 2);
    }
  };

  const answerBox = document_.createElement('input');
  answerBox.type = 'number';
  answerBox.step = '0.0001';
  answerBox.id = 'sim-answer';
  answerBox.setAttribute('aria-label', 'your estimate of pi');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit estimate');
  const more = document_.createElement('button');
  more.type = 'button';
  more.id = 'sim-more';
  describeControl(more, 'Throw more points');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(answerBox, submit, more);
  root.append(canvas, readout, controls, status, alternative);

  let connection: SimConnection | null = null;

  /**
   * THE RUNNING ESTIMATE AND ITS BAND, SHOWN BEFORE THE STUDENT ANSWERS.
   *
   * The band is in the readout, not only in the feedback, because that is the lesson: the answer to "how
   * accurate is this?" is a function of how many points were thrown, and a student should see that before
   * choosing a number rather than being told afterwards.
   */
  const refresh = (): void => {
    draw();
    const points = sample(seedInForce(), params.dropped);
    const inside = countInside(points);
    const band = toleranceFor(params.dropped);
    const series = convergence(seedInForce(), params.dropped);
    const trend = series.map((row) => `${String(row.n)}: ${format(row.estimate)}`).join('  ');
    readout.textContent =
      `${String(inside)} of ${String(params.dropped)} inside · estimate ${format(estimatePi(points))} ` +
      `· ±${format(band)}`;
    // THE CONVERGENCE SERIES IS ON SCREEN, because "ten times the points is three times the accuracy" is a
    // claim about a curve and the curve is one line long.
    trendReadout.textContent = trend === '' ? '' : `estimate by sample size — ${trend}`;
    alternative.textContent = describeAlternative(params);
  };

  const trendReadout = document_.createElement('p');
  trendReadout.id = 'sim-trend';
  root.insertBefore(trendReadout, controls);

  more.addEventListener('click', () => {
    /**
     * THROWING MORE POINTS EXTENDS THE SAME CLOUD.
     *
     * `sample(seed, n)` regenerates from the seed and takes the first `n`, so raising `dropped` adds to the
     * existing cloud rather than replacing it. That is what makes the button meaningful: the old dots stay
     * where they were and the estimate moves toward pi. A re-roll would make the number jump around for no
     * reason and the convergence curve would be noise.
     */
    const next = Math.min(MAX_SAMPLES, Math.max(200, params.dropped * 2));
    if (next === params.dropped) {
      status.textContent = `That is the maximum of ${String(MAX_SAMPLES)} points.`;
      announce(status, status.textContent ?? '');
      return;
    }
    params = clamp({ ...params, dropped: next });
    refresh();
    status.textContent = `Now ${String(next)} points thrown.`;
    announce(status, status.textContent ?? '');
  });

  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      answerBox.value.trim() === '' ? null : Number(answerBox.value),
      { confidence: 1, explanation: describeTask(params) },
    );
    status.textContent = 'Estimate submitted';
    announce(status, 'Estimate submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        params = paramsFrom((args.params as Record<string, unknown>) ?? {});
        answerBox.value = '';
        refresh();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      if (name === 'loadScenario') {
        // A SMALL sample, so the estimate is visibly wrong and the student has something to improve on.
        // A simulation that opens at 20,000 points shows a good answer on arrival and teaches nothing.
        params = paramsFrom({ samples: 200, dropped: 200, seed: 7 });
        refresh();
        return;
      }
    },
    onSetParams: (next) => {
      params = paramsFrom(next);
      refresh();
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    /**
     * THE STUDENT'S SAVED EXPERIMENT.
     *
     * `seed` AND `dropped` BOTH COME BACK, and the seed is the one that matters. Restoring `dropped` alone
     * would reopen a DIFFERENT cloud of the same size — a different question with the same sample size, and a
     * student who noted their estimate would find it no longer reproducible. This is the first simulation
     * where restoring the state wrongly is not a visual glitch but a change of task.
     */
    onRestore: (state) => {
      if (state === null || typeof state !== 'object') return;
      const s = state as Record<string, unknown>;
      params = clamp({
        samples: Number(s.samples),
        dropped: Number(s.dropped),
        seed: typeof s.seed === 'string' && s.seed !== '' ? s.seed : seedInForce(),
      });
      answerBox.value = typeof s.answer === 'string' ? s.answer : '';
      refresh();
    },
    getState: () => ({
      samples: params.samples,
      dropped: params.dropped,
      // THE SEED IS IN THE STATE. That is the design of this simulation, and `validateState` refuses a state
      // without one.
      seed: seedInForce(),
      /**
       * WHETHER THE SEED CAME FROM THE HOST, carried beside the value rather than inferred from it.
       *
       * The value alone cannot distinguish "the host chose this" from "the manifest default happened to be
       * this" -- and while the per-student bug was live they were equal, so a simulation that ignored the host
       * looked exactly like one that honoured it. A harness reading only the value would have called that
       * correct.
       */
      seedFromHost: hostSeed !== null,
      answer: answerBox.value,
    }),
  };

  const transport = {
    post: (frame: unknown): void => {
      parent?.postMessage(frame, '*');
    },
    subscribe: (handler: (frame: unknown, source: unknown) => void): (() => void) => {
      const listener = (event: MessageEvent): void => {
        const data = event.data as { type?: unknown; seed?: unknown } | null;
        const type = data?.type;
        if (typeof type === 'string') received.push(type);
        /**
         * PRECEDENCE, IN ONE PLACE.
         *
         * `sim:init` sets the host's seed; a later `sim:setParams` clears it. Both frames pass through the
         * transport listener, which is the only place that can tell them apart -- `onSetParams` receives the
         * two identically.
         */
        if (type === 'sim:init' && typeof data?.seed === 'string' && data.seed !== '') {
          hostSeed = data.seed;
        } else if (type === 'sim:setParams') {
          // A PARAMETER CHANGE IS A DELIBERATE INSTRUCTION, and it outranks the host's mount-time choice.
          // This is what lets a manifest's conformance script pin the seed and still get the seed it asked
          // for, while a plain mount honours whatever the host derived.
          hostSeed = null;
        }
        handler(event.data, event.source);
      };
      window_.addEventListener('message', listener);
      return () => window_.removeEventListener('message', listener);
    },
  };

  refresh();

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['estimatePi', 'countInside'],
  });

  return connection;
}
