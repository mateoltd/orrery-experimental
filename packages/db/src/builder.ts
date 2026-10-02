/**
 * The assignment builder, and previewing it as a student.  (P5-T3)
 *
 * ## `plans/06` §6, THE SEVEN STEPS, AND WHAT THIS FILE IS
 *
 * ```
 * 6. Compose the assessmentSpec (fixed items + pooled slots)
 * 7. previewAsStudent: pick a seed, see exactly what a student with that seed receives
 * ```
 *
 * Steps 1–5 are authoring and live in `question-banks.ts`. This file is 6 and 7, plus the gate
 * run in between — because a preview that does not run the gates is a preview of something you
 * cannot publish, which is a preview nobody acts on.
 *
 * ## THE PREVIEW USES THE EXACT RESOLUTION PATH, OR IT IS A LIAR
 *
 * The failure mode here is specific and easy: a preview that composes its own description of the
 * slots, resolves them with its own draw, and formats its own policy. It looks right, it is
 * subtly different from what the student will receive, and the difference is discovered by a
 * student at 09:00.
 *
 * So the preview calls `resolveSlots` and `resolveForStudent` — the same two functions an attempt
 * uses — and the difference between a preview and the real thing is the DATABASE ROWS, which is
 * the one thing that legitimately differs. There is a test that resolves the same slots twice, by
 * hand and through the preview, and compares.
 *
 * ## A PREVIEW IS NOT AN ATTEMPT, AND SAYS SO
 *
 * It creates no attempt, writes no `variantMap`, and consumes no `attemptNumber`. A student who
 * previews ten times must not have used an attempt — and a preview that consumed attempts would
 * be a way to burn a student's allowance by looking at the work.
 */

import { type Clock, systemClock } from '@orrery/clock';
import type { BlueprintCell, ItemFacts, SlotFacts } from '@orrery/contracts/blueprint';
import { resolveForStudent } from './assignments.js';
import type { PrismaClient, TxClient } from './index.js';
import { type PublishProblem, publishable, validateForPublish } from './publish-gates.js';
import { attemptSeed, resolveSlots, type SlotSpec, sameVariantMap } from './slots.js';

type Db = PrismaClient | TxClient;

export interface BuildDraftInput {
  readonly resourceVersionId: string;
  readonly slots: readonly SlotSpec[];
  readonly availableFrom?: Date | null;
  readonly availableUntil?: Date | null;
  readonly maxAttempts?: number | null;
  readonly policyOverride?: unknown;
}

export interface PreviewInput {
  readonly resourceVersionId: string;
  readonly slots: readonly SlotSpec[];
  readonly availableFrom?: Date | null;
  readonly availableUntil?: Date | null;
  readonly maxAttempts?: number | null;
  readonly policyOverride?: unknown;
  readonly blueprint?: { readonly cells: readonly BlueprintCell[] } | null;
  /** Which student to preview AS. Drives the override and the accommodation fold. */
  readonly studentId: string;
  readonly classroomId: string;
  /**
   * The seed to preview with. Supplied rather than generated, because "show me again" has to
   * show the SAME paper, and a preview that re-draws on every click is a preview of nothing.
   */
  readonly seed: string;
  readonly requireItemMetadata?: boolean;
}

export interface StudentPreview {
  /** Every slot, in position order, with what the student would see in it. */
  readonly slots: readonly {
    readonly position: number;
    readonly kind: SlotSpec['kind'];
    readonly poolId: string | null;
    readonly questionIds: readonly string[];
    /** Prompts, for the author to read. NEVER the answer key — INV-Q-1. */
    readonly prompts: readonly string[];
  }[];
  readonly policy: ReturnType<typeof resolveForStudent>;
  /** The gates, so the author sees what is blocking BEFORE they try to publish. */
  readonly problems: readonly PublishProblem[];
  readonly publishable: boolean;
  /** The seed that produced this, echoed so the UI can offer "preview another". */
  readonly seed: string;
}

/**
 * What a student with this seed receives.  (P5-T3, step 7)
 *
 * ## WHY THE GATES RUN HERE
 *
 * Step 7 is the last thing before publish, so it is the cheapest place to say "this cannot be
 * published". The alternative is a Publish button that fails, and a Publish button that fails is a
 * button a teacher learns not to press until they have worked out why.
 *
 * ## WHY NO ANSWER KEY APPEARS ANYWHERE IN HERE
 *
 * INV-Q-1: "Answer keys never leave the server." The preview is rendered in the AUTHORING UI,
 * which is a different trust context from the student's — but the preview type deliberately has
 * no field a key could be put in, so the omission is structural rather than a matter of the
 * formatter remembering. A future field called `items` holding whole question rows would have to
 * be re-audited; this one cannot hold them.
 */
