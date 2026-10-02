/**
 * The sim side of the host bridge.  (P6-T3)
 *
 * ## THE TRANSPORT IS INJECTED, NOT REACHED FOR
 *
 * `window.parent.postMessage` would make this module untestable without a DOM and unimportable in
 * Node — and the conformance suite has to run the whole bridge logic in Node to check a hostile
 * host's frames. So the bridge takes a transport: two functions, `post` and `subscribe`.
 *
 * That is also the honest shape. The bridge's job is frame VALIDATION and nonce handling, and
 * neither needs a window. A module that reaches for `window.parent` is asserting that the only
 * possible deployment is a real iframe, which is a claim the tests would refuse to make.
 *
 * ## THE SIM DOES NOT TRUST THE HOST EITHER
 *
 * `sim:init` carries a nonce. The bridge sends it and then remembers it, and any frame arriving
 * afterwards without that nonce is counted and dropped. A sim is running inside somebody else's page;
 * the page is not automatically on its side.
 */

import {
  evaluateHandshake,
  type GradingInstruction,
  type HostFrame,
  isAuthenticated,
  isSimErrorCode,
  RESIZE_DEBOUNCE_MS,
  SIM_PROTOCOL,
  type SimCapabilities,
  type SimErrorCode,
  type SimFrame,
  type SimMode,
  type StateRequestReason,
  type TelemetryName,
} from './protocol.js';

export interface Transport {
  /** Send a frame to the host. In a browser this is `parent.postMessage(frame, '*')`. */
  post(frame: SimFrame): void;
  /** Receive frames. Returns an unsubscribe function. */
  subscribe(handler: (frame: unknown, source: unknown) => void): () => void;
}

export interface BridgeHandlers {
  onResize?(size: { width: number; height: number }): void;
  onCommand?(name: string, args: Readonly<Record<string, unknown>>): void;
  onRequestState?(reason: StateRequestReason): void;
  onVisibility?(visible: boolean): void;
  onSetParams?(params: Readonly<Record<string, unknown>>, seed?: string): void;
  onTeardown?(): void;
  /** Supply the current state when the host asks for it. */
  getState(): unknown;
}

export interface BridgeCounters {
  readonly framesReceived: number;
  readonly framesDropped: number;
  /** Dropped frames that carried the right nonce but the wrong source. */
  readonly spoofAttempts: number;
  readonly errorsEmitted: number;
}

export interface HostBridge {
  /** Send `sim:ready`. Must happen after `sim:init`; before it, there is no nonce to echo. */
  ready(input: {
    readonly simId: string;
    readonly simVersion: string;
    readonly capabilities: SimCapabilities;
    readonly exports: readonly string[];
  }): void;
  reportAnswer(
    answer: unknown,
    meta?: { readonly confidence?: number; readonly explanation?: string },
  ): void;
  reportState(state: unknown): void;
  reportError(code: SimErrorCode, message: string, recoverable: boolean, stack?: string): void;
  telemetry(name: TelemetryName, value: number): void;
  readyForInput(): void;
  /** Never shown to a student. The host refuses one that claims otherwise (`assertAllowedOn`). */
  gradePreview(points: number, correct: boolean, rationale: string): void;
  counters(): BridgeCounters;
  /** Stop responding and release the subscription. */
  dispose(): void;
}

export interface BridgeInit {
  readonly transport: Transport;
  readonly handlers: BridgeHandlers;
  /** The value the host sent in `sim:init`. Everything else depends on it. */
  readonly init: Extract<HostFrame, { type: 'sim:init' }>;
  readonly expectedSource?: unknown;
}

/**
 * Wire the sim up to the host.
 *
 * ## THE SEQUENCE IS ENFORCED
 *
 * `sim:init` must arrive before anything else, because the nonce arrives with it and every outbound
 * frame echoes the nonce. A bridge that let `reportAnswer` run first would emit a frame the host
 * drops as unauthenticated — and would do it silently, which is the worst time.
 */
