/**
 * The partial-credit methods: hand-computed fixtures and properties.  (P7-T3)
 *
 * ## TWO KINDS OF TEST, AND THE PROPERTIES ARE THE ONES THAT MATTER
 *
 * The fixtures are what `plans/07` section 4 calls "the numbers that decide students' grades", and `P7-T5`
 * asks for them to be reviewed by a second person. A property test cannot tell you what a student should
 * score; only a fixture someone else checked can. So both are here.
 *
 * ## AND THE FIXTURES ARE HAND-COMPUTED IN THE COMMENTS, NOT SNAPSHOTTED FROM THE OUTPUT
 *
 * Every case states its arithmetic. A snapshot taken from the implementation records whatever the code did,
 * which is the opposite of checking it -- and this phase has already found the sig-fig rule reporting 3 for
 * `9.810` and the numeric tolerance accepting every answer, both while producing plausible output.
 */
import { describe, expect, it } from 'vitest';
import { PARTIAL_CREDIT_METHODS } from '../question/index.js';
import {
  applyMethod,
  assertMethodsMatchTheUnion,
  canGoNegative,
  METHODS,
  type Method,
  type MethodInput,
  PENALISING_METHODS,
  PUBLISHED_BUT_UNIMPLEMENTED,
  publishRefusal,
  selectAllScore,
  shareFor,
} from './methods.js';

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);

/** `M` is the full option count, which is not derivable from the two sets. */
const input = (selected: string[], key: string[], optionCount = 4): MethodInput => ({
  selected: set(...selected),
  key: set(...key),
  optionCount,
});

/**
 * Marks: the raw count times the per-option share, which is what a fixture should state.
 *
 * The `Object.is` normalisation is not decoration. `shareFor` returns 0 for an empty key, and a NEGATIVE raw
 * count times 0 is `-0` -- which `Object.is` distinguishes from `0` and which `expect(...).toBe(0)` rejects. The
 * mark is genuinely zero either way; the signed zero is an artefact of the arithmetic, and asserting on it
 * means asserting on the sign of a zero.
 */
const marks = (method: Method, i: MethodInput, maxPoints = 4): number => {
  const value = applyMethod(method, i).rawCount * shareFor(i.key, maxPoints);
  return Object.is(value, -0) ? 0 : value;
};

describe('fixtures: NC, all-or-nothing', () => {
  it('exactly the key scores full marks: 2 correct, 0 incorrect -> 2 * 2 = 4', () => {
    expect(marks('NC', input(['a', 'c'], ['a', 'c']))).toBe(4);
  });

  it('a missing option scores ZERO, not partial: 1 of 2 correct', () => {
    expect(marks('NC', input(['a'], ['a', 'c']))).toBe(0);
  });

  it('an extra option scores ZERO even with every correct one chosen', () => {
    // The distinguishing case from 1PM: the same selection as the partial case plus one distractor.
    expect(marks('NC', input(['a', 'c', 'b'], ['a', 'c']))).toBe(0);
  });

  it('selecting NOTHING scores zero, and is not an exception', () => {
    expect(marks('NC', input([], ['a', 'c']))).toBe(0);
  });
});

