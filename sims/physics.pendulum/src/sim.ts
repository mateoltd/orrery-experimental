/**
 * The protocol half.  (P6-T11, gold sim 22)
 *
 * ## THIS SIMULATION ADVANCES, AND EVERY OTHER ONE DOES NOT
 *
 * Twenty-one simulations answered `positionAt(t)` — a pure function of a number, so scrubbing backwards was
 * free and saving was one integer. This one INTEGRATES: the angle at step `n + 1` is computed from the angle
 * at step `n`. That is a categorically different contract, and it is the one `plans/10` means by
 * `physics.pendulum | fixed-timestep determinism`.
 *
 * ## AND THE STEP COUNT IS THE STATE, NOT THE TIME
 *
 * The alternative — storing `t` — is what the orrery could afford, because it never integrated. A pendulum's
 * trajectory cannot be recovered from a timestamp without replaying it, so the state is `{angle, velocity,
 * steps}` and the renderer asks for a STEP. `runTo(params, n)` is then a pure function of `(n, params)`, and
 * the same discipline as `positionAt(t)` reasserts itself at the boundary where it is actually needed.
 *
 * ## THE ANIMATION LOOP IS DECORATIVE AND IS SAYING SO
 *
 * `requestAnimationFrame` drives playback, and the loop does NOT compute the physics. It reads the stepper's
 * `t`, converts to an integer step, and asks the model. So a 30 fps laptop and a 144 Hz monitor show the same
 * trajectory, and a dropped frame makes the animation stutter rather than making the answer different.
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
  DT,
  describeAlternative,
  describeTask,
  energy,
  format,
  initialState,
  type PendulumParams,
  radToDeg,
  round,
  runTo,
  timeAt,
} from './model.js';

const SIM_ID = 'physics.pendulum';
const SIM_VERSION = '1.0.0';
const PANEL = 260;
/** Ten seconds of timeline. A long pendulum at 4 m has a period of ~4 s, so this is two and a half swings. */
const MAX_TIME = 10;

const CAPABILITIES: SimCapabilities = {
  // THIS DISAGREED WITH ITS OWN sim.manifest.json, WHICH IS THE AUTHORITATIVE COPY.
  // CLAIMED stepper: true while declaring no controls.stepper and no maxTime. The step BUTTONS
  // are real, which is what made the claim look true, but the host decides from this field.
  // The frame and the manifest must not make different claims about the same file.
  state: true,
  grading: true,
  randomised: false,
  audio: false,
  webgl: false,
  stepper: false,
  scenarios: [],
};

