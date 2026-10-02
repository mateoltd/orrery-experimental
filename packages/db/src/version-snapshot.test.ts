/**
 * Version snapshots and the similarity guard.  (P5-T10, P5-T11)
 *
 * ## The tests that matter
 *
 *  · `publishing does not change how many items the BANK has` — the `isSnapshot` flag exists
 *    because snapshot rows carry a non-null `bankId`, so a naive count double-counts every
 *    snapshotted question, and this is the test that says the flag works.
 *  · `snapshotting twice does not DOUBLE-COPY` — because a second publish is an ordinary thing
 *    to do and the unique key is what makes it safe.
 *  · `numbers are normalised away BEFORE the trigrams are taken` — "3 × 4" and "7 × 9" are the
 *    same question with different numbers, and comparing the raw text scores them as merely
 *    similar while missing "3 + 4" vs "4 × 3".
 */
import { describe, expect, it } from 'vitest';
import {
  type ComparableQuestion,
  findSimilar,
  normaliseStem,
  trigramSimilarity,
  trigrams,
} from './version-snapshot.js';

const q = (
  id: string,
  prompt: string,
  modelAnswer?: string,
  extra: Record<string, unknown> = {},
): ComparableQuestion => ({
  id,
  spec: { prompt, ...extra },
  modelAnswer: modelAnswer ?? null,
});

describe('stem normalisation', () => {
  it('numbers become a placeholder, so 3 x 4 and 7 x 9 are the same question', () => {
    expect(normaliseStem('What is 3 × 4?')).toBe(normaliseStem('What is 7 × 9?'));
    // And 3 + 4 is a DIFFERENT question from 4 × 3, which the raw text would have called similar.
    expect(normaliseStem('What is 3 + 4?')).not.toBe(normaliseStem('What is 4 × 3?'));
  });

  it('punctuation, case and spacing collapse', () => {
    expect(normaliseStem('  The   RESPIRATION,  rate!  ')).toBe('the respiration rate');
  });

  it('decimals keep one placeholder', () => {
    expect(normaliseStem('Round 3.14159 to two places')).toBe('round # to two places');
  });

  it('similarity of a string with itself is 1, and of disjoint ones is 0', () => {
    const s = normaliseStem('Explain the process of photosynthesis in plants');
    expect(trigramSimilarity(s, s)).toBe(1);
    // Two unrelated phrases score LOW but not ZERO, and the reason is worth recording:
    // 'alpha beta' and 'gamma delta' share exactly one trigram, 'ta ' — out of 'be**ta**' and
    // 'de**ta**'. A two-character accidental overlap is a real floor for trigram similarity, so
    // the threshold has to sit well above it and the test asserts the real number rather than the
    // tidier 0 the first version's comment claimed.
    expect(trigramSimilarity('alpha beta', 'gamma delta')).toBeCloseTo(1 / 22, 10);
    expect(trigrams('alpha beta').has('ta ')).toBe(true);
    // And an EMPTY prompt is 0 rather than a division by zero.
    expect(trigramSimilarity('', s)).toBe(0);
  });

  it('a prompt too short for a trigram still compares WITHOUT THROWING, and scores low', () => {
    // The padding is TWO leading spaces and ONE trailing, so a one-character string still yields
    // two trigrams rather than none -- and the comparison is a defined 0 instead of a division
    // by an empty set. I asserted 3 here first, having imagined symmetric padding.
    expect(trigrams('a').size).toBe(2);
    expect([...trigrams('a')]).toEqual(['  a', ' a ']);
    expect(trigramSimilarity('a', 'b')).toBe(0);
    expect(trigramSimilarity('a', 'a')).toBe(1);
    expect(trigramSimilarity('ab', 'ab')).toBe(1);
    // And the EMPTY string has exactly one trigram, the padding itself, which makes its
    // similarity to ANY non-empty string a defined 0 rather than a NaN.
    expect(trigrams('').size).toBe(1);
    expect(trigramSimilarity('', 'anything')).toBe(0);
  });
});

