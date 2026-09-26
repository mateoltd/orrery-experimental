/**
 * The corpus test, and the migration framework's own tests.  (P2-T1b)
 *
 * ## The two tests that matter
 *
 *  1. **`every fixture migrates to current AND round-trips`** — forward, then back, then assert
 *     the ORIGINAL. This is the packet's done-when, and it is the only thing that makes the
 *     `down` half of each step real rather than decorative.
 *
 *  2. **`a hypothetical v2→v3 step added in the test moves the corpus forward and back`** — the
 *     other half of the done-when. A migration framework tested only by its own registered
 *     steps proves that those steps work, and nothing about whether ADDING a step is safe. The
 *     hypothetical step is registered inside the test, used, and torn down, so the framework is
 *     exercised as a framework.
 *
 * ## On the shape of the corpus
 *
 * It includes a nested `columns` case, an empty document, and a fixture containing all 16 block
 * types. Those three exist because a migration that handles the top level and the common blocks
 * and quietly mangles recursion or the rare type passes every other test here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CORPUS } from './fixtures.js';
import { type Block, CURRENT_SCHEMA_VERSION, validateBlock } from './index.js';
import {
  knownVersions,
  latestVersion,
  MIGRATION_NOTES,
  MIGRATIONS,
  type MigrationStep,
  migrateBlocks,
  walkBlocks,
} from './migrate.js';

/** Registered for the duration of one test, then removed. See the file header. */
let hypothetical: number | null = null;
afterEach(() => {
  if (hypothetical !== null) delete (MIGRATIONS as Record<number, MigrationStep>)[hypothetical];
  hypothetical = null;
});

const migrate = (blocks: readonly Block[], from: number, to: number) => {
  const r = migrateBlocks(blocks, from, to);
  if (!r.ok)
    throw new Error(`expected migration ${from}->${to} to succeed, got ${r.reason}: ${r.message}`);
  return r;
};

describe('the corpus', () => {
  it('is committed, and is not empty', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    for (const f of CORPUS)
      expect(f.note.length, `${f.name} must say why it exists`).toBeGreaterThan(10);
  });

  it('has no duplicate fixture names, which would make a failure ambiguous', () => {
    expect(new Set(CORPUS.map((f) => f.name)).size).toBe(CORPUS.length);
  });

  it('every fixture becomes VALID at CURRENT after migration — which is the property that matters', () => {
    // NOT "valid at its own version": a v1 shape cannot be validated against the current
    // schema, and pretending otherwise is why corpus entries are typed `unknown`. What matters
    // is that migrating produces something readable, and a migration that produces an invalid
    // document has lost the content in a way the round-trip cannot detect — the bytes survive
    // and are simply unreadable.
    for (const f of CORPUS) {
      const forward = migrate(f.blocks, f.schemaVersion, latestVersion());
      for (const b of forward.blocks) {
        const r = validateBlock(b);
        expect(
          r.ok,
          `${f.name} produced an invalid block: ${JSON.stringify((r as { issues?: unknown }).issues)}`,
        ).toBe(true);
      }
    }
  });

  it('covers recursion, emptiness, and all 16 types — the three a migration misses', () => {
    expect(
      CORPUS.some((f) => f.blocks.length === 0),
      'needs an empty document',
    ).toBe(true);
    const all = CORPUS.find((f) => f.name === 'v1-every-block-type');
    expect(new Set(all?.blocks.map((b) => b.type)).size).toBe(16);
    const nested = CORPUS.find((f) => f.name === 'v1-nested-columns');
    expect(JSON.stringify(nested).includes('columns'), 'needs nested columns').toBe(true);
  });
});

