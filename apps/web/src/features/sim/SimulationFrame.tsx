'use client';

/**
 * The simulation frame.  (P6-T6)
 *
 * ## `sandbox="allow-scripts"` AND NOTHING ELSE, LITERALLY
 *
 * The attribute is written out rather than assembled from a variable, so a diff shows the whole
 * permission set in one line and a reviewer can see an addition immediately. Each absence is
 * load-bearing: `allow-same-origin` would make the frame same-origin and hand it our DOM, and
 * `allow-downloads` would let a sim exfiltrate a student's work through the download shelf, which no
 * CSP directive prevents.
 *
 * ## THE FAILURE UI IS NOT AN ERROR BOUNDARY
 *
 * Four distinct things can stop a simulation: it cannot be reached, it loaded and stalled, a different
 * version answered, or the sim itself failed. Each needs a different sentence for a student and a
 * different line for a teacher, and none of them is a thrown error. So the bridge holds a state, this
 * component renders it, and the static fallback is ALWAYS available — a lesson is never broken by a
 * registry problem.
 *
 * ## THE TIMER IS A REF, AND IT IS CLEARED
 *
 * The handshake timeout is a `setTimeout`, and a component that leaves one running after unmount calls
 * `setState` on a dead tree. That is a warning in development and a leak in a lesson with twelve sims.
 */

import { systemClock } from '@orrery/clock';
import { FRAME_SANDBOX_TOKENS, type SeedPolicy, type SimMode } from '@orrery/sim-sdk/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BLOCKED_ADVICE,
  type BlockedReason,
  createHostBridge,
  deriveSeed,
  type HostState,
  initialHostState,
} from './hostBridge';

export interface SimulationFrameProps {
  readonly simId: string;
  readonly simVersion: string;
  /** The content-hashed bundle URL on the SIM origin. Never the app origin. */
  readonly bundleUrl: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mode: SimMode;
  readonly seedPolicy: SeedPolicy;
  readonly defaultHeight: number;
  readonly minHeight: number;
  /** The text alternative. Shown in the fallback, in print, and to a screen reader. */
  readonly textAlternative: string;
  readonly title: string;
  readonly identity?: { attemptId?: string; userId?: string; assignmentId?: string };
  /** Lazy-mount on intersection. A lesson with twelve sims must not download twelve sims. */
  readonly lazy?: boolean;
  /** Injected for tests: the clock and the per-mount nonce. */
  readonly now?: () => number;
  readonly nonce?: string;
  readonly onAnswer?: (answer: unknown) => void;
  readonly onState?: (state: unknown) => void;
  readonly onFallback?: (reason: BlockedReason) => void;
}

/**
 * A nonce for this mount.
 *
 * Generated here rather than taken from a prop because it must be UNPREDICTABLE and FRESH per mount:
 * reusing one would let a page that observed an earlier mount post frames to this one. `crypto` rather
 * than `Math.random()` for the same reason `INV-RNG-1` exists — a guessable nonce is not a nonce.
 */
