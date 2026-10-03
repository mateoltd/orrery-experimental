/**
 * `sim.manifest.json`, mirrored in Zod, plus the rules a schema cannot express.  (P6-T2)
 *
 * ## WHY THERE ARE TWO IMPLEMENTATIONS AT ALL
 *
 * `plans/10` §3: "JSON Schema is the source of truth; Zod mirrors it." The reason for both is real:
 * JSON Schema is what tooling, editors and other systems read, while Zod gives the host a parsed,
 * typed manifest with defaults applied and no `as` casts at every call site.
 *
 * Two implementations of one contract drift. So the guarantee here is BEHAVIOURAL: a fixture battery
 * of manifests is run through both, and every fixture must be accepted by both or rejected by both.
 * A structural "the Zod schema looks like the JSON" assertion would pass while the two disagreed
 * about a real manifest, which is the failure that matters.
 *
 * ## THE RULES A SCHEMA CANNOT EXPRESS
 *
 * Three of `plans/10` §3.1's rules are cross-field or arithmetic, so they live in functions rather
 * than in keywords:
 *
 *  - `capabilities.grading === true` requires a `grading` block. JSON Schema's `if/then` would do it
 *    but our validator deliberately does not implement `if/then`, and "the validator silently ignores
 *    it" is the exact failure this validator exists to prevent.
 *  - `accessibility.keyboard` must be `true` when the lower `ageRange` bound is below 16.
 *  - `TOLERANCE` grading must declare at least one of `absolute`/`relative`, and the parameter
 *    editor needs every numeric param's `default` inside its own `[minimum, maximum]`.
 */

import { z } from 'zod';

// ───────────────────────────────────────────────── the mirror

export const simIdSchema = z
  .string()
  .max(80)
  // The first segment is the SUBJECT, and the subject enum contains `computing-science` and
  // `general-science`, so it has to be allowed a hyphen. It was not, which meant a simulation on
  // either of those subjects could not be given an id beginning with its own subject -- found by
  // `sim:validate` refusing `computing-science.download-time`.
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u,
    'must be subject.slug, where the subject is one of the declared subjects',
  );

export const semverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?$/u, 'must be semver');

export const subjectSchema = z.enum([
  'maths',
  'physics',
  'chemistry',
  'biology',
  'computing',
  'astronomy',
  'geography',
  'computing-science',
  'general-science',
]);

/** No exceptions: this is how we avoid shipping something we cannot license. */
export const licenceSchema = z.enum([
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC0-1.0',
  'MIT',
  'OFL-1.1',
  'PUBLIC-DOMAIN',
]);

export const provenanceSchema = z
  .string()
  .regex(/^(ORIGINAL|PORTED|INSPIRED_BY:.+)$/u, 'must be ORIGINAL, PORTED or INSPIRED_BY:<ref>');

/** Always relative, always inside the sim directory: a URL makes the bundle unhashable. */
/**
 * Relative, and inside the sim directory. The negative lookaheads are load-bearing: the character
 * class alone permits `..`, because `.` is an allowed character, so `./../secrets/browser.js`
 * matched the first version of this pattern and every `entry` field became an arbitrary read.
 *
 * Only a `..` SEGMENT is traversal, so `./a/..b/c.js` stays legal and `./..js` does too — both are
 * odd filenames inside the sim directory and neither escapes it. The lookaheads require a `/` or
 * the end of the path after the dots.
 */
export const relativeEntrySchema = z
  .string()
  .regex(
    /^\.\/(?!\.\.\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.(?:js|css)$/u,
    'must be a relative path inside the sim directory, ending in .js or .css',
  );

export const accessibilitySchema = z.object({
  keyboard: z.boolean(),
  screenReaderSummary: z.string().min(20).max(600),
  reducedMotion: z.boolean(),
  textAlternative: z.string().min(20).max(600),
  focusOrder: z.array(z.string()).default([]),
});

export const paramPropertySchema = z.object({
  type: z.enum(['number', 'integer', 'boolean', 'string', 'enum']),
  label: z.string().min(1).max(60),
  unit: z.string().max(20).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  step: z.number().positive().optional(),
  // Deliberately `z.unknown()`: the JSON Schema says `{}`, which accepts any value including
  // `undefined`, and a stricter Zod would reject a manifest the schema accepts. The two have to
  // agree, so the looseness is copied rather than improved.
  default: z.unknown(),
  enumValues: z.array(z.string()).min(1).optional(),
  description: z.string().max(300).optional(),
});

export const paramsSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), paramPropertySchema),
  required: z.array(z.string()).default([]),
});

