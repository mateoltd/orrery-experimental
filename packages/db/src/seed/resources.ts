/**
 * SEED RESOURCES: one curated resource per simulation.  (P17-T1)
 *
 * Follows `subjects.ts` exactly (reader + planter + counted report), because a second seed with a
 * second shape would be two things to get wrong. Differences, each load-bearing:
 *
 * - **The seed carries `simVersion`, and the validator checks it against the REGISTRY, not the
 *   manifest.** A seed pointing at `maths.pythagoras@9.9.9` would plant a resource whose embed resolves
 *   to nothing; the manifest is what the sim claims and the registry is what the host serves, so the
 *   registry is the authority. "Validated in registry CI" is this check, run as a unit test.
 * - **The planter takes `ownerId` as an argument.** Seed data with an invented owner is how a demo
 *   classroom ends up owned by a user nobody can log in as; the caller names the curriculum owner.
 * - **Each resource is one paragraph + one embed, mode `explore`.** No `practiceCheck` questions: writing
 *   30 questions is item authoring (`D-37`), not seeding, and a seed question nobody reviewed is worse
 *   than no question. The row for this task says so rather than implying questions exist.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentChecksum } from '@orrery/contracts/editor';
import type { PrismaClient } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface SeedResource {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly subjectSlug: string;
  readonly simId: string;
  readonly simVersion: string;
}

export interface ResourceSeed {
  readonly resources: readonly SeedResource[];
}

export function readResourceSeed(file = resolve(here, 'resources.json')): ResourceSeed {
  return JSON.parse(readFileSync(file, 'utf8')) as ResourceSeed;
}

/**
 * Pure validation against the registry entries and the subject slugs. Returns the problems rather
 * than throwing, because a validator that throws on the first problem reports one problem per run.
 */
export function validateResourceSeed(
  seed: ResourceSeed,
  registry: ReadonlyMap<string, string>,
  subjectSlugs: ReadonlySet<string>,
): readonly string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const resource of seed.resources) {
    if (slugs.has(resource.slug)) {
      problems.push(`duplicate slug: ${resource.slug}`);
    }
    slugs.add(resource.slug);
    const version = registry.get(resource.simId);
    if (version === undefined) {
      problems.push(`${resource.slug}: simId "${resource.simId}" is not in the registry`);
    } else if (version !== resource.simVersion) {
      problems.push(
        `${resource.slug}: pins ${resource.simId}@${resource.simVersion} but the registry serves ${version}`,
      );
    }
    if (!subjectSlugs.has(resource.subjectSlug)) {
      problems.push(`${resource.slug}: subject "${resource.subjectSlug}" does not exist`);
    }
    if (resource.title.trim().length === 0 || resource.summary.trim().length === 0) {
      problems.push(`${resource.slug}: title or summary is blank`);
    }
  }
  return problems;
}

export type SeedResourcesResult =
  | { readonly ok: true; readonly inserted: number; readonly updated: number }
  | { readonly ok: false; readonly unplaceable: readonly string[] };

export async function seedResources(
  db: PrismaClient,
  ownerId: string,
  seed: ResourceSeed = readResourceSeed(),
): Promise<SeedResourcesResult> {
  const before = await db.resource.count({
    where: { slug: { in: seed.resources.map((r) => r.slug) } },
  });

  for (const resource of seed.resources) {
    const blocks = [
      {
        type: 'paragraph',
        id: randomUUID(),
        content: [{ text: resource.summary }],
      },
      {
        type: 'embedSimulation',
        id: randomUUID(),
        simId: resource.simId,
        simVersion: resource.simVersion,
        params: {},
        seedPolicy: 'PER_VIEW',
        mode: 'explore',
      },
    ];
    const checksum = contentChecksum(blocks);
    const existing = await db.resource.findFirst({
      where: { slug: resource.slug },
      select: { id: true },
    });
    if (existing === null) {
      const created = await db.resource.create({
        data: {
          id: randomUUID(),
          ownerId,
          status: 'PUBLISHED',
          visibility: 'UNLISTED',
          title: resource.title,
          slug: resource.slug,
          summary: resource.summary,
        },
        select: { id: true },
      });
      await db.resourceVersion.create({
        data: {
          id: randomUUID(),
          resourceId: created.id,
          version: 1,
          blocks,
          blocksChecksum: checksum,
          meta: {},
          createdById: ownerId,
        },
      });
    } else {
      await db.resource.update({
        where: { id: existing.id },
        data: { title: resource.title, summary: resource.summary },
      });
    }
  }

  const after = await db.resource.count({
    where: { slug: { in: seed.resources.map((r) => r.slug) } },
  });
  const inserted = after - before;
  return { ok: true, inserted, updated: seed.resources.length - inserted };
}
