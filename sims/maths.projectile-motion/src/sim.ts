/**
 * The simulation's protocol entry. Browser only, inside the sandboxed frame.  (P6-T9)
 *
 * ## WHY THIS FILE EXISTS AND WHY IT IS NOT IN `browser.ts`
 *
 * `browser.ts` renders. This file *converses*: it completes the handshake, answers commands, reports
 * state and emits the answer. Keeping them apart is not tidiness — a simulation that renders without
 * speaking is a picture of a simulation, and the conformance suite exists precisely because a
 * plausible-looking canvas is the easiest way to ship something that cannot be graded.
 *
 * ## THE SEQUENCE IS NOT OPTIONAL
 *
 * `sim:init` must arrive before anything else, because the nonce arrives with it and every outbound
 * frame echoes the nonce. `createHostBridge` refuses anything called before that, which is the correct
 * place for the refusal: locally, rather than by emitting a frame the host will drop as
 * unauthenticated.
 *
 * ## `'*'` IS THE TARGET ORIGIN HERE, AND ONLY HERE
 *
 * The host knows its own origin and posts to it. A sandboxed sim has no way to know the host's origin
 * — `document.referrer` is suppressed and `parent.origin` is not a thing — so the sim posts to `'*'`.
 * That is safe in this direction precisely because the *host* is the one that authenticates: it checks
 * `event.source` and the nonce on every inbound frame, and this sim is `allow-scripts` with no
 * `allow-same-origin`, so it holds no origin the host could be tricked into trusting.
 */

