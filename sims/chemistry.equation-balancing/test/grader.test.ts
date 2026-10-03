/**
 * The grader, in bare Node.  (P6-T11, gold sim 12)
 *
 * The cases that matter are about WHAT COUNTS AS THE SAME ANSWER, because the student writes a sentence
 * and a string comparison would mark most correct answers wrong.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { describeEquation, isBalanced, parseSide, signature } from '../src/model.js';

const grade = (answer: unknown) => sim.grader.grade(null, { readonly: true }, answer);

describe('chemistry.equation-balancing', () => {
  // THE BUG THIS SIMULATION FOUND.
  //
  // `2H2O` is the most ordinary term in chemistry, and the parser read only the FIRST element match, so
  // it scored as four hydrogens and dropped the oxygen. Nothing balanced, ever, and the conformance cell
  // reported `expect.grade was 4, the grader awarded 0` against an answer that is correct.
  it('reads EVERY element in a term, not only the first', () => {
    expect(parseSide('2H2O')).toEqual([
      { element: 'H', count: 4 },
      { element: 'O', count: 2 },
    ]);
    expect(parseSide('H2O')).toEqual([
      { element: 'H', count: 2 },
      { element: 'O', count: 1 },
    ]);
  });

  it('adds repeated terms of one element rather than replacing them', () => {
    expect(parseSide('H2 + H')).toEqual([{ element: 'H', count: 3 }]);
  });

  it('treats an omitted coefficient as one', () => {
    expect(parseSide('H2 + O2')).toEqual([
      { element: 'H', count: 2 },
      { element: 'O', count: 2 },
    ]);
  });

  it('ignores a physical-state suffix', () => {
    expect(parseSide('2H2O(l)')).toEqual(parseSide('2H2O'));
  });

  // WHAT COUNTS AS THE SAME ANSWER.
  //
  // A grader that compares strings accepts exactly one spelling, so it marks most correct answers wrong
  // and teaches a student that the question is about matching a string rather than balancing an equation.
  it('accepts either direction, either arrow, and terms in either order', () => {
    for (const written of [
      '2H2 + O2 -> 2H2O',
      'O2 + 2H2 = 2H2O',
      '2O2 + 4H2 => 4H2O',
      '4H2+2O2->4H2O',
      '2 H2 + O2 → 2 H2O',
    ]) {
      expect(grade(written)).toMatchObject({ points: 4, code: 'CORRECT' });
    }
  });

  // A NON-REDUCED EQUATION IS ACCEPTED, AND THAT IS A DECISION.
  //
  // `2H2 + O2 -> H2O` has hydrogen:oxygen of 4:2 on the left and 2:1 on the right -- the same ratio, so
  // it is balanced by the definition this simulation uses. A textbook marks it down for not being the
  // simplest whole-number form, and a teacher may reasonably disagree with me here. The alternative --
  // rejecting it -- means asking for one particular reduction, which is a different question from
  // "balance this", and it is the reason scaling cancels at all. Recorded rather than hidden.
  it('accepts a NON-REDUCED balanced equation, because the ratio is what balancing means', () => {
    expect(grade('2H2 + O2 -> H2O')).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // MULTIPLYING AN EQUATION IS NOT DIFFERENT CHEMISTRY.
  //
  // Otherwise the question is really asking for one particular whole-number reduction, which is not what
  // balancing means.
  it('treats a SCALED equation as the same answer', () => {
    expect(grade('2H2 + O2 -> 2H2O').points).toBe(4);
    expect(grade('4H2 + 2O2 -> 4H2O').points).toBe(4);
    expect(grade('100H2 + 50O2 -> 100H2O').points).toBe(4);
  });

  it('rejects an equation that is NOT balanced, in either direction', () => {
    // Each of these has the right ELEMENTS on both sides and the wrong PROPORTION, which is the only way
    // to be unbalanced once the parser is right.
    for (const wrong of [
      'H2 + O2 -> H2O',
      'H2 + O2 -> 2H2O',
      '2H2 + 2O2 -> 2H2O',
      '4H2 + O2 -> 2H2O',
    ]) {
      expect(grade(wrong)).toMatchObject({ points: 0, code: 'WRONG' });
    }
  });

  it('is not fooled by the same elements in the wrong proportion', () => {
    // Same elements both sides, different ratio -- which is exactly what "balanced" excludes.
    expect(isBalanced('2H2 + O2', 'H2O + O2')).toBe(false);
    expect(signature('2H2 + O2')).not.toBe(signature('H2O + O2'));
  });

  it('says what is missing when there is no arrow', () => {
    const result = grade('2H2 + O2') as { code: string; feedback: string };
    expect(result.code).toBe('NO_ARROW');
    expect(result.feedback).toContain('->');
  });

  it('reports an unreadable term rather than silently marking it wrong', () => {
    const result = grade('2H2 + potato -> 2H2O') as { code: string };
    expect(result.code).toBe('UNPARSABLE');
  });

  it('treats an empty box as no answer, not as an empty equation that happens to balance', () => {
    // Two empty sides would have matching signatures and balanced for free.
    for (const blank of ['', '   ', null, undefined, Number.NaN]) {
      expect(grade(blank)).toMatchObject({ points: 0 });
    }
    expect(isBalanced('', '')).toBe(false);
  });

  it('never puts a balanced equation in the text alternative', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toContain('2H2');
    expect(text).not.toContain('->');
    expect(text.length).toBeGreaterThan(20);
  });

  it('declares NO parameters, because a parameter that can only be zero is a lie', () => {
    // The first version declared `context` as a number with `min: 0, max: 0` to carry a sentence.
    expect(Object.keys(sim.grader.params)).toHaveLength(0);
    expect(sim.grader.controls.params).toBe(false);
  });

  it('names the question without answering it', () => {
    expect(describeEquation()).toContain('H2');
    expect(describeEquation()).toContain('balanced');
  });
});
