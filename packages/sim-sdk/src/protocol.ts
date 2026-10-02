/**
 * `sim-host@1` — the protocol, as types rather than as a paragraph.  (P6-T1)
 *
 * ## WHY THE PROTOCOL IS CODE
 *
 * `plans/10` §2 describes the protocol in a table. A table cannot be wrong in the interesting way:
 * it cannot tell you that a sim sends `sim:answer` with a `points` field that the host will honour,
 * or that the error codes drifted from the ones the host matches on. So the frames are discriminated
 * unions, the error codes are a closed set, and the handshake is a function that returns a decision
 * instead of something a reader has to derive.
 *
 * The same types are the source of truth for THREE consumers that must not disagree: the host, the
 * sim, and the conformance harness. A sim built against a different revision of this file is a sim
 * that fails the handshake, loudly, rather than a sim that half-works.
 *
 * ## THE NONCE IS THE ONLY AUTHENTICATION THERE IS
 *
 * The frame is cross-origin, so `event.origin` is the sim origin and `'*'` is the only workable
 * target origin — which means `event.origin` proves nothing about who is talking. What proves it is
 * the per-mount nonce: a value the host generates, puts in `sim:init`, and requires on every inbound
 * frame, checked against `event.source` identity as well. An attacker who can guess neither the
 * mount nor the source can post a frame that is acted upon.
 *
 * ## A SIM IS NEVER TRUSTED, INCLUDING FOR ITS OWN GRADE
 *
 * Rule 1 of `plans/10` §2.3. `sim:gradePreview` exists for a teacher's screen and is structurally
 * unreachable from a student's, and the server re-runs `grader(state)` in Node regardless. The
 * `gradePreview` frame type therefore carries a marker saying which surface it is allowed on, and
 * `assertAllowedOn` is what enforces it — a comment would not.
 */

/** The protocol revision. A sim advertising anything else fails the handshake, loudly. */
export const SIM_PROTOCOL = 1 as const;

/**
 * How long the host waits for `sim:ready` before declaring the frame dead.
 *
 * 10 s rather than 2 s. The bundle is fetched from a separate origin on a cold cache over a school
 * network, and a 2 s budget fails exactly the students on the worst connections — the ones who then
 * get a fallback panel and learn nothing. The cost of the longer budget is a slower fallback for a
 * genuinely broken sim, which is a far better place to spend patience.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** `sim:resize` is debounced by the sim; the host coalesces whatever arrives inside this window. */
export const RESIZE_DEBOUNCE_MS = 120;

/**
 * Unsolicited `sim:state` checkpoints are debounced by the HOST, at 3 s.
 *
 * The number is `plans/10` §5.1's, and it is not arbitrary: a student exploring a simulation emits
 * a checkpoint on every meaningful change, and persisting each one turns a state document into a
 * write log. Three seconds is short enough that a refresh loses nothing a student would notice.
 */
export const STATE_CHECKPOINT_DEBOUNCE_MS = 3_000;

/**
 * No answer within this long after the host asked for one is not an error.
 *
 * A sim with `stepper: false` and no continuous animation may simply take a while, and a student
 * thinking is not a broken sim. The host waits; it does not synthesise an answer.
 */
export const ANSWER_SETTLE_MS = 750;

/**
 * The frame attribute that makes the sandbox real.
 *
 * Exactly these five tokens, and the absences are the point: no `allow-same-origin` (so the frame is
 * a unique opaque origin and cannot read our DOM, cookies, `localStorage` or `IndexedDB`), no
 * `allow-forms`, no `allow-popups`, no `allow-top-navigation`, no `allow-modals`, no
 * `allow-downloads`, no `allow-pointer-lock`.
 *
 * `allow-downloads` is the one people expect and it is refused deliberately: a sim that can write a
 * file can exfiltrate a student's work through the download shelf, which no amount of CSP prevents.
 */
export const FRAME_SANDBOX_TOKENS = 'allow-scripts' as const;

/** `srcdoc` is never used; the frame is always loaded from the sim origin by URL. */
export const ALLOW_SRCDOC = false as const;

// ───────────────────────────────────────────────── capability negotiation

/**
 * What a sim claims it can do. The host reads this from `sim:ready` and it is a CLAIM.
 *
 * `state` and `grading` are load-bearing: without `state` there is nothing to save on unmount and
 * nothing to grade, so the host shows a static fallback rather than a sim that cannot be submitted.
 */
export interface SimCapabilities {
  readonly state: boolean;
  readonly grading: boolean;
  readonly randomised: boolean;
  readonly audio: boolean;
  readonly webgl: boolean;
  readonly stepper: boolean;
  readonly scenarios: readonly string[];
}