export function createHostBridge(init: BridgeInit): HostBridge {
  const { transport, handlers, init: initFrame } = init;
  const nonce = initFrame.nonce;
  const counters = { framesReceived: 0, framesDropped: 0, spoofAttempts: 0, errorsEmitted: 0 };
  let started = false;
  let disposed = false;

  const post = (frame: Omit<SimFrame, 'nonce'> & { readonly nonce?: string }): void => {
    if (disposed) return;
    transport.post({ ...frame, nonce } as SimFrame);
  };

  const requireStarted = (what: string): boolean => {
    if (started) return true;
    // Refusing locally beats emitting a frame the host will drop as unauthenticated, and beats the
    // alternative — an `sim:error` that is itself dropped for carrying an unusable nonce.
    reportErrorSilently('HANDSHAKE_FAILED', `${what} was called before sim:init arrived`, false);
    return false;
  };

  const reportErrorSilently = (code: SimErrorCode, message: string, recoverable: boolean): void => {
    counters.errorsEmitted += 1;
    transport.post({ type: 'sim:error', nonce, code, message, recoverable } as SimFrame);
  };

  const unsubscribe = transport.subscribe((raw, source) => {
    if (disposed) return;
    counters.framesReceived += 1;
    // The nonce AND the source. `sim:init` is the one frame that arrives without the check already
    // applied, because it is what establishes the nonce.
    if (!isAuthenticated(raw, nonce, source, init.expectedSource ?? source)) {
      counters.framesDropped += 1;
      return;
    }
    const frame = raw as HostFrame;
    switch (frame.type) {
      case 'sim:init': {
        started = true;
        return;
      }
      case 'sim:setParams':
        handlers.onSetParams?.(frame.params, frame.seed);
        return;
      case 'sim:command':
        handlers.onCommand?.(frame.name, frame.args ?? {});
        return;
      case 'sim:requestState':
        handlers.onRequestState?.(frame.reason);
        // Answered immediately and unconditionally: the host asked, and a sim that decides for
        // itself when to volunteer a snapshot loses the student's work on `blur` and `unload`.
        transport.post({
          type: 'sim:state',
          nonce,
          state: handlers.getState(),
          checksum: '',
        } as SimFrame);
        return;
      case 'sim:visibility':
        handlers.onVisibility?.(frame.visible);
        return;
      case 'sim:teardown':
        handlers.onTeardown?.();
        dispose();
        return;
      default:
        // Unknown frames are ignored, not fatal (`plans/10` §2.3 rule 2). A newer host against an
        // older sim must degrade rather than crash.
        return;
    }
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  }

  return {
    ready(input): void {
      if (disposed) return;
      started = true;
      transport.post({
        type: 'sim:ready',
        nonce,
        protocol: SIM_PROTOCOL,
        simId: input.simId,
        simVersion: input.simVersion,
        capabilities: input.capabilities,
        exports: input.exports,
      } satisfies SimFrame);
    },
    reportAnswer(answer, meta): void {
      if (!requireStarted('reportAnswer')) return;
      post({
        type: 'sim:answer',
        ...(meta?.confidence === undefined ? {} : { confidence: meta.confidence }),
        ...(meta?.explanation === undefined ? {} : { explanation: meta.explanation }),
        answer,
      } as Omit<SimFrame, 'nonce'> as never);
    },
    reportState(state): void {
      if (!requireStarted('reportState')) return;
      // The checksum is filled in by the HOST from the canonical form, not by the sim: a sim that
      // computes it over its own object could produce a different string for the same state, and a
      // checksum that depends on serialisation order is not a checksum.
      post({ type: 'sim:state', state, checksum: '' } as Omit<SimFrame, 'nonce'> as never);
    },
    reportError(code, message, recoverable, stack): void {
      if (!isSimErrorCode(code)) {
        // An unrecognised code is not passed through as-is. The host switches on a closed set, so a
        // code it does not know is a code nothing will handle, and it is the host that decides the
        // fallback.
        reportErrorSilently('INTERNAL', `unknown error code ${JSON.stringify(code)}`, false);
        return;
      }
      counters.errorsEmitted += 1;
      transport.post({
        type: 'sim:error',
        nonce,
        code,
        message,
        recoverable,
        ...(stack === undefined ? {} : { stack }),
      } satisfies SimFrame);
    },
    telemetry(name, value): void {
      if (!requireStarted('telemetry')) return;
      if (!Number.isFinite(value)) {
        reportErrorSilently('INTERNAL', `telemetry ${name} carried ${String(value)}`, true);
        return;
      }
      post({ type: 'sim:telemetry', name, value } as Omit<SimFrame, 'nonce'> as never);
    },
    readyForInput(): void {
      if (!requireStarted('readyForInput')) return;
      post({ type: 'sim:readyForInput' } as Omit<SimFrame, 'nonce'> as never);
    },
    gradePreview(points, correct, rationale): void {
      if (!requireStarted('gradePreview')) return;
      if (!Number.isFinite(points)) {
        reportErrorSilently('INTERNAL', 'gradePreview carried a non-finite points value', true);
        return;
      }
      // `surface: 'authoring'` is a DECLARATION and the host does not believe it. The frame carries
      // it so a host that chooses to be strict can complain, but the decision is `assertAllowedOn`
      // on the host side, which the host applies against the surface IT is rendering.
      post({ type: 'sim:gradePreview', points, correct, rationale, surface: 'authoring' } as Omit<
        SimFrame,
        'nonce'
      > as never);
    },
    counters(): BridgeCounters {
      return { ...counters };
    },
    dispose,
  };
}

/**
 * The host's side of the handshake, for tests and for the host component.
 *
 * Exported from the SDK rather than written twice: a host implementation and a test implementation
 * that disagree about which frames are legal is a protocol nobody has specified.
 */
export function verifyReady(
  frame: unknown,
  expected: Parameters<typeof evaluateHandshake>[1],
): ReturnType<typeof evaluateHandshake> {
  return evaluateHandshake(frame, expected);
}

export { RESIZE_DEBOUNCE_MS };

/**
 * Coalesce `sim:resize` frames into at most one call per window.
 *
 * Debounced on the HOST as well as the sim, because either alone leaves a jittery layout: a sim that
 * forgets will flood, and a host that assumes every sim debounces will be flooded by the ones that
 * do not.
 */
export function createResizeCoalescer<T>(
  windowMs: number,
  deliver: (value: T) => void,
  now: () => number = () => 0,
): (value: T) => void {
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  return (value: T): void => {
    const at = now();
    if (at - lastAt >= windowMs && timer === null) {
      lastAt = at;
      deliver(value);
      return;
    }
    pending = value;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        lastAt = now();
        const next = pending;
        pending = null;
        if (next !== null) deliver(next);
      }, windowMs);
    }
  };
}

export type { GradingInstruction, SimMode };
