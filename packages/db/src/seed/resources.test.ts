/**
 * The registry-CI half of P17-T1: every seeded sim id resolves, at the pinned version.
 *
 * A UNIT test, deliberately -- it reads two JSON files and needs no database, so it runs in CI where
 * the integration suite may not. "Validated in registry CI" is this file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readResourceSeed, validateResourceSeed } from './resources.js';

const here = dirname(fileURLToPath(import.meta.url));

function registry(): Map<string, string> {
  const entries = JSON.parse(
    readFileSync(resolve(here, '../../../../sims/registry/registry.json'), 'utf8'),
  ).entries as { id: string; version: string }[];
  return new Map(entries.map((entry) => [entry.id, entry.version]));
}

function subjects(): Set<string> {
  const seed = JSON.parse(readFileSync(resolve(here, 'subjects.json'), 'utf8')) as unknown as {
    subjects: { slug: string }[];
  };
  return new Set(seed.subjects.map((subject) => subject.slug));
}

describe('seed resources validate against the registry', () => {
  it('ships 30 resources, one per simulation', () => {
    const seed = readResourceSeed();
    expect(seed.resources).toHaveLength(30);
    expect(new Set(seed.resources.map((r) => r.simId)).size).toBe(30);
  });

  it('every simId resolves at the pinned version, every subject exists, nothing blank', () => {
    const problems = validateResourceSeed(readResourceSeed(), registry(), subjects());
    expect(problems).toEqual([]);
  });

  it('catches an unknown simId rather than planting a broken embed', () => {
    const seed = readResourceSeed();
    const problems = validateResourceSeed(
      { resources: [{ ...seed.resources[0], simId: 'nope.missing' }] },
      registry(),
      subjects(),
    );
    expect(problems.some((p) => p.includes('not in the registry'))).toBe(true);
  });

  it('catches a version drift -- the registry moved and the seed did not follow', () => {
    const seed = readResourceSeed();
    const problems = validateResourceSeed(
      { resources: [{ ...seed.resources[0], simVersion: '0.0.0' }] },
      registry(),
      subjects(),
    );
    expect(problems.some((p) => p.includes('pins'))).toBe(true);
  });

  it('catches a duplicate slug and an unknown subject', () => {
    const seed = readResourceSeed();
    const dup = validateResourceSeed(
      { resources: [seed.resources[0], seed.resources[0]] },
      registry(),
      subjects(),
    );
    expect(dup.some((p) => p.includes('duplicate slug'))).toBe(true);
    const subj = validateResourceSeed(
      { resources: [{ ...seed.resources[0], subjectSlug: 'nope' }] },
      registry(),
      subjects(),
    );
    expect(subj.some((p) => p.includes('does not exist'))).toBe(true);
  });
});