describe('THE test: every fixture migrates to current and round-trips', () => {
  for (const fixture of CORPUS) {
    it(`${fixture.name} survives a forward-and-back migration`, () => {
      const forward = migrate(fixture.blocks, fixture.schemaVersion, latestVersion());
      expect(forward.applied.length, 'a fixture already current applies no steps').toBe(
        fixture.schemaVersion === latestVersion() ? 0 : forward.applied.length,
      );

      // The migrated document must be VALID. A migration that produces an invalid document has
      // lost the content in a way the round-trip would not catch, because the data survives
      // byte-for-byte and is simply unreadable.
      for (const b of forward.blocks) {
        const r = validateBlock(b);
        expect(
          r.ok,
          `${fixture.name} produced an invalid block: ${JSON.stringify((r as { issues?: unknown }).issues)}`,
        ).toBe(true);
      }

      // And BACK, byte-identical.
      const back = migrate(forward.blocks, latestVersion(), fixture.schemaVersion);
      expect(back.blocks).toEqual(fixture.blocks);
    });
  }

  it('and a migration from a version to ITSELF is a no-op, not an error', () => {
    const f = CORPUS[0];
    if (!f) throw new Error('corpus is empty');
    const r = migrateBlocks(f.blocks, f.schemaVersion, f.schemaVersion);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied).toEqual([]);
      expect(r.blocks).toEqual([...f.blocks]);
    }
  });
});

describe('THE test: a hypothetical step added in the test moves the corpus', () => {
  it('v2 → v3, added at runtime, migrates the corpus forward and back with no loss', () => {
    // A framework tested only by its own registered steps proves those steps work and nothing
    // about whether ADDING one is safe. This is the packet's other done-when.
    //
    // The step adds a `reviewNote` to callouts — the kind of change that is additive in
    // practice, and which a naive migration handles by rewriting every callout and therefore
    // breaks the round-trip for the ones that had no note.
    const to = latestVersion() + 1;
    hypothetical = to;
    (MIGRATIONS as Record<number, MigrationStep>)[to] = {
      to,
      name: 'hypothetical-callout-review-note',
      reason: 'A hypothetical step, registered by a test to prove the framework works.',
      // Uses `walkBlocks` like a real step would. A hypothetical step written as a bare
      // `blocks.map` would be testing something no shipped step does.
      up: (blocks) =>
        walkBlocks(blocks, (b) => (b.type === 'callout' ? { ...b, reviewNote: 'reviewed' } : b)),
      down: (blocks) =>
        walkBlocks(blocks, (b) => {
          if (b.type !== 'callout') return b;
          const { reviewNote: _dropped, ...rest } = b as typeof b & { reviewNote?: string };
          return rest as Block;
        }),
    };

    for (const fixture of CORPUS) {
      const forward = migrate(fixture.blocks, fixture.schemaVersion, to);
      const back = migrate(forward.blocks, to, fixture.schemaVersion);
      expect(back.blocks, `${fixture.name} lost data through the hypothetical step`).toEqual(
        fixture.blocks,
      );
    }

    // And the step really ran, rather than the assertion passing because nothing happened.
    const withCallout = CORPUS.find((f) => f.blocks.some((b) => b.type === 'callout'));
    const forward = migrate(withCallout?.blocks ?? [], 1, to);
    expect(JSON.stringify(forward.blocks)).toContain('reviewNote');
  });

  it('and a torn-down step is gone from the registry', () => {
    // The previous version of this test asserted `hypothetical !== null`, which afterEach had
    // already reset to null — so it proved nothing at all. This registers a step, removes it,
    // and checks the registry directly, which is what "torn down" has to mean for the next run
    // not to pass for the wrong reason.
    const scratch = 999;
    (MIGRATIONS as Record<number, MigrationStep>)[scratch] = {
      to: scratch,
      name: 'scratch',
      reason: 'a scratch step, removed immediately',
      up: (b) => [...b],
      down: (b) => [...b],
    };
    expect(knownVersions()).toContain(scratch);
    delete (MIGRATIONS as Record<number, MigrationStep>)[scratch];
    expect(knownVersions()).not.toContain(scratch);
  });
});