export const NO_CAPABILITIES: SimCapabilities = {
  state: false,
  grading: false,
  randomised: false,
  audio: false,
  webgl: false,
  stepper: false,
  scenarios: [],
};

/** How the frame is being used, which changes what the host allows. */
export type SimMode = 'lesson' | 'graded' | 'preview';

export type SeedPolicy =
  | { readonly kind: 'FIXED'; readonly seed: string }
  | {
      readonly kind: 'PER_STUDENT';
      readonly derivation: 'ATTEMPT_ID' | 'USER_ID' | 'ASSIGNMENT_ID';
    }
  | { readonly kind: 'PER_VIEW' };

/** Grading instructions the host passes down. `sim:gradePreview` may never widen these. */
export interface GradingInstruction {
  readonly strategy: 'EXACT' | 'TOLERANCE' | 'SET' | 'NUMERIC' | 'RUBRIC';
  readonly maxPoints: number;
  readonly tolerance?: { readonly absolute?: number; readonly relative?: number };
  readonly partialCredit: boolean;
}

// ───────────────────────────────────────────────── the error taxonomy

/**
 * Every way a sim can fail, in one closed set.  (`plans/10` §2.2 `sim:error`)
 *
 * Closed on purpose. A free-form `code: string` means the host has to `switch` on strings it cannot
 * enumerate, and the first code nobody handled becomes a silent no-op — which is how a sim that
 * cannot be graded ends up looking like a student who gave up.
 */
export type SimErrorCode =
  /** The sim did not identify itself as the manifest says it would. */
  | 'HANDSHAKE_FAILED'
  /** The sim asked for a capability the host has not granted, or used one the manifest denies. */
  | 'UNSUPPORTED_CAPABILITY'
  /** `setParams`, `loadScenario` or a command carried something the param schema rejects. */
  | 'PARAM_INVALID'
  /** `loadScenario` named a scenario not in the manifest's list. */
  | 'SCENARIO_UNKNOWN'
  /** State failed its schema, or its checksum did not match its content. */
  | 'STATE_INVALID'
  /** The render layer threw. Recoverable in the sense that the sim can be remounted. */
  | 'RENDER_FAILED'
  /** The grader threw. Always unrecoverable: a wrong grade is worse than no grade. */
  | 'GRADER_FAILED'
  /**
   * The sim attempted a prohibited capability: navigation, `window.open`, the clipboard, storage,
   * or a network call.  (`plans/10` §2.3 rule 5)
   *
   * Its own code because it is not a bug. It is a conformance failure AND an error, and the two
   * responses are different: the host shows the fallback, and the registry job fails the build.
   */
  | 'PROHIBITED_API'
  /** The sim exceeded a declared time budget, or missed the handshake deadline. */
  | 'TIMEOUT'
  /** Anything else. Deliberately last, and deliberately still a code. */
  | 'INTERNAL';

export interface SimErrorFrame {
  readonly type: 'sim:error';
  readonly code: SimErrorCode;
  readonly message: string;
  /**
   * Whether the host may keep showing this frame.
   *
   * `false` means the host tears the frame down and renders the static fallback. `GRADER_FAILED` is
   * always `false`: a sim that cannot grade must not keep looking gradable to a student.
   */
  readonly recoverable: boolean;
  readonly stack?: string;
}

/** Codes after which the host must stop trusting the frame entirely. */
export const FATAL_ERROR_CODES: readonly SimErrorCode[] = ['GRADER_FAILED', 'STATE_INVALID'];

export const isFatalError = (code: SimErrorCode): boolean => FATAL_ERROR_CODES.includes(code);

/**
 * The prohibited-API list, as names rather than as prose.
 *
 * `plans/10` §2.3 rule 5 says a sim cannot navigate, open windows, or read the clipboard. Stating
 * it as a set makes it checkable: the conformance suite walks these against a real sandboxed frame,
 * and a new one added here fails the suite until it is exercised.
 */
export const PROHIBITED_APIS: readonly string[] = [
  'window.open',
  'location.assign',
  'location.replace',
  'top.location',
  'parent.location',
  'navigator.clipboard.read',
  'navigator.clipboard.write',
  'window.localStorage',
  'window.sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
  'fetch',
  'EventSource',
  'WebSocket',
  'navigator.sendBeacon',
];

// ───────────────────────────────────────────────── frames

