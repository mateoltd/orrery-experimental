/**
 * Version snapshots, and the "too similar" guard.  (P5-T10, P5-T11)
 *
 * ## INV-BANK-3, AND THE FLAG THAT IS THE WHOLE POINT
 *
 * "Question *content* is snapshotted into the version at publish time (`variantSource = VERSION`).
 * A question edited later affects future versions only."
 *
 * So publishing a version COPIES every drawable question into it. The copy is not an optimisation
 * and not a cache — it is what makes a student's paper unchanged by a teacher fixing a typo in
 * question 3 three weeks later, and it is the second half of the pinning invariant: P5-T5 proves
 * the version is pinned, and this proves what the version CONTAINS is frozen too.
 *
 * The exception the plan allows is the interesting part: `variantSource = BANK` is "permitted
 * only for formative quizzes where the teacher explicitly accepts that a mid-flight edit changes
 * live attempts, and it is recorded per assessment". That is a teacher accepting that their own
 * live data moves under them, which is fine for a practice quiz and catastrophic for a graded
 * one — so the parameter is REQUIRED, the default is `VERSION`, and `attempt.variantSource` records
 * which one was in force.
 *
 * ## `isSnapshot` EXISTS SO THAT "HOW MANY ITEMS IN THIS BANK" IS NOT WRONG
 *
 * Snapshot rows carry a non-null `bankId`, so a naive count double-counts every snapshotted
 * question. B2 says exactly that, and it is the kind of note that is read once and then needed
 * again the first time somebody writes a "how many items does this bank have" query. So the count
 * in this module filters `isSnapshot: false`, and there is a test that a published version does
 * not change its bank's item count.
 *
 * ## THE "TOO SIMILAR" GUARD COMPARES THE THREE THINGS THE PLAN NAMES
 *
 * `plans/06` §6.2: normalised stem text (trigram similarity), answer key set, and numeric answer.
 * Above a threshold, the item requires an EXPLICIT ACKNOWLEDGEMENT rather than being refused —
 * because two genuinely similar questions in a bank is a real authoring outcome (a parallel form
 * is often the point), and a gate that refuses them silently produces banks nobody authors in.
 *
 * The acknowledgement is recorded, so "somebody already accepted this pair" is a fact rather than
 * a checkbox somebody has to find again.
 */

import { randomUUID } from 'node:crypto';
import { type Clock, systemClock } from '@orrery/clock';
import type { PrismaClient, TxClient } from './index.js';
import type { SlotSpec } from './slots.js';

type Db = PrismaClient | TxClient;

export interface SnapshotResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly snapshotCount: number;
  readonly variantSource: 'VERSION' | 'BANK';
}

export interface SnapshotInput {
  readonly resourceVersionId: string;
  readonly slots: readonly SlotSpec[];
  /**
   * `VERSION` (the default) copies every drawable question into the version.
   * `BANK` records that the assessment reads live bank content.
   */
  readonly variantSource?: 'VERSION' | 'BANK';
  readonly actorId: string;
}

/**
 * Copy every drawable question into the version.  (P5-T10, INV-BANK-3)
 *
 * ## A drawable question is one a POOLED slot could reach, OR one a FIXED slot names
 *
 * Copying the whole bank was the first version, and it is wrong twice over: it is O(bank) work
 * for a 3-item assessment, and it makes every published version a superset of the bank, so a
 * question that was in the bank and is later removed from every pool still survives in versions
 * that never needed it.
 *
 * ## The copy is IDEMPOTENT, and `@@unique([resourceVersionId, snapshotOfId])` is what makes it so
 *
 * Publishing the same version twice must not double-copy, because the dedupe key is already in the
 * schema and the alternative — checking first — is the read-then-write race this codebase keeps
 * refusing. A unique violation is the correct outcome of the second publish and is reported as
 * success.
 */