const PARAM_SPECS = {
  length: num({ name: 'length', label: 'length', unit: 'm', min: 0.2, max: 4, default: 1 }),
  start: num({
    name: 'start',
    label: 'start angle',
    unit: 'rad',
    min: -1.05,
    max: 1.05,
    default: 0.5,
  }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): PendulumParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues> as never);
  return clamp({ length: Number(values.length), start: Number(values.start) });
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
  /** THE SIMULATED STATE. Advanced by stepping, never by a frame rate. */
  let state = initialState(params);

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

    const cx = width / 2;
    const pivotY = 24;
    // THE ARM IS DRAWN AT AN ANGLE FROM VERTICAL, and the bob hangs below the pivot.
    const arm = Math.min(width * 0.4, PANEL * 0.7);
    const bx = cx + Math.sin(state.angle) * arm;
    const by = pivotY + Math.cos(state.angle) * arm;

    context.strokeStyle = '#cbd2d9';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, pivotY);
    context.lineTo(width, pivotY);
    context.stroke();

    context.strokeStyle = '#52606d';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(cx, pivotY);
    context.lineTo(bx, by);
    context.stroke();

    context.fillStyle = '#9b2c2c';
    context.beginPath();
    context.arc(bx, by, 9, 0, Math.PI * 2);
    context.fill();

    /**
     * THE TRAIL, AND IT IS WHAT MAKES THE PERIOD VISIBLE.
     *
     * A pendulum drawn at one instant looks like a stick. Drawn with the last second of its path, the
     * oscillation is a curve and the period is something a student can SEE rather than count — which is the
     * difference between a simulation that demonstrates the physics and one that decorates the page.
     */
    context.strokeStyle = 'rgba(11, 107, 138, 0.45)';
    context.lineWidth = 2;
    context.beginPath();
    const trailSteps = Math.floor(0.5 / DT);
    for (let back = 0; back <= trailSteps; back += 1) {
      const past = runTo(params, Math.max(0, state.steps - back));
      const px = cx + Math.sin(past.angle) * arm;
      const py = pivotY + Math.cos(past.angle) * arm;
      if (back === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.stroke();

    context.fillStyle = '#52606d';
    context.font = '13px system-ui, sans-serif';
    context.fillText(
      `step ${String(state.steps)} · t = ${format(timeAt(state.steps))} s`,
      10,
      PANEL - 10,
    );
    context.fillText(`angle ${format(round(radToDeg(state.angle)))}°`, 10, PANEL - 28);
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describeAlternative(params);
    readout.textContent = `t = ${format(timeAt(state.steps))} s · energy ${format(round(energy(state, params.length)))} J`;
  };

  alternative.id = 'sim-text-alternative';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  const readout = document_.createElement('p');
  readout.id = 'sim-readout';
  root.append(canvas, readout, status, alternative);

  /**
   * THE ENERGY GRAPH, as `<svg>` rather than another canvas.
   *
   * A second canvas would have been quicker and would have thrown away the one thing worth keeping: the energy
   * trace is a LINE that a student compares against the theoretical value, so it wants to be an element with a
   * label. And this simulation needs the axes to say `J` and `t`, which canvas cannot do without a parallel
   * implementation.
   */
  const graph = document_.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graph.id = 'sim-energy';
  graph.setAttribute('viewBox', '0 0 240 60');
  graph.setAttribute('width', '100%');
  graph.setAttribute('height', '60');
  graph.setAttribute('role', 'img');
  graph.setAttribute(
    'aria-label',
    'A graph of the pendulum’s total energy against time. A good simulation keeps this line flat.',
  );
  const energyPath = document_.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  energyPath.setAttribute('class', 'sim-energy-line');
  graph.append(energyPath);
  root.append(graph);

  const answer = document_.createElement('input');
  answer.type = 'number';
  answer.step = '0.01';
  answer.id = 'sim-answer';
  answer.setAttribute('aria-label', 'the period in seconds');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit period');
  const stepBack = document_.createElement('button');
  stepBack.type = 'button';
  stepBack.id = 'sim-step-back';
  describeControl(stepBack, 'Step back');
  const stepForward = document_.createElement('button');
  stepForward.type = 'button';
  stepForward.id = 'sim-step-forward';
  describeControl(stepForward, 'Step forward');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(stepBack, stepForward, answer, submit);
  root.append(controls);

  let connection: SimConnection | null = null;

  /** THE ENERGY TRACE, resampled. The same `energy` the grader would use. */
  const drawEnergy = (): void => {
    const steps = state.steps;
    if (steps < 2) {
      energyPath.setAttribute('points', '');
      return;
    }
    // SAMPLE THE WHOLE TRAJECTORY, not the last N steps, so the graph shows the flatness of the whole run
    // rather than a window that could be flat by accident.
    const sampleCount = 60;
    const every = Math.max(1, Math.floor(steps / sampleCount));
    const points: string[] = [];
    for (let index = 0; index <= steps; index += every) {
      const at = runTo(params, index);
      // `String(x).toFixed(1)` THROWS. `String` has already produced a string, and `toFixed` is a method
      // of `Number`, so the energy graph raised `TypeError: ...toFixed is not a function` on every frame
      // it tried to draw -- and JavaScript discarding the extra argument is why the surrounding tests
      // stayed green: nothing here is covered, and the failure was in a canvas path, not a graded one.
      points.push(
        `${((index / steps) * 240).toFixed(1)},${(55 - energy(at, params.length) * 8).toFixed(1)}`,
      );
    }
    energyPath.setAttribute('points', points.join(' '));
  };

  /** ONE STEP, OR A WHOLE NUMBER OF THEM, AND NOTHING ELSE. */
  const advance = (steps: number): void => {
    const target = Math.min(
      Math.round(timeAt(MAX_TIME) / DT),
      state.steps + Math.max(-240, Math.min(240, steps)),
    );
    state = runTo(params, Math.max(0, target));
    refresh();
    drawEnergy();
  };

  stepForward.addEventListener('click', () => {
    advance(24);
    announce(status, `Step ${String(state.steps)}.`);
  });
  stepBack.addEventListener('click', () => {
    advance(-24);
    announce(status, `Step ${String(state.steps)}.`);
  });
  submit.addEventListener('click', () => {
    connection?.bridge?.reportAnswer(answer.value.trim() === '' ? null : Number(answer.value), {
      confidence: 1,
      explanation: describeTask(params),
    });
    status.textContent = 'Period submitted';
    announce(status, 'Period submitted.');
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'reset') {
        params = paramsFrom((args.params as Record<string, unknown>) ?? {});
        state = initialState(params);
        answer.value = '';
        refresh();
        drawEnergy();
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      if (name === 'step') {
        // THE HOST'S OWN STEP BUTTON. `dt` is in SECONDS and is converted to WHOLE STEPS — a fractional step
        // would leave the trajectory un-reproducible, because step 100.5 is not a state this simulation can
        // return to.
        advance(Math.round(Number(args.dt ?? 0.1) / DT));
        return;
      }
      if (name === 'loadScenario') {
        params = paramsFrom({ length: 2, start: 0.6 });
        state = initialState(params);
        refresh();
        drawEnergy();
        return;
      }
    },
    onSetParams: (next) => {
      params = paramsFrom(next);
      state = initialState(params);
      refresh();
      drawEnergy();
    },
    onRequestState: () => {},
    onVisibility: () => {},
    onTeardown: () => {
      connection?.dispose();
    },
    /**
     * THE STUDENT'S SAVED PENDULUM.
     *
     * `angle`, `velocity` AND `steps` all come back. Steps alone is not enough to resume — the trajectory
     * after step 400 depends on the velocity at step 400, not just the angle — and angle alone would be worse,
     * because the simulation would silently restart with zero velocity and look like a different pendulum.
     */
    onRestore: (saved) => {
      if (saved === null || typeof saved !== 'object') return;
      const s = saved as Record<string, unknown>;
      params = paramsFrom({ length: Number(s.length), start: Number(s.start) });
      state = {
        angle: Number(s.angle),
        velocity: Number(s.velocity),
        steps: Math.max(0, Math.round(Number(s.steps))),
      };
      if (typeof s.answer === 'string') answer.value = s.answer;
      refresh();
      drawEnergy();
    },
    getState: () => ({
      length: params.length,
      start: params.start,
      angle: state.angle,
      velocity: state.velocity,
      steps: state.steps,
      answer: answer.value,
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
  drawEnergy();

  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['smallAnglePeriod', 'energy'],
  });

  return connection;
}
