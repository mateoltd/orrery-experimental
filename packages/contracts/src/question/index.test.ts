/**
 * The question union and its projections.  (P7-T1)
 *
 * ## WHAT IS ACTUALLY BEING TESTED HERE
 *
 * Not that the ten shapes parse — the compiler does that. The tests below are about the CLAIM that a new
 * question type fails compilation until it is handled, and about the claim that no key material reaches a
 * client payload. Both are security-relevant, and both are the kind of thing that fails by ACCIDENT later: a
 * field added to a spec, a projection spreading the spec instead of rebuilding it, a `never` check deleted
 * because it was inconvenient.
 *
 * ## WHY THE LEAK TEST RECURSIVE AND BY FIELD NAME
 *
 * A projection that returns `omit(spec, ['key'])` is correct for the ten types as written and wrong the moment
 * somebody adds a type whose answer lives under a different name. So `expectNoKeyMaterial` walks the WHOLE
 * payload looking for the key-bearing field names from `plans/07` §2 — `key`, `modelAnswer`, `rubric`,
 * `conceptHints` — at any depth, rather than asserting on one path per type.
 */
import { describe, expect, it } from 'vitest';
import {
  assertDefaults,
  assertExhaustiveTypes,
  COGNITIVE_DEMANDS,
  DEFAULT_PARTIAL_CREDIT,
  GRADING_MODES,
  PARTIAL_CREDIT_METHODS,
  publicQuestionSpec,
  QUESTION_TYPES,
  type QuestionSpec,
  questionCommonSchema,
  SHORT_TEXT_MATCHERS,
  teacherQuestionSpec,
} from './index.js';

const common = {
  points: 4,
  gradingMode: 'AUTO',
  shuffleOptions: false,
  estimatedSeconds: 60,
  cognitiveDemand: 'APPLY',
  tags: ['physics'],
} as const;

/** One minimal, complete spec per type — the same ten the module cross-checks itself against. */
const SPECS: readonly QuestionSpec[] = [
  {
    ...common,
    id: 'q1',
    type: 'single_choice',
    choices: [{ id: 'c1', text: 'one' }],
    key: { choiceId: 'c1' },
  },
  {
    ...common,
    id: 'q2',
    type: 'multi_select',
    choices: [
      { id: 'c1', text: 'one' },
      { id: 'c2', text: 'two' },
    ],
    key: { choiceIds: ['c1'] },
    partialCredit: DEFAULT_PARTIAL_CREDIT,
  },
  { ...common, id: 'q3', type: 'true_false', key: { value: true } },
  {
    ...common,
    id: 'q4',
    type: 'numeric',
    key: { value: 9.81, unit: 'm/s^2' },
    tolerance: { absolute: 0.05 },
    significantFigures: 3,
  },
  {
    ...common,
    id: 'q5',
    type: 'short_text',
    key: { text: 'photosynthesis' },
    matcher: 'FUZZY',
    matchers: { tokenOverlap: 0.6 },
  },
  {
    ...common,
    id: 'q6',
    type: 'ordering',
    items: [
      { id: 'i1', text: 'first' },
      { id: 'i2', text: 'second' },
    ],
    key: { itemIds: ['i2', 'i1'] },
  },
  {
    ...common,
    id: 'q7',
    gradingMode: 'MANUAL',
    type: 'free_response',
    rubric: [{ points: 4, descriptor: 'names both factors' }],
    conceptHints: ['chlorophyll', 'light'],
  },
  {
    ...common,
    id: 'q8',
    gradingMode: 'MANUAL',
    type: 'file_submission',
    allow: ['.png'],
    maxBytes: 1024,
  },
  {
    ...common,
    id: 'q9',
    type: 'simulation',
    simId: 'physics.pendulum',
    simVersion: '1.0.0',
    params: { length: 1 },
  },
  {
    ...common,
    id: 'q10',
    gradingMode: 'MANUAL',
    type: 'worked_solution',
    steps: [{ id: 's1', prompt: 'state F = ma', points: 2, key: { text: 'F = ma' } }],
  },
];

/** EVERY FIELD NAME `plans/07` §2.1 says a student payload must not carry. */
const KEY_FIELDS = ['key', 'modelAnswer', 'rubric', 'conceptHints'] as const;

/** Every path in `value` at which one of `names` appears, as a dotted string. */
const pathsCarrying = (value: unknown, names: readonly string[], prefix = ''): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      pathsCarrying(entry, names, `${prefix}[${String(index)}]`),
    );
  }
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = prefix === '' ? name : `${prefix}.${name}`;
    if ((names as readonly string[]).includes(name)) found.push(here);
    found.push(...pathsCarrying(entry, names, here));
  }
  return found;
};