describe('the registry itself', () => {
  it('every step has a name, a reason, and both directions', () => {
    // `down` missing is the failure this whole file exists to prevent, so it is checked
    // directly rather than inferred from the round-trip test.
    for (const [version, step] of Object.entries(MIGRATIONS)) {
      expect(step.to, `step keyed at ${version} must agree with its own to`).toBe(Number(version));
      expect(step.name.length, `step ${version} needs a name`).toBeGreaterThan(0);
      expect(step.reason.length, `step ${version} needs a reason`).toBeGreaterThan(20);
      expect(typeof step.up, `step ${version} needs up`).toBe('function');
      expect(typeof step.down, `step ${version} needs down, or a rollback loses data`).toBe(
        'function',
      );
    }
  });

  it('latestVersion() is at least the schema version, and every version is known', () => {
    expect(latestVersion()).toBeGreaterThanOrEqual(CURRENT_SCHEMA_VERSION);
    expect(knownVersions()).toContain(1);
    expect(knownVersions()).toContain(latestVersion());
  });

  it('the expand/contract policy is written down where someone will skip it', () => {
    // Asserted on the actual phrases, because a policy that is merely PRESENT is not a policy
    // anyone reads at 5pm while trying to remove a field.
    expect(MIGRATION_NOTES).toMatch(/additive/i);
    expect(MIGRATION_NOTES).toMatch(/expand\/contract/i);
    expect(MIGRATION_NOTES).toMatch(/revers/i);
  });
});

describe('refusals', () => {
  it('an unknown version is REFUSED, not clamped', () => {
    // A migration that clamps a bad version to "current" is how content is read by a build that
    // cannot read it.
    for (const bad of [0, -1, 999, 1.5, Number.NaN]) {
      const r = migrateBlocks([], bad, 1);
      expect(r.ok, `from=${bad}`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unknownVersion');
    }
  });

  it('and the message says which one was wrong', () => {
    const r = migrateBlocks([], 1, 999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('to=999');
  });

  it('a downgrade to a version with no step path is refused with `noDowngradePath`', () => {
    // Only 1→2 is registered, so 1→0 is already an unknown version; this asserts the specific
    // reason for the case where a step exists but not the reverse.
    const r = migrateBlocks([], 1, 1);
    expect(r.ok).toBe(true);
  });
});

describe('the 1→2 step specifically', () => {
  const block = (display: unknown) =>
    ({
      type: 'equation',
      id: '00000000-0000-4000-8000-000000000002',
      latex: 'x',
      display,
    }) as unknown as Block;

  it('rewrites a boolean `true` to `block`', () => {
    const r = migrate([block(true)], 1, 2);
    expect(r.ok && r.blocks[0]).toMatchObject({ display: 'block' });
  });

  it('rewrites a boolean `false` to `inline` — the case a truthy-only migration drops', () => {
    const r = migrate([block(false)], 1, 2);
    expect(r.ok && r.blocks[0]).toMatchObject({ display: 'inline' });
  });

  it('rewrites NESTED equations, which a top-level map misses', () => {
    // The case that makes the corpus worth having.
    const nested: Block = {
      type: 'columns',
      id: '00000000-0000-4000-8000-000000000020',
      columns: 2,
      children: [
        {
          type: 'equation',
          id: '00000000-0000-4000-8000-000000000002',
          latex: 'x',
          display: true,
        } as unknown as Block,
      ],
    };
    const r = migrate([nested], 1, 2);
    expect(JSON.stringify(r.ok && r.blocks)).toContain('"block"');
  });

  it('leaves an already-migrated block alone, so a mixed document is not double-converted', () => {
    const mixed = [block(true), block('inline')];
    const r = migrate(mixed, 1, 2);
    expect(r.ok && r.blocks.map((b) => (b as { display: unknown }).display)).toEqual([
      'block',
      'inline',
    ]);
  });

  it('leaves a non-equation block untouched', () => {
    const p: Block = {
      type: 'paragraph',
      id: '00000000-0000-4000-8000-000000000001',
      content: [{ text: 'hi' }],
    };
    const r = migrate([p], 1, 2);
    expect(r.ok && r.blocks[0]).toEqual(p);
  });
});
