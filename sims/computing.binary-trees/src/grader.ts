/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 72 `computing.binary-trees`)
 *
 * ## A SURPLUS ENTRY IS WRONG, NOT TRUNCATED, AND THIS FILE SAYS WHICH
 *
 * The card names this as the hazard for tolerance class T-H: "a surplus entry occupies a position
 * (`grading.ts:359`), so state whether it is wrong or truncated." `orderMatch` counts a longer answer's
 * extra entries in the DENOMINATOR (`grading.ts:484`), so appending a fifth traversal step to a four-step
 * answer costs the same as getting that position wrong. It is WRONG. A student's answer is the sequence
 * they walked, and walking past the end is a different walk.
 *
 * ## EACH FIELD IS GRADED WITH THE INSTRUMENT THE CARD NAMES FOR IT
 *
 * Three ordered sequences go through `orderMatch`, per POSITION over `max(expected, given)`. The height is
 * a count, so `numeric` and no band. `orderMatch` folds case, and unlike a genotype a node value has no case
 * to claim: `50` and `50` are the same node whatever the keyboard did.
 */

import { defineSim, numeric, orderMatch } from '@orrery/sim-sdk/grader';
import {
  asBoolean,
  balanced,
  clamp,
  describeTree,
  height,
  inOrder,
  postOrder,
  preOrder,
  root,
  type TreeParams,
} from './model.js';

/** 1 mark per traversal, and half a mark each for the two scalar facts — four in total. */
export const TRAVERSAL_MARKS = 1;
export const SCALAR_MARKS = 0.5;
export const MAX_POINTS = TRAVERSAL_MARKS * 3 + SCALAR_MARKS * 2;

const listOf = (value: unknown): unknown =>
  Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;

const parse = (answer: unknown) => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  const inOrderGiven = listOf(record.inOrder);
  const preOrderGiven = listOf(record.preOrder);
  const postOrderGiven = listOf(record.postOrder);
  if (inOrderGiven === null || preOrderGiven === null || postOrderGiven === null) return null;
  return { inOrderGiven, preOrderGiven, postOrderGiven, record };
};

export default defineSim({
  meta: {
    id: 'computing.binary-trees',
    title: 'Binary search trees',
    version: '1.0.0',
    subjects: ['computing'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    insertOrder: {
      type: 'string',
      name: 'insertOrder',
      label: 'Insertion order',
      default: '50,25,75,12,37,62,87',
      maxLength: 120,
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A binary search tree drawn as nested lists, a table of every node with its parent and side, and three boxes for the in-order, pre-order and post-order traversals.',
    reducedMotion: true,
    textAlternative:
      'A binary search tree built by inserting 50, 25, 75, 12, 37, 62 and 87 in that order, with no rebalancing. In order it reads 12, 25, 37, 50, 62, 75, 87. It is 2 edges tall and balanced.',
    summary:
      'Insert values into a binary search tree and name its in-order, pre-order and post-order traversals.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    const parsed = parse(answer);
    if (parsed === null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'All three traversals are needed, so there was nothing to score. Enter each traversal as a ' +
          'comma-separated list of the node values, and the height as a number of edges.',
      };
    }
    const params = clamp(rawParams as Partial<TreeParams>);
    const tree = root(params);
    if (tree === null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'NO_TREE',
        feedback:
          'No values were inserted, so there is no tree to traverse and nothing can be scored.',
      };
    }
    const inGrade = orderMatch(parsed.inOrderGiven, inOrder(tree), {
      maxPoints: TRAVERSAL_MARKS,
      partialCredit: true,
    });
    const preGrade = orderMatch(parsed.preOrderGiven, preOrder(tree), {
      maxPoints: TRAVERSAL_MARKS,
      partialCredit: true,
    });
    const postGrade = orderMatch(parsed.postOrderGiven, postOrder(tree), {
      maxPoints: TRAVERSAL_MARKS,
      partialCredit: true,
    });
    const heightGrade = numeric(parsed.record.height, height(tree), SCALAR_MARKS);
    const statedBalanced = asBoolean(parsed.record.balanced);
    const balanceRight = statedBalanced !== null && statedBalanced === balanced(tree);
    const balanceGrade = balanceRight
      ? {
          points: SCALAR_MARKS,
          maxPoints: SCALAR_MARKS,
          code: 'CORRECT',
          feedback: 'the balance claim is right',
        }
      : {
          points: 0,
          maxPoints: SCALAR_MARKS,
          code: statedBalanced === null ? 'UNPARSEABLE' : 'INCORRECT',
          feedback:
            statedBalanced === null
              ? 'the balance claim was neither yes nor no, so it could not be scored'
              : `you said the tree is ${String(statedBalanced)}, and it is ${String(balanced(tree))}`,
        };

    const points =
      inGrade.points +
      preGrade.points +
      postGrade.points +
      heightGrade.points +
      balanceGrade.points;
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeTree(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        `In-order: ${inGrade.feedback}. Pre-order: ${preGrade.feedback}. Post-order: ${postGrade.feedback}. ` +
        `Height: ${heightGrade.feedback}. Balanced: ${balanceGrade.feedback}. ` +
        `${describeTree(params)} A surplus entry is wrong rather than ignored: each one takes the place of ` +
        'a step you still had to get right.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const insertOrder = (state as { insertOrder?: unknown }).insertOrder;
    return typeof insertOrder === 'string' && insertOrder !== ''
      ? null
      : 'the state has no non-empty `insertOrder` string';
  },
});
