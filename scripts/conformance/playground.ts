/**
 * The simulation playground: a host you can actually watch.  (P6-T10)
 *
 * ## WHAT THIS IS FOR
 *
 * A simulation author needs to answer one question fast: *is my sim talking to the host correctly?* The
 * unit tests answer it for the SDK in isolation. Nothing answered it for a real bundle in a real frame,
 * so the answer came from conformance failures — which is backwards, and slow.
 *
 * So: a real iframe on a real second origin, with every frame in both directions listed as it happens,
 * and a button per host frame so you can send one deliberately. What you see here is what a student
 * would get, with the noise turned up.
 *
 * ## THE PROTOCOL INSPECTOR IS THE POINT, AND IT IS DELIBERATELY VERBOSE
 *
 * The console is the wrong place. `console.log` inside a sandboxed frame goes to the frame's own console,
 * which a developer has to have open separately, and it shows no nonce, no ordering against the host's
 * frames, and nothing about frames the sim DROPPED. Those are precisely the three things worth seeing, so
 * this records both directions with a monotonic timestamp and marks every frame the host rejected.
 *
 * ## IT USES THE SAME SANDBOX AND THE SAME PROTOCOL AS PRODUCTION
 *
 * `sandbox="allow-scripts"` and nothing else, `postMessage` to `'*'` because the frame is opaque, and the
 * SDK's own `evaluateHandshake` for the verdict. A playground that was more forgiving than production
 * would be a place bugs go to hide.
 */

import {
  evaluateHandshake,
  FRAME_SANDBOX_TOKENS,
  HANDSHAKE_TIMEOUT_MS,
  type HostFrame,
} from '@orrery/sim-sdk/protocol';

interface Config {
  readonly bundleUrl: string;
  readonly simId: string;
  readonly simVersion: string;
  readonly simOrigin: string;
  readonly params: Record<string, unknown>;
  readonly mode: 'lesson' | 'graded' | 'preview';
}

interface Logged {
  readonly seq: number;
  readonly at: number;
  readonly direction: 'host -> sim' | 'sim -> host';
  readonly type: string;
  readonly accepted: boolean;
  readonly note: string;
  readonly payload: unknown;
}

const readConfig = (): Config => {
  const raw = new URLSearchParams(globalThis.location.search).get('cfg');
  if (raw === null) throw new Error('the playground needs a ?cfg= parameter');
  return JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) as Config;
};

const config = readConfig();

/** A monotonic clock for DURATIONS — never `Date.now()`, which is banned outside `@orrery/clock`. */
const started = globalThis.performance.now();
const sinceStart = (): number => Math.round(globalThis.performance.now() - started);

const mintNonce = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const nonce = mintNonce();

const root = document.getElementById('root') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const verdictEl = document.getElementById('verdict') as HTMLElement;
const frameEl = document.getElementById('sim') as HTMLIFrameElement;
const paramEl = document.getElementById('params') as HTMLTextAreaElement;

paramEl.value = JSON.stringify(config.params, null, 2);

const log: Logged[] = [];
let seq = 0;

/**
 * Render one line per frame.
 *
 * Newest LAST, because a protocol log read top-down is a sequence, and newest-first turns "what happened
 * after my reset" into a scroll. Every line carries its own verdict so a dropped frame is visible rather
 * than absent.
 */
const render = (): void => {
  logEl.textContent = log
    .map((entry) => {
      const mark = entry.accepted ? ' ' : '!';
      return `${String(entry.seq).padStart(3, ' ')} ${String(entry.at).padStart(6, ' ')}ms ${mark} ${entry.direction.padEnd(13, ' ')} ${entry.type.padEnd(16, ' ')} ${entry.note}`;
    })
    .join('\n');
  logEl.scrollTop = logEl.scrollHeight;
};

const record = (
  direction: Logged['direction'],
  type: string,
  accepted: boolean,
  note: string,
  payload: unknown,
): void => {
  seq += 1;
  log.push({ seq, at: sinceStart(), direction, type, accepted, note, payload });
  render();
};

