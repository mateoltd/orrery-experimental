import { assertNoScoreLeak } from '@orrery/interop';
import { describe, expect, it } from 'vitest';
import { permittedAnswer, questionOutcome, sealedResults } from './student-results.js';

const receipt = {
  attemptId: 'a',
  submittedAt: '2026-10-05T10:00:00.000Z',
  receiptHash: 'receipt',
  answers: [{ questionId: 'q', answer: 'student answer' }],
};

describe('student results boundary', () => {
  it('sealed payload passes the shared guard and injected nested score names its path', () => {
    const payload = sealedResults(receipt);
    expect(() => assertNoScoreLeak(payload)).not.toThrow();
    expect(() => assertNoScoreLeak({ ...payload, questions: [{ outcome: 'CORRECT' }] })).toThrow(
      '$.questions[0].outcome (outcome)',
    );
    expect(() =>
      assertNoScoreLeak({ ...payload, receipt: { ...receipt, finalScore: 90 } }),
    ).toThrow('$.receipt.finalScore (finalScore)');
  });
  it('no-submission copy is derived from the receipt rather than hidden grading progress', () => {
    expect(sealedResults({ ...receipt, submittedAt: null }).notice).toContain(
      'No submission has been recorded',
    );
  });
  it.each([
    null,
    {},
    { showCorrectAnswersAfterRelease: false },
    { showCorrectAnswersAfterRelease: 'true' },
  ])('fails closed for policy %j', (policy) => {
    expect(permittedAnswer(policy, 'secret model', { key: { choiceId: 'secret' } })).toBeNull();
  });
  it('allows only model or key material after explicit permission, never the whole spec', () => {
    const policy = { showCorrectAnswersAfterRelease: true };
    expect(
      permittedAnswer(policy, 'model', { key: { choiceId: 'a' }, rubric: 'teacher-only' }),
    ).toBe('model');
    expect(permittedAnswer(policy, null, { key: { choiceId: 'a' }, rubric: 'teacher-only' })).toBe(
      '{"choiceId":"a"}',
    );
  });
  it.each([
    [null, 2, true, true, 'EXCUSED'],
    [null, 2, false, false, 'AWAITING_REVIEW'],
    [2, 2, false, true, 'AWAITING_REVIEW'],
    [2, 2, false, false, 'CORRECT'],
    [1, 2, false, false, 'PARTIAL'],
    [0, 2, false, false, 'INCORRECT'],
    [0, 0, false, false, 'INCORRECT'],
  ] as const)(
    'distinguishes outcome for %j/%j excused=%j human=%j',
    (score, max, excused, human, outcome) => {
      expect(questionOutcome(score, max, excused, human)).toBe(outcome);
    },
  );
});
