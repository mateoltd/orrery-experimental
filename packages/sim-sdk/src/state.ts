/**
 * State serialisation, checksumming and restore.  (P6-T3)
 *
 * ## WHY THE CHECKSUM IS A HAND-ROLLED FNV-1a AND NOT `node:crypto`
 *
 * `B14`: a grader bundle imports ZERO Node builtins. `node:crypto` is one, so the state checksum —
 * which the grader needs, because it has to decide whether a state it is handed is the state that
 * was saved — cannot use it.
 *
 * And it must not need it. The property we want is "did this change?", not "is this authentic": the
 * state travels inside the same sandbox as the sim, and an attacker who can edit the state can
 * recompute the checksum. This is a change detector and must never be named as a security control.
 *
 * ## WHY THE CANONICAL FORM SORTS KEYS
 *
 * A checksum over `JSON.stringify(state)` is not a checksum over the state. Two states with the same
 * properties inserted in a different order serialise differently and hash differently, so a restore
 * that rebuilt an object would report a mismatch against a state that never changed — and the
 * conformance suite's "serialise -> reload -> restore -> identical checksum" step would fail for
 * reasons that have nothing to do with the sim.
 */

import type { SimErrorCode } from './protocol.js';

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Sort keys, drop `undefined`, reject non-finite numbers and non-plain objects. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): Json {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value as Json;
  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(
        `NON_FINITE_NUMBER_IN_STATE: ${String(n)}. A state that cannot be serialised cannot be saved, and a sim that thinks it was saved is worse than one that says it failed.`,
      );
    }
    return n === 0 ? 0 : n;
  }
  if (Array.isArray(value))
    return value.map((element) => (element === undefined ? null : canonical(element)));
  if (type === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as object).constructor?.name ?? 'object';
      throw new TypeError(
        `NOT_A_PLAIN_OBJECT_IN_STATE: ${name}. Convert it in the sim, not in the serialiser.`,
      );
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, Json> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      out[key] = canonical(child);
    }
    return out;
  }
  throw new TypeError(`UNSUPPORTED_IN_STATE: ${type}`);
}

/**
 * FNV-1a over the canonical form, 64 bits as two interleaved 32-bit halves.
 *
 * 64 bits rather than 32 because a state checksum collides in a way a student can find: it decides
 * whether a grader accepts a state, and a collision means a legitimate paper is rejected as
 * tampered. This is still not a security control — see the note above — it just stops accidental
 * collisions from looking like sabotage.
 */
export function checksumState(state: unknown): string {
  const text = canonicalJson(state);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return h2.toString(16).padStart(8, '0') + h1.toString(16).padStart(8, '0');
}

export interface SerialisedState {
  /** The protocol version, so a `MAJOR` bump of the sim can invalidate old states on purpose. */
  readonly v: number;
  readonly simId: string;
  readonly simVersion: string;
  readonly checksum: string;
  readonly state: Json;
  /** When it was saved. NOT the sim's clock: the host's, recorded by the host. */
  readonly savedAt: string;
}

export interface RestoreOutcome<T> {
  readonly ok: boolean;
  readonly state: T | null;
  readonly problem: string | null;
  readonly code: SimErrorCode | null;
  /**
   * True when the state was written by an incompatible version.
   *
   * Distinct from "corrupt", because the response is different: the host OFFERS a safe reset and
   * keeps the old state around, rather than silently discarding a student's work.
   */
  readonly versionMismatch: boolean;
}

/**
 * Serialise for storage.
 *
 * `savedAt` is supplied by the host rather than read from a clock, for the reason `INV-SIM-2` exists:
 * a pure function cannot read a clock, and a sim that stores a timestamp from its own environment is a
 * sim whose state differs in two places.
 */
export function serialiseState(
  state: unknown,
  meta: {
    readonly simId: string;
    readonly simVersion: string;
    readonly protocol: number;
    readonly savedAt: string;
  },
): SerialisedState {
  return {
    v: meta.protocol,
    simId: meta.simId,
    simVersion: meta.simVersion,
    checksum: checksumState(state),
    state: canonical(state),
    savedAt: meta.savedAt,
  };
}

export const serialiseToText = (serialised: SerialisedState): string => JSON.stringify(serialised);

/**
 * Restore, and say precisely why not when it will not.
 *
 * ## THE TWO FAILURES ARE SEPARATE BECAUSE THE RESPONSES ARE
 *
 * A **checksum mismatch** means corruption or tampering: the host keeps the raw text, tells the
 * teacher, and starts a fresh state. A **version mismatch** means the sim's `MAJOR` moved and the
 * state schema with it: the student's work is not corrupt, it is from a different shape, and the host
 * offers a reset while retaining what was there.
 *
 * The first version returned one boolean, so the host had to guess which case it was in and
 * defaulted to discarding — which is how a student's afternoon of exploration disappears after a
 * point release.
 */
export function restoreState<T>(
  text: string,
  expected: { readonly simId: string; readonly simVersion: string },
): RestoreOutcome<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      state: null,
      problem: `the stored state is not JSON: ${String(error).slice(0, 80)}`,
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      state: null,
      problem: 'the stored state is not an object',
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  const stored = parsed as Partial<SerialisedState>;
  if (typeof stored.checksum !== 'string' || stored.state === undefined) {
    return {
      ok: false,
      state: null,
      problem: 'the stored state has no checksum, so there is nothing to verify it against',
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  if (stored.simId !== expected.simId) {
    return {
      ok: false,
      state: null,
      problem: `the state belongs to ${String(stored.simId)}, not ${expected.simId}`,
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  if (stored.simVersion !== expected.simVersion) {
    return {
      ok: false,
      state: null,
      problem:
        `the state was written by version ${String(stored.simVersion)} and the mounted version is ` +
        `${expected.simVersion}. Its shape may differ, so it is kept rather than loaded.`,
      code: 'STATE_INVALID',
      versionMismatch: true,
    };
  }
  let recomputed: string;
  try {
    recomputed = checksumState(stored.state);
  } catch (error) {
    return {
      ok: false,
      state: null,
      problem: `the stored state cannot be re-checksummed: ${String(error).slice(0, 80)}`,
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  if (recomputed !== stored.checksum) {
    return {
      ok: false,
      state: null,
      problem: `the state does not match its own checksum (stored ${stored.checksum}, recomputed ${recomputed})`,
      code: 'STATE_INVALID',
      versionMismatch: false,
    };
  }
  return { ok: true, state: stored.state as T, problem: null, code: null, versionMismatch: false };
}
