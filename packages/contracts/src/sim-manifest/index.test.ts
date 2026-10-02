/**
 * Two implementations of one contract, kept honest by a fixture battery.  (P6-T2)
 *
 * ## THE TEST THAT MATTERS
 *
 * `sim.manifest.schema.json` is the source of truth and `simManifestSchema` mirrors it. Two
 * implementations drift. The obvious guard — assert the Zod schema "looks like" the JSON — passes
 * while the two disagree about a real manifest, which is the failure that matters.
 *
 * So the guarantee is BEHAVIOURAL: every fixture in `valid` is accepted by the JSON Schema AND by
 * Zod; every fixture in `invalid` is rejected by both. A disagreement on any fixture is a defect,
 * and the fixture names say what behaviour each one pins.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSchemaIsSupported, UnsupportedKeywordError, validate } from '../jsonschema/index.js';
import {
  catalogueEntry,
  checkManifestRules,
  type ManifestProblem,
  type SimManifest,
  simManifestSchema,
} from './index.js';

// `packages/contracts/src/sim-manifest/` is four levels below the repository root. Three
// resolved to `packages/`, which is why the first run read a path that did not exist.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCHEMA_PATH = join(root, 'schemas/sim.manifest.schema.json');
const JSON_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'maths.projectile-motion',
  version: '2.1.0',
  title: 'Projectile motion',
  summary: 'Explore how launch speed and angle change range and flight time.',
  authors: ['A. Namer'],
  licence: 'CC-BY-4.0',
  provenance: 'ORIGINAL',
  protocol: 1,
  subjects: ['maths'],
  tags: ['kinematics', 'vectors'],
  ageRange: [13, 18],
  accessibility: {
    keyboard: true,
    screenReaderSummary: 'A graph of height against time for a thrown ball, with a trail.',
    reducedMotion: true,
    textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45 degrees.',
  },
  entry: './browser.js',
  grader: './grader.js',
  styles: './style.css',
  budget: { maxBytes: 350_000 },
  params: {
    type: 'object',
    properties: {
      speed: {
        type: 'number',
        label: 'Launch speed',
        unit: 'm/s',
        minimum: 5,
        maximum: 60,
        default: 25,
      },
      angle: {
        type: 'number',
        label: 'Launch angle',
        unit: '°',
        minimum: 5,
        maximum: 85,
        default: 45,
      },
    },
    required: ['speed', 'angle'],
  },
  capabilities: {
    state: true,
    grading: true,
    randomised: true,
    audio: false,
    webgl: false,
    stepper: true,
    scenarios: ['no-air', 'drag-linear'],
  },
  stateSchema: { type: 'object' },
  answerSchema: { type: 'object' },
  grading: {
    strategy: 'TOLERANCE',
    maxPoints: 4,
    tolerance: { absolute: 0.5, relative: 0.02 },
    partialCredit: true,
    rationaleTemplate: 'Range is {answer.range} m; correct is {expected.range} m.',
  },
  lifecycle: { autoPlay: false, defaultHeight: 420, minHeight: 240, aspectRatio: '16/10' },
  conformance: {
    script: [
      { command: 'setParams', args: { speed: 25, angle: 45 } },
      { command: 'command', args: { name: 'step' } },
    ],
    expect: { answer: { range: { min: 55, max: 65 } }, grade: 1 },
    capturesPath: './captures',
  },
  ...over,
});

const withParam = (name: string, prop: Record<string, unknown>): Record<string, unknown> => {
  const params = base().params as { properties: Record<string, unknown>; required: string[] };
  return base({
    params: {
      ...params,
      properties: { ...params.properties, [name]: prop },
    },
  });
};

/** Fixtures that must be ACCEPTED. Each name pins a behaviour worth keeping. */
const valid: readonly { readonly name: string; readonly manifest: Record<string, unknown> }[] = [
  { name: 'the example from plans/10 §3', manifest: base() },
  {
    name: 'a lesson sim: no grading, no state, and no conformance script',
    manifest: base({
      capabilities: {
        state: false,
        grading: false,
        randomised: false,
        audio: false,
        webgl: false,
        stepper: false,
        scenarios: [],
      },
      grading: undefined,
      conformance: undefined,
    }),
  },
  {
    name: 'an empty param set, for a sim with nothing to vary',
    manifest: base({ params: { type: 'object', properties: {} } }),
  },
  {
    name: 'INSPIRED_BY provenance, which is recorded rather than laundered',
    manifest: base({ provenance: 'INSPIRED_BY:phET/pendulum-lab' }),
  },
  {
    name: 'a prerelease version',
    manifest: base({ version: '1.0.0-rc.1' }),
  },
  {
    name: 'a deprecation WITH a successor',
    manifest: base({ deprecated: true, replacedById: 'maths.projectile-motion-2' }),
  },
  {
    name: 'a numeric param with a fractional default and a step',
    manifest: base({
      params: {
        type: 'object',
        properties: {
          gravity: {
            type: 'number',
            label: 'Gravity',
            unit: 'm/s2',
            minimum: 1.6,
            maximum: 24.8,
            step: 0.1,
            default: 9.81,
          },
        },
        required: ['gravity'],
      },
    }),
  },
];

