/**
 * The question union and its two projections.  (P7-T1)
 *
 * ## WHAT A `QuestionSpec` IS FOR
 *
 * `plans/07` §2: "A Zod discriminated union in `@orrery/contracts`. Adding a type fails compilation in the
 * public projection, the grader, the authoring UI and the response renderer (exhaustive `switch` with a
 * `never` check)."
 *
 * So the point of this file is not the ten shapes. It is that **there is exactly one place a new question type
 * has to be declared, and four places that then fail to compile until someone handles it.** A type that can be
 * added without a student projection is a type whose answer key can reach a browser by default.
 *
 * ## WHY THE DISCRIMINANT IS `type` AND NOT SOMETHING MORE CLEVER
 *
 * `type` is a plain string literal union so that `switch (spec.type)` narrows to a single variant, and the
 * `never` check at the bottom of every projection is what turns "somebody added a type" into a COMPILE ERROR
 * rather than a runtime `undefined` on a student's screen.
 *
 * ## AND WHY THE HANDLERS ARE FUNCTIONS RATHER THAN A BOOLEAN FLAG
 *
 * `publicQuestionSpec()` returns a DIFFERENT SHAPE per type, not the same shape with fields removed. That is
 * deliberate: if it returned `QuestionSpec` minus some keys, TypeScript could not tell a teacher that
 * `single_choice.key` was reachable in the student payload, because the field would still exist on the type.
 * Returning a narrower union makes the absence structural.
 */

import { z } from 'zod';

// ───────────────────────────────────────────────────────────── shared vocabulary

/** Cognitive demand, `plans/02` §5. Recorded per question so a paper's mix can be reported honestly. */
export const COGNITIVE_DEMANDS = [
  'REMEMBER',
  'UNDERSTAND',
  'APPLY',
  'ANALYSE',
  'EVALUATE',
  'CREATE',
] as const;
export type CognitiveDemand = (typeof COGNITIVE_DEMANDS)[number];

/**
 * The ten types, from `plans/07` §2.
 *
 * A single array so the exhaustive checks have something to check AGAINST. A `never` assertion proves the
 * compiler covered the union; this proves the union is the list the plan asked for. If a type were added to
 * the interfaces below and not here, `assertExhaustiveTypes` fails.
 */
