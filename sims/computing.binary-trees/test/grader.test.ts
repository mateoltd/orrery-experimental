/**
 * The model and the grader, in bare Node.  (P12-T2, card 72 `computing.binary-trees`)
 *
 * ## THE ASSERTION THAT MATTERS IS A PARTITION, NOT THREE LISTS
 *
 * Three expected traversal lists are three numbers that survive almost any bug — a traversal that skips the
 * leftmost leaf still produces something plausible for the other two. The property that actually catches a
 * traversal error is that the three traversals of one tree CONTAIN THE SAME VALUES, each exactly once. That
 * is asserted here, and it is asserted on a deliberately lopsided tree where a real implementation goes
 * wrong.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, { MAX_POINTS, TRAVERSAL_MARKS } from '../src/grader.js';
import {
  balanced,
  buildTree,
  connections,
  describeTree,
  height,
  inOrder,
  invariantHolds,
  parseOrder,
  postOrder,
  preOrder,
  type TreeParams,
} from '../src/model.js';

const TREE: TreeParams = { insertOrder: '50,25,75,12,37,62,87' };

const grade = (answer: unknown, params: TreeParams = TREE, state: unknown = { probe: true }) =>
  sim.grader.grade(state, params, answer);

const correct = (params: TreeParams = TREE) => {
  const tree = buildTree(parseOrder(params.insertOrder));
  return {
    inOrder: inOrder(tree),
    preOrder: preOrder(tree),
    postOrder: postOrder(tree),
    height: height(tree),
    balanced: balanced(tree),
  };
};

describe('the model', () => {
  it('builds the shape the insertion order implies, with no rebalancing', () => {
    const lopsided = buildTree(parseOrder('10,20,30,40,50'));
    // ASCENDING INSERTION IS A CHAIN, and a rebalancing insert would have made this three deep. This is the
    // card's focus: the tree's shape is a consequence of the order, so the order is the question.
    expect(height(lopsided)).toBe(4);
    expect(balanced(lopsided)).toBe(false);
    expect(height(buildTree(parseOrder('40,20,60,10,30')))).toBe(2);
  });

  it('keeps the BST invariant, checked rather than asserted in a comment', () => {
    expect(invariantHolds(buildTree(parseOrder('50,25,75,12,37,62,87')))).toBe(true);
    expect(invariantHolds(buildTree(parseOrder('10,20,30,40,50')))).toBe(true);
  });

  it('drops a duplicate rather than hanging it off one side, which would break the invariant', () => {
    const tree = buildTree(parseOrder('5,5'));
    expect(height(tree)).toBe(0);
    expect(preOrder(tree)).toEqual(['5']);
  });

  it('the three traversals PARTITION the values, which is what catches a traversal bug', () => {
    for (const order of ['50,25,75,12,37,62,87', '10,20,30,40,50', '7', '1,2,3,4,5,6,7,8,9']) {
      const tree = buildTree(parseOrder(order));
      const sorted = [...inOrder(tree)].sort();
      expect([...preOrder(tree)].sort(), order).toEqual(sorted);
      expect([...postOrder(tree)].sort(), order).toEqual(sorted);
      // AND THE IN-ORDER ONE IS SORTED, which is the property a BST is defined by.
      expect(inOrder(tree), order).toEqual([...sorted]);
    }
  });

  it('parses an insertion order without rounding or inventing values', () => {
    expect(parseOrder('50, 25.5, 75, , -12')).toEqual([50, 75, -12]);
    expect(parseOrder('')).toEqual([]);
  });

  it('describes the tree it is describing, quotes included', () => {
    expect(describeTree(TREE)).toContain('50, 25, 75, 12, 37, 62, 87');
    expect(describeTree(TREE)).toContain('12, 25, 37, 50, 62, 75, 87');
    expect(describeTree({ insertOrder: '' })).toContain('no tree');
  });

  it('lists the connections the card asks the non-visual path to carry', () => {
    const rows = connections(buildTree(parseOrder('2,1,3')));
    expect(rows).toEqual([
      { value: '2', parent: '—', side: 'root' },
      { value: '1', parent: '2', side: 'left' },
      { value: '3', parent: '2', side: 'right' },
    ]);
  });
});

describe('the grader', () => {
  it('awards full marks for the three traversals and the two scalars', () => {
    const graded = grade(correct());
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('is ORDER-SENSITIVE: a reversed traversal is not a set that happens to be right', () => {
    // The mistake `setMatch` would mark as a perfect score and `orderMatch` exists to catch.
    const answer = correct();
    const reversed = { ...answer, inOrder: [...answer.inOrder].reverse() };
    const graded = grade(reversed);
    // EXACTLY 3 + 1/7, and the seventh is not a rounding accident: reversing an ODD-length sorted list puts
    // the same middle value at the same index, and the middle value is the root. Credit is per POSITION, so
    // the one position a reversal cannot spoil is the one it keeps -- which is the behaviour that makes this
    // instrument rather than a set comparison.
    expect(graded.points).toBeCloseTo(MAX_POINTS - TRAVERSAL_MARKS + TRAVERSAL_MARKS / 7, 5);
    expect(graded.points).toBeLessThan(MAX_POINTS);
  });

  it('counts a SURPLUS entry against the student, because it occupies a position', () => {
    // The card asks the author to say whether a surplus entry is wrong or truncated. It is WRONG:
    // `orderMatch` puts the extra entry in the denominator (`grading.ts:484`).
    const answer = { ...correct(), postOrder: [...correct().postOrder, '999'] };
    expect(grade(answer).points).toBeLessThan(MAX_POINTS);
  });

  it('gives partial credit per POSITION, not per item present', () => {
    const answer = correct();
    const swapped = {
      ...answer,
      preOrder: [answer.preOrder[1], answer.preOrder[0], ...answer.preOrder.slice(2)],
    };
    const graded = grade(swapped);
    expect(graded.points).toBeGreaterThan(0);
    expect(graded.points).toBeLessThan(MAX_POINTS);
  });

  it('awards nothing for a blank answer, which is not a numeric comparison', () => {
    expect(grade(null).points).toBe(0);
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({ inOrder: ['1'] }).code).toBe('UNPARSEABLE');
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(correct())));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates the determinism probe state, because the probe sends one', () => {
    expect(() => grade(correct(), TREE, { probe: true })).not.toThrow();
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { insertOrder: TREE.insertOrder };
    const once = sim.grader.grade(state, state, correct());
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: correct() });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator({ insertOrder: '1,2,3' })).toBeNull();
    expect(validator({ insertOrder: '' })).toMatch(/insertOrder/u);
    expect(() =>
      gradeStoredState(sim.grader, { state: { insertOrder: 1 }, params: TREE, answer: correct() }),
    ).toThrow(/STATE_INVALID/u);
  });

  it('refuses an EMPTY insertion order by substituting the declared default, so no item is ungradable', () => {
    // The card's guarantee is that every combination a teacher can set has an answer. A blank insertion
    // order falling through to an empty tree would be a question nobody can be set, which is why `clamp`
    // substitutes rather than returning nothing.
    const blank = grade(correct(), { insertOrder: '' });
    const declared = grade(correct(), TREE);
    expect(blank.points).toBe(declared.points);
    expect(blank.code).toBe('CORRECT');
  });
});