export const capabilitiesSchema = z.object({
  state: z.boolean(),
  grading: z.boolean(),
  randomised: z.boolean(),
  audio: z.boolean(),
  webgl: z.boolean(),
  stepper: z.boolean(),
  scenarios: z.array(z.string()).default([]),
});

export const plainObjectSchema = z.object({ type: z.literal('object') });

export const gradingSchema = z.object({
  strategy: z.enum(['EXACT', 'TOLERANCE', 'SET', 'ORDER', 'NUMERIC', 'RUBRIC']),
  maxPoints: z.number().min(0.25).max(100),
  tolerance: z
    .object({
      absolute: z.number().min(0).optional(),
      relative: z.number().min(0).optional(),
    })
    .optional(),
  partialCredit: z.boolean(),
  rationaleTemplate: z.string().max(500).optional(),
});

export const lifecycleSchema = z.object({
  autoPlay: z.boolean().default(false),
  defaultHeight: z.number().int().min(240).max(1200),
  minHeight: z.number().int().min(160).max(1200).optional(),
  // `W/H`, as `plans/10` §3 writes it. A first pass used `W:H` and every valid manifest in the
  // plan's own example was rejected by it, which is the clearest possible statement that a spec's
  // example is part of the spec.
  aspectRatio: z
    .string()
    .regex(/^[1-9]\d*\/[1-9]\d*$/u)
    .optional(),
});

const expectationSchema = z.union([
  z.number(),
  z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      in: z.array(z.unknown()).min(1).optional(),
      set: z.array(z.unknown()).min(1).optional(),
      sequence: z.array(z.unknown()).min(1).optional(),
      /** A TEXT answer, compared verbatim. */
      exact: z.string().optional(),
      prefix: z.string().min(4).optional(),
    })
    .strict(),
]);