export async function snapshotDrawableQuestions(
  db: Db,
  input: SnapshotInput,
  clock: Clock = systemClock,
): Promise<SnapshotResult> {
  const variantSource = input.variantSource ?? 'VERSION';

  const questionIds = new Set<string>();
  for (const slot of input.slots) {
    if (slot.kind === 'FIXED') {
      if (slot.questionId !== null && slot.questionId !== undefined)
        questionIds.add(slot.questionId);
      continue;
    }
    const poolId = slot.poolId;
    if (poolId === null || poolId === undefined) continue;
    const items = await db.questionPoolItem.findMany({
      where: { poolId },
      select: { questionId: true },
    });
    for (const item of items) questionIds.add(item.questionId);
  }

  if (variantSource === 'BANK') {
    // The recorded exception. Nothing is copied, and `variantSource` on the attempt says so, so
    // a later reader can see that this assessment reads live content BY CHOICE rather than
    // because the copy was forgotten.
    return { ok: true, snapshotCount: 0, variantSource };
  }

  const originals = await db.question.findMany({
    where: { id: { in: [...questionIds] }, isSnapshot: false },
    select: {
      id: true,
      bankId: true,
      type: true,
      spec: true,
      points: true,
      gradingMode: true,
      partialCreditMethod: true,
      timeLimitSec: true,
      shuffleOptions: true,
      estimatedSeconds: true,
      modelAnswer: true,
      rubric: true,
      language: true,
      topic: true,
      cognitiveDemand: true,
      responseProcess: true,
      scoringSurface: true,
      simId: true,
      simVersion: true,
      simConfig: true,
      retiredFromSummativeUse: true,
    },
  });

  const now = new Date(clock.now());
  let written = 0;
  for (const original of originals) {
    const { id: _id, ...rest } = original;
    // A unique violation means this version already holds that snapshot, which is the correct
    // outcome of a second publish rather than an error.
    const inserted = await db.question.createMany({
      data: [
        {
          ...rest,
          id: randomUUID(),
          isSnapshot: true,
          snapshotOfId: original.id,
          resourceVersionId: input.resourceVersionId,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        } as never,
      ],
      skipDuplicates: true,
    });
    written += inserted.count;
  }

  return { ok: true, snapshotCount: written, variantSource };
}

/** The snapshot of a question inside a version, or null. */
export async function snapshotOf(
  db: Db,
  input: { readonly resourceVersionId: string; readonly questionId: string },
): Promise<{ readonly id: string } | null> {
  return db.question.findFirst({
    where: {
      resourceVersionId: input.resourceVersionId,
      snapshotOfId: input.questionId,
      isSnapshot: true,
    },
    select: { id: true },
  });
}

// ── the "too similar" guard (P5-T11) ─────────────────────────────────────────

export type SimilarityDimension = 'stem' | 'answerKey' | 'numericAnswer';

/** Reported in this order when two dimensions tie, because a readable stem beats a key set. */
const DIMENSION_ORDER: Record<SimilarityDimension, number> = {
  stem: 0,
  answerKey: 1,
  numericAnswer: 2,
};

export interface SimilarityHit {
  readonly dimension: SimilarityDimension;
  readonly otherQuestionId: string;
  /** 0..1. */
  readonly score: number;
  /** Why the two look alike, in words a teacher can act on. */
  readonly because: string;
}

export interface SimilarityReport {
  readonly hits: readonly SimilarityHit[];
  /** A pair the author has already acknowledged. Re-reporting it is noise. */
  readonly acknowledged: readonly SimilarityHit[];
}

/** Anything the guard needs to read from a question, and nothing else. */
export interface ComparableQuestion {
  readonly id: string;
  readonly spec: unknown;
  readonly modelAnswer: string | null;
}

/**
 * Normalise a stem for comparison.
 *
 * Lower-cased, punctuation collapsed to single spaces, the NUMBERS replaced with `#`, and the
 * OPERATORS replaced with `~`.
 *
 * ## Why the operators are kept, which the first version got wrong
 *
 * The first version mapped every non-alphanumeric character to a space, so "What is 3 + 4?" and
 * "What is 4 × 3?" both became "what is # #" — identical. Those are DIFFERENT questions with
 * DIFFERENT answers, and an item guard that says they are the same will get a bank full of "what
 * is a # b" prompts where `+` and `×` are interchangeable. A test asserting they differ caught it.
 *
 * So the operators are PRESERVED rather than replaced. The second attempt mapped them all to `~`,
 * which was still wrong for the same reason one step earlier: "3 + 4" and "4 × 3" both became
 * "what is # ~ #". A placeholder has to be distinguishable per VALUE, and the operators already
 * are. So they survive as themselves and everything else non-alphanumeric becomes a space.
 */
const OPERATORS = String.raw`+\-×÷/*^=<>≤≥`;

