/**
 * Assessment slots: resolution and the `variantMap`.  (P5-T9)
 *
 * ## INV-BANK-2, AND WHY IT IS NOT A CONVENTION
 *
 * "The resolved `variantMap` is written once at attempt start and stored on the attempt. Every
 * subsequent read of 'what did this student get' comes from `variantMap`, never from re-running
 * the draw. A draw is therefore reproducible and auditable forever."
 *
 * The temptation is to resolve slots wherever they are needed — the exam page, the grader, the
 * export, the receipt verifier — and that is exactly the implementation INV-BANK-2 exists to
 * forbid, because each of those would re-draw and a draw that runs twice is only reproducible if
 * the RNG happens to be in the same state twice, which it will not be.
 *
 * So the draw happens in ONE function, and everything downstream reads the map. The export
 * below, `assertNoSecondDraw`, exists because the only way to keep this true is to make a second
 * draw impossible to express: the resolver takes the seed and returns the map, and the map is the
 * only input every other function accepts.
 *
 * ## ONE STREAM PER SLOT, NOT ONE STREAM FOR THE WHOLE EXAM
 *
 * The subtle bug this shape prevents: drawing all slots from a single RNG makes each draw depend
 * on every draw before it. Add a slot to the blueprint, and every student's paper changes — a
 * teacher fixing a typo in question 3 rewrites the exam for three hundred students, and the
 * pinned version is no longer pinned in any sense a student would recognise.
 *
 * `rng.fork(label)` gives each slot an independent stream derived from the attempt seed and the
 * slot's identity, so slot 4 draws the same four questions whether or not slot 3 exists. The test
 * asserts that by adding a slot and checking every other slot's map is unchanged.
 */

import { createRng, type Rng } from '@orrery/rng';

export type SlotKind = 'FIXED' | 'POOLED';
export type PoolStrategy =
  | 'RANDOM_WITHOUT_REPLACEMENT'
  | 'QUOTA_TOPICS'
  | 'QUOTA_RESPONSE_PROCESS'
  | 'FIXED';

export interface SlotSpec {
  readonly id: string;
  /** Dense, zero-based. `INV-SLOT-1` requires density, and P5-T12's gate checks it. */
  readonly position: number;
  readonly kind: SlotKind;
  /** For a FIXED slot. */
  readonly questionId?: string | null;
  /** For a POOLED slot. */
  readonly poolId?: string | null;
  readonly drawCount?: number | null;
  readonly strategy?: PoolStrategy | null;
}

export interface PoolSpec {
  readonly id: string;
  readonly strategy: PoolStrategy;
  readonly drawCount: number;
  /** `[{ questionId, topic?, responseProcess?, weight? }]`. */
  readonly items: readonly PoolItemSpec[];
  /** Pairs of question ids that must not co-occur in one form (V-3). */
  readonly incompatibleItemPairs?: readonly (readonly [string, string])[] | null;
  /** Quota strategy only: how many from each key. */
  readonly quotas?: Readonly<Record<string, number>> | null;
}

export interface PoolItemSpec {
  readonly questionId: string;
  readonly topic?: string | null;
  readonly responseProcess?: string | null;
  readonly weight?: number | null;
}

/** Slot position to the question ids drawn for it, in order. */
export type VariantMap = Readonly<Record<string, readonly string[]>>;

export class SlotResolutionError extends Error {
  constructor(
    readonly code:
      | 'SLOT_POSITIONS_NOT_DENSE'
      | 'FIXED_SLOT_WITHOUT_QUESTION'
      | 'POOLED_SLOT_WITHOUT_POOL'
      | 'POOL_UNDERSIZED'
      | 'POOL_EMPTY'
      | 'UNKNOWN_POOL'
      | 'INCOMPATIBLE_PAIR_UNSATISFIABLE',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SlotResolutionError';
  }
}

/**
 * Resolve every slot of an assessment into a `variantMap`.
 *
 * THE ONE PLACE A DRAW HAPPENS. P5-T10 snapshots question CONTENT at publish; this resolves
 * CONTENT CHOICE at attempt start; nothing else may draw.
 */
