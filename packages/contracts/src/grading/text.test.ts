/**
 * Short-text matching and ordering adjacency.  (P7-T4)
 *
 * ## THE DIFF IS ASSERTED, NOT JUST THE VERDICT
 *
 * `plans/07` section 3.4 requires the rationale to show a token diff, because "a teacher must never be asked
 * to trust an opaque score". A test that only checked `correct` would pass on a matcher returning `true` for
 * unknown reasons, and the opacity is the defect. So most cases here assert what was COMPARED.
 */
import { describe, expect, it } from 'vitest';
import {
  diffTokens,
  exactMatch,
  fuzzyMatch,
  matchShortText,
  misorderedPairs,
  normaliseWhitespace,
  numericTextMatch,
  orderingCredit,
  regexSetMatch,
  STOPWORDS,
  stem,
  tokenise,
} from './text.js';

describe('tokenising', () => {
  it('drops stopwords, so they cannot carry the overlap', () => {
    // Otherwise "the mitochondria is the powerhouse" shares three tokens with any sentence containing "the".
    // `tokenise` RETURNS A LIST, duplicates and all, and `diffTokens` is what reduces it to a set. Asserting a
    // deduped array here asserted a dedupe that does not exist at this layer; the count of shared tokens is
    // unaffected because the overlap divides by a `Set`'s size.
    expect(tokenise('the cell is the powerhouse of the cell')).toEqual([
      'cell',
      'powerhouse',
      'cell',
    ]);
    expect(STOPWORDS.has('the')).toBe(true);
  });

  it('strips a suffix so an inflection still matches', () => {
    expect(tokenise('chloroplasts')).toEqual(['chloroplast']);
    // `organises` loses only the plural `s`, because the suffix list is guarded to four characters or more
    // (plus `s`) so that short words survive. I first expected a Porter-style `organis`.
    expect(stem('organises')).toBe('organise');
  });

  it('leaves a short word alone rather than over-stemming it', () => {
    // Stripping `s` from `gas` gives `ga`, and `bed` minus `ed` gives `b`. Two-letter stems collide, so the
    // minimum length guard is load-bearing rather than cosmetic.
    expect(stem('gas')).toBe('gas');
    expect(stem('bed')).toBe('bed');
  });

  it('strips the LONGEST suffix, so `ational` goes before `al`', () => {
    // `relational` -> `rel`, not `relat`, because `ational` is tried before the shorter candidates.
    expect(stem('relational')).toBe('rel');
  });

  it('leaves a word with no listed suffix ALONE, which is most words', () => {
    // `powerhouse` is the case that matters: it ends in `e`, and nothing in the list matches it. A stemmer
    // that guessed would turn it into something that does not appear in any key or response, and the token
    // would then never match anything at all.
    expect(stem('powerhouse')).toBe('powerhouse');
    expect(stem('mitochondria')).toBe('mitochondria');
  });

  it('splits on punctuation and digits alike', () => {
    expect(tokenise('H2O, and CO2!')).toEqual(['h2o', 'co2']);
  });
});

describe('the diff, which is what a teacher reads', () => {
  it('names what matched, what was missing and what was extra', () => {
    const diff = diffTokens(tokenise('mitochondria powerhouse'), tokenise('mitochondria membrane'));
    expect(diff.matched).toEqual(['mitochondria']);
    expect(diff.missing).toEqual(['powerhouse']);
    expect(diff.extra).toEqual(['membrane']);
    expect(diff.overlap).toBeCloseTo(0.5);
  });

  it('reports an EMPTY key as full overlap rather than NaN', () => {
    // `0 / 0` is NaN, and `NaN >= threshold` is FALSE, so an empty key would match nothing -- the opposite of
    // the intent, and invisible to any test that only used non-empty keys.
    expect(diffTokens([], ['anything']).overlap).toBe(1);
    expect(Number.isNaN(diffTokens([], []).overlap)).toBe(false);
  });
});

describe('EXACT', () => {
  it('ignores surrounding whitespace and case by default', () => {
    expect(exactMatch('Paris', '  paris ')).toBe(true);
  });

  it('respects caseSensitive when the author asks for it', () => {
    expect(exactMatch('Paris', 'paris', true)).toBe(false);
    expect(exactMatch('Paris', 'Paris', true)).toBe(true);
  });
});

