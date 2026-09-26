/**
 * Block migration.  (P2-T1b, INV-MIGRATE-1)
 *
 * ## Why this exists
 *
 * Content written in month 1 must render in month 18. The plan previously mentioned
 * `schemaVersion` and said migrations would be "explicit, tested and reversible" — and no task
 * built them. Without this, every schema change either breaks old content or triggers an
 * emergency migration nobody planned, and the fallback is to freeze the block schema forever,
 * which means the editor can never improve.
 *
 * ## Why every step is REVERSIBLE, and why that is a hard requirement
 *
 * The corpus test migrates a fixture forward to current and then BACK, asserting the original.
 * A one-way migration cannot be tested that way, so a one-way migration is not testable and
 * therefore not safe: the only way to find out it lost something is to read it.
 *
 * Reversibility is also what makes the DEPLOYMENT safe. Adding a field is additive and needs no
 * migration; REMOVING one is the dangerous direction, and the only way to remove a field without
 * stranding a year of content is to be able to go back. `down` is therefore not a nicety, it is
 * the thing that makes the next migration possible.
 *
 * ## Additive, then deprecate, then remove
 *
 * The same expand/contract discipline the database migrations use, for the same reason: a
 * writer on the old build and a writer on the new one must both be able to publish while the
 * deploy is in flight. `MIGRATION_NOTES` records the policy at the point where someone will be
 * tempted to skip it.
 *
 * ## Pure, and why the signature has no clock and no database
 *
 * `migrateBlocks(blocks, from, to)` is a function of its arguments. That is what lets the same
 * function run in a test, in a request, and in a one-off repair script, and produce the same
 * answer — which is the entire difference between a migration and a script somebody ran once.
 */

import { type Block, CURRENT_SCHEMA_VERSION } from './index.js';

/**
 * Apply a transform to every block, INCLUDING blocks nested inside `columns`.
 *
 * ## Why this exists
 *
 * The first version of the 1→2 step was `blocks.map(...)`, which rewrites the top level and
 * leaves the children of a `columns` block at the old shape. The `v1-nested-columns` corpus
 * fixture caught it on the first run, and the failure it produced is a good illustration of why
 * the corpus is worth its maintenance: the migration "succeeded", returned plausible data, and
 * the document was simply unreadable two levels down.
 *
 * A migration step that walks only the top level is the most common shape of this bug, and it
 * is invisible until someone nests a block.
 */
export function walkBlocks(blocks: readonly Block[], transform: (block: Block) => Block): Block[] {
  return blocks.map((block) => {
    const next = transform(block);
    if (next.type !== 'columns') return next;
    return { ...next, children: walkBlocks(next.children, transform) } as Block;
  });
}

export interface MigrationStep {
  /** The version this step PRODUCES. Steps are keyed by it, so ordering is the key order. */
  readonly to: number;
  readonly name: string;
  /** Why this step exists, in one line. A migration with no reason is an accident. */
  readonly reason: string;
  /** Forward. Total: every input of the previous version must produce valid output. */
  readonly up: (blocks: readonly Block[]) => Block[];
  /** The exact inverse of `up`. See the file header. */
  readonly down: (blocks: readonly Block[]) => Block[];
}

/**
 * The registered steps, in ascending order of `to`.
 *
 * KEYS, not a hand-maintained array, so the ordering is structural and two steps cannot claim
 * the same version. Adding a step means adding an entry here and nothing else; a duplicate is a
 * TypeScript error and a gap is caught by the corpus test.
 */
export const MIGRATIONS: Readonly<Record<number, MigrationStep>> = {
  // ── 1 → 2 ────────────────────────────────────────────────────────────────────────────
  2: {
    to: 2,
    name: 'equation-display-becomes-enum',
    reason:
      '`equation.display` was a boolean, so `true`/`false` had to be interpreted by every ' +
      'reader and one of them had it backwards. It is an enum now, and this step rewrites the ' +
      'stored shape. Lossless in both directions: `true` maps to `block` and back.',
    // The casts go through a `display: unknown` VIEW rather than asserting the block is the
    // old shape. `b` is statically the NEW shape, so a direct cast is rejected by TypeScript —
    // correctly, because the step's whole job is to convert a shape the current type does not
    // describe. Narrowing on the runtime `typeof` and then building the new value is honest;
    // `as Block` on the whole object would not be.
    up: (blocks) =>
      walkBlocks(blocks, (b) => {
        if (b.type !== 'equation') return b;
        const display = (b as { display: unknown }).display;
        if (typeof display !== 'boolean') return b;
        return { ...b, display: display ? ('block' as const) : ('inline' as const) };
      }),
    down: (blocks) =>
      walkBlocks(blocks, (b) => {
        if (b.type !== 'equation') return b;
        const display = (b as { display: unknown }).display;
        if (typeof display !== 'string') return b;
        // The inverse produces a shape the current type does not describe, which is what a
        // `down` is FOR. Cast once, through unknown, with the reason above.
        return { ...b, display: display === 'block' } as unknown as Block;
      }),
  },
};