/** Fixtures that must be REJECTED. Each name is the rule it pins. */
const invalid: readonly {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  readonly why: string;
}[] = [
  {
    name: 'a protocol other than 1',
    manifest: base({ protocol: 2 }),
    why: 'a host that speaks two revisions cannot tell which one a sim is using',
  },
  {
    name: 'an unrecognised licence',
    manifest: base({ licence: 'WTFPL' }),
    why: 'this is how we avoid shipping something we cannot license',
  },
  { name: 'an EMPTY provenance', manifest: base({ provenance: '' }), why: 'no exceptions' },
  {
    name: 'an ABSOLUTE entry URL',
    manifest: base({ entry: 'https://cdn.example/browser.js' }),
    why: 'a URL makes the bundle unhashable',
  },
  {
    name: 'an entry with a path traversal',
    manifest: base({ entry: './../secrets/browser.js' }),
    why: 'the path must stay inside the sim directory',
  },
  {
    name: 'an unknown top-level key',
    manifest: base({ secretBackdoor: true }),
    why: 'additionalProperties is false so a typo cannot be silently accepted',
  },
  {
    name: 'a budget above the 1.2 MB hard ceiling',
    manifest: base({ budget: { maxBytes: 2_000_000 } }),
    why: '§9 sets a hard ceiling',
  },
  { name: 'a one-element age range', manifest: base({ ageRange: [13] }), why: 'it is a range' },
  {
    name: 'an empty subjects list',
    manifest: base({ subjects: [] }),
    why: 'a sim belongs to at least one subject',
  },
  {
    name: 'a screen reader summary of three words',
    manifest: base({
      accessibility: {
        keyboard: true,
        screenReaderSummary: 'A graph.',
        reducedMotion: true,
        textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s.',
      },
    }),
    why: 'it is not a summary',
  },
  {
    name: 'a param with no label',
    manifest: withParam('x', { type: 'number', default: 1 }),
    why: 'the host renders the label and has nothing to render',
  },
  {
    name: 'a conformance script that is empty',
    manifest: base({ conformance: { script: [], expect: {} } }),
    why: 'an empty script tests nothing and passes',
  },
  {
    name: 'a grading strategy that does not exist',
    manifest: base({ grading: { strategy: 'VIBES', maxPoints: 1, partialCredit: false } }),
    why: 'the strategy set is closed',
  },
];

describe('the JSON Schema itself', () => {
  it('parses, and uses ONLY keywords the validator implements', () => {
    // The property that makes this validator honest. An unsupported keyword is an error, so a
    // schema nobody fully implemented cannot quietly under-check itself.
    expect(() => assertSchemaIsSupported(JSON_SCHEMA)).not.toThrow();
  });

  it('the validator REFUSES a keyword it does not implement, rather than ignoring it', () => {
    const naive = { type: 'object', patternProperties: { '^x': { type: 'string' } } };
    // `patternProperties` IS implemented. `dependentSchemas` is not, and pretending otherwise is
    // exactly the failure mode this design exists to prevent.
    const unsupported = { type: 'object', dependentSchemas: { a: { type: 'string' } } };
    expect(() => validate({}, naive as never)).not.toThrow();
    expect(() => validate({}, unsupported as never)).toThrow(UnsupportedKeywordError);
    try {
      validate({}, unsupported as never);
    } catch (error) {
      expect((error as Error).message).toContain('dependentSchemas');
      expect((error as Error).message).toMatch(/error rather than a pass/);
    }
  });

  it('the schema file is where the comment says it is, and it is the source of truth', () => {
    expect(SCHEMA_PATH.endsWith('schemas/sim.manifest.schema.json')).toBe(true);
    expect(JSON_SCHEMA.$id).toContain('sim.manifest.schema.json');
    expect(JSON_SCHEMA.title).toBe('Orrery simulation manifest');
  });
});

