/**
 * The loader's contract, against a stub database.  (P8-T17)
 *
 * The mounting test proves the runner renders and answers; THIS test proves what it renders with is
 * safe to hand to a browser. Each case is a property the whole exam depends on:
 *
 *   - wrong owner (or missing attempt) -> null, the whole paper, not a partial one;
 *   - a malformed spec -> null, not a crash and not a rendered fragment;
 *   - a missing prompt -> null, not a nameless fieldset;
 *   - and the load-bearing one: **no `key` anywhere in the output**, walked structurally rather than
 *     grepped textually, because the verb-IRI lesson (`.../verbs/answered` contains "answer") applies
 *     to key names too.
 */

import { EXAM_PROFILE_DEFAULTS } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';
import { loadExamRunnerData } from './exam-runner.js';

const teacherSpec = (overrides: Record<string, unknown> = {}) => ({
  id: 'q1',
  points: 4,
  gradingMode: 'AUTO',
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'REMEMBER',
  tags: [],
  type: 'single_choice',
  choices: [
    { id: 'a', text: 'Alpha' },
    { id: 'b', text: 'Bravo' },
  ],
  key: { choiceId: 'b' },
  prompt: 'Which is second?',
  ...overrides,
});

function stubDb(opts: {
  attempt?: { id: string; policySnapshot: unknown } | null;
  responses?: {
    id: string;
    questionId: string;
    position: number;
    answer: unknown;
    revision: number;
    question: { spec: unknown };
  }[];
}) {
  return {
    examAttempt: {
      findFirst: async () => opts.attempt ?? null,
    },
    questionResponse: {
      findMany: async () => opts.responses ?? [],
    },
    // A structural stub, not `as any`: the loader touches exactly two methods, and a stub that
    // implements more would be asserting an interface it does not check.
  } as unknown as Parameters<typeof loadExamRunnerData>[0];
}

// The real default policy, not a hand-shaped one: a fixture shaped by guessing would pass against a
// loader that accepts anything, which proves nothing about the frozen policies real attempts carry.
const POLICY = EXAM_PROFILE_DEFAULTS;

describe('loadExamRunnerData', () => {
  const response = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    questionId: 'q1',
    position: 0,
    answer: null,
    revision: 0,
    question: { spec: teacherSpec() },
    ...overrides,
  });

  it('refuses a wrong owner: someone else\u2019s attempt loads nothing', async () => {
    const data = await loadExamRunnerData(stubDb({ attempt: null }), 'intruder', 'att-1');
    expect(data).toBeNull();
  });

  it('refuses an empty paper rather than rendering an exam with no questions', async () => {
    const data = await loadExamRunnerData(
      stubDb({ attempt: { id: 'att-1', policySnapshot: POLICY }, responses: [] }),
      'stu-1',
      'att-1',
    );
    expect(data).toBeNull();
  });

  it('refuses a malformed spec instead of handing the registry something it cannot render', async () => {
    const data = await loadExamRunnerData(
      stubDb({
        attempt: { id: 'att-1', policySnapshot: POLICY },
        responses: [response({ question: { spec: { type: 'not_a_type' } } })],
      }),
      'stu-1',
      'att-1',
    );
    expect(data).toBeNull();
  });

  it('refuses a question with no prompt rather than rendering a nameless fieldset', async () => {
    const spec = teacherSpec();
    delete (spec as Record<string, unknown>).prompt;
    const data = await loadExamRunnerData(
      stubDb({
        attempt: { id: 'att-1', policySnapshot: POLICY },
        responses: [response({ question: { spec } })],
      }),
      'stu-1',
      'att-1',
    );
    expect(data).toBeNull();
  });

  it('returns public specs carrying NO key, walked structurally', async () => {
    const data = await loadExamRunnerData(
      stubDb({ attempt: { id: 'att-1', policySnapshot: POLICY }, responses: [response()] }),
      'stu-1',
      'att-1',
    );
    expect(data).not.toBeNull();
    expect(data?.questions).toHaveLength(1);
    const first = data?.questions[0];
    expect(first).toBeDefined();
    expect(first?.prompt).toBe('Which is second?');
    // Structural walk, not a text search: key NAMES are the finding, whatever their values.
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
    walk(first?.spec);
    expect(keys).not.toContain('key');
    expect(keys).not.toContain('modelAnswer');
  });

  it('refuses an unreadable policy rather than running under a policy nobody can read', async () => {
    const data = await loadExamRunnerData(
      stubDb({
        attempt: { id: 'att-1', policySnapshot: { mode: 'NOPE' } },
        responses: [response()],
      }),
      'stu-1',
      'att-1',
    );
    expect(data).toBeNull();
  });
});