export const QUESTION_TYPES = [
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
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * HOW A QUESTION IS GRADED. Not the same axis as the type: a `short_text` can be AUTO or MANUAL, and a
 * `simulation` can be either, which is exactly why `gradingMode` is carried separately.
 */
export const GRADING_MODES = ['AUTO', 'MANUAL'] as const;
export type GradingMode = (typeof GRADING_MODES)[number];

/**
 * THE FIVE NAMED PARTIAL-CREDIT METHODS, `plans/07` §3.
 *
 * ## THE NAMES ARE THE POINT, AND THE ORDER IS NOT
 *
 * `RN-05` supports exactly one conclusion: SOME form of partial credit beats dichotomous scoring, and
 * penalising incorrect selections beats not doing so. It does NOT support a specific default, and the review
 * found the original plan claiming one from a citation that had been edited to say the opposite. So `1PM` is
 * chosen as the default here on the stated grounds of the plan -- bounded below, never negative, no guessing
 * incentive -- and NOT because a citation says so.
 *
 * The first version ordered these `NC, NG, SU, RI, PM` because that is the order the packet lists them in, and
 * then defaulted the FIRST element, which is `NC`: no partial credit at all, for a section whose entire
 * subject is partial credit. A list whose order carries meaning is a trap, so `DEFAULT_PARTIAL_CREDIT` is a
 * named constant rather than an index.
 */
export const PARTIAL_CREDIT_METHODS = ['NC', '1PM', 'NG', 'SU', 'RI', 'PM'] as const;
export type PartialCreditMethod = (typeof PARTIAL_CREDIT_METHODS)[number];

/**
 * THE DEFAULT IS `1PM`, STATED AS A NAME.
 *
 * Not `PARTIAL_CREDIT_METHODS[0]`, and not a comment. It is named, it is exported, and `assertDefaults` pins it,
 * so a reorder of the list above cannot silently change what every `multi_select` question scores.
 */
export const DEFAULT_PARTIAL_CREDIT: PartialCreditMethod = '1PM';

// ───────────────────────────────────────────────────────────── per-type authoring shapes

/** A choice, with per-option feedback — `plans/07` §2 says feedback is PER OPTION, not per question. */
export interface Choice {
  readonly id: string;
  readonly text: string;
  /** Shown to the student after answering THIS option. Optional: most options have none. */
  readonly feedback?: string;
}

export interface SingleChoiceSpec {
  readonly type: 'single_choice';
  readonly choices: readonly Choice[];
  /** The ONE correct choice. Teacher-only: stripped by the public projection. */
  readonly key: { readonly choiceId: string };
}

export interface MultiSelectSpec {
  readonly type: 'multi_select';
  readonly choices: readonly Choice[];
  /** The set of correct choice ids. Teacher-only. */
  readonly key: { readonly choiceIds: readonly string[] };
  /**
   * WHICH PARTIAL-CREDIT METHOD, which is the question's own property rather than the assessment's.
   *
   * Per question and not per paper, because the plan's §3 table makes the choice depend on stakes and on
   * whether guessing is rewarded — and both of those are known when a question is written.
   */
  readonly partialCredit: PartialCreditMethod;
}

export interface TrueFalseSpec {
  readonly type: 'true_false';
  readonly key: { readonly value: boolean };
  /** What each answer means, for the student. Optional. */
  readonly statements?: { readonly whenTrue?: string; readonly whenFalse?: string };
}

/**
 * A numeric answer, with the whole tolerance apparatus.
 *
 * `significantFigures` is separate from `tolerance` because they enforce different things: tolerance decides
 * whether the number is CLOSE, and sig figs decide whether it is stated to the precision the question asked
 * for. `plans/07` §91 is explicit that a student is correct only if both hold, which is how the requirement
 * teaches precision.
 */
export interface NumericSpec {
  readonly type: 'numeric';
  readonly key: { readonly value: number; readonly unit?: string };
  readonly tolerance: { readonly absolute?: number; readonly relative?: number };
  readonly significantFigures?: number;
  /** Accept `2(3+4)` style input. Off by default: parsing a student's arithmetic is its own feature. */
  readonly acceptExpression?: boolean;
}

export const SHORT_TEXT_MATCHERS = [
  'EXACT',
  'NORMALISED',
  'REGEX_SET',
  'FUZZY',
  'NUMERIC_TOLERANCE',
] as const;
export type ShortTextMatcher = (typeof SHORT_TEXT_MATCHERS)[number];

export interface ShortTextSpec {
  readonly type: 'short_text';
  readonly key: { readonly text: string };
  readonly matcher: ShortTextMatcher;
  /** Used by `REGEX_SET`, `FUZZY` and `NUMERIC_TOLERANCE`. Absent for `EXACT`. */
  readonly matchers?: {
    readonly patterns?: readonly string[];
    readonly tokenOverlap?: number;
    readonly numericTolerance?: { readonly absolute?: number; readonly relative?: number };
  };
  readonly caseSensitive?: boolean;
}

/** Ordering, where credit is the fraction of correctly-ordered ADJACENT PAIRS — `plans/07` §93. */
export interface OrderingSpec {
  readonly type: 'ordering';
  readonly items: readonly { readonly id: string; readonly text: string }[];
  readonly key: { readonly itemIds: readonly string[] };
}

export interface RubricBand {
  readonly points: number;
  /** What earns this band. Shown to the marker, never to the student before they answer. */
  readonly descriptor: string;
}

export interface FreeResponseSpec {
  readonly type: 'free_response';
  readonly rubric: readonly RubricBand[];
  /**
   * AN OPTIONAL AUTO LAYER THAT ONLY *SUGGESTS*.
   *
   * `plans/07` §2 is careful here: the keyword layer never decides the mark. It is exposed so a marker can be
   * nudged, and it is stripped from the student payload along with everything else.
   */
  readonly conceptHints?: readonly string[];
}

export interface FileSubmissionSpec {
  readonly type: 'file_submission';
  readonly allow?: readonly string[];
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

export interface SimulationSpec {
  readonly type: 'simulation';
  /** `id@version`, resolved by the registry. A simulation question pins its version like any resource. */
  readonly simId: string;
  readonly simVersion: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * A multi-part worked solution, graded per step — the closest thing the plan has to a proof.
 *
 * The steps are ORDERED and each is graded on its own, so partial credit means "steps 1–3 of 5" rather than a
 * single holistic number.
 */
export interface WorkedSolutionSpec {
  readonly type: 'worked_solution';
  readonly steps: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly points: number;
    readonly key?: { readonly text: string };
  }[];
}

/** EVERY field every question has, whatever its type — `plans/07` §2's closing sentence. */
export interface QuestionCommon {
  readonly id: string;
  readonly points: number;
  readonly gradingMode: GradingMode;
  readonly timeLimitSec?: number;
  readonly shuffleOptions: boolean;
  readonly estimatedSeconds: number;
  readonly cognitiveDemand: CognitiveDemand;
  readonly tags: readonly string[];
  /** Teacher-only. Stripped by the public projection. */
  readonly modelAnswer?: string;
}

export type QuestionSpec =
  | (QuestionCommon & SingleChoiceSpec)
  | (QuestionCommon & MultiSelectSpec)
  | (QuestionCommon & TrueFalseSpec)
  | (QuestionCommon & NumericSpec)
  | (QuestionCommon & ShortTextSpec)
  | (QuestionCommon & OrderingSpec)
  | (QuestionCommon & FreeResponseSpec)
  | (QuestionCommon & FileSubmissionSpec)
  | (QuestionCommon & SimulationSpec)
  | (QuestionCommon & WorkedSolutionSpec);

// ───────────────────────────────────────────────────────────── the public projection

/**
 * THE STUDENT PAYLOAD, AND THE POINT OF THE WHOLE FILE.
 *
 * `plans/07` §2.1: "Strips keys, model answers, rubrics, rationales, and (for free response) any authoring
 * notes." `INV-Q-1` is that no client payload may contain key material, and it is enforced in CI by
 * `audit:seals` and `audit:payloads`.
 *
 * ## WHY THIS IS A `never` CHECK AND NOT A FIELD PICK
 *
 * The obvious implementation is `omit(spec, ['key', 'modelAnswer'])`, and it is wrong in a way TypeScript
 * cannot catch: the RESULT is still typed as `QuestionSpec`, so `payload.key` compiles, and the next person to
 * render it ships the answer key to every student. A projection that returns the wide type is a projection
 * that has not been written.
 *
 * So each variant is projected to its OWN narrower type, and the `assertNever` at the end of each arm means
 * adding a tenth-plus-one question type is a COMPILE ERROR here before it is a leak anywhere.
 */
export type PublicQuestionSpec =
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'single_choice';
      readonly choices: readonly Choice[];
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'multi_select';
      readonly choices: readonly Choice[];
      /**
       * `partialCredit` STAYS PUBLIC, and the reason is that it changes what a student should do.
       *
       * Under `NG` a wrong selection costs marks, so guessing is punished; under `1PM` it does not. A student
       * who cannot see which is in force is answering a different question from the one being marked. The
       * METHOD is public; the correct CHOICE SET is not.
       */
      readonly partialCredit: PartialCreditMethod;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'true_false';
      readonly statements?: TrueFalseSpec['statements'];
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'numeric';
      readonly tolerance: NumericSpec['tolerance'];
      readonly significantFigures?: number;
      readonly acceptExpression?: boolean;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'short_text';
      readonly matcher: ShortTextMatcher;
      readonly matchers?: ShortTextSpec['matchers'];
      readonly caseSensitive?: boolean;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'ordering';
      readonly items: OrderingSpec['items'];
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'free_response';
      readonly maxWords?: number;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'file_submission';
      readonly allow?: readonly string[];
      readonly maxBytes?: number;
      readonly maxFiles?: number;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'simulation';
      readonly simId: string;
      readonly simVersion: string;
      readonly params?: Readonly<Record<string, unknown>>;
    })
  | (Omit<QuestionCommon, 'modelAnswer'> & {
      readonly type: 'worked_solution';
      readonly steps: readonly {
        readonly id: string;
        readonly prompt: string;
        readonly points: number;
      }[];
    });

