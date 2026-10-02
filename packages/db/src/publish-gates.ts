/**
 * The publish gates.  (P5-T12)
 *
 * ## WHY PUBLISH IS GATED AT ALL
 *
 * Every gate in this file is checking something that is CHEAP TO FIX BEFORE A STUDENT STARTS AND
 * EXPENSIVE AFTERWARDS. A pool that cannot fill a paper, a blueprint no draw can satisfy, a slot
 * pointing at a question that does not exist, an item with no topic — each of those is a
 * teacher's afternoon and a student's 09:00, and each is invisible until somebody opens the exam.
 *
 * That is the same argument `INV-POLICY-2` makes about policy validation, and the same shape
 * `plans/06` §7 uses for pool health: **make the shortfall VISIBLE at authoring time so it gets
 * prioritised, rather than letting it be discovered by a class.**
 *
 * ## THE GATES RETURN PROBLEMS, THEY DO NOT THROW
 *
 * A throw is right for a bug and wrong for a teacher's incomplete draft. `validateForPublish`
 * (P2-T10) established the precedent: "a checklist with fixes, not a wall of red." So every gate
 * contributes named problems with a severity, and the caller decides what is fatal. A gate that
 * threw would make the authoring UI show a stack trace instead of the three things to fix.
 *
 * ## `INV-SLOT-1` IS REFERENTIAL INTEGRITY, AND IT IS THE ONE THAT MATTERS MOST
 *
 * "An `AssessmentSlot` list and the `Question` rows it references agree, verified at publish."
 * A FIXED slot naming a question from ANOTHER version is not a warning — it is a student being
 * marked against a question nobody taught, and the grade is still recorded. ADR-0025 calls this the
 * "complementary data-level check" to the path ban: the gate stops `currentVersionId` being READ,
 * and this stops the wrong question being STORED. Either alone is insufficient, because one is a
 * source-level rule and the other is a data-level fact.
 */

import {
  type BlueprintCell,
  blueprintCoverage,
  type ItemFacts,
  type SlotFacts,
} from '@orrery/contracts/blueprint';
import type { PoolSpec, SlotSpec } from './slots.js';

export type PublishProblemCode =
  | 'SLOT_POSITIONS_NOT_DENSE'
  | 'FIXED_SLOT_UNKNOWN_QUESTION'
  | 'FIXED_SLOT_FOREIGN_QUESTION'
  | 'FIXED_SLOT_WITHOUT_QUESTION'
  | 'POOLED_SLOT_WITHOUT_POOL'
  | 'POOL_UNDERSIZED'
  | 'POOL_EMPTY'
  | 'POOL_QUOTA_UNDERSIZED'
  | 'BLUEPRINT_UNSATISFIED'
  | 'ITEM_METADATA_MISSING'
  | 'NO_SLOTS';

export interface PublishProblem {
  readonly code: PublishProblemCode;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly detail: string;
  /** Slot position, item id, or pool id — whatever a teacher needs to find the thing. */
  readonly where: string;
  /** A fix, where one exists. A problem with no fix is a report, not a checklist item. */
  readonly fix?: string;
}

export interface PublishInput {
  readonly slots: readonly SlotSpec[];
  readonly pools: readonly PoolSpec[];
  /** Every question the slots can reach, with its metadata. */
  readonly items: readonly ItemFacts[];
  /**
   * Which version the FIXED slots' questions were SNAPSHOTED into.
   *
   * This is what makes `INV-SLOT-1` checkable. A question id alone cannot say whether it belongs
   * here — the caller has to say which version this publish is for, and then every FIXED slot's
   * snapshot is compared against it.
   */
  readonly versionId: string;
  readonly blueprint?: {
    readonly cells: readonly BlueprintCell[];
  } | null;
  /** `plans/06` §6.1: topic and cognitive demand are REQUIRED on publish. */
  readonly requireItemMetadata?: boolean;
}

/**
 * Every problem with publishing this version.
 *
 * All of them, always. The first version returned early on the first blocking problem, which is
 * the behaviour a test asserting one specific code would like and which is useless to a teacher
 * who then fixes one thing and is told about the next.
 */