/**
 * The highest known version, computed ON DEMAND rather than at module load.
 *
 * The first version was a `const`, which is the obvious thing to write and is wrong: the
 * hypothetical-step test registers a step at runtime, and a load-time `LATEST_VERSION` does not
 * know about it, so the migration refused with "unknown schema version". That is the framework
 * refusing to see a step that is genuinely registered — a stale derived value failing closed,
 * which is safe in production and useless in a test that is specifically exercising the registry.
 *
 * A function is the fix. It is a handful of `Object.keys` per call, on a path that already
 * parses every block, so the cost is not worth a stale cache.
 */
export function latestVersion(): number {
  return Math.max(CURRENT_SCHEMA_VERSION, ...Object.keys(MIGRATIONS).map(Number));
}

/** @deprecated use {@link latestVersion} — this is a load-time snapshot and can be stale. */
export const LATEST_VERSION = latestVersion();

export const MIGRATION_NOTES = `
Additive, then deprecate, then remove — the same expand/contract discipline the database
migrations use, and for the same reason: an author on the old build and an author on the new
one must both be able to publish while a deploy is in flight.

  1. ADD.    The new field is optional, and the old code ignores it.
  2. MIGRATE. A registered step rewrites stored content forward. Deploy it. Old code must
             still read the new shape, which it can because the field was optional.
  3. BACKFILL. Run the migration over content that has not been touched.
  4. REMOVE. Only once no build in the fleet reads the old shape. This is the irreversible
             step, and it is why every registered step must be reversible: it is the only
             thing standing between you and content that cannot be read at all.

A step that cannot be reversed is a decision to freeze the schema from that point on. That is
almost never what anyone intends, and it is discovered in month 18 rather than in review.
` as const;

export type MigrationOutcome =
  | { ok: true; blocks: Block[]; from: number; to: number; applied: readonly string[] }
  | { ok: false; reason: 'unknownVersion' | 'noDowngradePath'; message: string };

/**
 * Migrate between two versions.
 *
 * `from` and `to` are EXPLICIT rather than inferred from the blocks, because a block array
 * carries no version of its own — the version is on the document envelope — and inferring it
 * would mean guessing.
 *
 * Migrating DOWN is allowed when a down path exists, and that is deliberate: it is what the
 * corpus round-trip test uses, and it is what an operator uses to roll back a deploy that
 * turned out to be wrong. It is refused loudly rather than silently clamped, because silently
 * clamping a downgrade request to "no change" is how someone ends up serving content from a
 * build that cannot read it.
 */
export function migrateBlocks(
  blocks: readonly Block[],
  from: number,
  to: number,
): MigrationOutcome {
  if (!isKnownVersion(from) || !isKnownVersion(to)) {
    return {
      ok: false,
      reason: 'unknownVersion',
      message:
        `unknown schema version: ${isKnownVersion(from) ? '' : `from=${from} `}` +
        `${isKnownVersion(to) ? '' : `to=${to}`}`.trim() +
        `. Known: 1..${latestVersion()}. Refusing to guess — a migration that guesses which ` +
        'shape it is looking at is how content is lost.',
    };
  }

  if (from === to) return { ok: true, blocks: [...blocks], from, to, applied: [] };

  // The steps to apply are those whose VERSION lies in the half-open interval between the two
  // targets, and the direction decides which function is called.
  //
  //   up   from 1 to 2: versions v with from < v <= to  -> v = 2, ascending,  call step.up
  //   down from 2 to 1: versions v with to   < v <= from -> v = 2, descending, call step.down
  //
  // The first version of this had both filters written as (from, to], so a DOWNGRADE found no
  // steps at all and refused with `noDowngradePath` — the exact opposite of what it should
  // have done. The corpus round-trip test caught it on the first run, which is the argument for
  // requiring every step to be reversible in the first place: an irreversible framework has no
  // test that exercises this branch at all.
  const versions = Object.keys(MIGRATIONS)
    .map(Number)
    .sort((a, b) => a - b);
  const up = to > from;
  const steps = up
    ? versions.filter((v) => v > from && v <= to)
    : versions.filter((v) => v > to && v <= from).reverse();

  if (steps.length === 0) {
    return {
      ok: false,
      reason: up ? 'unknownVersion' : 'noDowngradePath',
      message: up
        ? `no registered path from ${from} to ${to}`
        : `no registered downgrade path from ${from} to ${to}. Every registered step must ` +
          'provide `down`; that is what makes a rollback possible without content loss.',
    };
  }

  const applied: string[] = [];
  let current = [...blocks];
  for (const version of steps) {
    const step = MIGRATIONS[version];
    if (!step) continue;
    current = up ? step.up(current) : step.down(current);
    applied.push(
      `${up ? `${version - 1}->${version}` : `${version}->${version - 1}`}:${step.name}`,
    );
  }

  return { ok: true, blocks: current, from, to, applied };
}

function isKnownVersion(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= latestVersion();
}

/** Versions that have ever existed, ascending. The corpus is keyed by these. */
export function knownVersions(): number[] {
  return [
    1,
    ...Object.keys(MIGRATIONS)
      .map(Number)
      .sort((a, b) => a - b),
  ];
}