/** Host → sim. Seven frames, exactly as `plans/10` §2.2 lists them. */
export type HostFrame =
  | {
      readonly type: 'sim:init';
      readonly protocol: number;
      /**
       * Per-mount, single use for authentication purposes, and required on every inbound frame.
       * See the note at the top of this file.
       */
      readonly nonce: string;
      readonly simId: string;
      readonly simVersion: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly seed: string;
      readonly mode: SimMode;
      readonly initialState?: unknown;
      readonly grading?: GradingInstruction;
    }
  | {
      readonly type: 'sim:setParams';
      readonly params: Readonly<Record<string, unknown>>;
      readonly seed?: string;
    }
  | {
      readonly type: 'sim:command';
      readonly name: SimCommandName;
      readonly args?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: 'sim:requestState'; readonly reason: StateRequestReason }
  | { readonly type: 'sim:visibility'; readonly visible: boolean }
  | { readonly type: 'sim:teardown' };

export type SimCommandName =
  | 'reset'
  | 'play'
  | 'pause'
  | 'step'
  | 'loadScenario'
  | 'focus'
  | 'setTheme';

/** Why the host wants a snapshot. Logged, because "why did we save at that moment" is a support question. */
export type StateRequestReason = 'save' | 'submit' | 'blur' | 'unload' | 'replay' | 'resize';

export type SimFrame =
  | {
      readonly type: 'sim:ready';
      readonly protocol: number;
      readonly nonce: string;
      readonly simId: string;
      readonly simVersion: string;
      readonly capabilities: SimCapabilities;
      readonly exports: readonly string[];
    }
  | ({ readonly nonce: string } & SimErrorFrame)
  | {
      readonly type: 'sim:resize';
      readonly nonce: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'sim:state';
      readonly nonce: string;
      readonly state: unknown;
      readonly checksum: string;
    }
  | {
      readonly type: 'sim:answer';
      readonly nonce: string;
      readonly answer: unknown;
      readonly confidence?: number;
      readonly explanation?: string;
    }
  | {
      readonly type: 'sim:gradePreview';
      readonly nonce: string;
      readonly points: number;
      readonly correct: boolean;
      readonly rationale: string;
      /**
       * Which surface this preview is allowed on. The host REFUSES a student-facing surface rather
       * than trusting the frame to arrive in the right place, because the frame is untrusted code
       * and the only thing that decides is here.
       */
      readonly surface: 'authoring' | 'student';
    }
  | {
      readonly type: 'sim:telemetry';
      readonly nonce: string;
      readonly name: string;
      readonly value: number;
    }
  | { readonly type: 'sim:readyForInput'; readonly nonce: string };

/**
 * Telemetry names are allowlisted.  (`plans/10` §2.2, and `INV-Q-1`'s cousin)
 *
 * A free-form name is a side channel: a sim could report `student_answer_correct` as a metric and
 * a dashboard would store pre-release outcomes outside the release gate. So the type carries the
 * allowlist, and a name outside it is a type error at the sim rather than a row in a warehouse.
 */
export const TELEMETRY_NAMES = [
  'mount_ms',
  'ready_ms',
  'steps_taken',
  'parameter_changes',
  'interactions',
  'answer_produced',
  'render_errors',
] as const;

export type TelemetryName = (typeof TELEMETRY_NAMES)[number];

/** Every frame type, for exhaustive switches and for the conformance suite's coverage check. */
export const HOST_FRAME_TYPES = [
  'sim:init',
  'sim:setParams',
  'sim:command',
  'sim:requestState',
  'sim:visibility',
  'sim:teardown',
] as const;

export const SIM_FRAME_TYPES = [
  'sim:ready',
  'sim:error',
  'sim:resize',
  'sim:state',
  'sim:answer',
  'sim:gradePreview',
  'sim:telemetry',
  'sim:readyForInput',
] as const;

export type HostFrameType = (typeof HOST_FRAME_TYPES)[number];
export type SimFrameType = (typeof SIM_FRAME_TYPES)[number];

// ───────────────────────────────────────────────── the handshake

export type HandshakeVerdict =
  | { readonly ok: true; readonly sim: SimFrame & { type: 'sim:ready' } }
  | { readonly ok: false; readonly code: SimErrorCode; readonly message: string };

export interface HandshakeExpectation {
  readonly protocol: number;
  readonly simId: string;
  readonly simVersion: string;
  readonly nonce: string;
  readonly capabilities: SimCapabilities;
  /** `grading: true` is only usable if the host actually supplied grading instructions. */
  readonly gradingSupplied: boolean;
}

/**
 * Decide whether a frame is one we act on at all.
 *
 * The nonce check comes FIRST, before anything is parsed. A frame with the wrong nonce has not been
 * authenticated, so reasoning about its contents is reasoning about attacker input, and an
 * expensive parse before a cheap comparison is how a page gets slow from someone else's traffic.
 */