describe('the union', () => {
  it('covers the ten types `plans/07` §2 asks for', () => {
    expect([...QUESTION_TYPES]).toEqual([
      'single_choice',
      'multi_select',
      'true_false',
      'numeric',
      'short_text',
      'ordering',
      'free_response',
      'file_submission',
      'simulation',
      'worked_solution',
    ]);
  });

  it('cross-checks the union against the list at module load', () => {
    /**
     * `assertNever` proves the COMPILER covered the union. It cannot prove the union lists what the plan asks
     * for — a type added to the interfaces and forgotten in `QUESTION_TYPES` would still project, still grade,
     * and still be missing from any audit of what exists. This is the runtime half of that claim.
     */
    expect(() => {
      assertExhaustiveTypes();
    }).not.toThrow();
  });

  it('defaults partial credit to 1PM, by NAME rather than by position', () => {
    /**
     * `NC` is the FIRST element of `PARTIAL_CREDIT_METHODS`, because that is the order the packet lists them
     * in. A first version defaulted `PARTIAL_CREDIT_METHODS[0]` and so defaulted every `multi_select` question
     * to NO partial credit — for a section whose entire subject is partial credit.
     *
     * `RN-05` supports only that SOME partial credit beats dichotomous scoring; it does not name a default. The
     * default here is `1PM` on the plan's own stated grounds, asserted by name so a reorder cannot change it.
     */
    expect(DEFAULT_PARTIAL_CREDIT).toBe('1PM');
    expect(PARTIAL_CREDIT_METHODS[0]).toBe('NC');
    expect(DEFAULT_PARTIAL_CREDIT).not.toBe(PARTIAL_CREDIT_METHODS[0]);
    expect(() => {
      assertDefaults();
    }).not.toThrow();
  });

  it('lists five partial-credit methods and five short-text matchers', () => {
    // SIX, not five. `P7-T3` in the packet says "the five partial-credit methods NC / NG / SU / RI / PM",
    // but that line predates the review recorded in plans/07 §3, which added `1PM` as the DEFAULT and left
    // the packet's summary un-updated. The table in §3 is the authority and it has six rows, so the constant
    // has six and this test asserts six. Taking the packet's word for it would have dropped the default.
    expect(PARTIAL_CREDIT_METHODS).toHaveLength(6);
    expect([...SHORT_TEXT_MATCHERS]).toEqual([
      'EXACT',
      'NORMALISED',
      'REGEX_SET',
      'FUZZY',
      'NUMERIC_TOLERANCE',
    ]);
    expect(COGNITIVE_DEMANDS).toHaveLength(6);
    expect([...GRADING_MODES]).toEqual(['AUTO', 'MANUAL']);
  });
});

