/**
 * Installing the seed banks.  (P5-T15)
 *
 * ## WHY THE IDS ARE THE CONTENT'S OWN STRINGS
 *
 * `bio-photosyn-01` is not a UUID, and that is the whole design. Re-running this installer has to
 * update an item whose prompt an author corrected last week rather than append a second copy of it
 * beside the old one, and stable ids are what make `upsert` possible at all. A pool that silently
 * accumulated near-duplicate items would show a healthy `M` and draw stale questions forever.
 *
 * ## THE KEYS GO IN AND NEVER COME BACK OUT
 *
 * `INV-Q-1`. The installer is the one place allowed to write `modelAnswer` and `rubric`, and
 * `studentFacingQuestion` below is the projection a student client is meant to use. It is exported
 * so a reviewer can check that it has no field a key could hide in — the guarantee is structural,
 * the way it is for the interop boundary, and for the same reason.
 */

import type { SeedBank, SeedQuestion } from '@orrery/contracts/seed-banks';
import {
  allSeedBankReports,
  SEED_BANKS,
  type SeedBankReport,
  seedBankReport,
} from '@orrery/contracts/seed-banks';
import type { PrismaClient, TxClient } from './index.js';

type Db = PrismaClient | TxClient;

export interface InstallInput {
  /**
   * The user who will own the banks.
   *
   * This is a SYSTEM action, not a user action, and it deliberately does not take an `Actor` or run
   * `canGlobal`. There is no authz question here because there is no request: seeding runs from a
   * migration or a console, before any classroom exists. The alternative — an `Actor` whose only
   * authority is "may create banks" — would add a permanent privilege nobody exercises.
   */
  readonly ownerId: string;
  /** Restrict the install to named banks. Used by tests so they do not pay for both. */
  readonly bankIds?: readonly string[];
  /** Defaults to `PRIVATE`: seed content is not public content. */
  readonly visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC';
}

export interface InstallResult {
  readonly banks: number;
  readonly questions: number;
  readonly pools: number;
  readonly poolItems: number;
  readonly reports: readonly SeedBankReport[];
}

/**
 * The projection a student client may use. No `modelAnswer`, no `rubric`, no key of any kind.
 *
 * Exported so the omission can be asserted on rather than promised in a comment.
 *
 * ## THE RATIONALE IS NOT PERSISTED, AND THAT IS A DECISION
 *
 * Every seeded item carries a `rationale` — why the key is the key — and none of it reaches the
 * database. `Question` has no author-notes column, and the first version of this installer abused
 * `cognitiveDemand` (a display-only field) to carry one, which both misuses the column and
 * duplicates a real one.
 *
 * So the source file is the authoring record. That is also the safer arrangement: an author's
 * reasoning cannot be projected to a student by accident, because it is not in the row at all.
 * Adding a column for it belongs with the authoring UI, not with a seed installer.
 */
export function studentFacingQuestion(row: {
  id: string;
  type: string;
  spec: unknown;
  points: unknown;
  timeLimitSec: number | null;
  estimatedSeconds: number | null;
  shuffleOptions: boolean;
  language: string;
  topic: string | null;
}): {
  id: string;
  type: string;
  spec: unknown;
  points: number;
  timeLimitSec: number | null;
  estimatedSeconds: number | null;
  shuffleOptions: boolean;
  language: string;
  topic: string | null;
} {
  return {
    id: row.id,
    type: row.type,
    spec: row.spec,
    points: Number(row.points),
    timeLimitSec: row.timeLimitSec,
    estimatedSeconds: row.estimatedSeconds,
    shuffleOptions: row.shuffleOptions,
    language: row.language,
    topic: row.topic,
  };
}

/** The seed content's `spec`, shaped for each question type. */
function specFor(q: SeedQuestion): Record<string, unknown> {
  const base: Record<string, unknown> = { prompt: q.prompt };
  if (q.options !== undefined) base.options = q.options;
  if (q.tolerance !== undefined) base.tolerance = q.tolerance;
  if (q.ordering !== undefined) base.items = q.ordering;
  return base;
}