describe('fixtures: 1PM, the default', () => {
  it('one of two correct scores HALF: 1 * (4/2) = 2', () => {
    expect(marks('1PM', input(['a'], ['a', 'c']))).toBe(2);
  });

  it('an extra distractor ZEROES THE WHOLE RESPONSE despite one correct', () => {
    /**
     * THE CLAUSE THAT MAKES 1PM THE DEFAULT. Selecting 3 when 2 are correct pays 0, not 1. Without it,
     * select-all on a 4-option item with a 2-option key would pay 2 of 4 for no knowledge at all.
     */
    const out = applyMethod('1PM', input(['a', 'b', 'c'], ['a', 'c']));
    expect(out.rawCount).toBe(0);
    expect(out.zeroedBySize).toBe(true);
  });

  it('selecting EXACTLY the key size is not over-selection', () => {
    // `> key.size` is the test, not `>=`: two selected against a two-option key is not "too many".
    expect(applyMethod('1PM', input(['a', 'b'], ['a', 'c'])).zeroedBySize).toBe(false);
    expect(marks('1PM', input(['a', 'b'], ['a', 'c']))).toBe(2);
  });

  it('an incorrect option costs NOTHING, which is what separates it from NG', () => {
    // Same size as the key, one wrong: 1 correct -> 1 * 2 = 2. NG scores 1 - 1 = 0 for the same response.
    expect(marks('1PM', input(['a', 'b'], ['a', 'c']))).toBe(2);
    expect(marks('NG', input(['a', 'b'], ['a', 'c']))).toBe(0);
  });
});

describe('fixtures: NG, negative crediting', () => {
  it('all correct scores full: 2 - 0 = 2 -> 4 marks', () => {
    expect(marks('NG', input(['a', 'c'], ['a', 'c']))).toBe(4);
  });

  it('one correct and one wrong scores ZERO: 1 - 1 = 0', () => {
    expect(marks('NG', input(['a', 'b'], ['a', 'c']))).toBe(0);
  });

  it('two wrong and no right scores NEGATIVE: 0 - 2 = -2 -> -4 marks', () => {
    /**
     * THE RAW SCORE IS NEGATIVE BY DESIGN. `plans/07` section 3.2 is explicit that this must not be clamped in
     * the item: "clamping at zero silently converts NG into no penalty for every student who guessed".
     */
    const out = applyMethod('NG', input(['b', 'd'], ['a', 'c']));
    expect(out.rawCount).toBe(-2);
    expect(out.negative).toBe(true);
    expect(marks('NG', input(['b', 'd'], ['a', 'c']))).toBe(-4);
  });

  it('has NO size clause, so over-selecting is neither zeroed nor specially punished', () => {
    // Four selected against a two-option key: 2 correct (`a`, `c`) and 2 incorrect (`b`, `d`), so `2 - 2 = 0`.
    // I first wrote this as -2, counting the selected-but-correct options as incorrect. The implementation was
    // right and the fixture was wrong, which is the reason the fixtures are hand-computed in prose rather than
    // recorded from output: a snapshot would have stored -2 and agreed with itself forever.
    const out = applyMethod('NG', input(['a', 'b', 'c', 'd'], ['a', 'c']));
    expect(out.zeroedBySize).toBe(false);
    expect(out.correctCount).toBe(2);
    expect(out.incorrectCount).toBe(2);
    expect(out.rawCount).toBe(0);
  });
});

describe('fixtures: SU, lenient about omissions and absolute about commission', () => {
  it('a SUBSET scores proportionally: 1 of 2 correct -> 2 marks', () => {
    expect(marks('SU', input(['a'], ['a', 'c']))).toBe(2);
  });

  it('one distractor ZEROES it, even with every correct option also chosen', () => {
    // 2 correct + 1 incorrect -> not a subset -> 0. The asymmetry against the line above IS the method.
    expect(marks('SU', input(['a', 'c', 'b'], ['a', 'c']))).toBe(0);
  });

  it('omitting everything scores zero rather than counting as an empty subset that pays nothing', () => {
    expect(marks('SU', input([], ['a', 'c']))).toBe(0);
  });

  it('cannot go negative, because it has no penalty term at all', () => {
    expect(canGoNegative('SU')).toBe(false);
  });
});