const summarise = (payload: unknown): string => {
  if (payload === null || typeof payload !== 'object') return JSON.stringify(payload) ?? 'null';
  const frame = payload as Record<string, unknown>;
  const interesting = [
    'name',
    'reason',
    'visible',
    'simId',
    'simVersion',
    'code',
    'message',
    'checksum',
  ];
  const parts = interesting
    .filter((key) => frame[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(frame[key])}`);
  return parts.length > 0 ? parts.join(' ') : JSON.stringify(payload).slice(0, 90);
};

// ── inbound: everything the sim says, and whether we believe it ──
globalThis.addEventListener('message', (event: MessageEvent) => {
  const frame = event.data as { type?: unknown; nonce?: unknown } | null;
  if (frame === null || typeof frame !== 'object' || typeof frame.type !== 'string') return;
  // The nonce is the whole authentication story, so a frame without a matching one is shown REJECTED
  // rather than dropped from the log: a sim whose nonce handling is wrong needs to be able to SEE that.
  const rightNonce = frame.nonce === nonce;
  record(
    'sim -> host',
    frame.type,
    rightNonce,
    rightNonce ? summarise(frame) : 'REJECTED: wrong nonce',
    frame,
  );

  if (frame.type === 'sim:ready') {
    const verdict = evaluateHandshake(frame, {
      simId: config.simId,
      simVersion: config.simVersion,
      protocol: 1,
    });
    verdictEl.textContent = verdict.ok
      ? `handshake OK — capabilities ${JSON.stringify((frame as { capabilities?: unknown }).capabilities)}`
      : `handshake REFUSED — ${verdict.code}: ${verdict.message}`;
    verdictEl.className = verdict.ok ? 'ok' : 'bad';
  }
});

// ── outbound: one button per host frame, sent deliberately ──
const post = (frame: HostFrame): void => {
  record('host -> sim', frame.type, true, summarise(frame), frame);
  frameEl.contentWindow?.postMessage(frame, '*');
};

const buttons: Array<[string, () => void]> = [
  ['play', () => post({ type: 'sim:command', name: 'play' } as HostFrame)],
  ['pause', () => post({ type: 'sim:command', name: 'pause' } as HostFrame)],
  ['step', () => post({ type: 'sim:command', name: 'step', args: { step: 1 } } as HostFrame)],
  ['focus', () => post({ type: 'sim:command', name: 'focus' } as HostFrame)],
  ['request state', () => post({ type: 'sim:requestState', reason: 'save' } as HostFrame)],
  ['hide', () => post({ type: 'sim:visibility', visible: false } as HostFrame)],
  ['show', () => post({ type: 'sim:visibility', visible: true } as HostFrame)],
  [
    'set params',
    () => {
      try {
        const parsed = JSON.parse(paramEl.value) as Record<string, unknown>;
        post({ type: 'sim:setParams', params: parsed } as HostFrame);
      } catch (error) {
        // A JSON error here is the author's, and swallowing it would look like a dead button.
        verdictEl.textContent = `setParams: ${error instanceof Error ? error.message : String(error)}`;
        verdictEl.className = 'bad';
      }
    },
  ],
  ['teardown', () => post({ type: 'sim:teardown' } as HostFrame)],
];

const bar = document.getElementById('bar') as HTMLElement;
for (const [label, action] of buttons) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  bar.append(button);
}

const clear = document.createElement('button');
clear.type = 'button';
clear.textContent = 'clear log';
clear.addEventListener('click', () => {
  log.length = 0;
  render();
});
bar.append(clear);

// ── the mount ──
const onLoad = (): void => {
  record('host -> sim', 'frame:load', true, 'the frame element finished loading', null);
  post({
    type: 'sim:init',
    protocol: 1,
    nonce,
    simId: config.simId,
    simVersion: config.simVersion,
    params: JSON.parse(paramEl.value) as Record<string, unknown>,
    seed: 'playground-seed',
    mode: config.mode,
  } as HostFrame);
};
// Assigned here rather than in the markup, because the bundle URL arrives in the query string. The first
// version left `src` empty: the page booted, the inspector rendered, the smoke test reported "no sim ->
// host frames" -- and the cause was a playground that never loaded a simulation at all.
frameEl.src = config.bundleUrl;
frameEl.addEventListener('load', onLoad);

// The handshake timeout is the protocol's, not a literal here.
globalThis.setTimeout(() => {
  if (!log.some((entry) => entry.type === 'sim:ready')) {
    verdictEl.textContent = `no sim:ready within ${String(HANDSHAKE_TIMEOUT_MS / 1000)}s`;
    verdictEl.className = 'bad';
  }
}, HANDSHAKE_TIMEOUT_MS);

// Asserted here rather than trusted: if the served page and the protocol's own constant ever disagree,
// the playground is no longer testing what ships, and saying so is better than a page that quietly
// differs from production.
if (frameEl.getAttribute('sandbox') !== FRAME_SANDBOX_TOKENS) {
  verdictEl.textContent = `the served page has sandbox="${String(frameEl.getAttribute('sandbox'))}", not "${FRAME_SANDBOX_TOKENS}"`;
  verdictEl.className = 'bad';
}

verdictEl.textContent = 'waiting for sim:ready…';
verdictEl.className = '';
root.dataset.playground = 'ready';

/** Exposed so `sim:playground --once` can assert on the page rather than on a screenshot. */
(globalThis as unknown as { __playground: unknown }).__playground = {
  log,
  verdict: () => verdictEl.textContent ?? '',
  nonce,
  evaluateHandshake: (frame: unknown) =>
    evaluateHandshake(frame, { simId: config.simId, simVersion: config.simVersion, protocol: 1 })
      .ok,
};
