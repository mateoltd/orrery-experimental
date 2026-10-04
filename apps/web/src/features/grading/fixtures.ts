/**
 * Test fixtures for the grading workspace.  (P9-T2)
 *
 * The auto-grades here are produced by calling the REAL `grade()` rather than written out by hand. A hand-written
 * `{ points: 0, flags: ['NEEDS_HUMAN'] }` tests the workspace against what this file's author believes the grader
 * returns; calling it tests against what it returns, and the difference is exactly the kind that has bitten this
 * repo before.
 */

import { grade } from '@orrery/contracts/grading';
import type { QuestionCommon, TeacherQuestionSpec } from '@orrery/contracts/question';

import type { AutoMark, ResponseFacts } from './markingState';
import type { MarkingRubric } from './rubric';

const common = (id: string, points: number, gradingMode: 'AUTO' | 'MANUAL'): QuestionCommon => ({
  id,
  points,
  gradingMode,
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'UNDERSTAND',
  tags: [],
});

export const autoMarkFor = (spec: TeacherQuestionSpec, answer: unknown): AutoMark => {
  const outcome = grade({ spec, response: answer });
  return {
    points: outcome.points,
    rawPoints: outcome.rawPoints,
    maxPoints: outcome.maxPoints,
    rationale: outcome.rationale,
    flags: outcome.flags,
    graderVersion: outcome.graderVersion,
  };
};

export const FREE_RESPONSE: TeacherQuestionSpec = {
  ...common('q-essay', 5, 'MANUAL'),
  type: 'free_response',
  rubric: [
    { points: 5, descriptor: 'names both forces and links them to the acceleration' },
    { points: 2, descriptor: 'names one force' },
    { points: 0, descriptor: 'names no force' },
  ],
  conceptHints: ['gravity', 'centripetal'],
  modelAnswer:
    'Gravity is the only force; it is not balanced, so the satellite accelerates inward.',
};

export const SINGLE_CHOICE: TeacherQuestionSpec = {
  ...common('q-choice', 2, 'AUTO'),
  type: 'single_choice',
  choices: [
    { id: 'a', text: 'It speeds up' },
    { id: 'b', text: 'It slows down' },
    { id: 'c', text: 'Its speed does not change' },
  ],
  key: { choiceId: 'a' },
};

/** `NG` with 2 correct of 5: selecting one right and two wrong scores below zero on the raw scale. */
export const MULTI_SELECT_NG: TeacherQuestionSpec = {
  ...common('q-multi', 4, 'AUTO'),
  type: 'multi_select',
  choices: [
    { id: 'a', text: 'Gravity' },
    { id: 'b', text: 'Thrust' },
    { id: 'c', text: 'Drag' },
    { id: 'd', text: 'Centripetal force as a separate force' },
    { id: 'e', text: 'Normal force' },
  ],
  key: { choiceIds: ['a', 'c'] },
  partialCredit: 'NG',
};

export const SIMULATION: TeacherQuestionSpec = {
  ...common('q-sim', 3, 'AUTO'),
  type: 'simulation',
  simId: 'orbit-decay',
  simVersion: '1.2.0',
};

export const ESSAY_PROMPT = "Explain why the satellite's speed changes at this point in its orbit.";
export const ESSAY_ANSWER =
  'Gravity pulls the satellite towards the planet.\nNothing balances it, so it speeds up.';

const facts = (over: Partial<ResponseFacts> & Pick<ResponseFacts, 'responseId' | 'spec'>) => ({
  questionId: over.spec.id,
  prompt: 'What happens to the speed of the satellite?',
  answer: null,
  isOmitted: false,
  notReached: false,
  isExcused: false,
  flagged: false,
  needsHuman: false,
  auto: null,
  manual: null,
  version: 'v1',
  ...over,
});

/** An essay nobody has marked. `grade()` says `points: 0` and `NEEDS_HUMAN`; the workspace must not show the zero. */
export const essayAwaiting = (over: Partial<ResponseFacts> = {}): ResponseFacts =>
  facts({
    responseId: 'r-essay',
    spec: FREE_RESPONSE,
    prompt: ESSAY_PROMPT,
    answer: { text: ESSAY_ANSWER },
    needsHuman: true,
    auto: autoMarkFor(FREE_RESPONSE, { text: ESSAY_ANSWER }),
    ...over,
  });

/** A single-choice answered wrongly: a real, sealed zero. */
export const choiceWrong = (over: Partial<ResponseFacts> = {}): ResponseFacts =>
  facts({
    responseId: 'r-choice-wrong',
    spec: SINGLE_CHOICE,
    answer: { choiceId: 'b' },
    auto: autoMarkFor(SINGLE_CHOICE, { choiceId: 'b' }),
    ...over,
  });

export const choiceRight = (over: Partial<ResponseFacts> = {}): ResponseFacts =>
  facts({
    responseId: 'r-choice-right',
    spec: SINGLE_CHOICE,
    answer: { choiceId: 'a' },
    auto: autoMarkFor(SINGLE_CHOICE, { choiceId: 'a' }),
    ...over,
  });

/** One correct and two incorrect under `NG`: raw score below zero, which the grader refers to a person. */
export const multiPenalised = (over: Partial<ResponseFacts> = {}): ResponseFacts => {
  const answer = { choiceIds: ['a', 'b', 'e'] };
  return facts({
    responseId: 'r-multi',
    spec: MULTI_SELECT_NG,
    prompt: 'Which forces act on the satellite?',
    answer,
    needsHuman: true,
    auto: autoMarkFor(MULTI_SELECT_NG, answer),
    ...over,
  });
};

/** A simulation answer whose grader threw. `INV-SIM-2`: ours, not the student's. */
export const simFault = (over: Partial<ResponseFacts> = {}): ResponseFacts =>
  facts({
    responseId: 'r-sim',
    spec: SIMULATION,
    prompt: 'Set the burn so the orbit becomes circular.',
    answer: { simState: { burn: 3 }, answer: { deltaV: 12.5 } },
    needsHuman: true,
    auto: autoMarkFor(SIMULATION, { simState: { burn: 3 }, answer: { deltaV: 12.5 } }),
    sim: {
      title: 'Orbital decay',
      outcome: {
        kind: 'NEEDS_HUMAN',
        reason: 'GRADER_THREW',
        detail: 'TypeError: state.burns is not iterable',
      },
      trace: [
        { t: 0, event: 'burn', value: 3 },
        { t: 4, event: 'burn', value: 1 },
      ],
    },
    ...over,
  });

export const ESSAY_RUBRIC: MarkingRubric = {
  questionId: 'q-essay',
  maxPoints: 5,
  bands: [
    {
      id: 'band-1',
      points: 5,
      descriptor: 'names both forces and links them to the acceleration',
      feedback: 'Both forces are named and linked to the acceleration.',
    },
    {
      id: 'band-2',
      points: 2,
      descriptor: 'names one force',
      feedback: 'One force is named. The second force is not mentioned.',
    },
    { id: 'band-3', points: 0, descriptor: 'names no force', feedback: '' },
  ],
};
