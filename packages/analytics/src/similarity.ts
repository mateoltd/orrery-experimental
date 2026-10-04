/**
 * Answer-similarity clustering for free text.  (P11-T7)
 *
 * ## THE CLUSTERING IS COMPLETE-LINKAGE, AND SINGLE-LINKAGE IS A CORRECTION (`C-24`)
 *
 * `plans/08` §5: single-linkage at a 5-gram threshold "chains through any shared sentence of boilerplate and
 * manufactures one giant cluster presented as '9 responses are near-identical'". That is not a cosmetic problem. The
 * finding is presented to a teacher as a fact about nine students, when what the algorithm found is that nine students
 * share a sentence from the question stem. Chaining is how a similarity metric becomes an accusation with a number
 * attached.
 *
 * Complete-linkage requires EVERY member of a cluster to be similar to every other member, so boilerplate cannot join
 * two answers that have nothing in common with each other.
 *
 * ## AND THIS NEVER ACCUSES (`RN-01`)
 *
 * "The machine's job is to point a human at something, not to reach a conclusion." So the copy names the innocent
 * explanations, the size of the cluster is the only number reported, and there is no per-student verdict anywhere in
 * this module. `V-14`/`U-5` add that two innocent causes are SYSTEMATIC in this product -- a shared model answer, and
 * assistive technology such as dictation -- so both are named in the copy rather than left for the teacher to guess.
 */

import { createHash } from 'node:crypto';
import { DISTRACTOR_MIN_N } from './distractors.js';

/** The plan's shingle width. Not a parameter: 5-grams are what `plans/08` §5 specifies. */
export const SHINGLE_SIZE = 5;

/** The threshold at which two answers are considered similar enough to compare. */
export const SIMILARITY_THRESHOLD = 0.6;

/** The minimum cluster size worth reporting. Two near-identical answers are coincidence. */
export const MIN_CLUSTER_SIZE = 3;

/**
 * STOPWORDS, removed during normalisation.
 *
 * A small, explicit list. A comprehensive stopword set is the wrong tool here: the point of a shingle is that shared
 * BOILERPLATE should NOT drive similarity, so removing more function words removes more chaining -- but a large list
 * would also remove the content words of a short answer, and then every short answer looks alike for a different
 * reason. Only words that carry no topical information are removed.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Articles, pronouns, auxiliaries, prepositions and conjunctions. Deliberately a short explicit list rather than a
  // comprehensive one: the point of a shingle is that shared BOILERPLATE should not drive similarity, but a large list
  // would also strip the content words of a short answer and make every short answer alike for a different reason.
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'so',
  'that',
  'this',
  'these',
  'those',
  'there',
  'here',
  'it',
  'its',
  'as',
  'at',
  'by',
  'in',
  'on',
  'to',
  'of',
  'in',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'doing',
  'has',
  'have',
  'had',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'our',
  'their',
  'not',
  'no',
  'can',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'could',
  'one',
  'all',
  'any',
  'some',
  'each',
  'every',
  'both',
  'other',
  'another',
  'such',
  'own',
  'same',
  'into',
  'from',
  'up',
  'down',
  'out',
  'about',
  'over',
  'under',
  'again',
  'further',
  'more',
  'most',
  'much',
  'many',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'get',
  'got',
  'make',
  'made',
  'also',
  'just',
  'only',
  'very',
  'too',
  'so',
  'still',
  'even',
  'because',
  'while',
  'during',
  'after',
  'before',
]);

/**
 * NORMALISE, per `plans/08` §5: lowercase, strip punctuation, collapse whitespace, remove stopwords, normalise
 * unicode, collapse character runs.
 *
 * **CHARACTER RUNS ARE COLLAPSED, and that is the part that matters for dictation.** Speech-to-text produces "the
 * resssponse" and "the response" for the same word, and without run-collapsing those two are different 5-grams and
 * similarity drops for exactly the students `U-5` is about.
 */
