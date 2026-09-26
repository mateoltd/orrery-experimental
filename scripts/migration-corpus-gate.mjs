#!/usr/bin/env node

/**
 * MIGRATION CORPUS GATE  (P2-T1b, INV-MIGRATE-1)
 *
 * ## Why this is a gate and not just a test
 *
 * `INV-MIGRATE-1` says no stored block requires a human to fix it. That is a property of the
 * DATA, and a data property that is only checked by a test is a property that gets skipped the
 * first time someone runs `pnpm vitest --changed` on a hotfix.
 *
 * So the round-trip is a gate: it runs in the Docker build alongside the other five, and a
 * migration that loses a field fails the BUILD rather than a lesson.
 *
 * ## What it asserts
 *
 * For every fixture in the committed corpus:
 *   1. it migrates forward to the current version,
 *   2. every block is VALID at the current version (data can survive byte-for-byte and still
 *      be unreadable, which a round-trip alone would not catch), and
 *   3. it migrates BACK and is byte-identical to the original.
 *
 * Step 3 is why every step carries a `down`. A one-way migration is not testable this way and
 * therefore not safe: the only way to find out it lost something is to read it.
 *
 * This runs OUTSIDE vitest on purpose — it must work in the build stage, where the test
 * config and the coverage thresholds are not in play.
 */

import { CORPUS } from '../packages/contracts/dist/blocks/fixtures.js';
import { blockSchema } from '../packages/contracts/dist/blocks/index.js';
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrateBlocks,
} from '../packages/contracts/dist/blocks/migrate.js';

const problems = [];
let checked = 0;

for (const fixture of CORPUS) {
  const forward = migrateBlocks(fixture.blocks, fixture.schemaVersion, LATEST_VERSION);
  if (!forward.ok) {
    problems.push(
      `${fixture.name}: cannot migrate ${fixture.schemaVersion}->${LATEST_VERSION} (${forward.reason}: ${forward.message})`,
    );
    continue;
  }

  for (const [i, block] of forward.blocks.entries()) {
    const result = blockSchema.safeParse(block);
    if (!result.success) {
      const where = result.error.issues.map((iss) => iss.path.join('.') || '(root)').join(', ');
      problems.push(
        `${fixture.name}: block ${i} is INVALID after migration — ${where}. ${result.error.issues[0]?.message ?? ''}`,
      );
    }
  }

  const back = migrateBlocks(forward.blocks, LATEST_VERSION, fixture.schemaVersion);
  if (!back.ok) {
    problems.push(
      `${fixture.name}: cannot migrate back ${LATEST_VERSION}->${fixture.schemaVersion} (${back.reason}: ${back.message})`,
    );
    continue;
  }

  const before = JSON.stringify(fixture.blocks);
  const after = JSON.stringify(back.blocks);
  if (before !== after) {
    problems.push(
      `${fixture.name}: ROUND TRIP LOST DATA.\n    before: ${before.slice(0, 400)}\n    after:  ${after.slice(0, 400)}`,
    );
  }
  checked += 1;
}

// Every step must be reversible. A step with no `down` is untested by the corpus above,
// because the corpus can only go as far back as the newest reversible step.
for (const [version, step] of Object.entries(MIGRATIONS)) {
  if (typeof step.down !== 'function') problems.push(`step ${version} (${step.name}) has no down`);
  if (typeof step.reason !== 'string' || step.reason.length < 20) {
    problems.push(
      `step ${version} (${step.name}) needs a reason: a migration with no reason is an accident`,
    );
  }
}

console.log('MIGRATION CORPUS GATE');
console.log('='.repeat(70));

if (problems.length > 0) {
  console.log(`FAILED — ${problems.length} problem(s) across ${CORPUS.length} fixtures\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nA migration that loses a field fails here, on a fixture, in CI — not on a');
  console.log("student's lesson in month 18.");
  process.exit(1);
}

console.log('MIGRATION CORPUS GATE PASSED');
console.log(
  `  ${checked} fixtures migrated forward, validated at current, and returned byte-identical`,
);
console.log(`  ${Object.keys(MIGRATIONS).length} registered step(s), all reversible`);
process.exit(0);