import {
  announce,
  type BridgeHandlers,
  bool,
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
import { checksumState } from '@orrery/sim-sdk/state';
import { apex, flightTime, type ProjectileParams, range, simulate, trajectory } from './model.js';

const SIM_ID = 'maths.projectile-motion';
const SIM_VERSION = '1.0.0';
const GRAPH_HEIGHT = 260;

const CAPABILITIES: SimCapabilities = {
  // Stated, not probed. A host that grants these and gets nothing is a broken host; a sim that claims
  // them and cannot deliver is a broken sim. Conformance checks the promise both ways.
  grading: true,
  stepper: true,
  scenarios: [],
};

/**
 * Read the host's params through the SDK's trust boundary.
 *
 * ## `clampParams(specs, supplied)`, AND NOTHING ELSE
 *
 * `params` arrive from the host and are not trusted: a hand-edited block can put anything there. The
 * first version of this file wrote its own `num(raw.speed, 25)` coercion -- and `num` is a SPEC BUILDER
 * that takes an options object, so passing a number read `spec.step` off `undefined` and the simulation
 * threw before it rendered anything. Every value here goes through `clampParams`, which is the one place
 * that knows about absent values, empty strings, non-numbers and ranges.
 */
const PARAM_SPECS = {
  speed: num({ name: 'speed', label: 'Launch speed', unit: 'm/s', min: 5, max: 60, default: 25 }),
  angle: num({
    name: 'angle',
    label: 'Launch angle',
    unit: 'degrees',
    min: 5,
    max: 85,
    default: 45,
  }),
  showTrail: bool({
    name: 'showTrail',
    label: 'Show trail',
    default: true,
  }),
};

const paramsFrom = (raw: Readonly<Record<string, unknown>>): SimParams => {
  const { values } = clampParams(PARAM_SPECS, raw as Partial<ParamValues>);
  return {
    speed: Number(values.speed),
    angle: Number(values.angle),
    showTrail: values.showTrail === true,
  };
};

/**
 * What the host configures, plus what the model needs.
 *
 * `gravity` is NOT a host parameter: the manifest does not declare it, so it can never arrive, and
 * omitting it handed `flightTime` a params object with `gravity: undefined` -- which is NaN, which
 * `initialStepper` rejected with a RangeError. A value that is not configurable is not a parameter.
 */
interface SimParams {
  readonly speed: number;
  readonly angle: number;
  readonly showTrail: boolean;
  readonly gravity: number;
}

/** Earth gravity, fixed. A simulation about projectiles that lets a teacher set `g` is a different sim. */
const GRAVITY = 9.81;

const modelParams = (params: SimParams): ProjectileParams => ({
  speed: params.speed,
  angle: params.angle,
  gravity: params.gravity ?? GRAVITY,
});

export interface SimRuntime {
  readonly connection: SimConnection;
  readonly stepper: Stepper;
  /** Everything the conformance harness needs, and nothing a student could use. */
  readonly debug: Readonly<{
    readonly params: () => ProjectileParams;
    readonly answer: () => { range: number; time: number };
    readonly trailLength: () => number;
  }>;
}

export function startSim(document_: Document, window_: Window, parent: Window | null): SimRuntime {
  const root = document_.getElementById('sim-root') ?? document_.body;
  const canvas = document_.createElement('canvas');
  const status = document_.createElement('p');
  const alternative = document_.createElement('p');

  let params = paramsFrom({});
  let stepper = createStepper({
    maxTime: flightTime(modelParams(params)),
    stepSize: 0.05,
    timeScale: 1,
  });
  let trail: Array<{ x: number; y: number }> = [];

  const currentAnswer = (): { range: number; time: number } => {
    const physics = modelParams(params);
    return {
      range: Math.round(range(physics) * 100) / 100,
      time: Math.round(flightTime(physics) * 100) / 100,
    };
  };

  const describe = (): string => {
    const a = currentAnswer();
    return (
      `At ${String(params.speed)} metres per second and ${String(params.angle)} degrees, the ball lands ` +
      `${String(a.range)} metres away after ${String(a.time)} seconds.`
    );
  };

  // Always in the DOM, and never `display:none`: a hidden alternative is not an alternative.
  alternative.id = 'sim-text-alternative';
  alternative.textContent = describe();
  canvas.id = 'sim-canvas';
  status.id = 'sim-status';
  status.setAttribute('role', 'status');
  root.append(canvas, status, alternative);

  const draw = (): void => {
    const width = root.clientWidth || 640;
    canvas.width = width;
    canvas.height = GRAPH_HEIGHT;
    canvas.style.width = '100%';
    canvas.style.height = `${String(GRAPH_HEIGHT)}px`;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, width, GRAPH_HEIGHT);
    context.strokeStyle = '#1f2933';
    context.lineWidth = 1;
    // The model's params, NOT the host's: `params` carries `showTrail` and no `gravity`, and handing it
    // to the model is how `flightTime` produced NaN once already.
    const physics = modelParams(params);
    const span = Math.max(range(physics) * 1.1, 1);
    const scaleX = width / span;
    const toX = (x: number): number => x * scaleX;
    const toY = (y: number): number => GRAPH_HEIGHT - y * scaleX;
    context.beginPath();
    for (const point of trajectory(physics)) {
      const x = toX(point.x);
      const y = toY(point.y);
      if (point.t === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    const here = simulate(physics, { t: stepper.get().t }, stepper.get().t);
    context.fillStyle = '#9b2c2c';
    context.beginPath();
    context.arc(toX(here.x), toY(here.y), 5, 0, Math.PI * 2);
    context.fill();
  };

  const refresh = (): void => {
    draw();
    alternative.textContent = describe();
  };

  // The controls. Built here rather than by a framework, and every one of them a real focusable
  // element: conformance tabs through them, and a control that only responds to a mouse is not a
  // control.
  const play = document_.createElement('button');
  play.type = 'button';
  play.id = 'sim-play';
  describeControl(play, 'Play');
  const step = document_.createElement('button');
  step.type = 'button';
  step.id = 'sim-step';
  describeControl(step, 'Step forward one frame');
  const submit = document_.createElement('button');
  submit.type = 'button';
  submit.id = 'sim-submit';
  describeControl(submit, 'Submit answer');
  const scrub = document_.createElement('input');
  scrub.type = 'range';
  scrub.id = 'sim-scrub';
  scrub.min = '0';
  scrub.max = String(stepper.get().maxTime);
  scrub.step = String(stepper.get().stepSize);
  scrub.setAttribute('aria-label', 'Time');
  const controls = document_.createElement('div');
  controls.id = 'sim-controls';
  controls.append(play, step, scrub, submit);
  root.append(controls);

  let running = false;
  play.addEventListener('click', () => {
    running = !running;
    play.setAttribute('aria-pressed', String(running));
    status.textContent = running ? 'Running' : 'Paused';
    announce(status, status.textContent ?? '');
  });
  step.addEventListener('click', () => {
    stepper.step(1);
    refresh();
  });
  scrub.addEventListener('input', () => {
    stepper.seek(Number(scrub.value));
    refresh();
  });
  // Declared before the handlers so the click handler below can close over it. A `let` rather than a
  // getter, because the connection exists from the start and the bridge only after `sim:init`.
  let connection: SimConnection | null = null;
  submit.addEventListener('click', () => {
    // The answer goes to the host, never to a server the sim chooses.
    connection?.bridge?.reportAnswer(currentAnswer(), { confidence: 1, explanation: describe() });
    status.textContent = 'Answer submitted';
    announce(status, 'Answer submitted.');
  });

  const restart = (next: SimParams): void => {
    params = { ...next, gravity: GRAVITY };
    trail = [];
    stepper = createStepper({
      maxTime: flightTime(modelParams(params)),
      stepSize: 0.05,
      timeScale: 1,
    });
    scrub.max = String(stepper.get().maxTime);
    refresh();
  };

  const snapshot = (): Record<string, unknown> => ({
    params,
    t: stepper.get().t,
    maxTime: stepper.get().maxTime,
    stepSize: stepper.get().stepSize,
    running,
    // The checksum is over the VALUES, so a state that round-trips byte-identically is provably the
    // same state rather than merely a similar one.
    checksum: checksumState({ params, t: stepper.get().t }),
  });

  const handlers: BridgeHandlers = {
    onResize: () => {
      draw();
    },
    onCommand: (name, args) => {
      if (name === 'play') {
        running = true;
        play.setAttribute('aria-pressed', 'true');
        status.textContent = 'Running';
        return;
      }
      if (name === 'pause') {
        running = false;
        play.setAttribute('aria-pressed', 'false');
        status.textContent = 'Paused';
        return;
      }
      if (name === 'step') {
        stepper.step(Number(args.step ?? 1));
        refresh();
        return;
      }
      if (name === 'reset') {
        restart(paramsFrom(args.params ?? {}));
        return;
      }
      if (name === 'loadScenario') {
        restart(paramsFrom(args.params ?? {}));
        return;
      }
      if (name === 'focus') {
        focusEntryPoint(root);
        return;
      }
      if (name === 'setTheme') return;
    },
    onSetParams: (next, seed) => {
      // A seed is honoured by the model only as a tie-break for the trail sample count; the physics is
      // deterministic regardless, which is what lets the grader agree with the screen.
      void seed;
      restart(paramsFrom(next));
    },
    onRequestState: () => {
      connection?.bridge?.reportState(snapshot());
    },
    onVisibility: (visible) => {
      // A hidden tab stops the clock. A timeline that advances while a student is looking something
      // up is a timeline they cannot reason about.
      if (!visible) running = false;
    },
    onTeardown: () => {
      running = false;
      connection?.dispose();
    },
    getState: () => snapshot(),
  };

  const transport = {
    post: (frame: unknown): void => {
      // `'*'` because a sandboxed sim cannot learn the host's origin, and the host authenticates
      // every inbound frame by source and nonce. See the file header.
      parent?.postMessage(frame, '*');
    },
    subscribe: (handler: (frame: unknown, source: unknown) => void): (() => void) => {
      const listener = (event: MessageEvent): void => {
        handler(event.data, event.source);
      };
      window_.addEventListener('message', listener);
      return () => window_.removeEventListener('message', listener);
    },
  };

  refresh();
  focusEntryPoint(root);

  // `connectSim`, not `createHostBridge`: the bridge cannot be built until `sim:init` arrives, and
  // that wait is the SDK's job rather than something every gold sim re-implements.
  connection = connectSim({
    transport,
    handlers,
    expectedSimId: SIM_ID,
    expectedVersion: SIM_VERSION,
    capabilities: CAPABILITIES,
    exports: ['range', 'flightTime', 'apex'],
  });

  return {
    connection,
    stepper,
    debug: {
      params: () => ({ speed: params.speed, angle: params.angle, gravity: params.gravity }),
      answer: currentAnswer,
      trailLength: () => trail.length,
    },
  };
}

export type { ParamValues };
/** `apex` and `trajectory` are re-exported so the harness can assert against the model, not a copy. */
export { apex, flightTime, range, simulate, trajectory };
