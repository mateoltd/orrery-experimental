/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 11)
 */

import { defineSim, num, orderMatch } from '@orrery/sim-sdk/grader';
import { correctPositions, describeOrder, format, NAMES, type OrderParams } from './model.js';

export default defineSim({
  meta: {
    id: 'biology.mitosis-order',
    title: 'Ordering the stages of cell division',
    version: '1.0.0',
    subjects: ['biology'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    count: num({ name: 'count', label: 'Stages', unit: '', min: 2, max: 6, default: 6 }),
  },
  controls: { params: true, state: true, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A list of six described events with buttons to move each one up and down, and a button to submit.',
    reducedMotion: true,
    // The order is the answer. The alternative names the TASK and the two end events, which are what a
    // blocked student and a printed worksheet both need in order to attempt it -- and the two end events
    // are already on the first and last cards, so nothing is given away that the question does not.
    textAlternative:
      'Six events from one cell division are described, each without its name. Arrange them in the order ' +
      'they occur, beginning with the stage in which DNA is copied and ending with the division of the ' +
      'cytoplasm.',
    summary: 'Put the described stages of cell division into the order they happen.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: OrderParams, answer: unknown) {
    const expected = NAMES.slice(0, params.count);
    const given = Array.isArray(answer)
      ? answer.map((entry) => String(entry))
      : // A single string is a common thing for a client to send for a list, and refusing it outright
        // would report a transport problem as a wrong answer.
        typeof answer === 'string' && answer.trim() !== ''
        ? answer.split(',').map((entry) => entry.trim())
        : null;

    if (given === null || given.length === 0) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Submit the stages in order, starting from the top of the list.',
      };
    }

    // `ORDER`, NOT `SET`. Every item is present in any arrangement, so a set matcher scores a reversed
    // sequence as a perfect answer -- the inverse of the mistake `setMatch` prevents in a quadratic.
    const judged = orderMatch(given, expected, { maxPoints: 4, partialCredit: true });
    const right = correctPositions(given, expected.length);
    return {
      points: judged.points,
      max: 4,
      code: right === expected.length ? 'CORRECT' : right > 0 ? 'PARTIAL' : 'WRONG',
      feedback:
        right === expected.length
          ? 'Correct — that is the order.'
          : `You have ${format(right)} of ${String(expected.length)} stages in the right position. ` +
            `${describeOrder(params.count)}`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const order = (state as { order?: unknown }).order;
    return Array.isArray(order) ? null : 'the state has no order array';
  },
});
