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

import { checksumState } from '@orrery/sim-sdk/state';
import { StrictMode } from 'react';
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
  readonly mode: 'lesson' | 'graded' | 'preview';
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
  <StrictMode>
    <SimulationFrame
      simId={config.simId}
      simVersion={config.simVersion}
      bundleUrl={config.bundleUrl}
      simOrigin={config.simOrigin}
      params={config.params}
      mode={config.mode}
      seedPolicy={{ kind: 'FIXED', seed: 'conformance-seed' }}
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
      onState={(state) => {
        log.states.push({ state, checksum: readChecksum(state) });
      }}
      onFallback={(reason) => {
        log.fallbacks.push(reason);
      }}
    />
  </StrictMode>,
);

function readChecksum(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const checksum = (state as { checksum?: unknown }).checksum;
  return typeof checksum === 'string' ? checksum : null;
}

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
