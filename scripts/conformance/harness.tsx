/**
 * The conformance harness page.  (P6-T9)
 *
 * ## WHY A HARNESS RATHER THAN THE REAL LESSON PAGE
 *
 * The matrix has to observe frames in both directions, and a Next.js route would put a router, a
 * session fetch and a design system between the test and the protocol. So this page renders the REAL
 * `SimulationFrame` — the same component, the same sandbox attribute, the same transport — and records
 * what crossed the boundary. Anything the component does not actually do is invisible to this harness
 * exactly as it would be invisible to a student.
 *
 * ## TWO ORIGINS, OR THE TEST PROVES NOTHING
 *
 * The sim bundle is served from a different port than the page, so `crossOriginIsolated`, CORP and the
 * sandbox are all doing genuine work rather than describing a same-origin arrangement where they would
 * have nothing to enforce.
 */

import type { SeedPolicy } from '@orrery/sim-sdk/protocol';
import { checksumState } from '@orrery/sim-sdk/state';
import { createRoot } from 'react-dom/client';
import { SimulationFrame } from '../../apps/web/src/features/sim/SimulationFrame';

interface HarnessConfig {
  readonly bundleUrl: string;
  readonly simOrigin: string;
  readonly simId: string;
  readonly simVersion: string;
  readonly defaultHeight: number;
  readonly minHeight: number;
  readonly textAlternative: string;
  readonly title: string;
  readonly params: Record<string, unknown>;
  /** A saved state to restore, when a cell is testing save/restore. Omitted otherwise. */
  readonly initialState?: unknown;
  readonly mode: 'lesson' | 'graded' | 'preview';
  /**
   * HOW THE HOST SHOULD DERIVE THE SEED, AND FOR WHOM.
   *
   * ## WHY THIS WAS PINNED, AND WHY THAT WAS THE WHOLE PROBLEM
   *
   * The seed policy was hardcoded to `{ kind: 'FIXED', seed: 'conformance-seed' }`. That is exactly right for
   * a determinism cell -- two mounts of the same simulation must agree -- and it meant `deriveSeed`'s
   * `PER_STUDENT` branch NEVER RAN IN A BROWSER.
   *
   * That branch is the anti-collusion claim: two students in one cohort must not get the same paper, and the
   * same student must get the same paper on a re-sit, because a teacher asking "what did they actually get?"
   * needs an answer. `hostBridge.ts` takes it seriously enough to throw `SEED_IDENTITY_MISSING` rather than
   * fall back, with the comment that a cohort sharing one paper is the failure nobody notices until the
   * results come in. None of that was exercised against a real frame.
   *
   * The default is unchanged, so every cell that does not care about seeding behaves exactly as before. A
   * spread of `{}` instead would hand the host `undefined` and change the mount for all twenty-three sims.
   */
  readonly seedPolicy?: SeedPolicy;
  readonly identity?: { attemptId?: string; userId?: string; assignmentId?: string };
}

/** Everything the harness saw, for the runner to read from the page. */
interface HarnessLog {
  readonly answers: unknown[];
  readonly states: Array<{ state: unknown; checksum: string | null }>;
  readonly fallbacks: string[];
  readonly statuses: string[];
  /** Every host frame the component actually posted, captured by wrapping `postMessage`. */
  /** Inbound frames as the PAGE saw them, installed before React mounts. */
  readonly inbound: Array<{ type: string; nonce: string | null }>;
  /**
   * Re-derive a checksum from a state, so the runner can check the sim's own claim rather than trust
   * the string the sim sent. A checksum that is merely non-empty proves nothing about the state.
   */
  checksumOf(value: unknown): string;
}

declare global {
  interface Window {
    __conformance: {
      readonly config: HarnessConfig;
      readonly log: HarnessLog;
      status(): string;
      ready: boolean;
    };
  }
}

/**
 * The configuration arrives in the query string as base64url.
 *
 * A URL rather than an injected script: the bundle reads this at module scope, so anything written by
 * an init script on `DOMContentLoaded` arrives too late and the harness mounts with an empty config.
 * Reading it once, from the one place that already has it, removes the race entirely.
 */