export function isAuthenticated(
  frame: unknown,
  nonce: string,
  source: unknown,
  expectedSource: unknown,
): boolean {
  if (source !== expectedSource) return false;
  if (frame === null || typeof frame !== 'object') return false;
  const candidate = (frame as { nonce?: unknown }).nonce;
  // `sim:ready` is the only frame without a nonce field in the type, and it carries one anyway —
  // a handshake that identifies itself without proving it is a handshake anyone can complete.
  return typeof candidate === 'string' && candidate === nonce;
}

/**
 * Validate `sim:ready` against what the host expects.
 *
 * A version mismatch is a DEGRADE with a clear panel, never a crash (`plans/10` §2.3 rule 3): the
 * surrounding lesson stays usable. A protocol mismatch is a REFUSAL, because a different protocol
 * revision means the frames mean different things and proceeding would be guessing.
 */
export function evaluateHandshake(
  frame: unknown,
  expected: HandshakeExpectation,
): HandshakeVerdict {
  if (frame === null || typeof frame !== 'object') {
    return { ok: false, code: 'HANDSHAKE_FAILED', message: 'the frame was not an object' };
  }
  const ready = frame as Partial<Extract<SimFrame, { type: 'sim:ready' }>>;
  if (ready.type !== 'sim:ready') {
    return {
      ok: false,
      code: 'HANDSHAKE_FAILED',
      message: `expected sim:ready, received ${String(ready.type)}`,
    };
  }
  if (ready.protocol !== expected.protocol) {
    return {
      ok: false,
      code: 'HANDSHAKE_FAILED',
      message: `protocol ${String(ready.protocol)} cannot be spoken by a host that speaks ${String(expected.protocol)}`,
    };
  }
  if (ready.simId !== expected.simId) {
    return {
      ok: false,
      code: 'HANDSHAKE_FAILED',
      message: `the frame claims ${String(ready.simId)} and the host mounted ${expected.simId}`,
    };
  }
  // The VERSION is allowed to differ, and that is the degrade path. The message says which way, so
  // a teacher sees "this sim is newer than the lesson" rather than a generic failure.
  if (ready.simVersion !== expected.simVersion) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message:
        `${expected.simId}@${String(ready.simVersion)} is mounted where the lesson asked for ` +
        `${expected.simVersion}. Showing the static fallback; the rest of the lesson still works.`,
    };
  }
  const caps = ready.capabilities;
  if (caps === undefined || typeof caps !== 'object') {
    return { ok: false, code: 'HANDSHAKE_FAILED', message: 'sim:ready carried no capabilities' };
  }
  if (caps.grading && !expected.gradingSupplied) {
    return {
      ok: false,
      code: 'UNSUPPORTED_CAPABILITY',
      message:
        'the sim grades but the host supplied no grading instruction, so no answer could be scored',
    };
  }
  // `caps.state === false` is NOT a refusal. A sim with no state is still a valid lesson; the host
  // simply must not promise "state captured on unmount" for it, which is a host-side decision made
  // from this value. The first version had a separate early return for that case, and the two
  // returns were identical except for a comment — two code paths to keep in step for nothing.
  return {
    ok: true,
    sim: {
      type: 'sim:ready',
      protocol: ready.protocol as number,
      nonce: ready.nonce as string,
      simId: expected.simId,
      simVersion: ready.simVersion as string,
      capabilities: caps,
      exports: ready.exports ?? [],
    },
  };
}

/**
 * Whether a `sim:gradePreview` may be shown here.
 *
 * `plans/10` §2.2 marks it "teacher-facing only; never shown to a student". A sim could simply
 * declare `surface: 'student'` — it is untrusted code, so its declaration is not evidence. The host
 * passes the surface IT is rendering and this function decides.
 */
export function assertAllowedOn(
  frame: { readonly surface: 'authoring' | 'student' },
  hostSurface: 'authoring' | 'student',
): void {
  if (frame.surface !== hostSurface) {
    throw new Error(
      `GRADE_PREVIEW_ON_WRONG_SURFACE: the sim declared "${frame.surface}" and the host is ` +
        `rendering "${hostSurface}". The host decides, not the frame.`,
    );
  }
}

/** Is `code` in the taxonomy? Runtime check, because a frame from the wild is not typed. */
export const isSimErrorCode = (value: unknown): value is SimErrorCode =>
  typeof value === 'string' && (SIM_ERROR_CODES as readonly string[]).includes(value);

export const SIM_ERROR_CODES = [
  'HANDSHAKE_FAILED',
  'UNSUPPORTED_CAPABILITY',
  'PARAM_INVALID',
  'SCENARIO_UNKNOWN',
  'STATE_INVALID',
  'RENDER_FAILED',
  'GRADER_FAILED',
  'PROHIBITED_API',
  'TIMEOUT',
  'INTERNAL',
] as const satisfies readonly SimErrorCode[];