describe('the two implementations agree', () => {
  for (const fixture of valid) {
    it(`BOTH accept: ${fixture.name}`, () => {
      const jsonErrors = validate(fixture.manifest, JSON_SCHEMA);
      const parsed = simManifestSchema.safeParse(fixture.manifest);
      expect(jsonErrors.map((e) => `${e.pointer} ${e.keyword}`)).toEqual([]);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });
  }

  for (const fixture of invalid) {
    it(`BOTH reject: ${fixture.name} — ${fixture.why}`, () => {
      const jsonErrors = validate(fixture.manifest, JSON_SCHEMA);
      const parsed = simManifestSchema.safeParse(fixture.manifest);
      expect(jsonErrors.length, 'the JSON Schema accepted it').toBeGreaterThan(0);
      expect(parsed.success, 'Zod accepted it').toBe(false);
    });
  }
});

/**
 * Fixtures the schema CANNOT reject, so only the rules layer catches them.
 *
 * "Compare the two elements of an array" is not expressible in `$defs`/`properties`/`minimum` with
 * the keyword set this validator implements, and it would need `if/then` or `$data` — which the
 * validator deliberately refuses to half-support. So these manifests are ACCEPTED by the JSON Schema
 * and by Zod and REFUSED by `checkManifestRules`, and the group exists so that boundary is a test
 * rather than a comment.
 */
const rulesOnly: readonly {
  readonly name: string;
  readonly manifest: Record<string, unknown>;
  readonly expect: RegExp;
}[] = [
  {
    name: 'an inverted age range',
    manifest: base({ ageRange: [18, 11] }),
    expect: /runs backwards/,
  },
  {
    name: 'a TOLERANCE grading block with no bound at all',
    manifest: base({ grading: { strategy: 'TOLERANCE', maxPoints: 4, partialCredit: true } }),
    expect: /accepts every answer and rejects nothing/,
  },
  {
    name: 'a default above its own maximum',
    manifest: base({
      params: {
        type: 'object',
        properties: {
          speed: { type: 'number', label: 'Speed', minimum: 5, maximum: 60, default: 500 },
        },
        required: ['speed'],
      },
    }),
    expect: /above the maximum/,
  },
  {
    name: 'a deprecation with no successor',
    manifest: base({ deprecated: true }),
    expect: /not where to go/,
  },
];

describe('the rules layer catches what the schema cannot', () => {
  for (const fixture of rulesOnly) {
    it(`schema accepts, rules refuse: ${fixture.name}`, () => {
      expect(validate(fixture.manifest, JSON_SCHEMA)).toEqual([]);
      const parsed = simManifestSchema.safeParse(fixture.manifest);
      expect(parsed.success, 'Zod should also accept it; this is a rules-layer rule').toBe(true);
      const problems = checkManifestRules(simManifestSchema.parse(fixture.manifest));
      expect(problems.map((p) => `${p.pointer} ${p.message}`).join(' ')).toMatch(fixture.expect);
    });
  }
});

