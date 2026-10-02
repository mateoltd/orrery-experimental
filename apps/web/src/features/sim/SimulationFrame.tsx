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
import {
  FRAME_SANDBOX_TOKENS,
  HANDSHAKE_TIMEOUT_MS,
  type HostFrame,
  type SeedPolicy,
  type SimMode,
} from '@orrery/sim-sdk/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BLOCKED_ADVICE,
  type BlockedReason,
  createHostBridge,
  deriveSeed,
  type HostState,
  initialHostState,
  type ProbeResult,
  probeSimOrigin,
} from './hostBridge';

export interface SimulationFrameProps {
  readonly simId: string;
  readonly simVersion: string;
  /** The content-hashed bundle URL on the SIM origin. Never the app origin. */
  readonly bundleUrl: string;
  /**
   * The SIM ORIGIN: where the bundle is served from, and what the reachability probe asks.
   *
   * It is NOT the `postMessage` target origin, and the reason is not a preference. `sandbox=
   * "allow-scripts"` deliberately withholds `allow-same-origin`, so the frame's origin is OPAQUE —
   * literally `'null'` — and `postMessage(frame, targetOrigin)` refuses any target that does not match
   * the recipient's origin. An explicit origin therefore throws for every sandboxed frame:
   *
   * > Failed to execute 'postMessage': The target origin provided ('https://sims.example') does not
   * > match the recipient window's origin ('null').
   *
   * A previous version of this file posted to the explicit origin and delivered NOTHING. The security
   * concern behind that choice was real, though, so it is answered where it can actually be answered —
   * see `POST_TARGET_ORIGIN` below.
   */
  readonly simOrigin: string;
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
  /**
   * Injected so the reachability probe is testable without a network. Explicit `null` SKIPS the probe,
   * which is how a unit test mounts the frame without one; the default resolves to `globalThis.fetch`
   * and becomes `null` only where there is no fetch at all.
   */
  readonly probeFetch?: typeof fetch | null;
  /** Injected for tests: the app origin the probe presents. */
  readonly appOrigin?: string;
  readonly onAnswer?: (answer: unknown) => void;
  /**
   * The state and the checksum the sim sent with it. Both, or the receiver cannot check anything --
   * `restoreState` needs the checksum the state was stored with to know the stored bytes are intact.
   */
  readonly onState?: (state: unknown, checksum: string | null) => void;
  readonly onFallback?: (reason: BlockedReason) => void;
}

/**
 * A nonce for this mount.
 *
 * Generated here rather than taken from a prop because it must be UNPREDICTABLE and FRESH per mount:
 * reusing one would let a page that observed an earlier mount post frames to this one. `crypto` rather
 * than `Math.random()` for the same reason `INV-RNG-1` exists — a guessable nonce is not a nonce.
 */
/**
 * The `postMessage` target origin, which is `'*'`, and here is the whole argument for it.
 *
 * ## WHY `'*'` IS NOT A CONVENIENCE HERE
 *
 * The obvious worry is that `'*'` hands the init frame -- params, seed and nonce -- to whatever document
 * is in the frame afterwards. That worry is correct, and it is also not fixable by naming an origin,
 * because naming an origin does not work at all: the frame is opaque by design, so every explicit target
 * is rejected and the host delivers nothing. `'*'` is the only value the platform accepts for an opaque
 * recipient. Refusing to post at all would be the secure choice and would make simulations impossible.
 *
 * So the exposure is bounded by what the sandbox already gives away, and by what the host checks on the
 * way back in:
 *
 *  1. The frame has NO origin of its own. `allow-same-origin` is withheld precisely so a sim cannot be
 *     the app origin and read the session cookie.
 *  2. A document that navigates itself INTO the frame inherits the sandbox, so it is opaque too — it has
 *     no origin to steal and cannot present the app's origin to anything.
 *  3. The host authenticates every inbound frame by `event.source` AND a per-mount nonce, so a third
 *     party cannot forge frames. A sim that navigates itself away is, at that point, running untrusted
 *     code in a frame we already chose to sandbox -- and it could already send answers, because the
 *     answer path is the protocol, not a secret.
 *  4. The sim origin serves the bundle with CORP `cross-origin` and the sim origin's own CSP, so the
 *     bundle's integrity is a deployment property rather than something postMessage can guarantee.
 *
 * What `'*'` costs is the ability to say "only this origin" at the transport layer. What the previous
 * version cost was every simulation.
 */