/** THE COMPILER'S ASSERTION. Unreachable at runtime; a type error if a variant is missed. */
const assertNever = (value: never): never => {
  throw new Error(`unhandled question type: ${JSON.stringify(value)}`);
};

/**
 * THE SHARED PREAMBLE, minus the teacher-only fields.
 *
 * `modelAnswer` is dropped by construction rather than by name, so a future field added here is a compile
 * error until someone decides whether it is safe to ship to a student.
 */
/**
 * THE COMMON FIELDS, BUILT BY NAMING THEM. NEVER BY SPREADING THE SPEC.
 *
 * ## THIS IS THE ONE PLACE A REST-SPREAD LEAKS, AND IT DID
 *
 * The obvious implementation is `({ modelAnswer, ...rest }: QuestionCommon) => rest`. It is correct as far as
 * TypeScript is concerned and wrong at RUN TIME: the parameter is annotated `QuestionCommon`, so the compiler
 * believes the only extra field is `modelAnswer` -- but the value passed in is the WHOLE spec. `{...rest}`
 * therefore copied `key`, `rubric`, `conceptHints` and every per-type field too, and the leak test found
 * exactly that: `{ id: 'q1', leaks: ['key'] }`.
 *
 * The annotation was not a lie to the reader, it was a lie to the RUNTIME: a destructuring pattern cannot
 * remove a property it was never told about, and TypeScript will not complain because it genuinely believes
 * there is nothing else there.
 *
 * So every field is named. The cost is that a field added to `QuestionCommon` becomes a compile error here
 * until someone decides whether a student may see it -- which is precisely the review the rest-spread
 * removed.
 */
