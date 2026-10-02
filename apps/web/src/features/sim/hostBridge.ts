/**
 * The host side of `sim-host@1`, and the state machine the frame component renders.  (P6-T6)
 *
 * ## THE HOST DOES NOT TRUST THE FRAME EITHER
 *
 * `plans/10` §2.1: the frame is cross-origin, so `event.origin` proves the bundle came from our sim
 * origin and `event.source` proves which frame spoke. Neither proves the frame is *the sim we mounted*,
 * so the per-mount nonce is the check that does. Three conditions, all required:
 *
 *  1. `event.source` is the frame element we created. A frame nested inside the sim — and a sim can
 *     create one — has a different source and is dropped.
 *  2. the nonce matches. Anything without it is counted, not acted on.
 *  3. the frame type is one we know. An unknown type is IGNORED, not fatal: a newer sim against an older
 *     host has to degrade (`plans/10` §2.3 rule 2).
 *
 * ## WHY THE FAILURE PATH IS A STATE MACHINE AND NOT AN ERROR THROWN IN AN EFFECT
 *
 * The interesting states are not errors: `BLOCKED` (a school firewall), `UNREACHABLE` (the sim origin
 * is down), `DEGRADED` (a version mismatch) and `TIMED_OUT`. Each has a DIFFERENT thing to tell a
 * student and a different thing to tell a teacher, and they all need to be reachable without an
 * exception crossing the component boundary. So the bridge reduces to a state, the component renders it,
 * and there is one state for "we are not going to show a frame".
 *
 * ## NOTHING HERE READS A CLOCK
 *
 * Timeouts arrive as an injected `now()`, for the same reason every other module in this repository
 * takes a clock: a test that needs to wait cannot reproduce a failure.
 */

import { systemClock } from '@orrery/clock';
import { createResizeCoalescer, RESIZE_DEBOUNCE_MS } from '@orrery/sim-sdk';
import {
  evaluateHandshake,
  HANDSHAKE_TIMEOUT_MS,
  type HostFrame,
  type SeedPolicy,
  type SimErrorCode,
  type SimFrame,
  type SimMode,
} from '@orrery/sim-sdk/protocol';

export type HostStatus =
  /** Nothing mounted yet, or lazily not yet intersected. */
  | 'IDLE'
  /** The frame is loading. */
  | 'LOADING'
  /** `sim:ready` accepted. */
  | 'READY'
  /** The bundle could not be reached: a school firewall, or the sim origin is down. */
  | 'UNREACHABLE'
  /** The frame loaded and then produced nothing. Distinct from UNREACHABLE, and the advice differs. */
  | 'TIMED_OUT'
  /** A different version answered. The static fallback shows; the lesson still works. */
  | 'DEGRADED'
  /** The sim reported a fatal error. */
  | 'FAILED';

export interface HostState {
  readonly status: HostStatus;
  /** True once we have decided NOT to show a frame. The static fallback renders instead. */
  readonly showFallback: boolean;
  /** A JSON pointer or a short sentence a STUDENT can act on. Not a stack trace. */
  readonly studentMessage: string | null;
  /** What a TEACHER needs: the code, the id, and what to do next. */
  readonly teacherDetail: string | null;
  readonly capabilities: {
    readonly state: boolean;
    readonly grading: boolean;
    readonly stepper: boolean;
  } | null;
  readonly height: number | null;
  /** Counters, so a support question has numbers in it rather than an opinion. */
  readonly framesAccepted: number;
  readonly framesDropped: number;
  readonly spoofAttempts: number;
  /**
   * Authenticated frames whose type this host does not know.
   *
   * Separate from `dropped` because they are a DIFFERENT problem: dropped means someone is talking to us
   * who should not be, and ignored means the future arrived early (`plans/10` §2.3 rule 2). A count of
   * ignored frames that climbs on one sim is how a host learns it needs updating.
   */
  readonly framesIgnored: number;
  readonly answer: unknown;
  readonly lastState: unknown;
  /**
   * The checksum the sim sent WITH that state.
   *
   * ## WHY THE HOST KEEPS IT
   *
   * `sim:state` carries `checksum` beside `state`, and the first version threw it away — so the host held
   * a state it could not verify, and `restoreState` on a later mount had nothing to compare against. The
   * whole point of a checksum on a wire format is that the RECEIVER checks it; a checksum only the sender
   * ever looks at is decoration.
   *
   * Kept beside the state rather than inside it: the state is the simulation's document, and the checksum
   * is the protocol's claim about that document. Mixing them lets a sim restate its own checksum over a
   * subset, which is how the projectile sim ended up with two disagreeing answers to one question.
   */
  readonly lastChecksum: string | null;
}