const POST_TARGET_ORIGIN = '*';

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
    simOrigin,
    probeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
    appOrigin = '',
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
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  /**
   * Three states, not two, because "not asked yet" and "asked and told no" must not mount the same
   * thing. `SKIPPED` exists only for a caller with no fetch, where the honest answer is "we could not
   * check" rather than a pass or a fail -- see `probeAllowsMount`.
   */
  const [probeState, setProbeState] = useState<'SKIPPED' | 'PENDING' | 'DONE'>(() =>
    probeFetch === null ? 'SKIPPED' : 'PENDING',
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createHostBridge> | null>(null);
  const lastAnswerRef = useRef<unknown>(null);

  // The configured SIM origin must still be an absolute origin. `POST_TARGET_ORIGIN` is `'*'`, so this
  // is no longer a postMessage constraint -- it is a check that the deployment is configured at all,
  // and it is what the reachability probe is asked about. A missing value is a config bug that should
  // fail here rather than silently in a student's lesson.
  const targetOrigin = useMemo(() => {
    try {
      const parsed = new URL(simOrigin);
      return parsed.origin === simOrigin ? parsed.origin : null;
    } catch {
      return null;
    }
  }, [simOrigin]);

  const originUsable = targetOrigin !== null;

  /**
   * The parent's callbacks, held in refs.
   *
   * ## WHY THEY ARE NOT IN THE BRIDGE EFFECT'S DEPENDENCY LIST
   *
   * Because they were, and it broke every simulation. A parent that passes an inline arrow --
   * `<SimulationFrame onState={(s) => ...} />`, which is how every caller writes it -- produces a new
   * function identity on every render. The effect therefore tore down the live bridge, emitted
   * `sim:teardown` and installed a fresh one on every single re-render, and the fresh bridge never got
   * `sim:init` because that only goes out on the iframe's `load`. The host sat at `READY` with one
   * frame accepted and a dead connection, and a re-render anywhere in the enclosing lesson was enough
   * to do it.
   *
   * The ref holds the latest callback, so the bridge is built once per connection and always calls the
   * current handler. This is the standard shape for "the thing I hand to a long-lived object must stay
   * fresh, and the object itself must not churn".
   */
  const callbacksRef = useRef({ onAnswer, onState, onFallback });
  callbacksRef.current = { onAnswer, onState, onFallback };

  const nonce = useMemo(() => props.nonce ?? mintNonce(), [props.nonce]);
  // Named fields, not the `identity` object, in both the capture and the dependency list. The first
  // version captured the object and depended on three of its properties, which is the shape that makes
  // a memo stale for reasons no reviewer can see: a new object with the same ids recomputes, and a
  // changed id under a stable object does not.
  const { attemptId, userId, assignmentId } = identity;
  /**
   * The seed's INPUTS, not the policy object's identity.
   *
   * `seedPolicy` is an object, and `<SimulationFrame seedPolicy={{ kind: 'FIXED', seed: 'x' }} />` is how
   * every caller writes it — the host's own `policyOf()` returns a fresh object per render. Depending on
   * the identity therefore re-ran the seed memo, and because `seed` is in the bridge effect's dependency
   * list, every render tore down the live bridge, posted `sim:teardown` and installed a new one that
   * never received `sim:init`. The simulation died on the first state update and the host sat at `READY`
   * with a dead connection, reporting a timeout for a simulation that was fine.
   *
   * A FIXED seed cannot be re-derived per render anyway — `deriveSeed` takes a nonce source, and a new
   * nonce per render would give a student a different simulation on every keystroke in the lesson.
   */
  const policyKind = seedPolicy.kind;
  const policySeed = seedPolicy.kind === 'FIXED' ? seedPolicy.seed : '';
  const policyDerivation = seedPolicy.kind === 'PER_STUDENT' ? seedPolicy.derivation : undefined;
  const seed = useMemo(
    // The policy REBUILT from its fields rather than closed over. Same values, and it means the memo's
    // dependency list is genuinely complete instead of suppressed -- which is the difference between a
    // deliberate decision and a lint rule that learned to look away.
    () =>
      deriveSeed(
        policyKind === 'FIXED'
          ? { kind: 'FIXED', seed: policySeed }
          : policyKind === 'PER_VIEW'
            ? { kind: 'PER_VIEW' }
            : { kind: 'PER_STUDENT', derivation: policyDerivation ?? 'USER_ID' },
        { attemptId, userId, assignmentId },
        () => mintNonce(),
      ),
    [policyKind, policySeed, policyDerivation, attemptId, userId, assignmentId],
  );

  /**
   * The params, keyed on their CONTENT.
   *
   * Same problem as the policy: a lesson block's `params` is a fresh object per render, and depending on
   * its identity would rebuild the bridge on every render for values that never changed.
   */
  const paramsKey = JSON.stringify(params);
  // Read through a ref, and keyed on the serialised VALUE. The content is what the simulation is
  // configured by; the identity is an artefact of whoever built the object this render.
  const policyRef = useRef(seedPolicy);
  policyRef.current = seedPolicy;
  /**
   * `params` with an identity that tracks its CONTENT, built by parsing the serialised value.
   *
   * The round trip is deliberate rather than a shortcut, so that the dependency is real: the bridge effect
   * genuinely reads this object, and the object changes exactly when the student changes a setting. It is
   * lossless for what a block may carry -- `params` values are `string | number | boolean` per the block
   * schema, and every one of those survives JSON.
   *
   * `JSON.stringify` as a change key is not clever, and being obvious to the next reader is worth more
   * here than saving a parse that happens once per settings change.
   */
  const stableParams = useMemo(
    () => JSON.parse(paramsKey) as Readonly<Record<string, unknown>>,
    [paramsKey],
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

  // Reachability BEFORE the bundle is requested.
  //
  // The first version inferred everything from the iframe's `error` event, which cannot tell a
  // blocked request from a 404 from a slow network, so every failure told a student to check their
  // firewall. Probing first also means a student on a blocked network never downloads a bundle that
  // was never going to run.
  useEffect(() => {
    if (!visible) return undefined;
    // No fetch means the check cannot run. Proceeding is the right call: a host that blocks mounts
    // because it could not ask a question is worse than a host that asks and does not listen.
    if (probeFetch === null) return undefined;
    let cancelled = false;
    const run = async (): Promise<void> => {
      // The component's own clock, so the probe's cache expiry obeys the same `INV-TIME-1` injection
      // as the handshake timeout and a test can expire it deliberately.
      const result = await probeSimOrigin(simOrigin, appOrigin, probeFetch, now);
      if (cancelled) return;
      setProbe(result);
      // Set on the way out of the effect, not on the way in: a `PENDING` that never becomes `DONE`
      // leaves the mount on its poster forever, which reads as "slow" rather than "broken".
      setProbeState('DONE');
      if (result.outcome !== 'OK') setBlockedReason(result.outcome);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [visible, simOrigin, appOrigin, probeFetch, now]);

  useEffect(() => {
    // Not mounted until the check has RESOLVED, in either direction. Mounting while a probe is still in
    // flight is how the first version downloaded a bundle for a network that had already been found to
    // be blocked.
    if (!visible || !originUsable) return undefined;
    if (probeState === 'PENDING') return undefined;
    if (probeState === 'DONE' && probe?.outcome !== 'OK') return undefined;
    // `frameEl`, not `frame`: `frame` is already the PROTOCOL frame everywhere else in this file,
    // and the shadowing made `frameEl.contentWindow` read `undefined` on a plain object -- so every
    // outbound frame was silently dropped.
    const frameEl = frameRef.current;
    if (frameEl === null) return undefined;

    const apply = (next: HostState): void => {
      setState(next);
      if (next.showFallback && next.status !== 'READY') {
        callbacksRef.current.onFallback?.(next.status === 'UNREACHABLE' ? 'FIREWALL' : 'UNKNOWN');
      }
    };

    const bridge = createHostBridge({
      simId,
      simVersion,
      nonce,
      mode,
      // Through the refs, because `paramsKey` and `seed` are what the effect is keyed on -- the CONTENT,
      // never the identity. Reading the objects directly here is what made the effect re-run per render.
      params: stableParams,
      seed,
      seedPolicy: policyRef.current,
      gradingSupplied: mode === 'graded',
      bundleUrl,
      defaultHeight,
      minHeight,
      now,
      expectedSource: frameEl.contentWindow,
      // Every inbound frame reports its next state here. Without this the component only ever learns
      // about `load` and a timeout, and a completed handshake renders as a timeout.
      onState: apply,
      transport: {
        subscribe(handler) {
          const listener = (event: MessageEvent): void => {
            handler(event.data, event.source);
          };
          globalThis.addEventListener('message', listener);
          return () => globalThis.removeEventListener('message', listener);
        },
        post(frame: HostFrame) {
          // The window captured when the bridge was created, not `frameRef.current`. React detaches a
          // ref during the commit that unmounts, so a teardown posted by the effect cleanup read a null
          // ref and was silently dropped -- the sim kept its rAF loop running for the rest of the page.
          const target = frameEl.contentWindow;
          if (target === null || target === undefined) return;
          target.postMessage(frame, POST_TARGET_ORIGIN);
        },
      },
    });
    bridgeRef.current = bridge;

    // The handshake timer starts when the frame ELEMENT loads, not here: a bundle that takes nine
    // seconds to download has not spent nine seconds failing to hand-shake.
    let loadObserved = false;
    const onLoad = (): void => {
      // Guarded, because a second `load` would start a second timer and the first one would still be
      // pending when the component unmounts.
      if (loadObserved) return;
      loadObserved = true;
      apply(bridge.onFrameEvent('load'));
      timerRef.current = setTimeout(
        () => {
          const timedOut = bridge.checkTimeout();
          if (timedOut !== null) apply(timedOut);
        },
        // The protocol's constant, not a literal. A timeout copied from the spec is a timeout that
        // drifts from the spec the first time the spec moves.
        HANDSHAKE_TIMEOUT_MS,
      );
      // The handshake starts HERE, after load, and `sim:init` is the first thing out. A frame that has
      // not loaded has no window to receive it, and a host that talks first spends its whole budget
      // downloading.
      bridge.emit(bridge.initFrame());
    };
    const onError = (): void => {
      apply(bridge.onFrameEvent('error'));
      setBlockedReason('FIREWALL');
    };
    frameEl.addEventListener('load', onLoad);
    frameEl.addEventListener('error', onError);

    return () => {
      frameEl.removeEventListener('load', onLoad);
      frameEl.removeEventListener('error', onError);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // `sim:teardown` first, so the sim can stop its rAF loop and release its listeners before we
      // stop listening to it. A simulation left running after its host is gone keeps a timer alive for
      // as long as the student stays on the page.
      bridge.emit(bridge.teardown());
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [
    visible,
    simId,
    simVersion,
    nonce,
    mode,
    stableParams,
    seed,
    // NOT `seedPolicy`: it is an object, and depending on its identity rebuilt the bridge on every
    // render. A genuine policy change is still covered, because `seed` is derived from the policy's
    // FIELDS above and `seed` is in this list.
    bundleUrl,
    defaultHeight,
    minHeight,
    now,
    originUsable,
    probeState,
    probe,
  ]);

  // The answer is reported ONCE per value, not once per render: a re-render of the surrounding lesson
  // must not resubmit a student's work.
  useEffect(() => {
    if (state.answer !== null && state.answer !== lastAnswerRef.current) {
      lastAnswerRef.current = state.answer;
      callbacksRef.current.onAnswer?.(state.answer);
    }
  }, [state.answer]);

  useEffect(() => {
    if (state.lastState !== null) {
      callbacksRef.current.onState?.(state.lastState, state.lastChecksum);
    }
  }, [state.lastState, state.lastChecksum]);

  // Visibility, and the STATE CAPTURE that goes with it.  (P6-T9)
  //
  // ## WHY CAPTURE IS ON THE SAME LIST AS PAUSE
  //
  // These are the same event seen from two directions. A hidden tab pauses the sim's rAF loop, and it is
  // also the last moment before a student closes the laptop — which is exactly when the state has to be
  // asked for. The first version emitted `sim:visibility` and never asked for state, so a simulation
  // that had been explored for ten minutes reported nothing on unload and the student's work was gone.
  //
  // `pagehide` as well as `visibilitychange`: on iOS Safari and in a bfcache restore, `unload` is
  // unreliable and the tab simply goes away, so the state request has to be sent on the event that
  // actually fires.
  useEffect(() => {
    const onVisibility = (): void => {
      // Emitted, not merely computed. A hidden tab pauses the sim's rAF loop, and a host that computes
      // the frame and never sends it leaves every student's timeline running on without them.
      const bridge = bridgeRef.current;
      if (bridge === null) return;
      const visible = document.visibilityState === 'visible';
      bridge.emit(bridge.visibility(visible));
      // The state ask is only meaningful on the way OUT, and asking on the way in would capture the
      // instant before the student looked at it.
      if (!visible) bridge.emit(bridge.requestState('blur'));
    };
    const onPageHide = (): void => {
      const bridge = bridgeRef.current;
      if (bridge === null) return;
      bridge.emit(bridge.requestState('unload'));
    };
    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  const height = Math.max(minHeight, state.height ?? defaultHeight);

  // A failed probe is a fallback in its own right, with its OWN advice rather than the bridge's generic
  // one: "your school network is blocking this" and "your network is blocking this" send a student to
  // two different places.
  const probeBlocked = probeState === 'DONE' && probe !== null && probe.outcome !== 'OK';
  const showFallback = state.showFallback || probeBlocked || !originUsable;
  const teacherDetail = !originUsable
    ? `The simulation origin ${JSON.stringify(simOrigin)} is not a usable origin, so the frame was not mounted. ` +
      'postMessage needs an explicit target origin, and falling back to "*" would leak the nonce.'
    : probeBlocked
      ? `The simulation origin ${simOrigin} did not answer its reachability probe: ${probe.detail}`
      : state.teacherDetail;

  return (
    <div
      className="sim-host"
      ref={containerRef}
      data-sim-id={simId}
      data-sim-status={state.status}
      // The counters are on the element because a support screenshot is the only artefact that survives
      // an incident: "the frame loaded and the sim said ready" and "the frame loaded and something
      // impersonated it" look identical in a status attribute.
      data-sim-frames={String(state.framesAccepted)}
      data-sim-dropped={String(state.framesDropped)}
      data-sim-spoofs={String(state.spoofAttempts)}
    >
      {showFallback ? (
        <div className="sim-host__fallback" role="status">
          <p className="sim-host__message">
            {state.studentMessage ?? BLOCKED_ADVICE[blockedReason ?? 'UNKNOWN']}
          </p>
          <p className="sim-host__text">{textAlternative}</p>
          {teacherDetail !== null ? (
            <p className="sim-host__teacher" data-testid="sim-teacher-detail">
              {teacherDetail}
            </p>
          ) : null}
        </div>
      ) : visible && originUsable && (probeState === 'SKIPPED' || probe?.outcome === 'OK') ? (
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
