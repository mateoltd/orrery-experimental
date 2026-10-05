/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 12)
 */

import { defineSim } from '@orrery/sim-sdk/grader';
import {
  type BalanceParams,
  describeEquation,
  GIVEN,
  isBalanced,
  parseSide,
  signature,
} from './model.js';

export default defineSim({
  meta: {
    id: 'chemistry.equation-balancing',
    title: 'Balancing a chemical equation',
    version: '1.0.0',
    subjects: ['chemistry'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {},
  controls: { params: false, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'An unbalanced equation, a single text box for the balanced equation, and a button to check it.',
    reducedMotion: true,
    // The balanced equation IS the answer, so nothing here contains one. The question is named instead,
    // which is what a blocked student and a printed worksheet both need in order to attempt it.
    textAlternative:
      'An unbalanced chemical equation is given. Write the balanced equation on one line. Whole numbers ' +
      'are acceptable and the equation may be written in either direction.',
    summary: 'Type the balanced form of an unbalanced equation and have it checked.',
  },
  grade(_state: unknown, _params: BalanceParams, answer: unknown) {
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    if (blank) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSEABLE',
        feedback: 'Write the balanced equation on one line.',
      };
    }
    const written = String(answer).trim();
    const [left, right] = written.split(/->|=|\u2192/u);
    if (left === undefined || right === undefined || right.trim() === '') {
      return {
        points: 0,
        maxPoints: 4,
        code: 'NO_ARROW',
        feedback:
          'An equation needs both sides. Write it with an arrow between them, for example ' +
          '"2H2 + O2 -> 2H2O".',
      };
    }

    let correct = false;
    try {
      // Either direction counts, because the same chemistry is written both ways in every textbook and a
      // grader that accepts one of them is asking a question the student was never asked.
      correct = isBalanced(left, right) || isBalanced(right, left);
    } catch (error) {
      return {
        points: 0,
        maxPoints: 4,
        code: 'UNPARSABLE',
        feedback: `That could not be read as an equation: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      };
    }

    return {
      points: correct ? 4 : 0,
      maxPoints: 4,
      code: correct ? 'CORRECT' : 'WRONG',
      feedback: correct
        ? 'Balanced.'
        : `${describeEquation()} Your equation balances the same elements in the same ` +
          `proportion as ${GIVEN.left} -> ${GIVEN.right} once the sides are put in order.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const written = (state as { written?: unknown }).written;
    return typeof written === 'string' ? null : 'the state has no written equation';
  },
});

export { isBalanced, parseSide, signature };