/**
 * The fallback reason the host reports for a blocked origin.
 *
 * A distinct string rather than `UNREACHABLE`, because the ADVICE is different and a teacher who is
 * told "check your firewall" for an empty box will not find it.
 */
export type BlockedReason = 'FIREWALL' | 'OFFLINE' | 'DNS' | 'UNKNOWN';

export const initialHostState = (): HostState => ({
  status: 'IDLE',
  showFallback: false,
  studentMessage: null,
  teacherDetail: null,
  capabilities: null,
  height: null,
  framesAccepted: 0,
  framesDropped: 0,
  spoofAttempts: 0,
  framesIgnored: 0,
  answer: null,
  lastState: null,
  lastChecksum: null,
});

export interface HostInput {
  readonly simId: string;
  readonly simVersion: string;
  readonly nonce: string;
  readonly mode: SimMode;
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: string;
  readonly seedPolicy: SeedPolicy;
  readonly initialState?: unknown;
  readonly gradingSupplied: boolean;
  readonly bundleUrl: string;
  /** The intrinsic height from the manifest, used before the frame has reported its own. */
  readonly defaultHeight: number;
  readonly minHeight: number;
  readonly now: () => number;
  /**
   * Injected so a test can deliver frames without a `window`, and so a listener is removable.
   *
   * `post` is separate from `subscribe` because the two directions are not symmetric: inbound frames
   * arrive on `globalThis` from a frame we did not choose, and outbound frames go to exactly one
   * window at exactly one origin. A transport that only subscribes can model a host that listens and
   * never speaks, which is how the first version of this component shipped six builders and not one
   * of them was ever delivered.
   */
  readonly transport: {
    subscribe(handler: (frame: unknown, source: unknown) => void): () => void;
    /** Absent only in tests that assert frames by value and never mount. */
    post?(frame: HostFrame): void;
  };
  /** The frame element the host created. Frames from anything else are dropped. */
  readonly expectedSource: unknown;
  /**
   * Called with the next state after EVERY inbound frame.
   *
   * ## WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL
   *
   * `createHostBridge` subscribes to the transport itself and calls `bridge.receive(...)` — and the
   * first version THREW THE RESULT AWAY. The bridge's internal state was correct the whole time, which
   * is why every unit test passed; but nothing ever told React, so the component rendered `LOADING`
   * forever while a real simulation sat on the other side of the boundary completing a perfect
   * handshake. Conformance found it: a `sim:ready` arrived in the page, the frame reported zero frames
   * accepted, and the host claimed a timeout.
   *
   * A state machine whose transitions are not OBSERVABLE is a state machine nobody can render.
   */
  readonly onState?: (next: HostState) => void;
}

export interface HostBridge {
  /** The `sim:init` frame, built once. */
  initFrame(): HostFrame;
  /** Deliver one inbound frame. Returns the next state. */
  receive(frame: unknown, source: unknown): HostState;
  /** Called when the frame element loads or fails. */
  onFrameEvent(event: 'load' | 'error'): HostState;
  /** Called after `HANDSHAKE_TIMEOUT_MS`. Returns null when the handshake is still in time. */
  checkTimeout(): HostState | null;
  /** Coalesced `sim:resize`, and the coalescer is exposed so a test can flush it. */
  applyResize(size: { width: number; height: number }): void;
  flushResize(): void;
  /** Host-driven frames. */
  command(
    name: 'reset' | 'play' | 'pause' | 'step' | 'loadScenario' | 'focus' | 'setTheme',
    args?: Readonly<Record<string, unknown>>,
  ): HostFrame;
  setParams(params: Readonly<Record<string, unknown>>, seed?: string): HostFrame;
  requestState(reason: 'save' | 'submit' | 'blur' | 'unload' | 'replay' | 'resize'): HostFrame;
  visibility(visible: boolean): HostFrame;
  teardown(): HostFrame;
  /**
   * Deliver one host frame. Every builder returns a frame rather than sending one, so a test can read
   * the value; nothing reaches a simulation without going through here.
   */
  emit(frame: HostFrame): void;
  get(): HostState;
  dispose(): void;
}

