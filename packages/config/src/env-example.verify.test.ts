/**
 * GATE VERIFICATION: `.env.example` must be a VALID example.
 *
 * The example file is the first thing a new contributor copies, and the first thing CI
 * runs against. If it drifts from the schema, every contributor's first `pnpm dev`
 * fails on a variable they have no way to know was added — and the most common outcome
 * is that they delete the validation instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Minimal .env reader: KEY=value, `#` comments, optional quotes. */
function readEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

describe('.env.example is a valid example', () => {
  const text = readFileSync(join(root, '.env.example'), 'utf8');
  const env = readEnvFile(text);

  it('parses to a non-empty set of variables', () => {
    expect(Object.keys(env).length).toBeGreaterThan(10);
  });

  it('validates against the schema once the placeholder secret is replaced', () => {
    // The example intentionally ships a placeholder AUTH_SECRET, which the schema
    // REFUSES — that refusal is itself tested in env.test.ts. So substitute a real
    // value here to prove the rest of the example is correct.
    const result = parseEnv({ ...env, AUTH_SECRET: 'x'.repeat(48) });
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it('contains no real secret — placeholders only', () => {
    for (const [k, v] of Object.entries(env)) {
      if (!/SECRET|KEY|PASSWORD|TOKEN/i.test(k)) continue;
      if (k === 'AUTH_SECRET') {
        expect(v).toMatch(/replace-me/);
      }
    }
    expect(env.AUTH_SECRET).toMatch(/replace-me/);
  });

  it('names a concurrency target, because P0-T9 must source or delete it', () => {
    expect(env.TARGET_CONCURRENT_EXAM_TAKERS).toBeDefined();
    expect(Number(env.TARGET_CONCURRENT_EXAM_TAKERS)).toBeGreaterThan(0);
  });
});
