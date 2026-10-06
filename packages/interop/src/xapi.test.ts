import { describe, expect, it } from 'vitest';
import {
  buildAnsweredStatement,
  buildExperiencedStatement,
  buildScoredStatement,
  dedupeKey,
  XAPI_VERBS,
} from './xapi.js';

const base = {
  attemptId: 'att-1',
  actorHomePage: 'https://orrery.example',
  actorName: 'user-7',
  objectId: 'https://orrery.example/items/q1',
} as const;

describe('xAPI statements', () => {
  it('uses ADL verb IRIs, not our own strings', () => {
    expect(XAPI_VERBS.answered).toBe('http://adlnet.gov/expapi/verbs/answered');
    expect(XAPI_VERBS.scored).toBe('http://adlnet.gov/expapi/verbs/scored');
  });

  it('ids are attempt + event, so a retried emission dedupes at the consumer', () => {
    const statement = buildAnsweredStatement({
      ...base,
      event: 'answered',
      durationSeconds: 42,
      attemptNumber: 2,
    });
    expect(statement.id).toBe('att-1:answered');
    expect(dedupeKey('att-1', 'answered')).toBe('att-1:answered');
  });

  it('carries NO answer content: no response field, no answer-shaped keys', () => {
    const statement = buildAnsweredStatement({
      ...base,
      event: 'answered',
      durationSeconds: 42,
      attemptNumber: 2,
    });
    // Structural, not substring: the verb IRI itself contains "answer" as a substring of "answered",
    // which is exactly why a `not.toContain('answer')` assertion fails on a correct payload -- and why
    // the check walks keys instead of grepping text, the same prose-versus-code trap as ever.
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(statement);
    for (const forbidden of ['response', 'answer', 'choices', 'correctChoice']) {
      expect(keys, `payload must not carry "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('identifies the actor by account, never by email', () => {
    const statement = buildExperiencedStatement({ ...base, event: 'experienced' });
    expect(JSON.stringify(statement)).not.toContain('mailto');
    expect(statement.actor.account.name).toBe('user-7');
  });

  it('REFUSES a scored statement for an unreleased score -- not a zero, not a placeholder, no statement', () => {
    expect(() =>
      buildScoredStatement({
        ...base,
        event: 'scored',
        score: { raw: 8, min: 0, max: 10, releasedAt: null },
      }),
    ).toThrow(/XAPI_SEALED_SCORE/);
  });

  it('scales the released score and marks success from the verb', () => {
    const passed = buildScoredStatement({
      ...base,
      event: 'passed',
      score: { raw: 8, min: 0, max: 10, releasedAt: '2026-01-01T00:00:00Z' },
    });
    expect(passed.result?.score?.scaled).toBeCloseTo(0.8);
    expect(passed.result?.success).toBe(true);
    expect(passed.result?.completion).toBe(true);
    const failed = buildScoredStatement({
      ...base,
      event: 'failed',
      score: { raw: 2, min: 0, max: 10, releasedAt: '2026-01-01T00:00:00Z' },
    });
    expect(failed.result?.success).toBe(false);
  });

  it('answered carries duration in ISO-8601 and the attempt number in extensions', () => {
    const statement = buildAnsweredStatement({
      ...base,
      event: 'answered',
      durationSeconds: 90,
      attemptNumber: 3,
    });
    expect(statement.result?.duration).toBe('PT90S');
    expect(
      statement.context?.extensions?.['https://orrery.example/extensions/attempt-number'],
    ).toBe(3);
  });
});