/**
 * Derive the seed from the policy.
 *
 * ## `PER_STUDENT` HASHES ITS INPUT, IT DOES NOT USE IT RAW
 *
 * An attempt id or a user id is a stable identifier, and putting one into a sim's PRNG makes the draw
 * predictable to anyone who has seen a list of them — which a teacher with a gradebook does. So the
 * value is hashed with a fixed salt before it becomes a seed: two students with adjacent ids get
 * unrelated sims, and the same student gets the same sim on every re-sit, which is what
 * "reproducible" has to mean for a teacher asking "what did they actually get?".
 */
export function deriveSeed(
  policy: SeedPolicy,
  identity: { attemptId?: string; userId?: string; assignmentId?: string },
  random: () => string,
): string {
  switch (policy.kind) {
    case 'FIXED':
      return policy.seed;
    case 'PER_VIEW':
      // Fresh every load, which is what discourages screenshot-sharing: a screenshot is evidence of one
      // view, not of the current one.
      return random();
    case 'PER_STUDENT': {
      // Named rather than indexed, and the mapping is explicit because the protocol's derivations are
      // `ATTEMPT_ID | USER_ID | ASSIGNMENT_ID` while the identity shape here is camelCase.
      //
      // Two bugs in one line if it were wrong. `identity[policy.derivation]` would be an `any` index
      // into an optional shape, so a typo would be `undefined` and quietly produce ONE SHARED SEED for
      // the whole cohort — the anti-collusion claim failing silently. The compiler caught the version
      // written against camelCase derivations, which is the point of the mapping existing.
      const value =
        DERIVATION_TO_FIELD[policy.derivation] === undefined
          ? undefined
          : identity[DERIVATION_TO_FIELD[policy.derivation] as keyof typeof identity];
      if (value === undefined || value === '') {
        throw new Error(
          `SEED_IDENTITY_MISSING: the policy derives the seed from ${policy.derivation} and none was ` +
            'supplied. A fallback seed would make every student in the cohort see the same paper.',
        );
      }
      return hashSeed(`${policy.derivation}:${value}`);
    }
    default: {
      // Unreachable for a well-typed policy, and a thrown error rather than a silent default seed: a
      // cohort that all shares one paper is the failure nobody notices until the results come in.
      const never: never = policy;
      throw new Error(`UNKNOWN_SEED_POLICY: ${JSON.stringify(never)}`);
    }
  }
}

/** The protocol's derivation names, mapped onto this module's identity shape. */
const DERIVATION_TO_FIELD = {
  ATTEMPT_ID: 'attemptId',
  USER_ID: 'userId',
  ASSIGNMENT_ID: 'assignmentId',
} as const;