describe('NORMALISED', () => {
  it('collapses internal whitespace runs', () => {
    expect(normaliseWhitespace('  water   cycle \n')).toBe('water cycle');
  });

  it('does NOT strip punctuation or accents, because that is a different matcher', () => {
    // Silently accepting `H-O` against `H2O` would be a chemistry grader wearing a whitespace matcher's name.
    expect(matchShortText('H2O', 'H-O', { matcher: 'NORMALISED' }).correct).toBe(false);
  });
});

describe('REGEX_SET', () => {
  it('passes when any author pattern matches', () => {
    expect(regexSetMatch(['^yes$', '^y$'], 'yes').correct).toBe(true);
    expect(regexSetMatch(['^yes$', '^y$'], 'no').correct).toBe(false);
  });

  it('treats an INVALID pattern as matching nothing, rather than throwing', () => {
    /**
     * A question bank's patterns are DATA and data can be malformed. `new RegExp('(')` throws, and a throw here
     * would propagate out of the grader -- the one thing section 4 forbids, because a student who triggered
     * someone else's bad pattern would have their paper not marked.
     */
    const verdict = regexSetMatch(['(unclosed'], 'anything');
    expect(verdict.correct).toBe(false);
    expect(verdict.invalidPatterns).toEqual(['(unclosed']);
  });

  it('still matches a VALID pattern alongside an invalid one', () => {
    const verdict = regexSetMatch(['(unclosed', '^yes$'], 'yes');
    expect(verdict.correct).toBe(true);
  });
});

describe('FUZZY', () => {
  it('matches an inflection of the key', () => {
    expect(fuzzyMatch('chloroplast', 'the chloroplasts').correct).toBe(true);
  });

  it('refuses below the threshold and names what was missing', () => {
    const verdict = fuzzyMatch('mitochondria powerhouse', 'mitochondria is nice');
    expect(verdict.correct).toBe(false);
    expect(verdict.diff.missing).toContain('powerhouse');
  });

  it('does NOT let a longer response raise the score', () => {
    /**
     * Dividing by the larger set would make a student who wrote a paragraph outscore one who wrote the answer.
     * Overlap is "how much of the ANSWER did they produce", so the key is always the denominator.
     */
    const terse = fuzzyMatch('mitochondria powerhouse', 'mitochondria powerhouse');
    const verbose = fuzzyMatch(
      'mitochondria powerhouse',
      'mitochondria powerhouse and also the membrane and the nucleus and ribosomes',
    );
    expect(verbose.overlap).toBe(terse.overlap);
  });

  it('defaults the threshold to something other than zero', () => {
    /**
     * A zero threshold means "any one shared token passes". On a TWO-word key that admits a response
     * containing one of them, which is the coin flip the default exists to prevent.
     *
     * A ONE-word key is a special case and is deliberately not this test: a key of `alpha` against a response
     * containing `alpha` has full overlap whatever the threshold, and that is correct -- the student did
     * produce the answer. I first wrote this case with a one-word key and asserted `false`, which would have
     * required the matcher to punish a student for answering correctly.
     */
    expect(fuzzyMatch('alpha beta', 'alpha gamma delta').correct).toBe(false);
    expect(fuzzyMatch('alpha beta', 'alpha beta').correct).toBe(true);
  });
});