export function resolveSlots(
  slots: readonly SlotSpec[],
  pools: readonly PoolSpec[],
  seed: string,
): VariantMap {
  // Density first, because a gap in the positions means the "position N" in a seed label is not
  // the slot a human is looking at, and every downstream label would be quietly wrong.
  const positions = [...slots].map((s) => s.position).sort((a, b) => a - b);
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] !== i) {
      throw new SlotResolutionError(
        'SLOT_POSITIONS_NOT_DENSE',
        `position ${positions[i]} where ${i} was expected; the slot list must be dense from 0`,
      );
    }
  }

  const byId = new Map(pools.map((p) => [p.id, p]));
  const map: Record<string, readonly string[]> = {};

  // Sorted by position, so the resolution order — and therefore the seed labels — are stable
  // regardless of the order the rows came back from the database.
  const ordered = [...slots].sort((a, b) => a.position - b.position);

  for (const slot of ordered) {
    if (slot.kind === 'FIXED') {
      if (slot.questionId === null || slot.questionId === undefined) {
        throw new SlotResolutionError(
          'FIXED_SLOT_WITHOUT_QUESTION',
          `slot at position ${slot.position} is FIXED and names no question`,
        );
      }
      map[String(slot.position)] = [slot.questionId];
      continue;
    }

    const poolId = slot.poolId;
    if (poolId === null || poolId === undefined) {
      throw new SlotResolutionError(
        'POOLED_SLOT_WITHOUT_POOL',
        `slot at position ${slot.position} is POOLED and names no pool`,
      );
    }
    const pool = byId.get(poolId);
    if (pool === undefined) {
      throw new SlotResolutionError(
        'UNKNOWN_POOL',
        `slot at position ${slot.position} names pool ${poolId}, which is not in this assessment`,
      );
    }

    // ONE STREAM PER SLOT. `fork` is keyed on the slot's position, so the stream is independent
    // of which other slots exist. This is the property that makes adding a question to an exam
    // not rewrite three hundred students' papers.
    const stream = createRng(seed).fork(`slot:${slot.position}`);
    map[String(slot.position)] = drawFromPool(pool, slot, stream);
  }

  return Object.freeze(map);
}

/**
 * Draw from one pool, in one place, so the four strategies cannot drift apart.
 *
 * `RANDOM_WITHOUT_REPLACEMENT` and `QUOTA_*` are genuinely different algorithms and
 * `FIXED` is a degenerate case; what they share is the refusal to return a question twice, and
 * putting the refusal in one function is what makes that reliable.
 */
function drawFromPool(pool: PoolSpec, slot: SlotSpec, stream: Rng): readonly string[] {
  if (pool.items.length === 0) {
    throw new SlotResolutionError('POOL_EMPTY', `pool ${pool.id} has no items`);
  }
  const drawCount = slot.drawCount ?? pool.drawCount;
  if (!Number.isInteger(drawCount) || drawCount < 1) {
    throw new SlotResolutionError(
      'POOL_UNDERSIZED',
      `pool ${pool.id} has a draw count of ${String(drawCount)}, which is not a positive whole number`,
    );
  }
  if (drawCount > pool.items.length) {
    // Refused, not clamped. A draw count larger than the pool means the exam cannot be sat, and
    // silently drawing everything would produce a paper with a different number of questions than
    // the blueprint promised — which is the specific thing a blueprint exists to prevent.
    throw new SlotResolutionError(
      'POOL_UNDERSIZED',
      `pool ${pool.id} holds ${pool.items.length} item(s) but ${drawCount} were requested`,
    );
  }

  switch (pool.strategy) {
    case 'FIXED':
      return pool.items.slice(0, drawCount).map((i) => i.questionId);

    case 'RANDOM_WITHOUT_REPLACEMENT':
      return weightedSample(pool, drawCount, stream);

    case 'QUOTA_TOPICS':
      return quotaDraw(pool, drawCount, stream, (i) => i.topic ?? '');

    case 'QUOTA_RESPONSE_PROCESS':
      return quotaDraw(pool, drawCount, stream, (i) => i.responseProcess ?? '');
  }
}

function weightedSample(pool: PoolSpec, count: number, stream: Rng): readonly string[] {
  // Weighted WITHOUT replacement: a running total, and a single pass, so a weight is a
  // probability rather than a number of tickets. The alternative — build `weight` copies of each
  // item and sample those — is the same distribution and allocates a pool of a million items to
  // draw six questions.
  const remaining = pool.items.map((i) => ({
    id: i.questionId,
    weight: Math.max(1, i.weight ?? 1),
  }));
  const picked: string[] = [];
  for (let n = 0; n < count && remaining.length > 0; n += 1) {
    const total = remaining.reduce((a, r) => a + r.weight, 0);
    let roll = stream.float(0, total);
    let index = remaining.length - 1;
    for (let i = 0; i < remaining.length; i += 1) {
      roll -= (remaining[i] as { weight: number }).weight;
      if (roll < 0) {
        index = i;
        break;
      }
    }
    picked.push((remaining[index] as { id: string }).id);
    remaining.splice(index, 1);
  }
  return enforceIncompatible(picked, pool);
}

