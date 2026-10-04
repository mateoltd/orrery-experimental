/**
 * Answer-similarity clustering.  (P11-T7)
 *
 * Two properties are being defended, and both come from `C-24` and `RN-01`:
 *
 *  · **complete-linkage, not single** -- single-linkage chains through any shared boilerplate and manufactures one
 *    giant cluster that a teacher reads as a fact about nine students;
 *  · **the copy never accuses** -- `RN-01`: the machine points a human at something, it does not reach a conclusion.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  clusterByCompleteLinkage,
  clusterCopy,
  fingerprint,
  jaccard,
  MIN_CLUSTER_SIZE,
  normalise,
  shingle,
} from './similarity.js';

const entry = (responseId: string, text: string) => ({ responseId, text });

describe('normalisation', () => {
  it('lowercases, strips punctuation and removes stopwords', () => {
    expect(normalise('The answer, is: that it works!')).toBe('answer works');
  });

  it('turns punctuation into SPACES, so word boundaries survive', () => {
    // "end,start" and "end start" must be the same string, or a comma changes every shingle after it.
    expect(normalise('end,start')).toBe(normalise('end start'));
  });

  it('strips accents, so "café" and "cafe" are one token', () => {
    expect(normalise('café')).toBe(normalise('cafe'));
    expect(normalise('naïve')).toBe('naive');
  });

  it('COLLAPSES CHARACTER RUNS, which is what makes dictation comparable', () => {
    /**
     * `U-5`: assistive technology produces "resssponse" for "response". Without run-collapsing those are different
     * 5-grams, similarity drops for exactly the students the copy is meant to protect.
     */
    expect(normalise('the resssponse shows')).toBe(normalise('the response shows'));
  });

  it('collapses runs of THREE OR MORE, and not two', () => {
    /**
     * Three is the deliberate threshold and my first test asserted two. Collapsing a run of two would rewrite `well`
     * to `wel` and `letter` to `leter`, so it corrupts real vocabulary to fix a case dictation does not produce --
     * speech-to-text stutters to three or more, not reliably to two.
     */
    expect(normalise('the resssponse')).toBe('response');
    expect(normalise('well written letters')).toBe('well written letters');
  });

  it('collapses runs BEFORE removing stopwords, so a stuttered stopword is removed too', () => {
    // Ordered the other way, "ttt the" survives as a token only dictation produces, and then two students using
    // dictation look MORE similar than the run-collapsing was meant to make them.
    // `ttthe` collapses to `the`, which is then removed as a stopword -- so a stuttered stopword leaves nothing
    // behind. `ttt the` would collapse to `t the`, leaving a stray `t` that only dictation produces.
    expect(normalise('ttthe answer')).toBe('answer');
  });

  it('is idempotent, so normalising twice changes nothing', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }),
        (text) => normalise(normalise(text)) === normalise(text),
      ),
      { numRuns: 300 },
    );
  });
});

describe('shingles and Jaccard', () => {
  it('builds 5-grams of WORDS', () => {
    expect([...shingle('a b c d e f')]).toEqual(['a b c d e', 'b c d e f']);
  });

  it('returns the whole answer as one shingle when it is SHORTER than the shingle width', () => {
    // An empty set would make every short answer score 0 against every other, hiding exactly the model answers the
    // copy is meant to name.
    expect([...shingle('a b')]).toEqual(['a b']);
    expect(jaccard(shingle('a b'), shingle('a b'))).toBe(1);
  });

  it('scores identical text 1 and disjoint text 0', () => {
    expect(jaccard(shingle('a b c d e f'), shingle('a b c d e f'))).toBe(1);
    expect(jaccard(shingle('a b c d e f'), shingle('w x y z q'))).toBe(0);
  });

  it('returns 0 for an empty set rather than dividing by zero', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('is symmetric, which Jaccard must be', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (a, b) => {
        const left = jaccard(shingle(normalise(a)), shingle(normalise(b)));
        const right = jaccard(shingle(normalise(b)), shingle(normalise(a)));
        return Math.abs(left - right) < 1e-12;
      }),
      { numRuns: 200 },
    );
  });
});

describe('fingerprints spot EXACT duplicates, which is a clearer finding', () => {
  it('gives the same fingerprint to text that differs only in case, punctuation or a run', () => {
    expect(fingerprint('The Response!')).toBe(fingerprint('the resssponse'));
  });

  it('gives different fingerprints to different answers', () => {
    expect(fingerprint('one thing entirely')).not.toBe(fingerprint('a wholly different idea'));
  });
});