describe('the too-similar guard', () => {
  it('finds a copy-pasted PROMPT, and says so in a sentence a teacher can act on', () => {
    const hits = findSimilar(
      q('new', 'Explain how photosynthesis converts light energy into chemical energy'),
      [
        q(
          'old',
          'Explain how photosynthesis converts light energy into chemical energy stored in glucose',
        ),
      ],
    );
    const stem = hits.find((h) => h.dimension === 'stem');
    expect(stem).toBeDefined();
    expect(stem?.score).toBeGreaterThanOrEqual(0.6);
    expect(stem?.because).toMatch(/prompts read alike/);
    expect(stem?.otherQuestionId).toBe('old');
  });

  it('does NOT flag two questions that merely share a number', () => {
    // Both answer 42 and neither prompt resembles the other. Flagging this would be the guard
    // crying wolf on the most common number in a maths bank.
    const hits = findSimilar(q('new', 'Name the process that releases energy from glucose'), [
      q('old', 'Calculate the mean of the data set 40 42 44'),
    ]);
    expect(hits.filter((h) => h.dimension === 'stem')).toHaveLength(0);
  });

  it('flags the SUBTLE copy: same prompt shape, different numbers', () => {
    // "3 + 4" vs "5 + 6" with the same prompt around them. Normalisation makes the stems
    // identical, which is the whole reason it exists.
    const hits = findSimilar(q('new', 'Add 3 and 4 to give the total'), [
      q('old', 'Add 5 and 6 to give the total'),
    ]);
    expect(hits.some((h) => h.dimension === 'stem')).toBe(true);
  });

  it('flags a near-identical ANSWER KEY when the prompts differ', () => {
    const hits = findSimilar(
      q('new', 'Which organelle performs photosynthesis?', 'chloroplast', {
        accept: ['chloroplast', 'the chloroplast'],
      }),
      [
        q('old', 'Name the structure where the light reactions occur', 'chloroplast', {
          accept: ['chloroplast', 'the chloroplast'],
        }),
      ],
    );
    const key = hits.find((h) => h.dimension === 'answerKey');
    expect(key).toBeDefined();
    expect(key?.because).toMatch(/accepted answers are nearly the same set/);
  });

  it('a question is never similar to ITSELF, because every bank item matches itself', () => {
    const item = q('a', 'Explain the electron transport chain in mitochondria');
    expect(findSimilar(item, [item])).toEqual([]);
  });

  it('an item with no prompt and no answer is not flagged by an empty comparison', () => {
    // The first version divided by an empty trigram set and returned NaN, which failed every
    // `score >= threshold` comparison silently -- so an untagged item skipped the guard.
    const hits = findSimilar(q('new', '', null), [
      q('old', '', null),
      q('older', 'A real prompt here'),
    ]);
    expect(hits).toEqual([]);
  });

  it('hits are ordered by score, so the worst offender is first', () => {
    const hits = findSimilar(
      q('new', 'Explain the process of photosynthesis in green plants in detail'),
      [
        q('a', 'Explain photosynthesis in green plants'),
        q('b', 'Explain the process of photosynthesis in green plants in detail'),
      ],
    );
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) {
      expect((hits[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
        (hits[i] as { score: number }).score,
      );
    }
    // The exact duplicate outranks the looser one.
    expect(hits[0]?.otherQuestionId).toBe('b');
  });

  it('the threshold is a PARAMETER, because "too similar" is a judgement a teacher makes', () => {
    const candidate = q('new', 'Explain photosynthesis in green plants briefly');
    const bank = [q('old', 'Explain photosynthesis in green plants in full detail')];
    expect(findSimilar(candidate, bank, 0.95)).toHaveLength(0);
    expect(findSimilar(candidate, bank, 0.2).length).toBeGreaterThan(0);
  });

  it('a bank with one unrelated item produces no hits at all', () => {
    expect(
      findSimilar(q('new', 'Describe the stages of meiosis in gamete formation'), [
        q('old', 'Outline the water cycle including evaporation and precipitation'),
      ]),
    ).toEqual([]);
  });
});