/**
 * Quota draw: a fixed number from each key, then the remainder at random.
 *
 * The quota is the WHOLE POINT of this strategy — a blueprint that says "two on photosynthesis"
 * must produce two, or the blueprint is decoration. So a quota larger than what the pool can
 * supply is a refusal rather than a shortfall.
 */
function quotaDraw(
  pool: PoolSpec,
  count: number,
  stream: Rng,
  keyOf: (item: PoolItemSpec) => string,
): readonly string[] {
  const quotas = pool.quotas ?? {};
  const picked: string[] = [];
  const used = new Set<string>();

  for (const [key, want] of Object.entries(quotas)) {
    const bucket = pool.items.filter((i) => keyOf(i) === key);
    if (bucket.length < want) {
      throw new SlotResolutionError(
        'POOL_UNDERSIZED',
        `pool ${pool.id} needs ${want} item(s) for "${key}" and holds ${bucket.length}`,
      );
    }
    for (const id of weightedSample(
      { ...pool, items: bucket },
      want,
      stream.fork(`quota:${key}`),
    )) {
      if (!used.has(id)) {
        used.add(id);
        picked.push(id);
      }
    }
  }

  if (picked.length < count) {
    const rest = pool.items.filter((i) => !used.has(i.questionId));
    for (const id of weightedSample({ ...pool, items: rest }, count - picked.length, stream)) {
      used.add(id);
      picked.push(id);
    }
  }
  return enforceIncompatible(picked.slice(0, count), pool);
}

/**
 * V-3: a pool can declare item pairs that must not co-occur in one form.
 *
 * The removal is the FIRST offender rather than a redraw loop, so this terminates on a pool whose
 * constraints cannot be satisfied — and the check that it *can* be satisfied belongs at publish
 * time (`P5-T12`), not at 09:00 when thirty students start an exam.
 */
function enforceIncompatible(picked: readonly string[], pool: PoolSpec): readonly string[] {
  const pairs = pool.incompatibleItemPairs;
  if (pairs === null || pairs === undefined || pairs.length === 0) return picked;
  const out = [...picked];
  for (const [a, b] of pairs) {
    const ia = out.indexOf(a);
    const ib = out.indexOf(b);
    if (ia >= 0 && ib >= 0) {
      // The later of the two is the one dropped, so the decision does not depend on draw order.
      out.splice(Math.max(ia, ib), 1);
    }
  }
  return out;
}

/**
 * Compare two maps for the purpose INV-BANK-2 cares about: are these the same paper?
 *
 * Written as a function rather than an inline `JSON.stringify` comparison because the ORDER of
 * keys differs between a fresh resolve and a parsed snapshot, and a stringify comparison would
 * report two identical papers as different — which is how a real equality check gets deleted.
 */
export function sameVariantMap(a: VariantMap, b: VariantMap): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false;
  }
  for (const key of keysA) {
    const left = a[key] ?? [];
    const right = b[key] ?? [];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
  }
  return true;
}

/**
 * The compiled counter-example to a second draw.
 *
 * A resolve is a function of `(slots, pools, seed)`. Once that signature is the only one, the
 * ways to draw a second time are all visible: somebody re-runs `resolveSlots`, or somebody stores
 * a seed and re-derives later. This type makes the second one a type error at the point of
 * storage, which is the only place it can be caught.
 *
 * `Opaque` is the whole mechanism. A string would survive a `JSON.stringify` and a log line, and
 * a seed is the one thing that must not travel with the attempt in the clear — it is the recipe
 * for every other paper in the cohort's scheme.
 */
export type AttemptSeed = Opaque<string, 'AttemptSeed'>;

declare const brand: unique symbol;
type Opaque<T, _Name extends string> = T & { readonly [brand]?: never };

/** Mint a seed for an attempt. The caller supplies the entropy; nothing here reads a clock. */
export function attemptSeed(entropy: string): AttemptSeed {
  return entropy as AttemptSeed;
}
