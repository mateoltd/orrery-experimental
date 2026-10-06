import { describe, expect, it } from 'vitest';
import { buildStudentGrade } from './boundary.js';
import { prepareOutbound, type ReleasedOutbound } from './outbound.js';
import {
  buildAnsweredStatement,
  buildExperiencedStatement,
  buildScoredStatement,
  dedupeKey,
  XAPI_VERBS,
} from './xapi.js';

const xapiTarget = {
  standard: 'XAPI',
  bindingId: 'bind-1',
  externalId: 'ext-1',
  attemptId: 'att-1',
  assignmentId: 'asg-1',
} as const;
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

  it('REFUSES a scored statement built from a sealed body -- end to end through the chokepoint', () => {
    // The grade holds a REAL score and is still sealed: the chokepoint drops it, and what reaches the
    // statement builder has no score at all. Before release the answer is not a zero and not a
    // placeholder -- it is the absence of a statement.
    const grade = buildStudentGrade({
      released: false,
      attemptId: 'att-1',
      assignmentId: 'asg-1',
      submittedAt: '2026-01-01T00:00:00Z',
      answers: [],
      score: { rawTotal: 8, maxTotal: 10, percentage: 80, perQuestion: [] },
      releasedAt: null,
      regradeNotice: null,
    });
    const body = prepareOutbound({ target: xapiTarget, grade });
    expect(body.state).toBe('SEALED');
    expect(() =>
      buildScoredStatement({ ...base, event: 'scored', outbound: body as ReleasedOutbound }),
    ).toThrow(/XAPI_SEALED_SCORE/);
  });

  it('REFUSES a body approved for the wrong standard -- an AGS score must not reach an LRS', () => {
    const grade = buildStudentGrade({
      released: true,
      attemptId: 'att-1',
      assignmentId: 'asg-1',
      submittedAt: '2026-01-01T00:00:00Z',
      answers: [],
      score: { rawTotal: 8, maxTotal: 10, percentage: 80, perQuestion: [] },
      releasedAt: '2026-01-02T00:00:00Z',
      regradeNotice: null,
    });
    const body = prepareOutbound({
      target: { ...xapiTarget, standard: 'LTI_AGS' },
      grade,
    });
    expect(body.state).toBe('RELEASED');
    expect(() =>
      buildScoredStatement({ ...base, event: 'scored', outbound: body as ReleasedOutbound }),
    ).toThrow(/XAPI_WRONG_STANDARD/);
  });

  it('formats a chokepoint-approved XAPI body: scaled, success and completion from the release', () => {
    const grade = buildStudentGrade({
      released: true,
      attemptId: 'att-1',
      assignmentId: 'asg-1',
      submittedAt: '2026-01-01T00:00:00Z',
      answers: [],
      score: { rawTotal: 8, maxTotal: 10, percentage: 80, perQuestion: [] },
      releasedAt: '2026-01-02T00:00:00Z',
      regradeNotice: null,
    });
    const body = prepareOutbound({ target: xapiTarget, grade });
    if (body.state !== 'RELEASED') throw new Error('expected a released body');
    const passed = buildScoredStatement({ ...base, event: 'passed', outbound: body });
    expect(passed.result?.score?.raw).toBe(8);
    expect(passed.result?.score?.max).toBe(10);
    expect(passed.result?.success).toBe(true);
    expect(passed.result?.completion).toBe(true);
    const failed = buildScoredStatement({ ...base, event: 'failed', outbound: body });
    expect(failed.result?.success).toBe(false);
  });
});