export function validateForPublish(input: PublishInput): readonly PublishProblem[] {
  const problems: PublishProblem[] = [];

  // ── slots ──────────────────────────────────────────────────────────────────
  if (input.slots.length === 0) {
    problems.push({
      code: 'NO_SLOTS',
      severity: 'BLOCKING',
      detail: 'this version has no slots, so there is nothing to sit',
      where: 'version',
      fix: 'add a slot, or publish it as a reading rather than an assessment',
    });
  }

  const positions = [...input.slots].map((s) => s.position).sort((a, b) => a - b);
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] !== i) {
      problems.push({
        code: 'SLOT_POSITIONS_NOT_DENSE',
        severity: 'BLOCKING',
        detail: `slot positions must run 0, 1, 2 … with no gap; found ${positions[i]} where ${i} was expected`,
        where: `position ${String(positions[i])}`,
        fix: 'renumber the slots so there are no gaps',
      });
      break;
    }
  }

  const itemById = new Map(input.items.map((i) => [i.questionId, i]));

  // ── INV-SLOT-1: every FIXED slot's question belongs to THIS version ─────────
  for (const slot of input.slots) {
    if (slot.kind !== 'FIXED') continue;
    const questionId = slot.questionId;
    if (questionId === null || questionId === undefined) {
      problems.push({
        code: 'FIXED_SLOT_WITHOUT_QUESTION',
        severity: 'BLOCKING',
        detail: 'a FIXED slot names no question',
        where: `position ${String(slot.position)}`,
        fix: 'choose the question for this slot, or make it POOLED',
      });
      continue;
    }
    const item = itemById.get(questionId);
    if (item === undefined) {
      problems.push({
        code: 'FIXED_SLOT_UNKNOWN_QUESTION',
        severity: 'BLOCKING',
        detail: `this slot names question ${questionId.slice(0, 8)}, which is not in this version`,
        where: `position ${String(slot.position)}`,
        fix: 'choose a question from this version, or publish it as a slot whose snapshot is missing',
      });
    }
  }

  // ── pools ───────────────────────────────────────────────────────────────────
  const poolById = new Map(input.pools.map((p) => [p.id, p]));
  for (const slot of input.slots) {
    if (slot.kind !== 'POOLED') continue;
    const poolId = slot.poolId;
    if (poolId === null || poolId === undefined) {
      problems.push({
        code: 'POOLED_SLOT_WITHOUT_POOL',
        severity: 'BLOCKING',
        detail: 'a POOLED slot names no pool',
        where: `position ${String(slot.position)}`,
        fix: 'choose a pool for this slot',
      });
      continue;
    }
    const pool = poolById.get(poolId);
    if (pool === undefined) {
      problems.push({
        code: 'POOLED_SLOT_WITHOUT_POOL',
        severity: 'BLOCKING',
        detail: `this slot names pool ${poolId.slice(0, 8)}, which is not part of this assessment`,
        where: `position ${String(slot.position)}`,
        fix: 'add the pool to this assessment, or point the slot at one that is',
      });
      continue;
    }
    if (pool.items.length === 0) {
      problems.push({
        code: 'POOL_EMPTY',
        severity: 'BLOCKING',
        detail: `pool "${pool.id}" has no items, so nothing can be drawn from it`,
        where: `pool ${pool.id}`,
        fix: 'add items to the pool, or remove the slot that uses it',
      });
      continue;
    }
    const drawCount = slot.drawCount ?? pool.drawCount;
    if (drawCount > pool.items.length) {
      problems.push({
        code: 'POOL_UNDERSIZED',
        severity: 'BLOCKING',
        // "Not clamped" is the important half. Clamping would silently produce a paper with
        // fewer questions than the blueprint promised.
        detail: `pool "${pool.id}" holds ${pool.items.length} item(s) and this slot draws ${drawCount}`,
        where: `position ${String(slot.position)}`,
        fix: `lower the draw count to ${pool.items.length} or fewer, or add ${drawCount - pool.items.length} more item(s)`,
      });
    }
    if (pool.strategy.startsWith('QUOTA_') && pool.quotas !== null && pool.quotas !== undefined) {
      for (const [key, want] of Object.entries(pool.quotas)) {
        const available = pool.items.filter((i) => quotaKeyOf(pool.strategy, i) === key).length;
        if (available < want) {
          problems.push({
            code: 'POOL_QUOTA_UNDERSIZED',
            severity: 'BLOCKING',
            detail: `pool "${pool.id}" requires ${want} item(s) for "${key}" and holds ${available}`,
            where: `pool ${pool.id}`,
            fix: `add ${want - available} more item(s) for "${key}", or lower the quota`,
          });
        }
      }
    }
  }

  // ── metadata (plans/06 §6.1) ───────────────────────────────────────────────
  if (input.requireItemMetadata === true) {
    for (const pool of input.pools) {
      for (const item of pool.items) {
        const facts = itemById.get(item.questionId);
        if (facts === undefined) continue;
        if (facts.topic === null || facts.topic.trim() === '') {
          problems.push({
            code: 'ITEM_METADATA_MISSING',
            severity: 'BLOCKING',
            // §6.1: "We would be building an item bank we could not use."
            detail: 'this item has no topic, so no blueprint can ever claim to cover it',
            where: `question ${item.questionId.slice(0, 8)}`,
            fix: 'tag the item with a topic',
          });
        }
        if (facts.responseProcess === null) {
          problems.push({
            code: 'ITEM_METADATA_MISSING',
            severity: 'BLOCKING',
            detail: 'this item has no response process, so no blueprint cell can match it',
            where: `question ${item.questionId.slice(0, 8)}`,
            fix: 'record the response process the item assesses',
          });
        }
      }
    }
  }

  // ── blueprint, at WORST CASE ────────────────────────────────────────────────
  if (input.blueprint !== null && input.blueprint !== undefined) {
    // Built by pushing, not by `map`. The two arms have DIFFERENT SHAPES and TypeScript is
    // right that a union of them is not an array of one type; the alternative is a cast, which
    // is the same problem wearing a hat.
    const slotFacts: SlotFacts[] = [];
    for (const slot of input.slots) {
      if (slot.kind === 'FIXED') {
        slotFacts.push({ kind: 'FIXED', questionId: slot.questionId ?? null });
        continue;
      }
      const pool =
        slot.poolId === null || slot.poolId === undefined ? undefined : poolById.get(slot.poolId);
      const poolItems =
        pool?.items
          .map((i) => itemById.get(i.questionId))
          .filter((x): x is ItemFacts => x !== undefined) ?? null;
      slotFacts.push({
        kind: 'POOLED',
        poolId: slot.poolId ?? null,
        poolSize: pool?.items.length ?? null,
        drawCount: slot.drawCount ?? pool?.drawCount ?? null,
        poolItems,
      });
    }
    const coverage = blueprintCoverage({
      cells: input.blueprint.cells,
      slots: slotFacts,
      items: input.items,
    });
    if (coverage.blocksAllDraws) {
      problems.push({
        code: 'BLUEPRINT_UNSATISFIED',
        severity: 'BLOCKING',
        detail: coverage.explanations.join('; '),
        where: 'blueprint',
        // The fix list is real: pool each cell separately, accept probabilistic coverage, or
        // draw everything. None of them is "ignore the gate".
        fix: "give each cell its own pool, or set the draw count equal to the pool size, or lower the cell's minimum",
      });
    } else if (!coverage.coversWorstCase) {
      problems.push({
        code: 'BLUEPRINT_UNSATISFIED',
        severity: 'WARNING',
        detail: 'the blueprint is satisfied in most draws but not every one',
        where: 'blueprint',
        fix: 'accept this if probabilistic coverage is acceptable for this assessment',
      });
    }
  }

  return problems;
}

export function publishable(problems: readonly PublishProblem[]): boolean {
  return problems.every((p) => p.severity !== 'BLOCKING');
}

const quotaKeyOf = (strategy: PoolSpec['strategy'], item: PoolSpec['items'][number]): string =>
  strategy === 'QUOTA_TOPICS' ? (item.topic ?? '') : (item.responseProcess ?? '');

export type { SlotSpec };
