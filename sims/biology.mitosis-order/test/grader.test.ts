/**
 * The grader, in bare Node.  (P6-T11, gold sim 11)
 *
 * The cases that matter are about POSITION and about order being the answer at all.
 */
import { describe, expect, it } from 'vitest';
import sim from '../src/grader.js';
import {
  correctPositions,
  describeOrder,
  move,
  NAMES,
  type OrderParams,
  STAGES,
  shuffled,
} from '../src/model.js';

const ORDER = [...NAMES];

/**
 * The stage at `index`, as a NAME.
 *
 * `ORDER[i]` is `string | undefined` under `noUncheckedIndexedAccess`, so building a swapped order out of
 * literals produces `(string | undefined)[]` — and a `correctPositions` call handed that array would
 * count an absent entry as merely misplaced rather than report the mistake. Resolving the index once, and
 * refusing an out-of-range one, keeps the test counting POSITIONS rather than counting holes.
 */
const stageAt = (index: number): string => {
  const name = ORDER[index];
  if (name === undefined) throw new Error(`no stage at index ${String(index)}`);
  return name;
};
const grade = (answer: unknown, params: OrderParams = { count: 6 }) =>
  sim.grader.grade(null, params, answer);

describe('biology.mitosis-order', () => {
  it('awards full marks for the correct order', () => {
    expect(grade(ORDER)).toMatchObject({ points: 4, code: 'CORRECT' });
  });

  // THE WHOLE REASON THIS SIMULATION EXISTS.
  //
  // Every item is present in ANY arrangement, so a set matcher scores a reversed sequence as a perfect
  // answer. That is the exact inverse of the mistake `setMatch` exists to prevent in a quadratic, where
  // `3, 1` and `1, 3` are the same answer. Reusing the set matcher for a sequencing task would have
  // marked every wrong order correct.
  it('does NOT accept a reversed sequence, which a set matcher would score as perfect', () => {
    const reversed = [...ORDER].reverse();
    expect(grade(reversed).points).toBe(0);
    // Every item IS present, and that earns nothing.
    expect(new Set(reversed)).toEqual(new Set(ORDER));
  });

  it('credits by POSITION rather than by which items are present', () => {
    // Two adjacent stages swapped: all six items present, four of six positions right.
    const swapped = [stageAt(0), stageAt(2), stageAt(1), ...ORDER.slice(3)];
    const result = grade(swapped);
    expect(result.points).toBeCloseTo((4 / 6) * 4, 6);
    expect(result.points).toBeLessThan(4);
    expect(correctPositions(swapped, 6)).toBe(4);
  });

  it('credits nothing for a list that is too long', () => {
    const result = grade([...ORDER, 'Nuclear envelope reformed']);
    expect(result.points).toBeLessThan(4);
  });

  it('accepts a COMMA-SEPARATED string, because a client will send one', () => {
    // Refusing it would report a transport quirk as a wrong answer, which is a support question dressed
    // up as a mark.
    expect(grade(ORDER.join(',')).points).toBe(4);
  });

  it('rejects an empty submission rather than scoring it as an empty order', () => {
    for (const blank of ['', '   ', [], null, undefined, Number.NaN, 42, {}]) {
      expect(grade(blank)).toMatchObject({ points: 0, code: 'UNPARSEABLE' });
    }
  });

  it('grades a SHORTER question against the shorter answer', () => {
    // Four stages, not six: the expected answer is the first four in order, and an answer that adds the
    // remaining two is wrong rather than generous.
    expect(grade(ORDER.slice(0, 4), { count: 4 }).points).toBe(4);
    expect(grade(ORDER, { count: 4 }).points).toBeLessThan(4);
  });

  // A SEEDED shuffle, because a different question in front of every student makes the simulation
  // untestable, and because a shuffle that lands on the answer teaches nothing.
  it('shuffles deterministically for a given seed', () => {
    expect(shuffled(6, 20_260_926)).toEqual(shuffled(6, 20_260_926));
    expect(shuffled(6, 1)).not.toEqual(shuffled(6, 2));
  });

  it('never shuffles into the answer order', () => {
    for (const seed of [1, 2, 3, 7, 42, 20_260_926, 999_983]) {
      const order = shuffled(6, seed);
      expect(order.every((name, index) => name === NAMES[index])).toBe(false);
      // BOTH sides sorted: `.sort()` is alphabetical, and the correct answer is in BIOLOGICAL order,
      // so comparing a sorted shuffle against an unsorted answer was always going to fail.
      expect([...order].sort()).toEqual([...NAMES].sort());
    }
  });

  it('moves an item and refuses to move one out of bounds, rather than clamping silently', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b', 'c'], 0, 0)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], -1, 1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], 1, 9)).toEqual(['a', 'b', 'c']);
  });

  it('includes Interphase, which is NOT a stage of mitosis', () => {
    // Deliberate: a student who lists only the four mitotic stages has answered a different question,
    // and the description says the list runs from one interphase to one cytokinesis.
    expect(NAMES[0]).toBe('Interphase');
    expect(STAGES).toHaveLength(6);
    expect(describeOrder(6)).toContain('DNA is copied');
  });

  it('never shows a stage NAME on the card, because the name is the answer', () => {
    for (const stage of STAGES) {
      expect(stage.detail).not.toContain(stage.name);
    }
  });

  it('keeps the order out of the text alternative', () => {
    const text = sim.grader.accessibility.textAlternative;
    expect(text).not.toContain('Prophase');
    expect(text).not.toContain('Metaphase');
    expect(text.length).toBeGreaterThan(20);
  });

  it('states the count in feedback rather than only the verdict', () => {
    const result = grade([...ORDER].reverse()) as { feedback: string };
    expect(result.feedback).toContain('6 stages');
  });
});
