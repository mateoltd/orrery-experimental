/**
 * The stepper: play, pause, step, scrub.  (P6-T3)
 *
 * ## WHY THE STATE MACHINE IS SEPARATE FROM THE WIDGETS
 *
 * A stepper is four buttons, a slider and an animation loop, and the loop is the part with bugs:
 * it must not run when the tab is hidden, it must not run when the student asked for reduced motion,
 * and a `step` pressed during a `play` must land on an exact value rather than wherever the loop
 * happened to be.
 *
 * So the LOGIC is a pure reducer here and the widgets are a thin layer over it. The reducer is
 * testable without a browser and without a clock, and it is where the fixed-timestep promise in the
 * manifest (`physics.pendulum` stresses exactly this) actually lives.
 *
 * ## FIXED TIMESTEP, NOT "WHATEVER THE FRAME DELTA SAYS"
 *
 * A frame delta varies with load, so integrating against it makes the same student's run produce
 * different numbers on a busy laptop and a quiet one — and then the recorded answer cannot be
 * reproduced from the recorded state. So `advance` consumes whole fixed steps and carries the
 * remainder, which is the only way a scrubbed timeline and a played timeline agree.
 */

export type StepperStatus = 'idle' | 'playing' | 'paused';

export interface StepperState {
  readonly status: StepperStatus;
  /** Sim time in the sim's own unit, always a multiple of `stepSize`. */
  readonly t: number;
  readonly maxTime: number;
  /** Sim-time units per step. NOT milliseconds — see `timeScale`. */
  readonly stepSize: number;
  /**
   * Sim-time units per REAL SECOND. 1 means the sim runs in real time.
   *
   * This is the only place the two clocks meet. Without it the reducer compares a frame delta with a
   * step size in different units, which is not a small error: see `advance`'s `dt`.
   */
  readonly timeScale: number;
  /**
   * Sim time accumulated but not yet a whole step.
   *
   * Part of the state, not a local, because it must survive a save/restore: a restored sim with the
   * same `t` but no carry would drift from the one it was saved from, and `physics.pendulum` exists
   * to break exactly this assumption.
   */
  readonly carry: number;
  /** Total steps taken, including backwards ones. Reported as telemetry, not used for physics. */
  readonly steps: number;
  /** Set while the student is dragging the scrubber, so a resize or a `setParams` can defer. */
  readonly scrubbing: boolean;
}

export type StepperAction =
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  | { readonly type: 'toggle' }
  | { readonly type: 'step'; readonly direction?: 1 | -1 }
  | { readonly type: 'scrubTo'; readonly t: number }
  | { readonly type: 'scrubStart' }
  | { readonly type: 'scrubEnd' }
  | {
      readonly type: 'advance';
      /**
       * Elapsed REAL time in SECONDS, fractional: 0.0167 for a 60 fps frame.
       *
       * Seconds, not milliseconds. The first version took milliseconds and multiplied by a `timeScale`
       * that was read as seconds, so a single 16.7 ms frame advanced the sim by 16.5 of its own
       * seconds — and a 60 fps pendulum reached the end of its timeline before the first frame was
       * painted. A unit error in one conversion is a completely broken simulation, silently.
       */
      readonly dt: number;
    }
  | { readonly type: 'reset' }
  | { readonly type: 'setMaxTime'; readonly maxTime: number };

/**
 * The most steps one `advance` may consume, however long the tab was hidden.
 *
 * A tab that was hidden for ten minutes returns with a `dt` of 600 000, and consuming all of it would
 * be 600 000 steps of work in a single frame: a locked tab, discovered by the student, on the slowest
 * machine in the room. So past the cap the surplus is DISCARDED — the timeline falls behind rather
 * than the browser freezing, which is the right way round for a simulation.
 */
export const MAX_CATCHUP_STEPS = 240;

/**
 * Tolerance, as a fraction of a step, when asking "is there a whole step yet?".
 *
 * Float addition does not land on exact values, and `Math.floor` is not tolerant. See the `advance`
 * case for what a missing tolerance costs.
 */
export const CARRY_EPSILON = 1e-9;

const clampToRange = (t: number, maxTime: number, stepSize: number): number => {
  const steps = Math.round(t / stepSize);
  const bounded = Math.max(0, Math.min(steps, Math.round(maxTime / stepSize)));
  return bounded * stepSize;
};