export function normaliseStem(prompt: string): string {
  const keep = new Set([...OPERATORS, ...'#']);
  return prompt
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .split('')
    .map((ch) => (keep.has(ch) || /[\p{L}\p{N}\s]/u.test(ch) ? ch : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trigram set of a normalised string, padded so that short strings still produce trigrams.
 *
 * The padding means a one-character string yields three trigrams drawn mostly from the padding,
 * so two different one-character strings score LOW BUT NONZERO rather than 0. That is the right
 * behaviour — "x" and "y" really do share their surrounding context — and the test asserts the
 * real number rather than the tidier one the first version's comment claimed.
 */
export function trigrams(normalised: string): Set<string> {
  const padded = `  ${normalised} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** Jaccard similarity of two trigram sets. 0 when either is empty. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const g of left) if (right.has(g)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const SIMILARITY_THRESHOLD = 0.6;

/** Where a prompt lives inside `Question.spec`. Read defensively: `spec` is JSON. */
function promptOf(spec: unknown): string {
  if (spec === null || typeof spec !== 'object') return '';
  const record = spec as Record<string, unknown>;
  for (const key of ['prompt', 'stem', 'text', 'question']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** The answer-key set, as sorted lowercase tokens. */
function answerKeyTokens(spec: unknown, modelAnswer: string | null): Set<string> {
  const tokens = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const t of value.toLowerCase().split(/[^a-z0-9.]+/)) if (t !== '') tokens.add(t);
  };
  if (spec !== null && typeof spec === 'object') {
    for (const key of ['modelAnswer', 'accept', 'acceptedAnswers', 'answerKey']) {
      const value = (spec as Record<string, unknown>)[key];
      if (Array.isArray(value)) for (const v of value) add(v);
      else add(value);
    }
  }
  add(modelAnswer);
  return tokens;
}

/** Every number in a string, for the numeric-answer dimension. */
function numbersIn(value: string | null): Set<string> {
  const out = new Set<string>();
  if (value === null) return out;
  for (const m of value.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(m[0]);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Compare a candidate item against the bank, on the THREE dimensions `plans/06` §6.2 names.
 *
 * "Duplicate items in a pool silently destroy the variation the pool exists to provide, and this
 * is the cheapest possible guard against that" — so the threshold is on the DIMENSIONS the plan
 * names, and a hit in any one of them is reported. The stem is the load-bearing one: two items
 * with the same prompt and different answer keys are the classic copy-paste, and a numeric answer
 * match with the same prompt is the subtler version of it.
 */
export function findSimilar(
  candidate: ComparableQuestion,
  bank: readonly ComparableQuestion[],
  threshold = SIMILARITY_THRESHOLD,
): readonly SimilarityHit[] {
  const hits: SimilarityHit[] = [];
  const candidatePrompt = normaliseStem(promptOf(candidate.spec));
  const candidateKey = answerKeyTokens(candidate.spec, candidate.modelAnswer);
  const candidateNumbers = numbersIn(candidate.modelAnswer);

  for (const other of bank) {
    if (other.id === candidate.id) continue;

    const otherPrompt = normaliseStem(promptOf(other.spec));
    const stemScore = trigramSimilarity(candidatePrompt, otherPrompt);
    const promptsComparable = candidatePrompt !== '' && otherPrompt !== '';
    if (promptsComparable && stemScore >= threshold) {
      hits.push({
        dimension: 'stem',
        otherQuestionId: other.id,
        score: stemScore,
        because: `the two prompts read alike once numbers are normalised away (${stemScore.toFixed(2)} ≥ ${String(threshold)})`,
      });
    }

    const otherKey = answerKeyTokens(other.spec, other.modelAnswer);
    const keyScore = jaccard(candidateKey, otherKey);
    if (candidateKey.size > 0 && otherKey.size > 0 && keyScore >= threshold) {
      hits.push({
        dimension: 'answerKey',
        otherQuestionId: other.id,
        score: keyScore,
        because: `the accepted answers are nearly the same set (${keyScore.toFixed(2)})`,
      });
    }

    const otherNumbers = numbersIn(other.modelAnswer);
    // A numeric match ONLY counts when the prompts are ALSO close, and the first version did not
    // check that -- it compared the numbers and reported, so the comment above it described a rule
    // the code did not implement.
    //
    // The reason it matters: two questions that both happen to answer 42 are not duplicates, and a
    // maths bank is full of them. The student's defence is to know WHICH question they are on, and
    // a bare numeric match takes that away.
    //
    // Which is also why the `continue` statements are gone from the other two branches. With them,
    // a close-stem pair reported `stem` and stopped, so the numeric dimension could never fire at
    // all -- which is why the rule could be missing from the code for so long without a test
    // noticing. All three dimensions are now independent, and a pair can be reported as two
    // problems rather than one.
    if (
      promptsComparable &&
      stemScore >= threshold &&
      candidateNumbers.size > 0 &&
      otherNumbers.size > 0 &&
      jaccard(candidateNumbers, otherNumbers) >= 1
    ) {
      hits.push({
        dimension: 'numericAnswer',
        otherQuestionId: other.id,
        score: stemScore,
        because:
          'the prompts are alike AND both items have the same numeric answer, so a student can carry one answer across',
      });
    }
  }

  // Score first, then dimension, then id. One pair can now produce several hits of equal score,
  // and an unstable order makes "the worst offender is first" depend on insertion order.
  return hits.sort(
    (a, b) => b.score - a.score || DIMENSION_ORDER[a.dimension] - DIMENSION_ORDER[b.dimension],
  );
}