describe('NUMERIC_TOLERANCE on numbers in text', () => {
  it('matches a quantity written with a different spelling of its unit', () => {
    expect(numericTextMatch('2.5 m per s', '2.5 m/s', { absolute: 0.01 }).correct).toBe(true);
  });

  it('CANNOT DISTINGUISH A UNIT EXPONENT FROM A QUANTITY, and says so', () => {
    /**
     * A KNOWN LIMITATION, ASSERTED SO IT CANNOT BE DISCOVERED BY A STUDENT INSTEAD.
     *
     * The number extractor is a regex over `-?\d+(\.\d+)?`, so the `2` in `m/s^2` is read as a quantity the
     * student must reproduce. A key of `2.5 m/s^2` therefore demands BOTH 2.5 and 2, and `2.5 m/s` supplies
     * only the first, so the matcher refuses a response whose number is right and whose unit is abbreviated.
     *
     * That is defensible as a strict reading and wrong as a convenience, and which one an author wants depends
     * on the question. The honest fix is not a cleverer regex -- it is that `numericTextMatch` is only the right
     * matcher when the author has checked their key for unit exponents, so the limitation is stated here where
     * the next author will read it rather than discovered on a live paper.
     */
    expect(numericTextMatch('2.5 m/s^2', '2.5 m/s', { absolute: 0.01 }).correct).toBe(false);
    expect(numericTextMatch('2.5 m/s^2', '2.5 m/s^2', { absolute: 0.01 }).correct).toBe(true);
  });

  it('is needed because FUZZY CANNOT DISTINGUISH THESE TWO STRINGS', () => {
    /**
     * THE FINDING, AND IT IS NOT THE ONE I EXPECTED.
     *
     * I wrote this test asserting `fuzzyMatch('2.5 m/s^2', '2.5 m/s').correct === false`, on the assumption
     * that the unit strings would tokenise differently. They do not: the tokeniser splits on every
     * non-alphanumeric character, so `2.5` becomes `2` and `5` and `m/s^2` becomes `m`, `s`, `2` — and
     * `diffTokens` reduces both sides to a SET, in which the duplicate `2` has collapsed. The two strings
     * produce the identical token set `{2, 5, m, s}` and a perfect overlap.
     *
     * So FUZZY accepts a response that omits a square. That is not a bug to be patched in `fuzzyMatch` — it is
     * what a token-overlap matcher IS — and it is the reason this matcher exists as a separate one. The number
     * is the assertion; the words around it are decoration to a fuzzy comparison.
     */
    expect(fuzzyMatch('2.5 m/s^2', '2.5 m/s').correct).toBe(true);
    expect(fuzzyMatch('2.5 m/s^2', '2.5 m/s').diff.overlap).toBe(1);
  });

  it('requires EVERY key number to be matched, so "2 or 3" fails a key of 2.5', () => {
    expect(numericTextMatch('2.5', '2 or 3', { absolute: 0.01 }).correct).toBe(false);
    expect(numericTextMatch('2.5', '2.5', { absolute: 0.01 }).correct).toBe(true);
  });

  it('refuses a key with no numbers rather than vacuously passing it', () => {
    // `every` on an empty array is true, so without this the matcher would mark ANY response correct.
    expect(numericTextMatch('no digits here', 'anything at all', { absolute: 1 }).correct).toBe(
      false,
    );
  });
});

describe('an unknown matcher', () => {
  it('matches NOTHING and names itself, rather than throwing or defaulting to correct', () => {
    const verdict = matchShortText('x', 'x', { matcher: 'SEMANTIC' });
    expect(verdict.correct).toBe(false);
    expect(verdict.matcher).toBe('SEMANTIC');
  });
});