describe('fixtures: RI, Ripkey', () => {
  it('zeroes an over-sized response where NG would carry a penalty', () => {
    const ri = applyMethod('RI', input(['a', 'b', 'c'], ['a', 'c']));
    expect(ri.zeroedBySize).toBe(true);
    expect(ri.rawCount).toBe(0);
    // NG has no size clause, so the same response scores `2 correct - 1 incorrect = +1`. POSITIVE, for a
    // response that selected one option too many. That is the gameability `plans/07` section 3.3 refuses at
    // publish time, and it is why the two methods differ on exactly this input.
    expect(applyMethod('NG', input(['a', 'b', 'c'], ['a', 'c'])).rawCount).toBe(1);
  });

  it('still penalises WITHIN the key size: 1 correct, 1 wrong, size 2 of 2 -> 0', () => {
    const out = applyMethod('RI', input(['a', 'b'], ['a', 'c']));
    expect(out.rawCount).toBe(0);
    expect(out.zeroedBySize).toBe(false);
  });

  it('goes negative only at legal size, which is the whole difference from NG', () => {
    // 1 correct, 1 wrong against a 3-option key: 1 - 1 = 0 at size 2 of 3.
    expect(applyMethod('RI', input(['a', 'b'], ['a', 'c', 'e'], 5)).rawCount).toBe(0);
    // 0 correct, 1 wrong against a 2-option key: 0 - 1 = -1, and the size clause does not apply.
    expect(applyMethod('RI', input(['b'], ['a', 'c'])).rawCount).toBe(-1);
  });
});

describe('fixtures: PM, plus/minus', () => {
  it('is NG with no size clause, so the two agree on every selection', () => {
    const cases: Array<[string[], string[]]> = [
      [
        ['a', 'c'],
        ['a', 'c'],
      ],
      [['a'], ['a', 'c']],
      [
        ['a', 'b'],
        ['a', 'c'],
      ],
      [
        ['b', 'd'],
        ['a', 'c'],
      ],
    ];
    for (const [sel, key] of cases) {
      expect(applyMethod('PM', input(sel, key)).rawCount).toBe(
        applyMethod('NG', input(sel, key)).rawCount,
      );
    }
  });

  it('is GAMEABLE where NG is too, and that is why both are publish-guarded', () => {
    // 5 options, 3 correct: selecting all pays 2*3 - 5 = 1 of 3, so a student who ticked everything and was
    // wrong about two options beats one who chose carefully and missed two.
    expect(selectAllScore(5, 3, 'PM')).toBe(1);
    expect(selectAllScore(5, 3, 'NG')).toBe(1);
    expect(PENALISING_METHODS).toEqual(['NG', 'PM']);
  });
});

/**
 * A DETERMINISTIC SWEEP, because a property test with random inputs is a test that fails on a Tuesday.
 *
 * Every subset of every key, for five options: 32 selections per key size and 192 cases in total, small enough
 * to enumerate exhaustively -- so a failure names a concrete selection rather than a seed -- and large enough
 * that the claims below are not resting on four hand-picked cases.
 */
const allCases = (optionCount: number): MethodInput[] => {
  const ids = Array.from({ length: optionCount }, (_, index) => String.fromCharCode(97 + index));
  const cases: MethodInput[] = [];
  for (let keySize = 0; keySize <= optionCount; keySize += 1) {
    const keys = ids.slice(0, keySize);
    for (let mask = 0; mask < 2 ** optionCount; mask += 1) {
      cases.push({
        selected: set(...ids.filter((_, index) => (mask & (1 << index)) !== 0)),
        key: set(...keys),
        optionCount,
      });
    }
  }
  return cases;
};

const CASES = allCases(5);