export const conformanceSchema = z.object({
  script: z
    .array(
      z.object({
        // `click` drives the simulation's OWN controls from Node, which is the only way to exercise an
        // interaction the simulation implements itself rather than injecting an answer past it.
        command: z.enum(['setParams', 'command', 'click', 'wait', 'requestState', 'reset']),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1),
  /**
   * What a STUDENT would enter, keyed by the sim's own field name (`{ intercept: 2 }`).
   *
   * Deliberately separate from `expect`. The two answer different questions: one is the INPUT, the other
   * is the claim about the OUTPUT. A simulation that computes its own answer has nothing to type, and one
   * that asks the student for a number has nothing to submit without this — so the conformance runner
   * fills these in before activating the submit control.
   *
   * Putting the expected answer here instead would mean typing the expectation into the field and then
   * asserting the simulation reports it, which is a test that cannot fail for the reason anyone would
   * write it. That mistake is worth a field of its own to avoid.
   */
  type: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  expect: z.object({
    // ONE SHAPE, USED TWICE, SO THE TWO CANNOT DRIFT.
    //
    // The JSON Schema and this mirror are checked against each other by `gate:schema`, and they had
    // already drifted once: `expect.value` was added to the runner for a simulation whose answer is a
    // bare number, and the runner -- which is not validated -- accepted it while both schemas refused it.
    // A contract that only one of three consumers enforces is not a contract.
    answer: z.record(z.string(), expectationSchema).optional(),
    /** For an answer that IS a number. `answer` is keyed, for `{quantity, value}` and `{roots: [...]}`. */
    value: expectationSchema.optional(),
    grade: z.number().min(0).optional(),
    stateChecksumPrefix: z.string().min(4).optional(),
  }),
  capturesPath: z.string().regex(/^\.\//u).optional(),
});

/**
 * How a conformance cell judges one value: an exact number, a range, membership in a list, or a set
 * compared WITHOUT ORDER. The last one exists because a quadratic's roots are an answer whose order is
 * not part of the answer, and a positional comparison marks a correct pair wrong half the time.
 */
export const simManifestSchema = z
  .object({
    id: simIdSchema,
    version: semverSchema,
    title: z.string().min(3).max(120),
    summary: z.string().min(10).max(400),
    authors: z.array(z.string().min(1)).default([]),
    licence: licenceSchema,
    provenance: provenanceSchema,
    // `1`, and only 1. A host that can speak two protocol revisions cannot tell which one a sim is
    // using, and "probably the same" is how a frame ends up half-interpreted.
    protocol: z.literal(1),
    subjects: z.array(subjectSchema).min(1),
    tags: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u)).default([]),
    ageRange: z.tuple([z.number().int().min(3).max(21), z.number().int().min(3).max(21)]),
    accessibility: accessibilitySchema,
    entry: relativeEntrySchema,
    grader: relativeEntrySchema,
    styles: relativeEntrySchema.optional(),
    budget: z.object({ maxBytes: z.number().int().min(1024).max(1_200_000) }),
    params: paramsSchema,
    capabilities: capabilitiesSchema,
    stateSchema: plainObjectSchema,
    answerSchema: plainObjectSchema,
    grading: gradingSchema.optional(),
    lifecycle: lifecycleSchema,
    conformance: conformanceSchema.optional(),
    deprecated: z.boolean().default(false),
    replacedById: simIdSchema.optional(),
  })
  .strict();

export type SimManifest = z.infer<typeof simManifestSchema>;

// ───────────────────────────────────────────────── the rules a schema cannot express

/**
 * Why a manifest is refused.
 *
 * A local union rather than a reuse of `SimErrorCode`, because importing the protocol's taxonomy
 * would make `@orrery/contracts` depend on `@orrery/sim-sdk` for four string literals — and the
 * manifest is validated long before anything speaks `sim-host@1`. The codes the CLI shares with the
 * protocol are the three that describe a sim rather than its manifest, and those are listed here so
 * the overlap is visible instead of accidental.
 */
export type ManifestProblemCode =
  | 'MANIFEST_INVALID'
  | 'GRADING_MISSING'
  | 'KEYBOARD_REQUIRED'
  | 'TOLERANCE_MISSING'
  | 'DEFAULT_OUT_OF_RANGE'
  | 'AGE_RANGE_INVERTED'
  /** Shared with the protocol: the entry or grader file is not there. */
  | 'HANDSHAKE_FAILED'
  /** Shared: the bundle is larger than `budget.maxBytes`. */
  | 'BUDGET_EXCEEDED'
  /** Shared: three identical runs did not produce identical output. */
  | 'DETERMINISM_FAILED'
  /** Shared: the grader touched I/O, a clock, or unseeded randomness. */
  | 'PROHIBITED_API';

export interface ManifestProblem {
  /** A JSON pointer into the manifest, so the message is actionable. */
  readonly pointer: string;
  readonly code: ManifestProblemCode;
  readonly message: string;
}

const problem = (pointer: string, code: ManifestProblemCode, message: string): ManifestProblem => ({
  pointer,
  code,
  message,
});

/**
 * The cross-field and arithmetic rules.  (`plans/10` §3.1)
 *
 * Pure: it takes a parsed manifest and returns problems. The rules that need the filesystem, Node
 * or three grader runs are the CLI's job, because doing them here would make this function
 * untestable without a disk.
 */
export function checkManifestRules(manifest: SimManifest): ManifestProblem[] {
  const out: ManifestProblem[] = [];

  // `plans/10` §3: grading is "required when capabilities.grading is true". A sim that claims to
  // grade and declares no strategy has an answer nobody can score, and a student finds out.
  if (manifest.capabilities.grading && manifest.grading === undefined) {
    out.push(
      problem(
        '/grading',
        'GRADING_MISSING',
        'capabilities.grading is true but no grading block was declared, so an answer could be ' +
          'produced that nothing knows how to score',
      ),
    );
  }
  if (!manifest.capabilities.grading && manifest.grading !== undefined) {
    out.push(
      problem(
        '/grading',
        'MANIFEST_INVALID',
        'a grading block was declared but capabilities.grading is false, so the host would never ' +
          'ask for an answer to grade',
      ),
    );
  }

  if (manifest.grading?.strategy === 'TOLERANCE') {
    const t = manifest.grading.tolerance;
    if (t === undefined || (t.absolute === undefined && t.relative === undefined)) {
      out.push(
        problem(
          '/grading/tolerance',
          'TOLERANCE_MISSING',
          'TOLERANCE grading with no absolute and no relative bound accepts every answer and ' +
            'rejects nothing, which is not a tolerance',
        ),
      );
    }
  }

  // A keyboard-inaccessible sim for under-16s is refused. Not advisory: the sim is the question,
  // and a student who cannot operate the question has been excluded from the assessment.
  if (manifest.ageRange[0] < 16 && !manifest.accessibility.keyboard) {
    out.push(
      problem(
        '/accessibility/keyboard',
        'KEYBOARD_REQUIRED',
        `ageRange starts at ${String(manifest.ageRange[0])}, so accessibility.keyboard must be ` +
          'true. A sim is the question surface in graded mode, so a student who cannot operate it ' +
          'has been excluded from the assessment rather than given an accommodation.',
      ),
    );
  }

  if (manifest.ageRange[0] > manifest.ageRange[1]) {
    out.push(
      problem(
        '/ageRange',
        'AGE_RANGE_INVERTED',
        `the range ${String(manifest.ageRange[0])}-${String(manifest.ageRange[1])} runs backwards`,
      ),
    );
  }

  // A default outside the param's own range is the classic authoring slip: the sim works at 25 and
  // the host renders an editor whose every value is invalid.
  for (const [name, prop] of Object.entries(manifest.params.properties)) {
    const value = prop.default;
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < prop.minimum) {
        out.push(
          problem(
            `/params/properties/${name}/default`,
            'DEFAULT_OUT_OF_RANGE',
            `default ${String(value)} is below the minimum ${String(prop.minimum)}`,
          ),
        );
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        out.push(
          problem(
            `/params/properties/${name}/default`,
            'DEFAULT_OUT_OF_RANGE',
            `default ${String(value)} is above the maximum ${String(prop.maximum)}`,
          ),
        );
      }
    }
    if (
      prop.type === 'enum' &&
      (prop.enumValues === undefined || !prop.enumValues.includes(String(value)))
    ) {
      out.push(
        problem(
          `/params/properties/${name}/default`,
          'DEFAULT_OUT_OF_RANGE',
          'an enum param has no default, or one that is not among its enumValues',
        ),
      );
    }
  }

  // A required param with no default is unsatisfiable on first mount: `sim:init` would arrive with
  // the param absent and the sim would have to invent one.
  for (const name of manifest.params.required) {
    if (!(name in manifest.params.properties)) {
      out.push(
        problem(
          `/params/required/${name}`,
          'MANIFEST_INVALID',
          'a required param is not declared in properties',
        ),
      );
    }
  }

  // `deprecated` without a successor is a dead end for an author mid-lesson.
  if (manifest.deprecated && manifest.replacedById === undefined) {
    out.push(
      problem(
        '/replacedById',
        'MANIFEST_INVALID',
        'the sim is marked deprecated with no replacedById, so an author who opens it is told it ' +
          'is going away and not where to go',
      ),
    );
  }
  if (manifest.deprecated && manifest.replacedById === manifest.id) {
    out.push(problem('/replacedById', 'MANIFEST_INVALID', 'a sim cannot replace itself'));
  }

  return out;
}

/**
 * The catalogue-facing subset, and the ONLY projection that reaches a student's browser.
 *
 * `plans/10` §9: "the catalogue fetches a metadata index, never code." This is that index, and it
 * has no `entry`, no `grader` and no `params` — so a catalogue page cannot be used to load a
 * bundle by fetching a URL out of a listing.
 */
export function catalogueEntry(manifest: SimManifest): {
  id: string;
  version: string;
  title: string;
  summary: string;
  subjects: readonly string[];
  tags: readonly string[];
  ageRange: readonly [number, number];
  screenReaderSummary: string;
  textAlternative: string;
  budgetBytes: number;
  defaultHeight: number;
  deprecated: boolean;
  replacedById: string | null;
} {
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    summary: manifest.summary,
    subjects: manifest.subjects,
    tags: manifest.tags,
    ageRange: manifest.ageRange,
    screenReaderSummary: manifest.accessibility.screenReaderSummary,
    textAlternative: manifest.accessibility.textAlternative,
    budgetBytes: manifest.budget.maxBytes,
    defaultHeight: manifest.lifecycle.defaultHeight,
    deprecated: manifest.deprecated,
    replacedById: manifest.replacedById ?? null,
  };
}