export function initialStepper(input: {
  readonly maxTime: number;
  /** Sim-time units per step. */
  readonly stepSize: number;
  /** Sim-time units per REAL SECOND. Defaults to 1. */
  readonly timeScale?: number;
}): StepperState {
  if (!Number.isFinite(input.maxTime) || input.maxTime <= 0) {
    throw new RangeError(
      `stepper: maxTime must be a positive finite number, got ${String(input.maxTime)}`,
    );
  }
  if (!Number.isFinite(input.stepSize) || input.stepSize <= 0) {
    throw new RangeError(
      `stepper: stepSize must be a positive finite number, got ${String(input.stepSize)}`,
    );
  }
  const timeScale = input.timeScale ?? 1;
  if (!Number.isFinite(timeScale) || timeScale <= 0) {
    throw new RangeError(
      `stepper: timeScale must be positive and finite, got ${String(timeScale)}`,
    );
  }
  return {
    status: 'idle',
    t: 0,
    maxTime: input.maxTime,
    stepSize: input.stepSize,
    timeScale,
    carry: 0,
    steps: 0,
    scrubbing: false,
  };
}

/**
 * The reducer.
 *
 * ## `scrubEnd` DOES NOT STOP THE PLAYBACK ON ITS OWN
 *
 * Dragging the scrubber while playing is a normal thing to do and the loop should resume afterwards,
 * because the student was watching something move. So `scrubStart` records the intent and `scrubEnd`
 * restores it, rather than leaving a sim paused after every correction.
 *
 * ## `t` IS ALWAYS A MULTIPLE OF `stepSize`
 *
 * Even after a scrub. A student who drags the scrubber to an arbitrary pixel should get the nearest
 * step, not a state the stepper itself cannot reproduce — otherwise `scrubTo(0.37)` followed by
 * `step` gives different answers depending on which came first.
 */
export function stepperReduce(state: StepperState, action: StepperAction): StepperState {
  switch (action.type) {
    case 'play': {
      // Playing at the end restarts, which is what a student pressing play at the end expects. It is
      // also the only alternative to a play button that appears to do nothing.
      if (state.t >= state.maxTime) return { ...state, status: 'playing', t: 0 };
      return { ...state, status: 'playing' };
    }
    case 'pause':
      return state.status === 'paused' ? state : { ...state, status: 'paused' };
    case 'toggle':
      return stepperReduce(
        state,
        state.status === 'playing' ? { type: 'pause' } : { type: 'play' },
      );
    case 'step': {
      const direction = action.direction ?? 1;
      const next = clampToRange(
        state.t + direction * state.stepSize,
        state.maxTime,
        state.stepSize,
      );
      // A step PAUSES. A single step while an animation is running produces a blur of states, and a
      // student pressing step is asking for one.
      return { ...state, t: next, status: 'paused', steps: state.steps + 1 };
    }
    case 'scrubStart':
      return { ...state, scrubbing: true };
    case 'scrubTo':
      return { ...state, t: clampToRange(action.t, state.maxTime, state.stepSize) };
    case 'scrubEnd':
      return { ...state, scrubbing: false };
    case 'advance': {
      if (state.status !== 'playing' || state.scrubbing) return state;
      if (!Number.isFinite(action.dt) || action.dt <= 0) return state;
      // `dt` is real SECONDS and `timeScale` is sim units per real second, so this is the only
      // conversion between the two clocks and it happens here and nowhere else.
      const simDt = action.dt * state.timeScale;
      const carry = state.carry + simDt;
      // A fraction of a step accumulated by repeated addition is never exactly a fraction. After
      // `advance(2.4)` the carry is 0.3999999999999999, and adding 0.1 gives 0.4999999999999999, whose
      // ratio to a 0.5 step is 0.9999999999999998 -- so `Math.floor` returns ZERO and the step is
      // silently dropped. The timeline then drifts by one step roughly every fifty frames, which no
      // screenshot catches and which makes a recorded state diverge from a replay.
      //
      // So the comparison carries a tolerance. It is 1e-9 of a step, which is orders of magnitude
      // above float noise and orders of magnitude below any time a student can perceive.
      const wanted = Math.floor((carry + CARRY_EPSILON * state.stepSize) / state.stepSize);
      if (wanted <= 0) return { ...state, carry };
      const consumed = Math.min(wanted, MAX_CATCHUP_STEPS);
      const next = clampToRange(state.t + consumed * state.stepSize, state.maxTime, state.stepSize);
      const steps = state.steps + consumed;
      // The leftover is always KEPT. When the cap discarded some steps, `consumed * stepSize` is less
      // than the elapsed sim time, so the surplus — plus the sub-step remainder — is dropped and the
      // timeline falls behind rather than the browser freezing.
      const leftover = carry - consumed * state.stepSize;
      // Reaching the end stops, rather than spinning at `maxTime` forever. A loop that never stops is
      // a battery complaint from a student's parent.
      return next >= state.maxTime
        ? { ...state, t: next, status: 'paused', steps, carry: 0 }
        : { ...state, t: next, steps, carry: Math.max(0, leftover) };
    }
    case 'reset':
      // The carry goes too. Leaving it means a reset sim resumes mid-step, which is invisible on
      // screen and visible in a restored state.
      return { ...state, t: 0, status: 'idle', steps: 0, carry: 0 };
    case 'setMaxTime': {
      if (!Number.isFinite(action.maxTime) || action.maxTime <= 0) return state;
      return {
        ...state,
        maxTime: action.maxTime,
        t: clampToRange(state.t, action.maxTime, state.stepSize),
      };
    }
    default:
      return state;
  }
}