describe('COMPLETE linkage, which is the whole correction (`C-24`)', () => {
  it('clusters three identical answers together', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', 'the gradient increases as depth increases'),
        entry('r2', 'the gradient increases as depth increases'),
        entry('r3', 'the gradient increases as depth increases'),
        entry('r4', 'photosynthesis converts light energy into chemical energy stored in glucose'),
      ],
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.responseIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('does NOT chain through shared boilerplate (`C-24`)', () => {
    /**
     * Three answers that each share a sentence of boilerplate with the question stem, and have nothing in common with
     * each other. Single-linkage would chain them into one cluster of three -- presented as "3 responses are
     * near-identical", which is a claim about three students that the evidence does not support.
     */
    const boiler = 'in this question you are asked to explain the process';
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', `${boiler} and the answer concerns the rate of the reaction in solution`),
        entry('r2', `${boiler} while the second answer concerns entropy in an isolated system`),
        entry('r3', `${boiler} the third answer concerns the bond energy of the diatomic molecule`),
      ],
    });
    // Complete-linkage cannot merge any two, because the answers differ in everything after the boilerplate.
    expect(clusters).toEqual([]);
  });

  it('requires EVERY cross-pair to pass, not just one', () => {
    // A is close to B and B is close to C, but A and C share nothing.
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('a', 'alpha beta gamma delta epsilon zeta eta'),
        entry('b', 'alpha beta gamma delta epsilon zeta theta'),
        entry('c', 'iota kappa lambda mu nu xi omicron'),
      ],
      threshold: 0.5,
    });
    // Even if b could join either, a and c cannot both be in the same cluster, so nothing of size 3 forms.
    for (const cluster of clusters) expect(cluster.size).toBeLessThan(3);
  });

  it('reports the WEAKEST pair between DISTINCT members, which is the honest figure', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', 'the gradient increases as depth increases across the whole column'),
        entry('r2', 'the gradient increases as depth increases across the whole column'),
        entry(
          'r3',
          'the gradient increases as depth increases across the whole column of readings',
        ),
      ],
      threshold: 0.3,
    });
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    // The first version compared each member with ITSELF here, so this field was always 1 -- a number that measures
    // nothing, in the one field a teacher would use to judge how strong the finding is.
    expect(cluster?.weakestPair).toBeLessThan(1);
    expect(cluster?.weakestPair).toBeGreaterThan(0);
  });

  it('reports 1 for a cluster whose members are all identical', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', 'the gradient increases as depth increases across the whole column'),
        entry('r2', 'the gradient increases as depth increases across the whole column'),
        entry('r3', 'the gradient increases as depth increases across the whole column'),
      ],
    });
    expect(clusters[0]?.weakestPair).toBe(1);
  });

  it('marks a cluster of identical answers as an EXACT duplicate', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', 'exactly the same words here'),
        entry('r2', 'exactly the same words here'),
        entry('r3', 'exactly the same words here'),
      ],
    });
    expect(clusters[0]?.isExactDuplicate).toBe(true);
  });

  it('reports nothing for a cluster below the minimum size, because two is coincidence', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [entry('r1', 'the same answer'), entry('r2', 'the same answer')],
    });
    expect(clusters).toEqual([]);
    expect(MIN_CLUSTER_SIZE).toBe(3);
  });

  it('is DETERMINISTIC, so a report does not reshuffle between two page loads', () => {
    const entries = [
      entry('r1', 'shared model answer text used by everyone'),
      entry('r2', 'shared model answer text used by everyone'),
      entry('r3', 'shared model answer text used by everyone'),
      entry('r4', 'a genuinely different answer about entropy'),
    ];
    const first = JSON.stringify(clusterByCompleteLinkage({ entries }));
    // Shuffled input, same clusters: the result cannot depend on discovery order.
    const second = JSON.stringify(clusterByCompleteLinkage({ entries: [...entries].reverse() }));
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  it('never puts one response in two clusters', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('r1', 'identical text for all three of these'),
        entry('r2', 'identical text for all three of these'),
        entry('r3', 'identical text for all three of these'),
        entry('r4', 'identical text for all three of these'),
      ],
    });
    const seen = clusters.flatMap((cluster) => [...cluster.responseIds]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('carries RESPONSE IDS and never student names (`RN-01`)', () => {
    const clusters = clusterByCompleteLinkage({
      entries: [
        entry('resp-1', 'identical text for all three'),
        entry('resp-2', 'identical text for all three'),
        entry('resp-3', 'identical text for all three'),
      ],
    });
    expect(clusters[0]?.responseIds.every((id) => id.startsWith('resp-'))).toBe(true);
  });
});

describe('the copy NEVER accuses (`RN-01`, `V-14`, `U-5`)', () => {
  const cluster = {
    id: 'c1',
    responseIds: ['r1', 'r2', 'r3'],
    size: 3,
    weakestPair: 0.7,
    isExactDuplicate: false,
  };

  it('names the size and the innocent explanations', () => {
    const copy = clusterCopy(cluster);
    expect(copy.headline).toBe('3 responses are near-identical.');
    expect(copy.body).toContain('model answer');
    expect(copy.body).toContain('group assignment');
  });

  it('names ASSISTIVE TECHNOLOGY, because `U-5` makes it systematic in this product', () => {
    // A teacher who does not know to look for dictation will read a dictating student's cluster as a copied one.
    expect(clusterCopy(cluster).body).toContain('assistive technology');
  });

  it('states plainly that it is not evidence of misconduct', () => {
    expect(clusterCopy(cluster).body).toContain('not evidence of misconduct');
  });

  it('asks for a REVIEW rather than asserting a conclusion', () => {
    expect(clusterCopy(cluster).body).toContain('Review the work');
    expect(clusterCopy(cluster).body).toContain('decide whether anything needs following up');
  });

  it('never contains an accusation word, at any cluster size', () => {
    for (const size of [3, 9, 40]) {
      const text =
        `${clusterCopy({ ...cluster, size }).headline} ${clusterCopy({ ...cluster, size }).body}`.toLowerCase();
      expect(text, String(size)).not.toMatch(/cheat|plagiar|copied by|collud|fraud|dishonest/);
    }
  });
});
