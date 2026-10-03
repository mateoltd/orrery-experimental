/**
 * The protocol half.  (P6-T11, gold sim 24)
 *
 * ## THE FIRST SIMULATION WHOSE STATE IS A THOUSAND THINGS, AND THAT IS THE CORNER
 *
 * Twenty-three simulations so far, and the largest state was a list of forty comparisons. This one holds a
 * thousand particles with positions and velocities, which is `plans/10`'s "large state, event-driven" corner.
 * It exists partly for the chemistry and partly because until now nothing in the tree was big enough to
 * exercise the bundle budget or the state checksum at size.
 *
 * ## AND IT ADVANCES, FOR THE PENDULUM'S REASON
 *
 * A particle's next position comes from its current position and velocity, so this INTEGRATES rather than
 * evaluating a picture from a clock. That brings the pendulum's discipline with it: a FIXED `dt`, a step COUNT
 * as the state, and `runTo(params, seed, step)` pure in its arguments. A frame-rate-dependent gas would give a
 * different collision count on a 144 Hz monitor than on a 60 Hz one, which here is not a rendering detail but
 * a different answer.
 *
 * ## AND THE COUNTER IS THE PRIMARY DISPLAY, NOT A DETAIL
 *
 * Every previous simulation drew a POSITION and the number was secondary. This one's question IS a number, so
 * the counter is large and the dots are the evidence for it -- the reverse of every other layout.
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
  DEFAULT_BOX,
  describeAlternative,
  describeTask,
  format,
  type GasParams,
  type GasState,
  KELVIN_MAX,
  KELVIN_MIN,
  MAX_PARTICLES,
  MAX_SEED,
  MIN_PARTICLES,
  PARTICLES,
  runTo,
  STEPS_PER_SECOND,
  seededParticles,
  WARMUP_STEPS,
} from './model.js';

const SIM_ID = 'chemistry.particle-view';
const SIM_VERSION = '1.0.0';
const PANEL = 340;

const CAPABILITIES: SimCapabilities = {
  state: true,
  grading: true,
  stepper: false,
  scenarios: [],
};

const PARAM_SPECS = {
  kelvin: num({
    name: 'kelvin',
    label: 'temperature',
    unit: 'K',
    min: KELVIN_MIN,
    max: KELVIN_MAX,
    default: 300,
  }),
  box: num({ name: 'box', label: 'side', unit: 'm', min: 0.05, max: 0.5, default: DEFAULT_BOX }),
  particles: num({
    name: 'particles',
    label: 'atoms',
    unit: '',
    min: MIN_PARTICLES,
    max: MAX_PARTICLES,
    default: PARTICLES,
  }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): GasParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues> as never);
  return clamp({
    kelvin: Number(values.kelvin),
    box: Number(values.box),
    particles: Number(values.particles),
  });
};

export function startSim(
  document_: Document,
  window_: Window,
  parent: Window | null,
): SimConnection {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const canvas = document_.createElement('canvas');
  const counter = document_.createElement('p');
  const task = document_.createElement('p');
  const alternative = document_.createElement('p');
  const status = document_.createElement('p');
  const received: string[] = [];
  const errors: string[] = [];
  (window_ as unknown as { __simReceived?: string[] }).__simReceived = received;
  (window_ as unknown as { __simErrors?: string[] }).__simErrors = errors;
  window_.addEventListener('error', (event: ErrorEvent) => {
    errors.push(String(event.message));
  });

  let params = paramsFrom({});
  let seed = 20240;
  let step = 0;
  let connection: SimConnection | null = null;
  /** The state being drawn. Recomputed from `(params, seed, step)` so the scrub is pure. */
  let state: GasState = runTo(params, seed, 0);

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

    // THE BOX, and a margin so the walls are visible rather than implied by the dots stopping.
    const margin = 12;
    const size = Math.max(40, Math.min(width - margin * 2, PANEL - 60));
    const left = (width - size) / 2;
    const top = 16;
    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.strokeRect(left, top, size, size);

    /**
     * A THOUSAND DOTS, DRAWN IN ONE PASS.
     *
     * `fillRect` per atom rather than an arc each: a thousand `arc` calls is a thousand path constructions,
     * and the first version of this drew circles and dropped frames on a laptop. The atom is a dot, and at this
     * size the difference is invisible while the difference in cost is not.
     */
    const scale = size / params.box;
    context.fillStyle = '#3d5a80';
    for (const particle of state.particles) {
      context.fillRect(left + particle.x * scale - 1, top + particle.y * scale - 1, 2, 2);
    }

    /**
     * THE COUNTER, LARGE, BECAUSE IT IS THE THING BEING ASKED ABOUT.
     *
     * And the rate beside it, DIFFERENCED OVER THE WINDOW rather than counted from step zero -- because the
     * count from step zero is the drifting number, and showing it as "collisions per second" would point the
     * student at the wrong figure for the first second of the simulation.
     */
    context.fillStyle = '#102a43';
    context.font = 'bold 19px system-ui, sans-serif';
    context.textAlign = 'left';
    const seconds = step / STEPS_PER_SECOND;
    const rate =
      step > WARMUP_STEPS
        ? ((state.collisions - runTo(params, seed, WARMUP_STEPS).collisions) /
            (step - WARMUP_STEPS)) *
          STEPS_PER_SECOND
        : 0;
    context.fillText(`collisions: ${String(state.collisions)}`, 12, PANEL - 26);
    context.font = '13px system-ui, sans-serif';
    context.fillText(
      step <= WARMUP_STEPS
        ? `t = ${seconds.toFixed(2)} s — let it settle before reading a rate`
        : `t = ${seconds.toFixed(2)} s — ${format(rate, 0)} per second since the settle`,
      12,
      PANEL - 8,
    );
  };

  const setStep = (next: number): void => {
    const bounded = Math.min(Math.max(Math.round(next), 0), STEPS_PER_SECOND * 20);
    if (bounded === step) return;
    step = bounded;
    state = runTo(params, seed, step);
    draw();
  };

  task.id = 'sim-task';
  task.textContent = describeTask(params);
  counter.id = 'sim-counter';
  alternative.id = 'sim-alternative';
  alternative.textContent = describeAlternative(params);
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(task, canvas, counter, alternative, status);
  describeControl(canvas, describeTask(params));
  focusEntryPoint(document_, canvas);
  draw();

  /**
   * THE ANIMATION LOOP IS DECORATIVE AND SAYS SO.
   *
   * `requestAnimationFrame` advances the step index and asks the model. It does NOT compute any physics, so a
   * 30 fps laptop and a 144 Hz monitor show the same gas: a dropped frame makes the animation stutter rather
   * than making the answer different. This is the pendulum's discipline, and it is why `step` is the state.
   */
  let playing = false;
  let handle = 0;
  let lastFrame = 0;
  const tick = (now: number): void => {
    if (!playing) return;
    // TWO STEPS PER FRAME regardless of elapsed time: the simulation's clock is `STEPS_PER_SECOND`, and tying
    // it to wall-clock frames would reintroduce exactly the frame-rate dependence this design removes.
    setStep(step + 2);
    lastFrame = now;
    handle = window_.requestAnimationFrame(tick);
  };
  const play = (): void => {
    if (playing) return;
    playing = true;
    lastFrame = 0;
    handle = window_.requestAnimationFrame(tick);
    announce(status, 'Running.');
  };
  const pause = (): void => {
    playing = false;
    if (handle !== 0) window_.cancelAnimationFrame(handle);
    announce(status, 'Paused.');
  };

  /**
   * THE ANSWER IS TYPED, because a rate is not something a pointer can read off a picture.
   *
   * There is no marker to drag and no region to click, so the box IS the whole answer surface -- and omitting it
   * failed three conformance cells at once with "the sim has no #sim-answer field", which reads like a runner
   * problem rather than a missing control.
   */
  const answerBox = document_.createElement('input');
  answerBox.type = 'number';
  answerBox.id = 'sim-answer';
  answerBox.min = '0';
  answerBox.step = '1';
  answerBox.setAttribute('aria-label', 'collisions per second');
  describeControl(answerBox, 'Collisions per second');

  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  submit.textContent = 'Submit';
  describeControl(submit, 'Submit answer');

  const controls = document_.createElement('div');
  controls.className = 'sim-controls';
  controls.append(answerBox, submit);
  root.append(controls);

  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(
      answerBox.value.trim() === '' ? null : Number(answerBox.value),
      { confidence: 1, explanation: describeTask(params) },
    );
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => draw(),
    onCommand: (name) => {
      if (name === 'reset') {
        params = paramsFrom({});
        task.textContent = describeTask(params);
        alternative.textContent = describeAlternative(params);
        setStep(0);
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(document_, canvas);
        return;
      }
      if (name === 'play' || name === 'toggle') {
        if (playing) pause();
        else play();
        return;
      }
      if (name === 'pause') {
        pause();
      }
    },
    onSetParams: (next) => {
      params = paramsFrom(next);
      task.textContent = describeTask(params);
      alternative.textContent = describeAlternative(params);
      // A NEW GAS RESETS THE CLOCK, or the counter would be totalling collisions of a gas nobody has seen.
      setStep(0);
    },
    onRequestState: () => {},
    onVisibility: (visible) => {
      // A HIDDEN TAB MUST NOT ACCUMULATE STEPS. Without this the gas runs on while nobody is looking and the
      // student returns to a counter far past the point they left it.
      if (!visible) pause();
    },
    onTeardown: () => {
      pause();
      connection?.dispose();
    },
    onRestore: (saved) => {
      /**
       * THE RESTORED STATE IS A SEED AND A STEP COUNT, NEVER A PICTURE.
       *
       * The dots are recomputed by replaying from step zero, so a restored view cannot disagree with the
       * counter printed beside it. A thousand stored positions would also be a large state for no benefit: the
       * whole design rests on the trace being derivable.
       */
      if (saved === null || typeof saved !== 'object') return;
      const s = saved as Record<string, unknown>;
      params = paramsFrom({
        kelvin: Number(s.kelvin),
        box: Number(s.box),
        particles: Number(s.particles),
      });
      seed = clampSeedValue(s.seed);
      task.textContent = describeTask(params);
      alternative.textContent = describeAlternative(params);
      answerBox.value = typeof s.answer === 'string' ? s.answer : '';
      setStep(typeof s.step === 'number' ? s.step : 0);
    },
    getState: () => ({
      kelvin: params.kelvin,
      box: params.box,
      particles: params.particles,
      seed,
      step,
      // THE COUNTER TRAVELS WITH THE STATE, because it is what the student was watching.
      collisions: state.collisions,
      lastCollisions: state.lastCollisions,
      // The typed answer is part of the work: restoring the gas and the counter without it would leave an
      // empty box beside a fully-answered question.
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
        if (typeof data?.type === 'string') received.push(data.type);
        /**
         * THE HOST'S SEED, TAKEN FROM `sim:init` ONLY.
         *
         * This simulation is not `randomised` -- every atom moves at the one speed the temperature implies -- so
         * it has no question to vary between students, and it must NOT silently adopt a per-student seed that
         * would change nothing but the restore path.
         */
        if (data?.type === 'sim:init' && typeof data.seed === 'string' && data.seed !== '') {
          seed = clampSeedValue(data.seed);
        }
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
    exports: ['runTo', 'settledRate', 'seededParticles'],
  });

  // `seededParticles` is exported so a reader can reproduce the opening arrangement, which is the only way to
  // check the counter against the atoms it came from.
  void seededParticles;
  void lastFrame;
  return connection;
}

const clampSeedValue = (raw: unknown): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(MAX_SEED, Math.max(0, Math.round(value))) : 20240;
};