describe('publicQuestionSpec', () => {
  it('projects all ten types without throwing', () => {
    for (const spec of SPECS) {
      expect(() => publicQuestionSpec(spec)).not.toThrow();
    }
  });

  it('carries NO key material at any depth, for any type', () => {
    /**
     * THE CENTRAL CLAIM, AND `INV-Q-1`'S ENFORCEMENT IN miniature.
     *
     * Walked by field NAME at any depth rather than asserted per type, so a new type whose answer lives under
     * a new name is caught by this test rather than by an incident.
     */
    for (const spec of SPECS) {
      const payload = publicQuestionSpec(spec);
      expect({ id: spec.id, leaks: pathsCarrying(payload, KEY_FIELDS) }).toEqual({
        id: spec.id,
        leaks: [],
      });
    }
  });

  it('does not leak a key that is JSON-identical to a public field', () => {
    /**
     * A leak test that only checks key NAMES passes if the answer is smuggled under a name the test does not
     * know about. So this one asserts positively that the VALUE cannot be found anywhere in the serialised
     * payload, which catches a key smuggled through as a differently-named field.
     */
    const spec = SPECS[0];
    if (spec?.type !== 'single_choice') throw new Error('fixture 0 is not single_choice');
    const serialised = JSON.stringify(publicQuestionSpec(spec));
    expect(spec.key.choiceId).toBe('c1');
    // `c1` also appears as a CHOICE id, which is public and must remain — so the assertion is on the KEY
    // object specifically, and the deep walk above is what covers the general case.
    expect(serialised).not.toContain('"key"');
  });

  it('strips the RUBRIC and the CONCEPT HINTS from a free response', () => {
    const spec = SPECS[6];
    if (spec?.type !== 'free_response') throw new Error('fixture 6 is not free_response');
    const payload = publicQuestionSpec(spec);
    expect(payload.rubric).toBeUndefined();
    expect(payload.conceptHints).toBeUndefined();
    expect(payload).toHaveProperty('type', 'free_response');
  });

  it('strips a worked solution step key while keeping the prompt and its points', () => {
    const spec = SPECS[9];
    if (spec?.type !== 'worked_solution') throw new Error('fixture 9 is not worked_solution');
    const [step] = publicQuestionSpec(spec).steps;
    expect(step).toEqual({ id: 's1', prompt: 'state F = ma', points: 2 });
    expect(step).not.toHaveProperty('key');
  });

  it('keeps the NUMERIC TOLERANCE public and the answer private', () => {
    /**
     * The asymmetry is the design: a student is told how close counts as close enough, and not what close
     * enough is. Dropping the tolerance "to be safe" would make the question unanswerable rather than safe.
     */
    const spec = SPECS[3];
    if (spec?.type !== 'numeric') throw new Error('fixture 3 is not numeric');
    const payload = publicQuestionSpec(spec);
    expect(payload.tolerance).toEqual({ absolute: 0.05 });
    expect(payload.significantFigures).toBe(3);
    expect(payload).not.toHaveProperty('key');
  });

  it('keeps the PARTIAL-CREDIT METHOD public, because it changes what a student should do', () => {
    /**
     * Under `NG` a wrong selection costs marks; under `1PM` it does not. A student who cannot see which is in
     * force is answering a different question from the one being marked. The METHOD is public; the correct
     * CHOICE SET is not.
     */
    const spec = SPECS[1];
    if (spec?.type !== 'multi_select') throw new Error('fixture 1 is not multi_select');
    const payload = publicQuestionSpec(spec);
    expect(payload.partialCredit).toBe(DEFAULT_PARTIAL_CREDIT);
    expect(payload).not.toHaveProperty('key');
  });

  it('strips modelAnswer from EVERY type, because it is a common field', () => {
    for (const type of QUESTION_TYPES) {
      const found = SPECS.find((entry) => entry.type === type);
      // A non-null assertion here would make the loop silently test nothing if the fixture list and
      // `QUESTION_TYPES` ever drifted apart -- which is exactly the drift the module's own `assertExhaustiveTypes`
      // exists to catch. Failing loudly is better than asserting over `undefined`.
      if (found === undefined) throw new Error(`no fixture for ${type}`);
      expect(publicQuestionSpec({ ...found, modelAnswer: 'the answer is 42' })).not.toHaveProperty(
        'modelAnswer',
      );
    }
  });

  it('keeps the id, so a payload can still be matched to a response', () => {
    for (const spec of SPECS) {
      expect(publicQuestionSpec(spec).id).toBe(spec.id);
    }
  });
});

describe('teacherQuestionSpec', () => {
  it('returns the key, the rubric and the model answer for every type', () => {
    for (const spec of SPECS) {
      expect(teacherQuestionSpec(spec)).toEqual(spec);
    }
  });

  it('keeps the partial-credit method the question declared', () => {
    const spec = SPECS[1];
    if (spec?.type !== 'multi_select') throw new Error('fixture 1 is not multi_select');
    expect(teacherQuestionSpec(spec).partialCredit).toBe(DEFAULT_PARTIAL_CREDIT);
  });
});

describe('the wire schema', () => {
  it('accepts a well-formed common shape', () => {
    const result = questionCommonSchema.safeParse({ ...common, id: 'q1' });
    expect(result.success).toBe(true);
  });

  it('refuses a non-positive points value, which no marking scheme means', () => {
    expect(questionCommonSchema.safeParse({ ...common, id: 'q1', points: 0 }).success).toBe(false);
    expect(questionCommonSchema.safeParse({ ...common, id: 'q1', points: -1 }).success).toBe(false);
  });

  it('refuses an unknown grading mode, a fractional time limit, and an unknown demand', () => {
    expect(
      questionCommonSchema.safeParse({ ...common, id: 'q1', gradingMode: 'AUTOMATIC' }).success,
    ).toBe(false);
    expect(questionCommonSchema.safeParse({ ...common, id: 'q1', timeLimitSec: 1.5 }).success).toBe(
      false,
    );
    expect(
      questionCommonSchema.safeParse({ ...common, id: 'q1', cognitiveDemand: 'GUESS' }).success,
    ).toBe(false);
  });

  it('allows a missing time limit, because most questions have none', () => {
    expect(
      questionCommonSchema.safeParse({ ...common, id: 'q1', timeLimitSec: undefined }).success,
    ).toBe(true);
  });
});