/** FNV-1a over the salted identity. Same primitive as the SDK's checksum, for the same reason. */
function hashSeed(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const salted = `orrery-sim-v1:${value}`;
  for (let i = 0; i < salted.length; i += 1) {
    const code = salted.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return `${h2.toString(16).padStart(8, '0')}${h1.toString(16).padStart(8, '0')}`;
}

/** The student-facing sentence for each terminal status. One voice, no jargon, no codes. */
export const STUDENT_MESSAGES: Readonly<Record<HostStatus, string | null>> = {
  IDLE: null,
  LOADING: 'Loading the simulation…',
  READY: null,
  UNREACHABLE: 'This simulation could not be loaded. The rest of the lesson still works.',
  TIMED_OUT:
    'This simulation did not start in time. Reload the page to try again, or read the description below.',
  DEGRADED:
    'This version of the simulation is not available right now. The description below is still accurate.',
  FAILED: 'This simulation stopped working. Tell your teacher, and read the description below.',
};

export const createHostBridge = (input: HostInput): HostBridge => {
  let state = initialHostState();
  /** When the frame element reported a load. The clock starts THERE, not at mount: a bundle that takes
   *  nine seconds to download has not spent nine seconds failing to hand-shake. */
  let loadingSince: number | null = null;
  const { now } = input;

  const framesReceivedBy: { accepted: number; dropped: number; spoof: number; ignored: number } = {
    accepted: 0,
    dropped: 0,
    spoof: 0,
    ignored: 0,
  };

  const coalesceResize = createResizeCoalescer<{ width: number; height: number }>(
    RESIZE_DEBOUNCE_MS,
    (size) => {
      // A frame reporting a height smaller than the manifest's floor is either not laid out yet or a sim
      // that has collapsed; the floor is honoured so a control bar is never cut off.
      const height = Math.max(input.minHeight, Math.round(size.height));
      if (Number.isFinite(height) && height > 0) state = { ...state, height };
    },
    now,
  );

  /** Every frame refreshes the counters, so a counter is never stale in a support screenshot. */
  const counted = (next: HostState): HostState => {
    state = {
      ...next,
      framesAccepted: framesReceivedBy.accepted,
      framesDropped: framesReceivedBy.dropped,
      spoofAttempts: framesReceivedBy.spoof,
      framesIgnored: framesReceivedBy.ignored,
    };
    return state;
  };

  const terminal = (status: HostStatus, teacherDetail: string): HostState =>
    counted({
      ...state,
      status,
      showFallback: true,
      studentMessage: STUDENT_MESSAGES[status],
      teacherDetail,
    });

  const bridge: HostBridge = {
    initFrame(): HostFrame {
      return {
        type: 'sim:init',
        protocol: 1,
        nonce: input.nonce,
        simId: input.simId,
        simVersion: input.simVersion,
        params: input.params,
        seed: input.seed,
        mode: input.mode,
        ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
        ...(input.gradingSupplied
          ? { grading: { strategy: 'TOLERANCE', maxPoints: 4, partialCredit: true } }
          : {}),
      };
    },

    receive(frame, source): HostState {
      // Condition 1: the SOURCE. A sim can create its own iframe, and a frame nested inside ours has a
      // different source. Checked before anything else for the same reason the nonce is: an
      // unauthenticated frame's contents are attacker input.
      if (source !== input.expectedSource) {
        framesReceivedBy.spoof += 1;
        state = {
          ...state,
          spoofAttempts: framesReceivedBy.spoof,
          framesDropped: framesReceivedBy.dropped,
        };
        return state;
      }
      // Condition 2: the nonce.
      const nonce = (frame as { nonce?: unknown } | null)?.nonce;
      if (nonce !== input.nonce) {
        framesReceivedBy.dropped += 1;
        return counted(state);
      }
      // Condition 3: a known type. Unknown is IGNORED (rule 2), which is not the same as accepted.
      const type = (frame as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !type.startsWith('sim:')) {
        // Authenticated but not a frame type at all, which is different from a frame type we do not
        // know. Dropped either way: it cannot be acted on.
        framesReceivedBy.dropped += 1;
        return counted(state);
      }
      framesReceivedBy.accepted += 1;

      switch (type as SimFrame['type']) {
        case 'sim:ready': {
          const verdict = evaluateHandshake(frame, {
            protocol: 1,
            simId: input.simId,
            simVersion: input.simVersion,
            nonce: input.nonce,
            capabilities: {
              state: false,
              grading: false,
              randomised: false,
              audio: false,
              webgl: false,
              stepper: false,
              scenarios: [],
            },
            gradingSupplied: input.gradingSupplied,
          });
          if (!verdict.ok) {
            const degraded = verdict.message.includes('static fallback');
            if (degraded) {
              // A VERSION mismatch. The lesson keeps working and the panel says which version is
              // mounted — `plans/10` §2.3 rule 3.
              return terminal('DEGRADED', verdict.message);
            }
            return terminal('FAILED', verdict.message);
          }
          loadingSince = null;
          const caps = verdict.sim.capabilities;
          state = {
            ...state,
            status: 'READY',
            showFallback: false,
            studentMessage: null,
            teacherDetail: null,
            capabilities: { state: caps.state, grading: caps.grading, stepper: caps.stepper },
            height: state.height ?? input.defaultHeight,
          };
          return counted(state);
        }
        case 'sim:resize': {
          coalesceResize(frame as { width: number; height: number });
          return counted(state);
        }
        case 'sim:state': {
          const { state: payload, checksum } = frame as { state: unknown; checksum?: unknown };
          state = {
            ...state,
            lastState: payload,
            lastChecksum: typeof checksum === 'string' ? checksum : null,
          };
          return counted(state);
        }
        case 'sim:answer': {
          state = { ...state, answer: (frame as { answer: unknown }).answer };
          return counted(state);
        }
        case 'sim:gradePreview': {
          // A teacher-only frame arriving in a STUDENT mount is not an error the sim committed — it is
          // a sim declaring its own surface. The host discards it and records it, because "a sim sent us
          // its grade during an exam" is worth a support ticket.
          state = {
            ...state,
            teacherDetail:
              input.mode === 'graded'
                ? 'a sim sent a gradePreview during a graded mount; it was discarded'
                : state.teacherDetail,
          };
          return counted(state);
        }
        case 'sim:error': {
          const error = frame as { code: SimErrorCode; message: string; recoverable: boolean };
          if (!error.recoverable || error.code === 'GRADER_FAILED') {
            return terminal('FAILED', `${error.code}: ${error.message}`);
          }
          state = { ...state, teacherDetail: `${error.code}: ${error.message}` };
          return counted(state);
        }
        case 'sim:telemetry':
        case 'sim:readyForInput':
          return counted(state);
        default: {
          // Authenticated, well-formed, and from a NEWER host or sim than we know about. Ignored, which
          // is what makes the protocol additive.
          framesReceivedBy.ignored += 1;
          return counted(state);
        }
      }
    },

    onFrameEvent(event): HostState {
      if (event === 'error') {
        return terminal(
          'UNREACHABLE',
          'the frame element reported a load error — most often a firewall',
        );
      }
      if (state.status === 'IDLE') {
        loadingSince = now();
        state = { ...state, status: 'LOADING', height: state.height ?? input.defaultHeight };
      }
      return state;
    },

    checkTimeout(): HostState | null {
      // Only meaningful once the frame element has actually LOADED. A frame that never loaded is
      // UNREACHABLE via `onFrameEvent`, and reporting it as a TIMEOUT would tell a teacher to reload a
      // page that fails identically.
      //
      // The first version of this compared `now()` against an arithmetic expression built out of
      // `defaultHeight`, which is not a timestamp. It never fired, and the failure was invisible
      // because the only assertion was on the returned state, not on whether a timeout CAN happen.
      if (state.status !== 'LOADING') return null;
      if (loadingSince === null) return null;
      if (now() - loadingSince < HANDSHAKE_TIMEOUT_MS) return null;
      return terminal('TIMED_OUT', `no sim:ready within ${String(HANDSHAKE_TIMEOUT_MS)} ms`);
    },

    applyResize(size: { width: number; height: number }): void {
      coalesceResize(size);
    },

    flushResize(): void {
      // Delivers the PENDING measurement, and nothing when there is none. Sending a synthetic zero here
      // is what collapsed every sim to its minimum height on unmount in the first version.
      coalesceResize.flush();
    },

    command(
      name: 'reset' | 'play' | 'pause' | 'step' | 'loadScenario' | 'focus' | 'setTheme',
      args?: Readonly<Record<string, unknown>>,
    ): HostFrame {
      return { type: 'sim:command', name, ...(args === undefined ? {} : { args }) };
    },
    setParams(params, seed): HostFrame {
      return { type: 'sim:setParams', params, ...(seed === undefined ? {} : { seed }) };
    },
    requestState(reason): HostFrame {
      return { type: 'sim:requestState', reason };
    },
    visibility(visible): HostFrame {
      return { type: 'sim:visibility', visible };
    },
    teardown(): HostFrame {
      return { type: 'sim:teardown' };
    },
    emit(frame: HostFrame): void {
      // Every builder above is a value producer, not a sender. Routing delivery through one method
      // means there is exactly one place to instrument -- and, more importantly, exactly one place that
      // CAN FORGET.
      //
      // ## THE NONCE IS STAMPED HERE, NOT IN THE BUILDERS
      //
      // Every builder except `initFrame` returned a frame with NO nonce, and the sim's SDK drops any
      // frame whose nonce does not match: `isAuthenticated` is `source === expected && candidate ===
      // nonce`. So `sim:visibility`, `sim:command`, `sim:setParams`, `sim:requestState` and `sim:teardown`
      // were all silently discarded — five of the protocol's frames, delivered and thrown away. Only the
      // handshake worked, because `connectSim` does not authenticate the frame that authorises it.
      //
      // That is the worst shape this bug could have taken: the handshake completing proved nothing about
      // anything after it, and a host whose pause, step, reset, state-capture and teardown were all no-ops
      // looked perfectly healthy in every test.
      //
      // Stamped centrally, no builder can forget, and a frame that arrives without a nonce is now
      // impossible to construct by accident.
      input.transport.post?.({ ...frame, nonce: input.nonce } as HostFrame);
    },
    get(): HostState {
      return state;
    },
    dispose(): void {
      // Idempotent: `sim:teardown` disposes, and unmounting disposes again.
      unsubscribe();
      state = initialHostState();
    },
  };

  // Retained, not discarded. The first version called `subscribe` and threw the unsubscribe away,
  // so a lesson with twelve sims left twelve listeners behind, each one holding a closure over a
  // disposed bridge that still answered messages.
  const unsubscribe = input.transport.subscribe((frame, source) => {
    const next = bridge.receive(frame, source);
    // Reported here rather than only on `load` and `checkTimeout`, because every protocol event a
    // simulation sends — ready, answer, state, resize, error — arrives through this one path.
    input.onState?.(next);
  });

  return bridge;
};

/**
 * Decide whether the sim origin is reachable, from the host's point of view.
 *
 * ## A `no-cors` FETCH AND NOT `<img>` OR A SCRIPT TAG
 *
 * A `<script>` tag or an image cannot tell "blocked" from "404" from "slow", and a CSP that blocks the
 * request reports success. A `no-cors` fetch resolves with an OPAQUE response whether it came from the
 * server or was blocked, so it is useless for the check.
 *
 * What works is a CORS probe: the sim origin sends `Access-Control-Allow-Origin: <app origin>`, so a
 * blocked request and a served one are distinguishable. The sim origin is configured to answer it,
 * and the offline check in `SimOriginStatus` is what consumes it.
 */
export const SIM_ORIGIN_PROBE_PATH = '/__sim_origin_probe';

/** What the probe concluded. `OK` is the only outcome that lets a mount proceed. */
export type ProbeOutcome = 'OK' | 'FIREWALL' | 'OFFLINE' | 'DNS';

export interface ProbeResult {
  readonly outcome: ProbeOutcome;
  /** For a teacher. The student's advice comes from `BLOCKED_ADVICE`, keyed by `outcome`. */
  readonly detail: string;
  /** The status the fetch returned, or 0 when the request never produced a response. */
  readonly status: number;
}

/**
 * Probe the sim origin.
 *
 * ## A THROTTLE, AND WHY IT IS ONE
 *
 * This runs once per mount, and a lesson with twelve sims would fire twelve probes for one answer. The
 * cache is keyed by origin, holds only successful probes, and is bounded by TIME, not by an entry count
 * that never gets cleared.
 */
const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { readonly result: ProbeResult; readonly at: number }>();

/**
 * Classify a CORS probe failure.
 *
 * ## `navigator.onLine === false` IS THE ONLY PROOF OF OFFLINE
 *
 * A failed fetch is ambiguous in every other way: a blocked response, a 502 and a dropped packet all
 * reject identically. So OFFLINE is only reported when the browser itself says so, and everything else
 * is FIREWALL -- which is the advice a school can act on. Reporting OFFLINE for a firewall sends a
 * student to check a network cable that is plugged in.
 */
export function classifyProbe(error: unknown, status: number, online: boolean): ProbeResult {
  if (online === false) {
    return { outcome: 'OFFLINE', detail: 'the browser reports no network connection', status };
  }
  const detail =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'the request produced no readable failure';
  return { outcome: 'FIREWALL', detail, status };
}

/**
 * Decide whether the sim origin is reachable, from the host's point of view.
 *
 * ## A `cors` FETCH AND NOT `<img>` OR A SCRIPT TAG
 *
 * A `<script>` tag or an image cannot tell "blocked" from "404" from "slow", and a CSP that blocks the
 * request reports success. A `no-cors` fetch resolves with an OPAQUE response whether it came from the
 * server or was blocked, so it is useless for the check.
 *
 * What works is a CORS probe: the sim origin sends `Access-Control-Allow-Origin: <app origin>`, so a
 * blocked request and a served one are distinguishable. The sim origin is configured to answer it, and
 * the offline check in `SimOriginStatus` is what consumes it.
 *
 * @param origin The sim origin, already validated as distinct from the app origin.
 * @param appOrigin Sent as the request origin, so the probe checks OUR side of the CORS handshake too.
 * @param fetchImpl Injected so the check is testable without a network and without a timer.
 * @param now Injected for the same reason, and to keep `INV-TIME-1` intact.
 */
export async function probeSimOrigin(
  origin: string,
  appOrigin: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = systemClock.now,
): Promise<ProbeResult> {
  const cached = probeCache.get(origin);
  // Expiry rather than eviction: a tab left open across a lesson period must re-ask, or a network that
  // was broken at 09:00 is still declared broken at 11:00 by a cache nobody can clear.
  if (cached !== undefined && now() - cached.at < PROBE_TTL_MS) return cached.result;

  const online = globalThis.navigator?.onLine !== false;
  let result: ProbeResult;
  try {
    // A `cors` fetch, never `no-cors`: an opaque response cannot be distinguished from a blocked one,
    // which is the entire question being asked here.
    const response = await fetchImpl(`${origin}${SIM_ORIGIN_PROBE_PATH}`, {
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      // Sent explicitly because the sim origin may not echo it, and a rejected header would look
      // identical to a block.
      headers: { 'X-Orrery-App-Origin': appOrigin },
    });
    if (response.ok) {
      result = {
        outcome: 'OK',
        detail: 'the sim origin answered the CORS probe',
        status: response.status,
      };
      // Cached WITH ITS TIMESTAMP, not as a bare result: an entry with no `at` makes `now() - at` NaN,
      // and NaN fails every comparison -- so nothing is ever reused and the throttle silently does
      // nothing at all.
      probeCache.set(origin, { result, at: now() });
      return result;
    }
    // A 4xx from the probe endpoint means the origin is REACHABLE and chose not to answer, which is a
    // deployment fault rather than a network one, and the advice differs.
    result = {
      outcome: response.status >= 500 ? 'DNS' : 'FIREWALL',
      detail: `the sim origin answered ${String(response.status)} for the probe`,
      status: response.status,
    };
  } catch (error) {
    result = classifyProbe(error, 0, online);
  }
  // Only successes are cached: caching a failure means a student who fixes their network keeps the
  // stale advice until a reload, which is the moment they are least able to interpret it.
  return result;
}

/** Drop cached probe results. Exported so a test cannot leak state into the next one. */
export function resetProbeCache(): void {
  probeCache.clear();
}

/** How long a successful answer is reused. Exported so the policy is assertable rather than implied. */
export const PROBE_CACHE_TTL_MS = PROBE_TTL_MS;

/** True when the mount may proceed: the origin answered, or nobody has asked yet. */
export function probeAllowsMount(result: ProbeResult | null): boolean {
  return result === null || result.outcome === 'OK';
}

export function isBlockedReason(value: unknown): value is BlockedReason {
  return value === 'FIREWALL' || value === 'OFFLINE' || value === 'DNS' || value === 'UNKNOWN';
}

/** The advice for each reason, because "it did not load" is not something a student can act on. */
export const BLOCKED_ADVICE: Readonly<Record<BlockedReason, string>> = {
  FIREWALL:
    'Your school network appears to be blocking the simulation server. Nothing is wrong with your work — ' +
    'tell your teacher, and the description below covers the same material.',
  OFFLINE: 'This device appears to be offline. Reconnect and reload the page.',
  DNS: 'The simulation server could not be found. This is a school network problem, not yours.',
  UNKNOWN: 'The simulation could not be loaded. The description below covers the same material.',
};
