import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../index.js';

/**
 * The subject seed.  (P3-T2)
 *
 * ## The seed is a FILE, and that is the whole design
 *
 * `subjects.json` is read by this loader and by `scripts/subject-tree-gate.mjs`. The gate
 * therefore validates **the exact bytes that get inserted**, not a copy that a reviewer checked
 * once. This is the same shape P2 used for the migration corpus, and the reason is the same: a
 * validated copy is a fiction, and the copy is where drift appears.
 *
 * The gate earned its place before this loader was written. It found **nine subjects that were
 * their own parent** — every area's root slug collided with one of its own children, so
 * `general-skills/academic` was simultaneously the area root and a topic beneath itself. That is
 * not a subtle defect that a careful reader would have spotted in a 246-row JSON file; it is
 * precisely the kind that arrives with a hand-written hierarchy.
 *
 * ## Idempotent, because a seed that only works once is a script
 *
 * Upsert on `slug`. Re-running the seed must not duplicate 246 rows, and it must not fail on the
 * unique index either — a seed that is safe to run twice is a seed that is safe to run in a
 * migration and in a test, which is the only way anyone ever runs one.
 *
 * ## Parents before children, always
 *
 * The JSON is already ordered parents-first by construction, but the loader does not TRUST that:
 * it walks the list repeatedly until no more rows can be inserted. A seed file edited by hand
 * later will have its rows reordered by a text editor, and "the file happened to be in order" is
 * not a property worth relying on.
 */

const here = dirname(fileURLToPath(import.meta.url));

export interface SeedSubject {
  readonly slug: string;
  readonly name: string;
  readonly area: string;
  readonly depth: number;
  readonly parent: string | null;
  readonly position: number;
  readonly colour: string;
}

export interface SubjectSeed {
  readonly areas: readonly string[];
  readonly subjects: readonly SeedSubject[];
}

/**
 * Read the seed file.
 *
 * `require`-free on purpose: this module is imported by a script and by tests, and an ESM
 * resolver that reaches for a bundler is a bundler that has to be present in CI.
 */
export function readSubjectSeed(file = resolve(here, 'subjects.json')): SubjectSeed {
  return JSON.parse(readFileSync(file, 'utf8')) as SubjectSeed;
}

export type SeedResult =
  | { readonly ok: true; readonly inserted: number; readonly updated: number }
  | { readonly ok: false; readonly unplaceable: readonly string[] };

/**
 * Insert or update every subject.
 *
 * `inserted` and `updated` are reported separately because "the seed ran" is a claim about
 * something happening, and a seed that has silently been updating 246 rows for six months has
 * not been seeding anything.
 */
export async function seedSubjects(
  db: PrismaClient,
  seed: SubjectSeed = readSubjectSeed(),
): Promise<SeedResult> {
  const slugs = seed.subjects.map((s) => s.slug);

  // Counted BEFORE and AFTER rather than per-row. `upsert` does not report which branch it
  // took, so a per-row counter is a guess dressed as a number — and a seed report that is
  // quietly wrong is worse than no report.
  const before = await db.subject.count({ where: { slug: { in: slugs } } });

  const ids = new Map<string, string>();
  let progress = true;

  // Repeat until a pass places nothing new. One pass is not enough, and assuming it is would
  // mean a hand-reordered seed file silently seeds a partial tree.
  while (progress) {
    progress = false;
    for (const subject of seed.subjects) {
      if (ids.has(subject.slug)) continue;
      const parentId = subject.parent === null ? null : (ids.get(subject.parent) ?? undefined);
      // The parent has not been placed yet, so try again next pass. `undefined` is distinct
      // from `null` deliberately: null means "this is a root".
      if (subject.parent !== null && parentId === undefined) continue;

      const row = await db.subject.upsert({
        where: { slug: subject.slug },
        create: {
          slug: subject.slug,
          name: subject.name,
          parentId: parentId ?? null,
          position: subject.position,
          colour: subject.colour,
        },
        update: {
          name: subject.name,
          // The parent is updated too, so a corrected tree file REPAIRS the database rather than
          // being ignored because the slug already exists. A seed that only ever inserts is a
          // seed that cannot fix anything.
          parentId: parentId ?? null,
          position: subject.position,
          colour: subject.colour,
        },
        select: { id: true },
      });
      ids.set(subject.slug, row.id);
      progress = true;
    }
  }

  const unplaceable = seed.subjects.filter((s) => !ids.has(s.slug)).map((s) => s.slug);
  if (unplaceable.length > 0) return { ok: false, unplaceable };

  const after = await db.subject.count({ where: { slug: { in: slugs } } });
  return { ok: true, inserted: after - before, updated: before };
}

/** The seed as a slug-keyed lookup, for callers that want to reference a subject by name. */
export function seedIndex(seed: SubjectSeed = readSubjectSeed()): ReadonlyMap<string, SeedSubject> {
  return new Map(seed.subjects.map((s) => [s.slug, s]));
}