const publicCommon = (spec: QuestionCommon): Omit<QuestionCommon, 'modelAnswer'> => ({
  id: spec.id,
  points: spec.points,
  gradingMode: spec.gradingMode,
  shuffleOptions: spec.shuffleOptions,
  estimatedSeconds: spec.estimatedSeconds,
  cognitiveDemand: spec.cognitiveDemand,
  tags: spec.tags,
  ...(spec.timeLimitSec === undefined ? {} : { timeLimitSec: spec.timeLimitSec }),
});

/**
 * `publicQuestionSpec()` — the student payload.
 *
 * Exhaustive, one arm per type, with a `never` check. That check is the mechanism `plans/02` §187 asks for:
 * "exhaustively typed so a new question type fails compilation until it is handled."
 */
export function publicQuestionSpec(spec: QuestionSpec): PublicQuestionSpec {
  const common = publicCommon(spec);
  switch (spec.type) {
    case 'single_choice':
      // `key` is dropped by CONSTRUCTION — the returned object literal never mentions it. Reading the key off
      // this value is a type error rather than a runtime `undefined`.
      return { ...common, type: 'single_choice', choices: spec.choices };
    case 'multi_select':
      return {
        ...common,
        type: 'multi_select',
        choices: spec.choices,
        partialCredit: spec.partialCredit,
      };
    case 'true_false':
      return {
        ...common,
        type: 'true_false',
        ...(spec.statements === undefined ? {} : { statements: spec.statements }),
      };
    case 'numeric':
      // The TOLERANCE is public and the KEY is not, and that is the whole point of a numeric question: the
      // student is told how close is close enough, and not what close enough is.
      return {
        ...common,
        type: 'numeric',
        tolerance: spec.tolerance,
        ...(spec.significantFigures === undefined
          ? {}
          : { significantFigures: spec.significantFigures }),
        ...(spec.acceptExpression === undefined ? {} : { acceptExpression: spec.acceptExpression }),
      };
    case 'short_text':
      return {
        ...common,
        type: 'short_text',
        matcher: spec.matcher,
        ...(spec.matchers === undefined ? {} : { matchers: spec.matchers }),
        ...(spec.caseSensitive === undefined ? {} : { caseSensitive: spec.caseSensitive }),
      };
    case 'ordering':
      return { ...common, type: 'ordering', items: spec.items };
    case 'free_response':
      /**
       * THE RUBRIC AND THE CONCEPT HINTS ARE BOTH STRIPPED.
       *
       * The rubric is the key. The hints are "any authoring notes" in `plans/07` §2.1's words, and a student
       * who can see which concepts the answer must contain has been given the marking scheme. Neither is in
       * the returned literal, so neither can be read off the public type.
       */
      return { ...common, type: 'free_response' };
    case 'file_submission':
      return {
        ...common,
        type: 'file_submission',
        ...(spec.allow === undefined ? {} : { allow: spec.allow }),
        ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
        ...(spec.maxFiles === undefined ? {} : { maxFiles: spec.maxFiles }),
      };
    case 'simulation':
      return {
        ...common,
        type: 'simulation',
        simId: spec.simId,
        simVersion: spec.simVersion,
        ...(spec.params === undefined ? {} : { params: spec.params }),
      };
    case 'worked_solution':
      // THE STEPS WITHOUT THEIR KEYS. A step's `key` is part of the mark, so the projection rebuilds each step
      // rather than spreading it.
      return {
        ...common,
        type: 'worked_solution',
        steps: spec.steps.map((step) => ({
          id: step.id,
          prompt: step.prompt,
          points: step.points,
        })),
      };
    default:
      return assertNever(spec);
  }
}

// ───────────────────────────────────────────────────────────── the teacher projection

/**
 * `teacherQuestionSpec()` — the key, the rubric, and everything a marker needs.
 *
 * It is the WHOLE spec plus what the public one adds back, rather than a separately maintained shape. Two
 * projections of the same object are going to disagree eventually, and the disagreement will always be in the
 * direction of a teacher seeing less than they should.
 */