const mintNonce = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export function SimulationFrame(props: SimulationFrameProps): React.ReactElement {
  const {
    simId,
    simVersion,
    bundleUrl,
    params,
    mode,
    seedPolicy,
    defaultHeight,
    minHeight,
    textAlternative,
    title,
    identity = {},
    lazy = true,
    // `systemClock`, never `Date.now()`: `INV-TIME-1`, and the app-wide gate enforces it. A component
    // default of `Date.now()` would be a clock nobody can substitute in a test.
    now = systemClock.now,
    onAnswer,
    onState,
    onFallback,
  } = props;

  const [visible, setVisible] = useState(!lazy);
  const [state, setState] = useState<HostState>(initialHostState);
  const [blockedReason, setBlockedReason] = useState<BlockedReason | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createHostBridge> | null>(null);
  const lastAnswerRef = useRef<unknown>(null);

  const nonce = useMemo(() => props.nonce ?? mintNonce(), [props.nonce]);
  // Named fields, not the `identity` object, in both the capture and the dependency list. The first
  // version captured the object and depended on three of its properties, which is the shape that makes
  // a memo stale for reasons no reviewer can see: a new object with the same ids recomputes, and a
  // changed id under a stable object does not.
  const { attemptId, userId, assignmentId } = identity;
  const seed = useMemo(
    () => deriveSeed(seedPolicy, { attemptId, userId, assignmentId }, () => mintNonce()),
    [seedPolicy, attemptId, userId, assignmentId],
  );

  useEffect(() => {
    if (!lazy || visible) return;
    const node = containerRef.current;
    if (node === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer means no lazy behaviour, not no simulation. A browser without one still gets the
      // frame.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [lazy, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const frame = frameRef.current;
    if (frame === null) return undefined;

    const bridge = createHostBridge({
      simId,
      simVersion,
      nonce,
      mode,
      params,
      seed,
      seedPolicy,
      gradingSupplied: mode === 'graded',
      bundleUrl,
      defaultHeight,
      minHeight,
      now,
      expectedSource: frame.contentWindow,
      transport: {
        subscribe(handler) {
          const listener = (event: MessageEvent): void => {
            handler(event.data, event.source);
          };
          globalThis.addEventListener('message', listener);
          return () => globalThis.removeEventListener('message', listener);
        },
      },
    });
    bridgeRef.current = bridge;

    const apply = (next: HostState): void => {
      setState(next);
      if (next.showFallback && next.status !== 'READY') {
        onFallback?.(next.status === 'UNREACHABLE' ? 'FIREWALL' : 'UNKNOWN');
      }
    };

    // The handshake timer starts when the frame ELEMENT loads, not here: a bundle that takes nine
    // seconds to download has not spent nine seconds failing to hand-shake.
    const onLoad = (): void => {
      apply(bridge.onFrameEvent('load'));
      timerRef.current = setTimeout(() => {
        const timedOut = bridge.checkTimeout();
        if (timedOut !== null) apply(timedOut);
      }, 10_000);
    };
    const onError = (): void => {
      apply(bridge.onFrameEvent('error'));
      setBlockedReason('FIREWALL');
    };
    frame.addEventListener('load', onLoad);
    frame.addEventListener('error', onError);

    // `sim:init` goes out after load, because a frame that has not loaded has no window to receive it.
    onLoad();

    return () => {
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onError);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [
    visible,
    simId,
    simVersion,
    nonce,
    mode,
    params,
    seed,
    seedPolicy,
    bundleUrl,
    defaultHeight,
    minHeight,
    now,
    onFallback,
  ]);

  // The answer is reported ONCE per value, not once per render: a re-render of the surrounding lesson
  // must not resubmit a student's work.
  useEffect(() => {
    if (state.answer !== null && state.answer !== lastAnswerRef.current) {
      lastAnswerRef.current = state.answer;
      onAnswer?.(state.answer);
    }
  }, [state.answer, onAnswer]);

  useEffect(() => {
    if (state.lastState !== null) onState?.(state.lastState);
  }, [state.lastState, onState]);

  // A hidden tab pauses rAF loops inside the sim. Without this frame a student who switches tabs to
  // look something up comes back to a timeline that ran on without them.
  useEffect(() => {
    const onVisibility = (): void => {
      bridgeRef.current?.visibility(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const height = Math.max(minHeight, state.height ?? defaultHeight);

  return (
    <div className="sim-host" ref={containerRef} data-sim-id={simId} data-sim-status={state.status}>
      {state.showFallback ? (
        <div className="sim-host__fallback" role="status">
          <p className="sim-host__message">
            {state.studentMessage ?? BLOCKED_ADVICE[blockedReason ?? 'UNKNOWN']}
          </p>
          <p className="sim-host__text">{textAlternative}</p>
          {state.teacherDetail !== null ? (
            <p className="sim-host__teacher" data-testid="sim-teacher-detail">
              {state.teacherDetail}
            </p>
          ) : null}
        </div>
      ) : visible ? (
        <iframe
          ref={frameRef}
          className="sim-host__frame"
          title={title}
          src={bundleUrl}
          // Exactly one token. The absences are the sandbox.
          sandbox={FRAME_SANDBOX_TOKENS}
          // `srcdoc` is never used: an inline frame is reachable in ways a URL frame is not, and it
          // makes the bundle unhashable.
          style={{ height: `${String(height)}px`, width: '100%', border: 0 }}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="sim-host__poster" style={{ height: `${String(height)}px` }}>
          <p>{textAlternative}</p>
        </div>
      )}
      {/* The alternative is ALWAYS in the DOM, not only in the fallback: a screen-reader user tabbing
          past the frame reaches it, and a printed worksheet has something to print. */}
      <p className="sim-host__alternative" data-testid="sim-alternative">
        {textAlternative}
      </p>
      {state.status === 'LOADING' ? (
        <p className="sim-host__loading">Loading the simulation…</p>
      ) : null}
      {blockedReason !== null && state.status === 'UNREACHABLE' ? (
        <p className="sim-host__advice">{BLOCKED_ADVICE[blockedReason]}</p>
      ) : null}
    </div>
  );
}
