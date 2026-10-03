/**
 * The grader, in bare Node.  (P6-T11, gold sim 6)
 *
 * The point of this simulation is the SEED: two seeds give two sequences, and the same seed always gives
 * the same one. That is the property a teacher needs to answer "what did they actually get?", and it is
 * the first gold sim to exercise the path from the host's seed policy into a simulation's own randomness.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import { describeSequence, nextTerm, paramsFromSeed, terms } from '../src/model.js';

const grade = (answer: unknown, seed: number, shown = 5) =>
  sim.grader.grade({ seed, shown }, null, answer);

describe('maths.sequence-next grading', () => {
  it('awards full marks for the next term', () => {
    const seed = 0x1234_5678;
    expect(grade(nextTerm(paramsFromSeed(seed)), seed).points).toBe(4);
  });

  it('IS REPRODUCIBLE: the same seed always gives the same answer', () => {
    const seed = 0xdead_beef;
    const first = grade(nextTerm(paramsFromSeed(seed)), seed).points;
    // A student who re-sits must be given the same exercise, or "what did they actually get?" has no
    // answer.
    expect(grade(nextTerm(paramsFromSeed(seed)), seed).points).toBe(first);
    expect(grade(999, seed).points).toBe(0);
  });

  it('gives DIFFERENT students DIFFERENT sequences', () => {
    const a = terms(paramsFromSeed(0x1111_1111));
    const b = terms(paramsFromSeed(0x9999_9999));
    expect(a).not.toEqual(b);
  });

  it('marks an off-by-one wrong, because the whole task is the next term', () => {
    const seed = 0x00ff_00ff;
    const right = nextTerm(paramsFromSeed(seed));
    expect(grade(right, seed).points).toBe(4);
    expect(grade(right + 1, seed).points).toBe(0);
    expect(grade(right - 1, seed).points).toBe(0);
  });

  it('refuses a grade with no SEED, rather than grading a sequence it cannot rebuild', () => {
    const result = sim.grader.grade({ shown: 5 }, null, 30);
    expect(result.points).toBe(0);
    expect(result.feedback).toMatch(/without the sequence/u);
    expect(sim.grader.grade(null, null, 30).points).toBe(0);
  });

  it('marks an empty answer zero rather than reading it as the term 0', () => {
    // `Number('')` is 0, and 0 is a plausible-looking answer nobody gave.
    const seed = 0x1234_5678;
    expect(grade(Number.NaN, seed).points).toBe(0);
    expect(grade('', seed).points).toBe(0);
  });

  it('NEVER PUTS THE ANSWER IN THE TEXT ALTERNATIVE', () => {
    // The alternative exists for a blocked browser and a printed worksheet. Naming the next term would
    // hand a blocked student the answer and give a printed exercise its own solution.
    for (const seed of [0x1234_5678, 0x00ff_00ff, 0x7777_7777]) {
      const params = paramsFromSeed(seed);
      const text = describeSequence(params);
      expect(text).not.toContain(String(nextTerm(params)));
      expect(text).toContain('comes next');
    }
  });
});