const readConfig = (): HarnessConfig => {
  const raw = new URLSearchParams(globalThis.location.search).get('cfg');
  if (raw === null) throw new Error('the conformance harness needs a ?cfg= parameter');
  const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded) as HarnessConfig;
};

const config = readConfig();
const log: HarnessLog = { answers: [], states: [], fallbacks: [], statuses: [], inbound: [] };

// Installed BEFORE the first render, because a listener added afterwards misses the handshake -- which
// is exactly what the first version of the `sim:ready` cell did: it waited two seconds for a frame that
// had already arrived and been dropped on the floor.
globalThis.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: unknown; nonce?: unknown } | null;
  if (data === null || typeof data.type !== 'string') return;
  log.inbound.push({
    type: data.type,
    nonce: typeof data.nonce === 'string' ? data.nonce : null,
  });
});

/**
 * Outbound frames are NOT recorded by patching `postMessage`.
 *
 * The first version wrapped `postMessage` on the frame's window and reported "no sim:init was posted"
 * for a host that was posting one. The reason is the whole point of the sandbox: cross-origin frame
 * windows refuse property assignment, so the patch threw a SecurityError every time an iframe appeared.
 * The measurement was impossible, not merely wrong.
 *
 * What is observable instead is the sim's side: a `sim:ready` carrying the host's nonce proves the init
 * was delivered AND that the sim read it. The host's own counters are exposed on `data-sim-frames`.
 */

const mountPoint = document.createElement('div');
mountPoint.id = 'root';
document.body.append(mountPoint);

createRoot(mountPoint).render(
  // NOT WRAPPED IN `StrictMode`, AND THAT IS LOAD-BEARING.
  //
  // StrictMode double-invokes effects in development, so the frame mounts, tears down, and mounts again
  // with a fresh document. A conformance script that posts `sim:setParams` can land in the FIRST document
  // and then read the SECOND one's state -- which showed up as `expect.answer.quantity` answering
  // `"acceleration"` for a script that had just set `"mass"`, intermittently, in whichever run lost the
  // race. The defect was invisible while `sim:init` params were discarded, because the simulation always
  // started from its own defaults and the script happened to set those same values.
  //
  // Production does not remount a lesson block to check for impure effects, and a harness that measures a
  // simulation through a remount is measuring React, not the simulation.
  <SimulationFrame
    simId={config.simId}
    simVersion={config.simVersion}
    bundleUrl={config.bundleUrl}
    simOrigin={config.simOrigin}
    params={config.params}
    // Only present when a cell asked for a restore; otherwise the prop is OMITTED, so an ordinary mount
    // carries nothing -- which is exactly what a real first visit looks like.
    {...(config.initialState === undefined ? {} : { initialState: config.initialState })}
    mode={config.mode}
    seedPolicy={config.seedPolicy ?? { kind: 'FIXED', seed: 'conformance-seed' }}
    {...(config.identity === undefined ? {} : { identity: config.identity })}
    defaultHeight={config.defaultHeight}
    minHeight={config.minHeight}
    textAlternative={config.textAlternative}
    title={config.title}
    lazy={false}
    // No probe: this harness serves its own sim origin, so the reachability check is a separate
    // concern with its own tests, and stubbing it here would only assert the stub.
    probeFetch={null}
    onAnswer={(answer) => {
      log.answers.push(answer);
    }}
    onState={(state, checksum) => {
      log.states.push({ state, checksum });
    }}
    onFallback={(reason) => {
      log.fallbacks.push(reason);
    }}
  />,
);

const observer = new MutationObserver(() => {
  const host = document.querySelector('.sim-host');
  const status = host?.getAttribute('data-sim-status');
  if (status !== null && log.statuses.at(-1) !== status) log.statuses.push(status);
});
observer.observe(document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ['data-sim-status'],
});

window.__conformance = {
  config,
  log,
  checksumOf: (value: unknown): string => checksumState(value),
  status: () => document.querySelector('.sim-host')?.getAttribute('data-sim-status') ?? 'ABSENT',
  ready: true,
};
