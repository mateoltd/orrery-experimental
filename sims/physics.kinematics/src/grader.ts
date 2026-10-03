/**
 * The grader half. Node, no DOM, deterministic.  (P6-T11, gold sim 8)
 */

import { choice, defineSim, num, tolerance } from '@orrery/sim-sdk/grader';
import {
  describeKinematics,
  displacement,
  findScenario,
  format,
  type KinematicsParams,
  SCENARIOS,
} from './model.js';

/** One point per metre of error, capped, so a wildly wrong answer cannot score by being large. */
const TOLERANCE = { absolute: 0.5, relative: 0.02 } as const;

export default defineSim({
  meta: {
    id: 'physics.kinematics',
    title: 'Displacement under acceleration',
    version: '1.0.0',
    subjects: ['physics'],
    license: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    t: num({ name: 't', label: 'Time', unit: 's', min: 0.1, max: 5, default: 2 }),
    // DECLARED HERE, which is what makes it survive `clampParams`.
    //
    // A parameter the grader does not declare is dropped at the trust boundary, so `params.scenario`
    // arrived `undefined` and every answer graded `UNKNOWN_SCENARIO`. The first version put the scenario
    // in `capabilities.scenarios` only -- correct as a protocol claim, and useless as a graded input,
    // because nothing carried the value through.
    scenario: choice({
      name: 'scenario',
      label: 'Situation',
      values: ['dropped', 'thrown', 'rolled'],
      default: 'dropped',
    }),
  },
  controls: { params: true, state: true, scenarios: SCENARIOS.map((scenario) => scenario.name) },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A choice of situation, a time in seconds, and a box to work out the distance travelled.',
    reducedMotion: true,
    // No distance here: the distance is the answer, and this alternative is what a blocked student and a
    // printed worksheet both get instead of the question.
    textAlternative:
      'A situation is chosen, a time in seconds is set, and the task is to work out how far the object has moved.',
    summary: 'Choose a situation, set a time, and calculate how far the object has travelled.',
  },
  // `grade(state, params, answer)` -- three positional arguments; `defineSim` checks the arity at load.
  grade(_state: unknown, params: KinematicsParams, answer: unknown) {
    const scenario = findScenario(params.scenario);
    if (scenario === null) {
      return {
        points: 0,
        max: 4,
        code: 'UNKNOWN_SCENARIO',
        feedback: `This simulation has no situation called ${JSON.stringify(params.scenario)}.`,
      };
    }
    // `Number('')` is 0, not NaN, so an empty box scored a clean zero metres -- indistinguishable from a
    // student who typed 0. An absent answer and a wrong answer are different events.
    const blank =
      answer === null ||
      answer === undefined ||
      (typeof answer === 'string' && answer.trim() === '');
    const given = Number(answer);
    if (blank || !Number.isFinite(given)) {
      return {
        points: 0,
        max: 4,
        code: 'UNPARSEABLE',
        feedback: 'Enter how far it has moved, in metres.',
      };
    }
    const expected = displacement(scenario, Number(params.t));
    const judged = tolerance(given, expected, {
      abs: TOLERANCE.absolute,
      rel: TOLERANCE.relative,
      maxPoints: 4,
      partialCredit: true,
    });
    return {
      points: judged.points,
      max: 4,
      code: judged.points === 4 ? 'CORRECT' : judged.points > 0 ? 'CLOSE' : 'WRONG',
      feedback:
        judged.points === 4
          ? `Correct: ${format(expected)} m.`
          : `You said ${format(given)} m. ${describeKinematics(scenario, Number(params.t))} s = ut + ½at² gives ${format(expected)} m.`,
    };
  },
  validateState(state) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const scenario = (state as { scenario?: unknown }).scenario;
    return typeof scenario === 'string' ? null : 'the state has no scenario name';
  },
});