describe('properties over every selection of every key', () => {
  it('never awards more than the number of correct options available', () => {
    /**
     * THE BOUNDS INVARIANT, IN UNITS OF THE PER-OPTION SHARE, FOR EVERY METHOD AND EVERY INPUT.
     *
     * Stated on `rawCount` rather than marks because marks need a `maxPoints` and the invariant is about the
     * method. Stated on the RAW value rather than the clamped one because `plans/07` section 3.2 requires NG to
     * be allowed below zero.
     */
    for (const method of METHODS) {
      for (const c of CASES) {
        expect(applyMethod(method, c).rawCount).toBeLessThanOrEqual(c.key.size);
      }
    }
  });

  it('gives NC, 1PM and SU a score bounded BELOW by zero, which is why they can carry the default', () => {
    for (const method of ['NC', '1PM', 'SU'] as const) {
      for (const c of CASES) {
        expect(applyMethod(method, c).rawCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('lets ONLY the three penalising methods report a negative score', () => {
    // `canGoNegative` is asserted rather than assumed: NC, 1PM and SU have no penalty term, so a negative from
    // one of them would mean the implementation had grown a penalty by accident.
    for (const method of METHODS) {
      for (const c of CASES) {
        const out = applyMethod(method, c);
        expect(out.negative).toBe(canGoNegative(method) && out.rawCount < 0);
      }
    }
  });

  it('reports `negative` consistently with `rawCount`, so a consumer need not recompute it', () => {
    for (const method of METHODS) {
      for (const c of CASES) {
        const out = applyMethod(method, c);
        expect(out.negative).toBe(out.rawCount < 0);
      }
    }
  });

  it('counts only what was selected, so credit is never awarded for an unselected option', () => {
    for (const method of METHODS) {
      for (const c of CASES) {
        const out = applyMethod(method, c);
        expect(out.correctCount + out.incorrectCount).toBe(c.selected.size);
        expect(out.correctCount).toBeLessThanOrEqual(c.key.size);
      }
    }
  });

  it('gives the full mark to an exactly-correct response under EVERY method', () => {
    // The one property they must share, or a student who answers perfectly is marked short by a method chosen
    // to be lenient.
    for (const method of METHODS) {
      for (let keySize = 0; keySize <= 5; keySize += 1) {
        const ids = Array.from({ length: keySize }, (_, index) => String.fromCharCode(97 + index));
        const out = applyMethod(method, {
          selected: set(...ids),
          key: set(...ids),
          optionCount: 5,
        });
        expect(out.rawCount).toBe(keySize);
      }
    }
  });

  it('treats a SELECTION AS A SET, so a repeated id is not a second vote', () => {
    // Enforced by the type; asserted because the first version of this input was an ARRAY and repeated ids
    // inflated the score while nothing about the output looked wrong.
    const duplicated = { ...input(['a'], ['a', 'c']), selected: set('a', 'a') };
    expect(applyMethod('1PM', duplicated).correctCount).toBe(1);
  });

  it('never divides by zero on an empty key, whatever the method', () => {
    // `shareFor` returns 0 for an empty key, so the MARK is 0 rather than Infinity or NaN for every method.
    // The RAW count is not 0 for all of them and must not be: NG and PM select 2 and correct 0, so they score
    // `0 - 2 = -2`. An item whose key is empty is a broken item, and the score for it is the question.
    for (const method of METHODS) {
      const empty = input(['a', 'b'], [], 4);
      expect(marks(method, empty)).toBe(0);
      expect(Number.isFinite(applyMethod(method, empty).rawCount)).toBe(true);
    }
    expect(applyMethod('NG', input(['a', 'b'], [], 4)).rawCount).toBe(-2);
    expect(applyMethod('NC', input(['a', 'b'], [], 4)).rawCount).toBe(0);
    expect(applyMethod('1PM', input(['a', 'b'], [], 4)).rawCount).toBe(0);
  });
});

describe('the size clauses close the exploit they exist for', () => {
  it('zeroes an over-sized response under 1PM and RI, and never under NC, NG, SU or PM', () => {
    // NC has no credit to lose and SU is already zero because a distractor makes it not a subset. NG and PM
    // deliberately have no clause, which is why they are the two the publish guard refuses.
    const over = input(['a', 'b', 'c', 'd', 'e'], ['a', 'c']);
    for (const method of METHODS) {
      expect(applyMethod(method, over).zeroedBySize).toBe(method === '1PM' || method === 'RI');
    }
  });

  it('makes select-all worth NOTHING under 1PM whenever the key is smaller than the pool', () => {
    // `correct < optionCount` is the condition. At `correct === optionCount` selecting everything IS the key,
    // so `selected.size > key.size` is false, nothing is zeroed, and the student is right -- which the first
    // version of this loop asserted against and was corrected by.
    for (let correct = 1; correct < 5; correct += 1) {
      const ids = Array.from({ length: 5 }, (_, index) => String.fromCharCode(97 + index));
      const all = applyMethod('1PM', {
        selected: set(...ids),
        key: set(...ids.slice(0, correct)),
        optionCount: 5,
      });
      expect(all.rawCount).toBe(0);
    }
  });

  it('gives NG a positive select-all score exactly when 2C exceeds M, which is the publish rule', () => {
    for (let options = 1; options <= 8; options += 1) {
      for (let correct = 0; correct <= options; correct += 1) {
        expect(selectAllScore(options, correct, 'NG')).toBe(2 * correct - options);
        expect(publishRefusal(options, correct, 'NG') === null).toBe(2 * correct - options <= 0);
      }
    }
  });

  it('refuses a gameable item with a message naming the number and a way out', () => {
    // A refusal a teacher cannot act on gets worked around, and the workaround is a method that pays for
    // guessing -- which is the thing the refusal exists to prevent.
    const message = publishRefusal(5, 3, 'NG');
    expect(message).not.toBeNull();
    expect(message).toContain('1PM');
    expect(message).toContain('5');
    expect(message).toContain('3');
  });

  it('never refuses a method with no penalty term, however lopsided the item', () => {
    for (const method of ['NC', '1PM', 'SU', 'RI'] as const) {
      expect(selectAllScore(5, 5, method)).toBe(0);
      expect(publishRefusal(5, 5, method)).toBeNull();
    }
  });

  it('refuses PM exactly where it refuses NG, since they score identically', () => {
    for (let options = 1; options <= 8; options += 1) {
      for (let correct = 0; correct <= options; correct += 1) {
        expect(publishRefusal(options, correct, 'PM') === null).toBe(
          publishRefusal(options, correct, 'NG') === null,
        );
      }
    }
  });
});

describe('the registry and the question union agree', () => {
  it('implements every method the question union declares', () => {
    expect(() => {
      assertMethodsMatchTheUnion(PARTIAL_CREDIT_METHODS);
    }).not.toThrow();
  });

  it('fails loudly when the union names a method with no implementation', () => {
    expect(() => {
      assertMethodsMatchTheUnion([...PARTIAL_CREDIT_METHODS, 'PROP']);
    }).toThrow(/PROP/u);
  });

  it('fails loudly when an implemented method is missing from the union', () => {
    expect(() => {
      assertMethodsMatchTheUnion(['NC', '1PM']);
    }).toThrow(/implemented/u);
  });

  it('lists PROP as published-but-unimplemented rather than dropping it silently', () => {
    /**
     * `plans/07` section 3's table has seven rows and `P7-T3`'s task line names five. With the `1PM` default
     * added by the review that is six, which is what the union carries. PROP is in neither, and naming it here
     * means the discrepancy is a decision rather than an omission -- so if anyone adds it to the table, the
     * registry check above is what forces the conversation.
     */
    expect(PUBLISHED_BUT_UNIMPLEMENTED).toEqual(['PROP']);
    expect(METHODS).not.toContain('PROP');
  });

  it('applies every method through one dispatch, so an unimplemented method cannot be selected', () => {
    // `applyMethod` indexes a `Record` keyed by `Method`, so a method added to `METHODS` without a handler is a
    // COMPILE error rather than an `undefined` call at grading time.
    for (const method of METHODS) {
      expect(typeof applyMethod(method, input(['a'], ['a']))).toBe('object');
    }
  });
});