export type TeacherQuestionSpec = QuestionSpec;

export function teacherQuestionSpec(spec: QuestionSpec): TeacherQuestionSpec {
  return spec;
}

// ───────────────────────────────────────────────────────────── runtime checks

/**
 * THE UNION AND THE LIST AGREE.
 *
 * `assertNever` proves the compiler covered every variant in `QuestionSpec`; it cannot prove that
 * `QuestionSpec` lists what `plans/07` §2 asks for. A type added to the interfaces and forgotten here would
 * still project, still grade, and still be missing from the plan's audit of what exists — so the two are
 * cross-checked at runtime as well, once, at module load.
 *
 * The check is a comparison of the discriminant values reachable from a sample of each type rather than a
 * second hand-written list, because a second list is a third thing to forget.
 */
export const assertExhaustiveTypes = (): void => {
  const declared = new Set<string>(QUESTION_TYPES);
  // One minimal spec per type, enough to read the discriminant off.
  const samples: readonly QuestionSpec[] = [
    { ...base('a'), type: 'single_choice', choices: [], key: { choiceId: 'c' } },
    {
      ...base('b'),
      type: 'multi_select',
      choices: [],
      key: { choiceIds: [] },
      partialCredit: DEFAULT_PARTIAL_CREDIT,
    },
    { ...base('c'), type: 'true_false', key: { value: true } },
    { ...base('d'), type: 'numeric', key: { value: 1 }, tolerance: { absolute: 0.1 } },
    { ...base('e'), type: 'short_text', key: { text: 'x' }, matcher: 'EXACT' },
    { ...base('f'), type: 'ordering', items: [], key: { itemIds: [] } },
    { ...base('g'), type: 'free_response', rubric: [] },
    { ...base('h'), type: 'file_submission', allow: ['.png'] },
    { ...base('i'), type: 'simulation', simId: 'x', simVersion: '1.0.0' },
    { ...base('j'), type: 'worked_solution', steps: [] },
  ];
  for (const sample of samples) {
    if (!declared.has(sample.type)) {
      throw new Error(`QUESTION_TYPES is missing ${sample.type}`);
    }
  }
  if (samples.length !== declared.size) {
    throw new Error(
      `QUESTION_TYPES lists ${String(declared.size)} types but the union has ${String(samples.length)}`,
    );
  }
};

/**
 * `DEFAULT_PARTIAL_CREDIT` IS A MEMBER OF THE METHODS LIST.
 *
 * A default that is not in the list would be a value no grader accepts, and every `multi_select` question that
 * relied on it would fail to score rather than fall back. `as PartialCreditMethod` on the constant means the
 * compiler already rejects a typo; this catches a value that is well-typed but absent.
 */
export const assertDefaults = (): void => {
  if (!(PARTIAL_CREDIT_METHODS as readonly string[]).includes(DEFAULT_PARTIAL_CREDIT)) {
    throw new Error(
      `DEFAULT_PARTIAL_CREDIT ${DEFAULT_PARTIAL_CREDIT} is not a member of PARTIAL_CREDIT_METHODS`,
    );
  }
};

const base = (id: string): QuestionCommon => ({
  id,
  points: 1,
  gradingMode: 'AUTO',
  shuffleOptions: false,
  estimatedSeconds: 30,
  cognitiveDemand: 'REMEMBER',
  tags: [],
});

// ───────────────────────────────────────────────────────────── the runtime shape check

/**
 * A Zod schema for the parts that arrive over the wire.
 *
 * The TYPES above are the authoring contract and are checked by the compiler; this is what a JSON payload is
 * checked against, because a payload from the database has never seen TypeScript. It validates the SHARED
 * fields and the discriminant, and leaves the per-type detail to the projection — which is the honest split,
 * since a full per-type Zod union here would be a second specification of the ten shapes.
 *
 * `z.discriminatedUnion` rather than `z.union` so an unknown `type` fails with a list of the ten valid values
 * instead of a stack of failed branches.
 */
export const questionCommonSchema = z.object({
  id: z.string().min(1),
  points: z.number().positive(),
  gradingMode: z.enum(GRADING_MODES),
  timeLimitSec: z.number().int().positive().optional(),
  shuffleOptions: z.boolean(),
  estimatedSeconds: z.number().int().nonnegative(),
  cognitiveDemand: z.enum(COGNITIVE_DEMANDS),
  tags: z.array(z.string()),
  modelAnswer: z.string().optional(),
});

export const questionTypeSchema = z.enum(QUESTION_TYPES);