export async function previewAsStudent(
  db: Db,
  input: PreviewInput,
  clock: Clock = systemClock,
): Promise<StudentPreview> {
  const now = new Date(clock.now());

  const poolIds = input.slots
    .map((s) => (s.kind === 'POOLED' ? s.poolId : null))
    .filter((id): id is string => id !== null);
  const pools = await db.questionPool.findMany({
    where: { id: { in: poolIds } },
    select: {
      id: true,
      strategy: true,
      drawCount: true,
      items: {
        select: {
          weight: true,
          question: {
            select: { id: true, topic: true, responseProcess: true, spec: true, modelAnswer: true },
          },
        },
      },
    },
  });

  const questionIds = new Set<string>();
  for (const slot of input.slots) {
    if (slot.kind === 'FIXED' && slot.questionId != null) questionIds.add(slot.questionId);
  }
  for (const pool of pools) for (const i of pool.items) questionIds.add(i.question.id);

  const questions = await db.question.findMany({
    where: { id: { in: [...questionIds] } },
    // `modelAnswer` is deliberately absent: the prompt only. See the note on INV-Q-1 above.
    select: { id: true, topic: true, responseProcess: true, spec: true },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));

  const items: ItemFacts[] = questions.map((q) => ({
    questionId: q.id,
    topic: q.topic,
    responseProcess: q.responseProcess === null ? null : String(q.responseProcess),
  }));

  const variantMap = resolveSlots(
    input.slots,
    pools.map((p) => ({
      id: p.id,
      strategy: p.strategy,
      drawCount: p.drawCount,
      items: p.items.map((i) => ({
        questionId: i.question.id,
        topic: i.question.topic,
        responseProcess:
          i.question.responseProcess === null ? null : String(i.question.responseProcess),
        weight: i.weight,
      })),
    })),
    input.seed,
  );

  const [override, accommodations] = await Promise.all([
    db.assignmentStudentOverride.findFirst({
      where: {
        assignment: { id: { in: await assignmentIdsFor(db, input.resourceVersionId) } },
        studentId: input.studentId,
      },
      select: {
        availableFrom: true,
        availableUntil: true,
        maxAttempts: true,
        extraTimePercent: true,
        policyOverride: true,
      },
      take: 1,
    }),
    db.accommodation.findMany({
      where: {
        classroomId: input.classroomId,
        studentId: input.studentId,
        status: 'ACTIVE',
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { relaxations: true, extraTimePercent: true },
    }),
  ]);

  const policy = resolveForStudent({
    mode: 'EXAM',
    versionPolicy: (
      await db.resourceVersion.findUnique({
        where: { id: input.resourceVersionId },
        select: { assessmentPolicy: true },
      })
    )?.assessmentPolicy as never,
    assignmentOverride: input.policyOverride as never,
    availableFrom: input.availableFrom ?? null,
    availableUntil: input.availableUntil ?? null,
    maxAttempts: input.maxAttempts ?? 1,
    studentOverride: override
      ? {
          availableFrom:
            override.availableFrom == null ? null : new Date(override.availableFrom).toISOString(),
          availableUntil:
            override.availableUntil == null
              ? null
              : new Date(override.availableUntil).toISOString(),
          maxAttempts: override.maxAttempts,
          extraTimePercent:
            override.extraTimePercent == null ? null : Number(override.extraTimePercent),
          policyOverride: override.policyOverride as never,
        }
      : null,
    accommodation:
      accommodations.length === 0
        ? null
        : {
            relaxations: accommodations.flatMap((a) => a.relaxations),
            extraTimePercent: Math.max(
              0,
              ...accommodations.map((a) => Number(a.extraTimePercent ?? 0)),
            ),
            status: 'ACTIVE',
          },
  });

  const problems = validateForPublish({
    slots: input.slots,
    pools: pools.map((p) => ({
      id: p.id,
      strategy: p.strategy,
      drawCount: p.drawCount,
      items: p.items.map((i) => ({
        questionId: i.question.id,
        topic: i.question.topic,
        responseProcess:
          i.question.responseProcess === null ? null : String(i.question.responseProcess),
        weight: i.weight,
      })),
    })),
    items,
    versionId: input.resourceVersionId,
    ...(input.blueprint === null || input.blueprint === undefined
      ? {}
      : { blueprint: { cells: input.blueprint.cells } }),
    requireItemMetadata: input.requireItemMetadata ?? true,
  });

  const slots = [...input.slots]
    .sort((a, b) => a.position - b.position)
    .map((slot) => {
      const ids = variantMap[String(slot.position)] ?? [];
      return {
        position: slot.position,
        kind: slot.kind,
        poolId: slot.poolId ?? null,
        questionIds: ids,
        prompts: ids.map((id) => promptText(byId.get(id)?.spec)),
      };
    });

  return { slots, policy, problems, publishable: publishable(problems), seed: input.seed };
}

/**
 * An assignment already using this version, if there is one, so the override lookup has
 * something to match.
 *
 * The preview is for a DRAFT that does not exist yet, so there is usually no assignment to read an
 * override from — and returning an empty list is the correct answer rather than a placeholder id.
 */
async function assignmentIdsFor(db: Db, resourceVersionId: string): Promise<string[]> {
  const rows = await db.assignment.findMany({
    where: { resourceVersionId },
    select: { id: true },
    take: 20,
  });
  return rows.map((r) => r.id);
}

function promptText(spec: unknown): string {
  if (spec === null || typeof spec !== 'object') return '';
  const record = spec as Record<string, unknown>;
  for (const key of ['prompt', 'stem', 'text', 'question']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export { attemptSeed, type SlotFacts, sameVariantMap };