/**
 * Install the banks, pools and items. Idempotent: running it twice changes nothing the second time.
 *
 * `createMany` with `skipDuplicates` for the pool items rather than an upsert per row, because a
 * pool with forty items would otherwise be forty round trips and the install is the slowest thing
 * in a fresh database.
 *
 * ## `revision` IS NOT BUMPED, AND THAT IS WHY "IDEMPOTENT" IS TRUE
 *
 * The first version incremented `revision` on update, on the reasonable-sounding grounds that an
 * author editing a seeded item should bump it. But the upsert's `update` branch runs on EVERY
 * reinstall, so a second `pnpm db:seed` on an unchanged file marked all seventy-odd items as
 * revised — and `revision` is what an already-sitted attempt is pinned to. A no-op installer that
 * quietly invalidates thirty students' papers is worse than one that does not update at all.
 *
 * Authored edits go through the authoring API, which does bump `revision`. This is a fixture loader.
 */
export async function installSeedBanks(db: Db, input: InstallInput): Promise<InstallResult> {
  const wanted =
    input.bankIds === undefined
      ? SEED_BANKS
      : SEED_BANKS.filter((b) => input.bankIds?.includes(b.id));
  if (wanted.length === 0)
    throw new Error(`NO_SUCH_SEED_BANK: ${(input.bankIds ?? []).join(', ')}`);

  let questionCount = 0;
  let poolCount = 0;
  let itemCount = 0;

  for (const bank of wanted) {
    await db.questionBank.upsert({
      where: { id: bank.id },
      create: {
        id: bank.id,
        ownerId: input.ownerId,
        name: bank.name,
        description: bank.description,
        visibility: input.visibility ?? 'PRIVATE',
      },
      update: {
        name: bank.name,
        description: bank.description,
        visibility: input.visibility ?? 'PRIVATE',
      },
    });

    for (const q of bank.questions) {
      await db.question.upsert({
        where: { id: q.id },
        create: {
          id: q.id,
          bankId: bank.id,
          type: q.type,
          spec: specFor(q) as never,
          points: q.points,
          gradingMode: q.gradingMode,
          estimatedSeconds: q.estimatedSeconds,
          modelAnswer: q.modelAnswer,
          rubric: q.rubric as never,
          topic: q.topic,
          responseProcess: q.responseProcess,
        },
        update: {
          type: q.type,
          spec: specFor(q) as never,
          points: q.points,
          gradingMode: q.gradingMode,
          estimatedSeconds: q.estimatedSeconds,
          modelAnswer: q.modelAnswer,
          rubric: q.rubric as never,
          topic: q.topic,
          responseProcess: q.responseProcess,
        },
      });
      questionCount += 1;
    }

    for (const pool of bank.pools) {
      await db.questionPool.upsert({
        where: { id: pool.id },
        create: {
          id: pool.id,
          bankId: bank.id,
          name: pool.name,
          strategy: pool.strategy,
          drawCount: pool.drawCount,
          expectedCohortSize: pool.expectedCohortSize,
        },
        update: {
          name: pool.name,
          strategy: pool.strategy,
          drawCount: pool.drawCount,
          expectedCohortSize: pool.expectedCohortSize,
        },
      });
      poolCount += 1;
      // One statement, forty rows. `skipDuplicates` is what makes a second run a no-op.
      const created = await db.questionPoolItem.createMany({
        data: pool.questionIds.map((questionId) => ({ poolId: pool.id, questionId })),
        skipDuplicates: true,
      });
      itemCount += created.count;
    }
  }

  return {
    banks: wanted.length,
    questions: questionCount,
    pools: poolCount,
    poolItems: itemCount,
    reports: wanted.map((b) => seedBankReportFor(b)),
  };
}

const seedBankReportFor = (bank: SeedBank): SeedBankReport => {
  const report = allSeedBankReports().find((r) => r.bankId === bank.id);
  if (!report) throw new Error(`NO_REPORT_FOR_SEED_BANK: ${bank.id}`);
  return report;
};

export { allSeedBankReports, SEED_BANKS, seedBankReport };