/**
 * A stepper bound to a store, for a sim author who wants an object and not a reducer.
 */
export interface Stepper {
  get(): StepperState;
  dispatch(action: StepperAction): void;
  subscribe(listener: (state: StepperState) => void): () => void;
  /**
   * True when this sim may move on its own.
   *
   * False when the student asked for reduced motion AND the host has not overridden it. A stepper
   * that only suppresses motion without leaving the timeline reachable has excluded the student it
   * was meant to include — so `step`, `scrubTo` and `reset` always work, and only `play` and
   * `advance` are withheld.
   */
  mayAutoPlay(): boolean;
}

/**
 * ## THE POLICY LIVES HERE AND NOT IN THE REDUCER
 *
 * `stepperReduce` is a pure function of `(state, action)` and knows nothing about a student's OS
 * setting, which keeps it testable with no DOM and no media query. The reduced-motion policy is one
 * guard in `dispatch`, and it is overridable: a student with the OS setting on may still want to
 * watch the thing move, and an OS setting is not a statement about a specific simulation.
 *
 * The first version wrote `reducedMotion ? 'idle' : 'idle'` — two identical branches, which the
 * compiler then rejected by narrowing `status` to the literal `'idle'`. A policy that cannot
 * distinguish its two cases is not a policy, and the narrowing error is what said so.
 *
 * ## `allowMotion` DEFAULTS TO TRUE, AND THAT IS THE USEFUL DIRECTION
 *
 * It is derived from `prefersReducedMotion()`, which is false in a headless conformance run because
 * no `matchMedia` exists there. Defaulting to "may not play" would make every automated screenshot
 * show a frozen sim and every automated run measure nothing, so the opt-out is explicit instead.
 */
export function createStepper(input: {
  readonly maxTime: number;
  readonly stepSize: number;
  readonly timeScale?: number;
  readonly allowMotion?: boolean;
}): Stepper {
  const mayAutoPlay = input.allowMotion ?? true;
  let state: StepperState = initialStepper(input);
  const listeners = new Set<(state: StepperState) => void>();
  return {
    get: () => state,
    dispatch(action): void {
      if (!mayAutoPlay && (action.type === 'play' || action.type === 'advance')) return;
      const next = stepperReduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mayAutoPlay: () => mayAutoPlay,
  };
}

/** Keyboard bindings for the stepper's controls.  (`plans/10` §4, the a11y baseline) */
export function stepperKeyMap(): Readonly<Record<string, StepperAction>> {
  return {
    ' ': { type: 'toggle' },
    ArrowRight: { type: 'step', direction: 1 },
    ArrowLeft: { type: 'step', direction: -1 },
    Home: { type: 'scrubTo', t: 0 },
    End: { type: 'scrubTo', t: Number.MAX_SAFE_INTEGER },
  };
}