describe('the rules a schema cannot express', () => {
  const check = (over: Record<string, unknown>): ManifestProblem[] =>
    checkManifestRules(simManifestSchema.parse(base(over)));

  it('grades: true with no grading block is refused, because nothing could score the answer', () => {
    const problems = check({ grading: undefined });
    expect(problems.map((p) => p.code)).toContain('GRADING_MISSING');
    expect(problems.find((p) => p.code === 'GRADING_MISSING')?.pointer).toBe('/grading');
  });

  it('a grading block with grades: false is refused, because the host would never ask', () => {
    const problems = check({
      capabilities: {
        state: true,
        grading: false,
        randomised: true,
        audio: false,
        webgl: false,
        stepper: true,
        scenarios: [],
      },
    });
    expect(problems.map((p) => p.message).join(' ')).toMatch(
      /never.*ask for an answer|could be produced/,
    );
  });

  it('TOLERANCE with no bound at all is refused: it accepts everything', () => {
    const problems = check({
      grading: { strategy: 'TOLERANCE', maxPoints: 4, partialCredit: true },
    });
    expect(problems.map((p) => p.code)).toContain('TOLERANCE_MISSING');
  });

  it('keyboard is REQUIRED below 16, and it is not advisory', () => {
    const problems = check({
      ageRange: [13, 18],
      accessibility: {
        keyboard: false,
        screenReaderSummary: 'A graph of height against time for a thrown ball, with a trail.',
        reducedMotion: true,
        textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45 degrees.',
      },
    });
    const problem = problems.find((p) => p.code === 'KEYBOARD_REQUIRED');
    expect(problem).toBeDefined();
    // The message says why it is a refusal rather than a warning, because the natural response to a
    // warning is to ship it and fix it later.
    expect(problem?.message).toMatch(/excluded from the assessment/);
  });

  it('keyboard is not required at 16 and above', () => {
    const problems = check({
      ageRange: [16, 18],
      accessibility: {
        keyboard: false,
        screenReaderSummary: 'A graph of height against time for a thrown ball, with a trail.',
        reducedMotion: true,
        textAlternative: 'Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45 degrees.',
      },
    });
    expect(problems.map((p) => p.code)).not.toContain('KEYBOARD_REQUIRED');
  });

  it('a default OUTSIDE its own range is refused, by pointer', () => {
    const problems = check({
      params: {
        type: 'object',
        properties: {
          speed: { type: 'number', label: 'Speed', minimum: 5, maximum: 60, default: 500 },
        },
        required: ['speed'],
      },
    });
    const problem = problems.find((p) => p.code === 'DEFAULT_OUT_OF_RANGE');
    expect(problem?.pointer).toBe('/params/properties/speed/default');
    expect(problem?.message).toMatch(/above the maximum/);
  });

  it('an enum param whose default is not among its values is refused', () => {
    const problems = check({
      params: {
        type: 'object',
        properties: {
          mode: { type: 'enum', label: 'Mode', enumValues: ['fast', 'slow'], default: 'medium' },
        },
        required: ['mode'],
      },
    });
    expect(problems.map((p) => p.code)).toContain('DEFAULT_OUT_OF_RANGE');
  });

  it('a required param that is not declared is refused', () => {
    const problems = check({
      params: { type: 'object', properties: {}, required: ['ghost'] },
    });
    expect(problems.map((p) => p.message).join(' ')).toMatch(/required param is not declared/);
  });

  it('a deprecation with no successor is refused, because it is a dead end mid-lesson', () => {
    expect(
      check({ deprecated: true })
        .map((p) => p.message)
        .join(' '),
    ).toMatch(/not where to go/);
    expect(check({ deprecated: true, replacedById: 'maths.projectile-motion-2' })).toEqual([]);
  });

  it('a sim cannot replace itself', () => {
    const problems = check({ deprecated: true, replacedById: 'maths.projectile-motion' });
    expect(problems.map((p) => p.message).join(' ')).toMatch(/cannot replace itself/);
  });

  it('a good manifest has NO problems', () => {
    expect(checkManifestRules(simManifestSchema.parse(base()))).toEqual([]);
  });
});

describe('the catalogue projection', () => {
  it('carries NO entry, NO grader and NO params, so a listing cannot be used to load a bundle', () => {
    const entry = catalogueEntry(simManifestSchema.parse(base())) as Record<string, unknown>;
    expect(entry.entry).toBeUndefined();
    expect(entry.grader).toBeUndefined();
    expect(entry.params).toBeUndefined();
    expect(entry.capabilities).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual([
      'ageRange',
      'budgetBytes',
      'defaultHeight',
      'deprecated',
      'id',
      'replacedById',
      'screenReaderSummary',
      'subjects',
      'summary',
      'tags',
      'textAlternative',
      'title',
      'version',
    ]);
  });

  it('carries the TEXT ALTERNATIVE, because a catalogue page is where it is needed', () => {
    // A catalogue page with a screenshot and no text is useless to a screen-reader user, and the
    // text alternative is the one thing that makes the screenshot redundant.
    const entry = catalogueEntry(simManifestSchema.parse(base()));
    expect(entry.textAlternative).toMatch(/Height falls to 0/);
    expect(entry.screenReaderSummary.length).toBeGreaterThan(20);
  });

  it('normalises a missing replacedById to null rather than leaving it undefined', () => {
    const entry = catalogueEntry(simManifestSchema.parse(base()));
    expect(entry.replacedById).toBeNull();
  });
});

describe('the manifest type is what the rest of the platform wants', () => {
  it('SimManifest is exported and usable, not just the schema', () => {
    const manifest: SimManifest = simManifestSchema.parse(base());
    expect(manifest.id).toBe('maths.projectile-motion');
    // Defaults are APPLIED by Zod, which is half the reason for having it: the host never has to
    // write `manifest.tags ?? []`.
    expect(manifest.tags).toEqual(['kinematics', 'vectors']);
    expect(manifest.deprecated).toBe(false);
    expect(manifest.lifecycle.autoPlay).toBe(false);
    expect(manifest.authors).toEqual(['A. Namer']);
  });

  it('a missing optional list comes back as [], so the host has one code path', () => {
    const minimal = simManifestSchema.parse(base({ tags: undefined, authors: undefined }));
    expect(minimal.tags).toEqual([]);
    expect(minimal.authors).toEqual([]);
    expect(minimal.lifecycle.autoPlay).toBe(false);
  });
});