export const normalise = (text: string): string => {
  // Unicode NFKD then strip combining marks, so "café" and "cafe" are the same token.
  // Combining marks are written as the ESCAPE RANGE, never as literal combining characters. A literal range is
  // invisible in every diff and every editor and can be mangled by a copy-paste -- the same class of defect PF-4
  // records for raw NUL bytes, and here it would silently stop stripping accents.
  const decomposed = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lowercased = decomposed.toLowerCase();

  // Punctuation to a space, not to nothing: "end,start" and "end start" must be the same string.
  const unpunctuated = lowercased.replace(/[^\p{L}\p{N}\s]/gu, ' ');

  // Collapse character runs of 2+ to one. Ordered BEFORE stopword removal so "tthe" becomes "the" and is then
  // removed, rather than surviving as a token that only dictation produces.
  const runCollapsed = unpunctuated.replace(/(.)\1{2,}/gu, '$1');

  return runCollapsed
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .join(' ')
    .trim();
};

/**
 * SHINGLED 5-GAMS OF WORDS, not of characters.
 *
 * Character 5-grams would match two answers that share a long word fragment regardless of topic, which is the same
 * chaining problem in a different coordinate system.
 */
export const shingle = (normalisedText: string, size = SHINGLE_SIZE): ReadonlySet<string> => {
  const words = normalisedText.split(' ').filter((word) => word.length > 0);
  if (words.length === 0) return new Set();
  if (words.length < size) {
    // A shorter answer than the shingle width is its own single shingle. Returning an EMPTY set would make every short
    // answer score 0 against every other, which would hide exactly the model answers the copy is meant to name.
    return new Set([words.join(' ')]);
  }
  const shingles = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) {
    shingles.add(words.slice(i, i + size).join(' '));
  }
  return shingles;
};

/** Jaccard: |A ∩ B| / |A ∪ B|. */
export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/** The fingerprint: `sha256(normalised)`. Used to spot EXACT duplicates, which are a different and clearer finding. */
export const fingerprint = (text: string): string =>
  createHash('sha256').update(normalise(text), 'utf8').digest('hex');

export interface SimilarityEntry {
  readonly responseId: string;
  readonly text: string;
}

/** One cluster, with the evidence a teacher needs to look at it. */
export interface SimilarityCluster {
  readonly id: string;
  /** Response ids in the cluster. NOT student names -- `RN-01`: no student is an accused party. */
  readonly responseIds: readonly string[];
  readonly size: number;
  /** The lowest within-cluster similarity, which is the honest figure: complete-linkage is bounded by its weakest pair. */
  readonly weakestPair: number;
  /** True when every member is byte-identical after normalisation, which is a clearer finding than "similar". */
  readonly isExactDuplicate: boolean;
}

export interface ClusteringInput {
  readonly entries: readonly SimilarityEntry[];
  readonly threshold?: number;
}

/**
 * CLUSTER BY COMPLETE LINKAGE.
 *
 * The algorithm is deliberately the simple one: start with every response in its own cluster, then repeatedly merge the
 * two clusters whose members are MOST similar, provided the merge keeps every cross-pair at or above the threshold.
 * That last clause is the whole difference from single-linkage and it is checked, not assumed.
 *
 * Deterministic: ties break on cluster id, so the same input always produces the same clustering. A similarity report
 * that reshuffles between two page loads is a report nobody can act on.
 */