describe('ORDERING: credit as the fraction of correctly-ordered adjacent pairs', () => {
  it('gives full credit for a perfect order', () => {
    expect(orderingCredit(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('gives HALF for one correct pair out of two', () => {
    // ['b','a','c'] has pairs (b,a) wrong and (a,c) right, so 1 of 2.
    expect(orderingCredit(['a', 'b', 'c'], ['b', 'a', 'c'])).toBeCloseTo(0.5);
  });

  it('gives most of the credit to a student with one transition wrong', () => {
    // The pedagogical claim in section 3.4: 3 of 4 in correct relative order earns most of the credit.
    // Positional credit would give the same 1 of 4 as a student who understood nothing.
    const key = ['a', 'b', 'c', 'd', 'e'];
    expect(orderingCredit(key, ['a', 'b', 'c', 'e', 'd'])).toBeCloseTo(0.75);
  });

  it('does NOT treat a repeated item as a mis-ordering', () => {
    // A pair (a,a) is not a transition the student got wrong, so it counts as correct. Treating it as an error
    // meant repeating one item lost the mark on an otherwise perfect list.
    expect(orderingCredit(['a', 'b'], ['a', 'a'])).toBe(1);
  });

  it('gives full credit to a response of ONE item, and NOTHING to a response of none', () => {
    // `0 / 0` is NaN, and a one-item list is trivially in order.
    expect(orderingCredit(['a', 'b', 'c'], ['b'])).toBe(1);

    /**
     * AND THE EMPTY CASE IS NOT THE SAME CASE.
     *
     * The assertion here used to be `orderingCredit(['a','b'], []) === 1`, sharing one `length <= 1` guard
     * with the single-item case. That granted FULL MARKS to a student who submitted no ordering at all, and
     * nothing in the function said so -- it was a pure helper, so a blank was assumed to be handled upstream.
     *
     * Two cases that look adjacent are not: one item is trivially in order, and zero items is not an ordering.
     */
    expect(orderingCredit(['a', 'b'], [])).toBe(0);
    expect(orderingCredit([], [])).toBe(0);
  });

  it('ignores pairs containing an item the key does not have, rather than counting them wrong', () => {
    // Counting them wrong would let a student lose marks for an option the platform introduced.
    expect(orderingCredit(['a', 'b', 'c'], ['a', 'zzz'])).toBe(1);
  });

  it('names the pairs that were wrong, so a rationale can quote them', () => {
    expect(misorderedPairs(['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual(['b before a']);
    expect(misorderedPairs(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });
});

describe('the dispatch reaches every matcher', () => {
  /**
   * `matchShortText` is what the grader calls, and most of these tests exercise the named functions directly.
   * So the switch arms went uncovered -- and an uncovered arm is a matcher that would return "unknown" for a
   * question whose matcher IS supported, which is a wrong mark rather than a missing feature.
   */
  it('dispatches EXACT, NORMALISED, REGEX_SET, FUZZY and NUMERIC_TOLERANCE', () => {
    expect(matchShortText('Paris', 'paris', { matcher: 'EXACT' }).correct).toBe(true);
    expect(matchShortText('water  cycle', 'water cycle', { matcher: 'NORMALISED' }).correct).toBe(
      true,
    );
    expect(matchShortText('x', 'yes', { matcher: 'REGEX_SET', patterns: ['^yes$'] }).correct).toBe(
      true,
    );
    expect(matchShortText('chloroplast', 'chloroplasts', { matcher: 'FUZZY' }).correct).toBe(true);
    expect(
      matchShortText('2.5 m per s', '2.5 m/s', {
        matcher: 'NUMERIC_TOLERANCE',
        numericTolerance: { absolute: 0.01 },
      }).correct,
    ).toBe(true);
  });

  it('passes the author options through, rather than ignoring them at the dispatch', () => {
    expect(
      matchShortText('Paris', 'paris', { matcher: 'EXACT', caseSensitive: true }).correct,
    ).toBe(false);
    expect(
      matchShortText('mitochondria powerhouse', 'mitochondria is nice', {
        matcher: 'FUZZY',
        tokenOverlap: 0.2,
      }).correct,
    ).toBe(true);
  });

  it('treats a REGEX_SET with NO patterns as matching nothing', () => {
    expect(matchShortText('x', 'x', { matcher: 'REGEX_SET' }).correct).toBe(false);
  });
});

describe('defensive guards, which are only reachable through unusual input', () => {
  it('reads a NUMERIC_TOLERANCE with NEITHER tolerance field, treating both as zero', () => {
    // `absolute ?? 0` with nothing set means an exact numeric match, which is the correct reading of "no
    // tolerance declared" and the opposite of treating the absence as unlimited.
    expect(numericTextMatch('2.5', '2.5', {}).correct).toBe(true);
    expect(numericTextMatch('2.5', '2.51', {}).correct).toBe(false);
  });

  it('dispatches NUMERIC_TOLERANCE with no tolerance object at all', () => {
    expect(matchShortText('5', '5', { matcher: 'NUMERIC_TOLERANCE' }).correct).toBe(true);
  });

  it('ignores a SPARSE response array rather than reading undefined', () => {
    // `response` is typed `readonly string[]`, which permits holes. `left === undefined` is therefore reachable
    // from TypeScript-valid input, not only from a cast.
    const sparse = new Array<string>(4) as string[];
    sparse[0] = 'a';
    sparse[2] = 'b';
    expect(() => orderingCredit(['a', 'b', 'c'], sparse)).not.toThrow();
    expect(Number.isFinite(orderingCredit(['a', 'b', 'c'], sparse))).toBe(true);
    expect(() => misorderedPairs(['a', 'b', 'c'], sparse)).not.toThrow();
  });

  it('ignores a pair whose item is missing from the key, in BOTH loops', () => {
    // `orderingCredit` skips it so the pair is not counted; `misorderedPairs` skips it so a rationale does not
    // name an error the student could not have made.
    expect(orderingCredit(['a', 'b'], ['a', 'zzz'])).toBe(1);
    expect(misorderedPairs(['a', 'b'], ['a', 'zzz'])).toEqual([]);
  });
});