export const clusterByCompleteLinkage = (input: ClusteringInput): readonly SimilarityCluster[] => {
  const threshold = input.threshold ?? SIMILARITY_THRESHOLD;

  const shingles = new Map<string, ReadonlySet<string>>();
  const prints = new Map<string, string>();
  for (const entry of input.entries) {
    const normalised = normalise(entry.text);
    prints.set(entry.responseId, normalised);
    shingles.set(entry.responseId, shingle(normalised));
  }

  const ids = input.entries.map((entry) => entry.responseId).sort();

  /** Minimum similarity across every cross-pair between two clusters, or `null` for an empty side. */
  const weakestAcross = (left: readonly string[], right: readonly string[]): number => {
    if (left.length === 0 || right.length === 0) return 1;
    let weakest = 1;
    for (const a of left) {
      for (const b of right) {
        const score = jaccard(shingles.get(a) ?? new Set(), shingles.get(b) ?? new Set());
        if (score < weakest) weakest = score;
      }
    }
    return weakest;
  };

  let clusters: string[][] = ids.map((id) => [id]);

  for (;;) {
    let best: { left: number; right: number; score: number } | null = null;

    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = weakestAcross(clusters[i] ?? [], clusters[j] ?? []);
        // `>= threshold` is the completeness condition: the merge is only allowed if the WEAKEST cross-pair passes.
        if (score < threshold) continue;
        // Strictly greater, so a tie keeps the earlier pair and the result does not depend on iteration order.
        if (best === null || score > best.score) best = { left: i, right: j, score };
      }
    }

    if (best === null) break;
    const left = clusters[best.left] ?? [];
    const right = clusters[best.right] ?? [];
    const merged = [...left, ...right].sort();
    clusters = clusters.filter((_, index) => index !== best.left && index !== best.right);
    clusters.push(merged);
    // Re-sorted by the merged contents, so the sequence of merges does not depend on discovery order.
    clusters.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  }

  /** The lowest similarity between two DIFFERENT members. `null` when there is no pair to measure. */
  function weakestDistinctPair(members: readonly string[]): number {
    if (members.length < 2) return 0;
    let weakest = 1;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const score = jaccard(
          shingles.get(members[i] ?? '') ?? new Set(),
          shingles.get(members[j] ?? '') ?? new Set(),
        );
        if (score < weakest) weakest = score;
      }
    }
    return weakest;
  }

  return clusters
    .filter((members) => members.length >= MIN_CLUSTER_SIZE)
    .map((members, index) => {
      const sorted = [...members].sort();
      return {
        id: `cluster-${String(index + 1)}`,
        responseIds: sorted,
        size: sorted.length,
        // The weakest pair BETWEEN DISTINCT members. The first version called `weakestAcross(sorted, sorted)`, which
        // compares every member with ITSELF and therefore always returns 1 -- a number that measures nothing and is
        // exactly the kind of field nobody notices being wrong.
        weakestPair: weakestDistinctPair(sorted),
        isExactDuplicate: new Set(sorted.map((id) => prints.get(id) ?? '')).size === 1,
      };
    });
};

/**
 * THE WORDING, and `plans/08` §5 gives it verbatim because it was chosen deliberately.
 *
 * It names the innocent explanations, states that it is not evidence of misconduct, and asks for a review rather than
 * asserting a conclusion. `V-14`/`U-5` add the two causes that are SYSTEMATIC in this product -- a shared model answer
 * and assistive technology such as dictation -- because a teacher who does not know to look for them will read a
 * dictating student's cluster as a copied one.
 */
export const clusterCopy = (cluster: SimilarityCluster): { headline: string; body: string } => ({
  headline: `${String(cluster.size)} responses are near-identical.`,
  body:
    'This often has an innocent explanation — a shared model answer, a group assignment, a lecture everyone copied ' +
    'from, or a student using dictation or other assistive technology, which produces very similar text for very ' +
    'different thinking. It is not evidence of misconduct. Review the work and decide whether anything needs ' +
    'following up.',
});

/** A cluster below this size is coincidence, and `plans/08` reports nothing about it. */
export const CLUSTER_MIN_N = MIN_CLUSTER_SIZE;

/** Similarity is a per-response statistic, so it shares the distractor floor rather than inventing one. */
export const SIMILARITY_SUPPRESSION_FLOOR = DISTRACTOR_MIN_N;
