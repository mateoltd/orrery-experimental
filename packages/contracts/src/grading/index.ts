/**
 * `@orrery/grading` — the pure core.  (P7-T2)
 *
 * ## WHY THIS FILE HAS NO `Date.now()` AND NO CLOCK OF ANY KIND
 *
 * `plans/07` §4 lists six properties that make a grader trustworthy, and the first two are the load-bearing
 * ones: **pure** ("no clock, no I/O, no randomness, no network") and **idempotent** ("same input -> byte
 * identical output"). Those two together are what make a regrade auditable rather than a rewrite of history.
 *
 * A grader that reads the clock is not idempotent, and it does not look like it is: two runs an hour apart
 * return different rationales for the same answer, so nobody can tell a logic change from a slow machine. The
 * discipline this project already enforces with `INV-TIME-1` applies here for the same reason, and the only
 * safe way to hold it is that there is no way to reach a clock from this module.
 *
 * ## AND "TOTAL" MEANS NO THROW ESCAPES, INCLUDING FOR HOSTILE INPUT
 *
 * `plans/07` §4: "Every `(spec, response)` pair returns a `GradeOutput`, including malformed, missing, and
 * hostile responses. No throw escapes. A grader that can crash is a grader that can be made to skip a
 * student's grade."
 *
 * That is a security property, not a robustness one. A student who can make the grader throw has found a way to
 * have their paper not marked, and the system's response to an exception is almost always "leave it for a human"
 * -- which is precisely the outcome a motivated student is optimising for. So `grade()` is total by
 * construction: it takes `unknown` for the response, and every branch ends in a `GradeOutput`.
 *
 * ## AND BOUNDED IS CHECKED AT THE EXIT RATHER THAN ASSUMED AT EVERY SITE
 *
 * "0 <= points <= maxPoints always, including on malformed input. Property-tested." Clamping once, at the
 * single point every result leaves through, is what makes that true by construction instead of true by
 * discipline -- a discipline that survives exactly as long as nobody adds a new return path.
 */

import type { QuestionSpec, QuestionType } from '../question/index.js';
import { applyMethod, shareFor } from './methods.js';
import { matchShortText, misorderedPairs, orderingCredit } from './text.js';

/**
 * THE GRADER'S OWN VERSION, and the reason regrades are auditable.
 *
 * Stored per response, so a logic change is an explicit regrade rather than a silent rewrite: yesterday's
 * marks say which version produced them. Without it, "the grader changed last Tuesday" is indistinguishable
 * from "the grader was always wrong", and only one of those can be investigated.
 */
export const GRADER_VERSION = '1.0.0';

/** How a response was scored, as opposed to how it will be marked. */
export type AutoGraderStatus =
  | 'AUTO_GRADED'
  | 'MANUAL_ONLY'
  /** Auto-grading was attempted and produced nothing usable. Never thrown; see `TOTAL` above. */
  | 'MALFORMED'
  /** The response carried a shape this grader version does not know. */
  | 'UNKNOWN_TYPE';

/**
 * WHY a grade looks the way it does, in a form a marker can read and a test can assert on.
 *
 * `code` is a closed set so a UI can switch on it exhaustively; `explanation` is prose for a human and is NOT
 * part of any equality contract, which is why `idempotent` is asserted on `code` and `points`.
 */
export type Rationale = {
  readonly code: RationaleCode;
  readonly explanation: string;
  /** Field-level detail, e.g. which pairs were mis-ordered. Empty rather than undefined for stable shape. */
  readonly detail: Readonly<Record<string, string | number | boolean>>;
};

export const RATIONALE_CODES = [
  'CORRECT',
  'INCORRECT',
  'PARTIAL',
  'BLANK',
  'UNPARSEABLE',
  'MANUAL_REQUIRES_HUMAN',
  'UNKNOWN_QUESTION_TYPE',
] as const;
export type RationaleCode = (typeof RATIONALE_CODES)[number];

/**
 * THINGS A HUMAN NEEDS TO SEE THAT THE SCORE ALONE DOES NOT SAY.
 *
 * `MALFORMED` is the important one: a response that auto-grading could not read is not a zero, and reporting
 * it as zero is how a paper-swap or a transcription error disappears into an average.
 */
export type GradeFlag =
  | 'MALFORMED_RESPONSE'
  | 'EXCUSED'
  | 'QUICK_SCORED'
  | 'NEEDS_HUMAN'
  | 'UNKNOWN_TYPE'
  | 'OUT_OF_RANGE_KEY';

export type GradeOutput = {
  readonly points: number;
  /**
   * THE SCORE BEFORE THE ZERO FLOOR, which `NG` and `PM` can drive NEGATIVE.
   *
   * `plans/07` section 3.2 is explicit that this must be stored rather than clamped in the item: "clamping at
   * zero silently converts NG into no penalty for every student who guessed -- destroying the guessing
   * suppression NG exists to provide -- while keeping the penalty for students who did not guess." The floor
   * belongs in the attempt total and nowhere else.
   *
   * So `points` carries the invariant section 4 property-tests (`0 <= points <= maxPoints`) and `rawPoints`
   * carries what the method actually said. For NC, 1PM and SU the two are equal; for NG and PM they are not.
   */
  readonly rawPoints: number;
  readonly maxPoints: number;
  readonly correct: boolean;
  readonly rationale: Rationale;
  readonly flags: readonly GradeFlag[];
  readonly graderVersion: string;
};

/**
 * THE RESPONSE, AS `unknown`.
 *
 * Deliberately not a typed `ResponseAnswer`. It arrives from JSON written by a browser and read back out of a
 * database column, so it has never been near TypeScript -- and `grade` must survive whatever is actually there,
 * which is what `TOTAL` requires. Typing it would move the malformed case into the type system, where it would
 * be unreachable, and the one input that matters most is the one you cannot describe.
 */
export type RawResponse = unknown;

/**
 * WHAT THE GRADER NEEDS AND NOTHING MORE.
 *
 * `variant` is the drawn variant where a question is randomised, `graderVersion` is the caller's claim about
 * which version is grading, and `seed` is the RNG seed that produced the variant. All three are needed to
 * re-grade identically; a grader that cannot see the variant cannot re-grade a randomised item at all.
 */
export type GradeInput = {
  readonly spec: QuestionSpec;
  readonly response: RawResponse;
  readonly variant?: Readonly<Record<string, unknown>>;
  readonly graderVersion?: string;
  readonly seed?: string;
};

// ───────────────────────────────────────────────────────────── reading untrusted input

/**
 * IS THIS AN OBJECT WE CAN READ FIELDS OFF?
 *
 * `typeof null === 'object'`, so a bare `typeof` check admits `null` and every field read afterwards throws on
 * it. Arrays are excluded too: `Array.isArray` is checked explicitly rather than by `typeof`, because an array
 * has numeric indices and would sail through an object check and then fail every field read.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * THE ANSWER KEY, OR `null` IF IT CANNOT BE READ.  (`plans/07` §4, `total`)
 *
 * ## EVERY HANDLER READS `spec.key`, AND A MISSING KEY IS A THROW IN FIVE PLACES
 *
 * `key` is required by `QuestionSpec`, so none of this is reachable from typed code. But `grade` reads specs
 * out of JSON columns written by authoring tools, and the totality requirement is about RUNTIME input, not
 * about the type: "`grade` must return a `GradeOutput` for every `(spec, response)` pair, including malformed,
 * missing, and hostile inputs."
 *
 * A bank row written by an older build, a half-finished draft saved as a question, or a hand-edited fixture
 * each produce a record with no `key`, and `new Set(spec.key.choiceIds)` throws a `TypeError` from inside the
 * auto-grade loop -- where one unreadable question takes the submission down with it and nothing lands in the
 * attempt log to explain why.
 *
 * So the read is done once, here, and each handler refuses on `null`. A missing key is NOT scored as zero: an
 * absent key is a question nobody knows the answer to, which is a different fact from a student answering
 * wrongly, and `OUT_OF_RANGE_KEY` is the flag that says so.
 */
const readKey = (spec: { key?: unknown }): Record<string, unknown> | null =>
  isRecord(spec.key) ? spec.key : null;

/**
 * THE KEY, AND THE ONE FIELD INSIDE IT THAT THE TYPE ACTUALLY NEEDS -- OR A REFUSAL.
 *
 * ## A RECORD IS NOT A VALID KEY, AND THE DIFFERENCE WAS WORTH A STUDENT'S MARK
 *
 * The first version checked only that `spec.key` was an object. `single_choice` with `key: {choiceIds: null}`
 * passes that check, and then `asString(undefined)` returned `null`, so `given === null` was false for every
 * real answer and the question marked EVERY student wrong -- with `points: 0` and **no flag at all**, which is
 * the worst of the available outcomes: a wrong mark, silently attributed to the students rather than to the
 * question that caused it.
 *
 * So the requirement is stated per type: `choiceId` a string, `value` a boolean or a finite number, `text` a
 * string, `choiceIds` and `itemIds` arrays of strings. A key that fails is refused through the same door as a
 * missing one, because to a marker both mean the same thing: nobody knows what this question's answer is.
 *
 * The parameter asks only for the two fields this function reads, rather than being `Record<string, unknown>`
 * or `unknown`. A typed `QuestionSpec` satisfies `{key?: unknown; points?: unknown}` without a cast, whereas it
 * does NOT satisfy a `Record<string, unknown>` -- an interface has no index signature -- so the alternatives
 * were either a cast at five call sites or a re-check of something `grade` has already proved.
 */
const readTypedKey = <T>(
  spec: { key?: unknown; points?: unknown },
  type: string,
  field: string,
  read: (key: Record<string, unknown>) => T | null,
): { key: Record<string, unknown>; value: T } | GradeOutput => {
  const key = readKey(spec);
  // `grade` has already proved the spec is a record, and `points` has already been read as a number for
  // `maxPoints`, so `?? 0` is for a spec whose `points` is missing or non-finite -- not for a missing object.
  const maxPoints = asNumber(spec.points) ?? 0;
  if (key === null) return unusableKey(maxPoints, type);
  const value = read(key);
  if (value === null) return unusableKey(maxPoints, type, field);
  return { key, value };
};

/** The refusal every handler returns when the key is unreadable. One place, so the wording cannot drift. */
const unusableKey = (maxPoints: number, type: string, field?: string): GradeOutput =>
  emit(
    0,
    maxPoints,
    why(
      'MANUAL_REQUIRES_HUMAN',
      field === undefined
        ? 'This question has no readable answer key, so it was not scored.'
        : `This question's answer key has no readable "${field}", so it was not scored.`,
      field === undefined ? { type } : { type, field },
    ),
    ['NEEDS_HUMAN', 'OUT_OF_RANGE_KEY'],
  );

/**
 * A STRING, OR NOTHING.
 *
 * `String(value)` on a number would turn a student who answered `5` into `"5"` and mark them right for the
 * wrong reason, so the coercion that is convenient here is the coercion that invents answers.
 */
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A FINITE NUMBER. `NaN` and `Infinity` are rejected: both poison every arithmetic result downstream. */
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * AN ARRAY OF STRINGS THAT IS ALL STRINGS, or nothing.
 *
 * The difference from `asStringArray` matters and is not a subtlety. For a RESPONSE, dropping the entries that
 * are not strings is the right recovery, because a browser sent them and half a list beats none. For an ANSWER
 * KEY there is no recovery to make: a key whose list contains a number is a key nobody wrote correctly, and
 * dropping the bad entry would quietly remove an option from the question. So the key reader refuses instead.
 */
const asStrictStringArray = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
  }
  return value as readonly string[];
};

/** AN ARRAY OF STRINGS, or nothing. Elements that are not strings are dropped rather than stringified. */
const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
};

/**
 * IS THE ONE FIELD THIS TYPE READS EMPTY -- OR IS THE ANSWER SOMEWHERE THIS GRADER CANNOT SEE?  (`ADV-S2`)
 *
 * Asked only once a handler has FAILED to read `field`, and it decides between the two zeros that must never be
 * confused: `BLANK`, which stands, and `MALFORMED_RESPONSE`, which goes to a human.
 *
 * ## "THE FIELD IS MISSING" WAS READ AS "NOTHING WAS ANSWERED", AND THOSE ARE NOT THE SAME
 *
 * `PF-5` made a missing or `null` field a `BLANK`, and tested it with `{}`. But `{ state, answer: 5 }` is also an
 * object with no `value` -- a simulation's answer saved against a numeric question, or a client that renamed a
 * field -- and it took the same branch: `BLANK`, zero marks, no flag. The paper meanwhile counted it as ANSWERED,
 * so the two layers disagreed and neither raised anything. That is the silent zero for a pipeline fault that
 * `MALFORMED_RESPONSE` exists to prevent.
 *
 * So a blank is the type's own shape with nothing in it, and there are exactly two ways to write that:
 *
 * - the field is THERE and holds `null` or `undefined` -- a browser sends `null` for a cleared input;
 * - the object is EMPTY -- the shape before anything was put in it.
 *
 * An object that carries something, none of it under the name this type reads, is not empty. Whatever the student
 * answered is in there and cannot be read, which is a fault -- and erring this way costs a marker one look, where
 * erring the other way costs a student a mark nobody will ever look at.
 */
const leftEmpty = (response: Record<string, unknown>, field: string): boolean => {
  const held = response[field];
  if (held !== undefined && held !== null) return false;
  return Object.hasOwn(response, field) || Object.keys(response).length === 0;
};

// ───────────────────────────────────────────────────────────── the exit

/**
 * `-0` BECOMES `0`, AND NOTHING ELSE IS TOUCHED.
 *
 * Named so the intent is visible at the call site: this is NOT a clamp. A negative score is a legitimate
 * value here -- `NG` produces them by design -- and a helper called `clamp` returning `-4` would be the sort of
 * contradiction this file keeps finding.
 */
const normaliseZero = (value: number): number =>
  Object.is(value, -0) ? 0 : Number.isFinite(value) ? value : 0;

/**
 * THE ONE PLACE A `GradeOutput` IS BUILT, and the reason "bounded" is true by construction.
 *
 * `points` is clamped into `[0, maxPoints]` HERE rather than at each of the six type handlers. Those handlers
 * are arithmetic written by different people under time pressure, and a handler that forgets to clamp is a
 * student awarded more than the question was worth -- or a negative mark that fails a schema constraint and
 * takes the whole submission with it.
 *
 * `maxPoints` is also floored at zero here. A question authored with `points: -5` would otherwise produce a
 * range that is empty, and a clamped point value in an empty range is not a number.
 */
const emit = (
  rawPoints: number,
  maxPoints: number,
  rationale: Rationale,
  /**
   * `flags` IS OPTIONAL because most outcomes have none, and a caller passing `[]` at every call site is a
   * caller whose `[]` will eventually be `[]` when it should have been `['NEEDS_HUMAN']`.
   */
  flags: readonly GradeFlag[] = [],
  /** The untransformed score, when it differs from `points`. Defaults to the same value. */
  unbounded?: number,
): GradeOutput => {
  const ceiling = Number.isFinite(maxPoints) && maxPoints > 0 ? maxPoints : 0;
  // `Number.isFinite(rawPoints)` first: `Math.min(Math.max(NaN, 0), 5)` is NaN, and NaN points serialise to
  // `null` in JSON and fail the column constraint at write time rather than at grade time.
  const points = Number.isFinite(rawPoints) ? Math.min(Math.max(rawPoints, 0), ceiling) : 0;
  return {
    points,
    /**
     * THE RAW SCORE IS NOT CLAMPED. THAT IS THE WHOLE POINT OF HAVING IT.
     *
     * The first version of this line was `Math.max(unbounded ?? rawPoints, 0)` -- the same clamp as `points`,
     * applied to the value whose entire purpose is to escape it. `NG` can return `-4`, and a `rawPoints` of
     * `-4` is what `plans/07` section 3.2 requires be stored, because the floor belongs in the attempt total
     * and "clamping at zero silently converts NG into no penalty for every student who guessed".
     *
     * `Number.isFinite` is still required, because a NaN that reaches a stored column fails at write time
     * rather than at grade time. Only the `-0` is normalised: `Math.max(-0, -0)` is `-0`, and `-0` compares
     * unequal to `0` under `Object.is`, so a diff of the two columns would show a change that is not one.
     */
    rawPoints: normaliseZero(unbounded ?? rawPoints),
    maxPoints: ceiling,
    // `correct` is `points === maxPoints` rather than a flag the handlers set, so it cannot disagree with the
    // score it describes. A question worth zero is never "correct", which is why this is a comparison rather
    // than a boolean the handlers pass in.
    correct: ceiling > 0 && points >= ceiling,
    rationale,
    flags,
    graderVersion: GRADER_VERSION,
  };
};

/** THE EXIT FOR A RESPONSE THAT IS NOT A SHAPE WE CAN READ. Blank is distinguished from unparseable. */
const malformed = (
  maxPoints: number,
  detail: Rationale,
  flags: readonly GradeFlag[] = ['MALFORMED_RESPONSE'],
) => emit(0, maxPoints, detail, flags);

/** A rationale with no detail, which is the common case and gets a stable empty object rather than undefined. */
const why = (
  code: RationaleCode,
  explanation: string,
  detail: Record<string, string | number | boolean> = {},
) => ({
  code,
  explanation,
  detail,
});

// ───────────────────────────────────────────────────────────── the per-type handlers

/**
 * THE SIX AUTO-GRADABLE TYPES, and the four that are not.
 *
 * `free_response`, `file_submission` and `worked_solution` are MANUAL by the plan's own table, and
 * `short_text` and `simulation` are AUTO **or** MANUAL. So "not auto-gradable" is a property of the SPEC's
 * `gradingMode` as much as of its type, and a handler that graded a MANUAL `short_text` would pre-empt a
 * marker.
 */
const isAutoGradable = (spec: QuestionSpec): boolean => spec.gradingMode === 'AUTO';

/**
 * THE AUTO-GRADABLE TYPES, and now SIX of them.
 *
 * `ordering` and `short_text` were listed here as "arrive with P7-T4" while `grade()` had no case for either,
 * so a short-text or ordering question marked AUTO fell through to `UNKNOWN_QUESTION_TYPE` and a visible
 * `NEEDS_HUMAN` flag -- correct behaviour, WRONG REASON, and it made the P7 exit criterion ("all auto-grades
 * match the hand-computed fixtures") unreachable for two of the ten types. The fixture table is what found it.
 *
 * `simulation` is the sixth gap and it is DIFFERENT ON PURPOSE. Its grade comes from a sandboxed bundle
 * returning a promise, so it cannot be reached from a function whose contract is pure, total and synchronous
 * without lying about one of those three words. It stays out of `HANDLED` and is graded through
 * `./simulation.ts`, at the worker boundary.
 */
export const HANDLED: readonly QuestionType[] = [
  'single_choice',
  'multi_select',
  'true_false',
  'numeric',
  'short_text',
  'ordering',
];

/** The response shapes each handler reads. Declared per type so a handler cannot read the wrong field. */
type ResponseOf<T extends QuestionType> = Extract<QuestionSpec, { type: T }>;

const gradeSingleChoice = (
  spec: ResponseOf<'single_choice'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'single_choice', 'choiceId', (key) => asString(key.choiceId));
  if (!('key' in read)) return read;
  const given = asString(response.choiceId);
  if (given === null) {
    return malformed(spec.points, why('UNPARSEABLE', 'No option was chosen.'));
  }
  const correct = given === read.value;
  return emit(
    correct ? spec.points : 0,
    spec.points,
    correct
      ? why('CORRECT', 'Correct option chosen.')
      : why('INCORRECT', 'A different option was chosen.', { chosen: given }),
    [],
  );
};

/**
 * MULTI-SELECT, with the partial-credit method DECIDED BY THE QUESTION and not by this module.
 *
 * ## WHY THE METHOD IS AN INPUT RATHER THAN A DEFAULT HERE
 *
 * `plans/07` §3 makes the choice of method a property of the question, because it depends on stakes and on
 * whether guessing is rewarded -- both known when the question is written. A grader that defaulted it would be
 * picking a scoring policy at marking time, and `RN-05` does not name a default; the default lives on the
 * question (`DEFAULT_PARTIAL_CREDIT`) and this module only applies what it is told.
 *
 * ## AND ONLY NC AND 1PM ARE HERE, BECAUSE THE OTHERS ARE P7-T3's WORK
 *
 * `NG`, `SU`, `RI` and `PM` are named in the union and are applied in `@orrery/grading`'s next task. Rather
 * than guess four psychometrics now and have P7-T3 "confirm" them, an unimplemented method returns
 * `NEEDS_HUMAN` -- visible, bounded, and impossible to mistake for a correct zero.
 */
const gradeMultiSelect = (
  spec: ResponseOf<'multi_select'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'multi_select', 'choiceIds', (key) =>
    asStrictStringArray(key.choiceIds),
  );
  if (!('key' in read)) return read;
  const keyIds = read.value;
  const chosen = asStringArray(response.choiceIds);
  if (chosen === null) {
    return malformed(spec.points, why('UNPARSEABLE', 'No set of options was returned.'));
  }

  const method = spec.partialCredit;
  /**
   * THE METHOD IS THE QUESTION'S, AND IT IS APPLIED BY THE ONE SHARED IMPLEMENTATION.
   *
   * `plans/07` section 3 makes the choice depend on stakes and on whether guessing is rewarded, both known when
   * the question is written, so a grader that defaulted it would be picking a scoring policy at marking time --
   * and `RN-05` names no default. The default lives on the question (`DEFAULT_PARTIAL_CREDIT`) and this module
   * only applies what it is told.
   *
   * The arithmetic lives in `./methods.ts` and was INLINE here first. Two copies of six formulas is two places
   * for them to disagree, and the inline one had already drifted from the fixtures before it was replaced.
   */
  const keySet = new Set(keyIds);
  const applied = applyMethod(method, {
    selected: new Set(chosen),
    key: keySet,
    // `M` IS THE FULL OPTION LIST, and the size clauses are meaningless without it: a distractor the student
    // did not tick is invisible in `selected`, so the pool size cannot be recovered from either set.
    optionCount: Array.isArray(spec.choices) ? spec.choices.length : 0,
  });
  const raw = applied.rawCount * shareFor(keySet, spec.points);

  /**
   * AN UNKNOWN SCORING METHOD IS REFUSED, NOT GUESSED.
   *
   * The method name arrives in a JSON column, so `PROP` (published in `plans/07` §3's table and implemented
   * nowhere), a typo, or a name from a newer bank can all arrive here. None of them can be computed, and the
   * tempting fallbacks are both wrong: scoring it `NC` invents a policy, and scoring it zero invents a mark.
   *
   * So the response is reported as needing a human, with the counts the student actually produced so a marker
   * can see the shape of the answer, and the check runs BEFORE the blank check -- a blank response on a
   * question whose method we cannot compute is still an uncomputable question.
   */
  if (applied.unknownMethod !== undefined) {
    return emit(
      0,
      spec.points,
      why(
        'MANUAL_REQUIRES_HUMAN',
        `The scoring method "${applied.unknownMethod}" is not one this grader can apply, so no mark was computed.`,
        {
          method: applied.unknownMethod,
          correctCount: applied.correctCount,
          incorrectCount: applied.incorrectCount,
        },
      ),
      ['NEEDS_HUMAN'],
    );
  }

  if (chosen.length === 0) {
    // BLANK IS NOT INCORRECT, and it is not "no correct options selected" either: a student who answered
    // nothing has told the marker something different from one who chose wrongly.
    return emit(
      0,
      spec.points,
      why('BLANK', 'No options were selected.', { correctCount: applied.correctCount }),
    );
  }

  if (applied.zeroedBySize) {
    return emit(
      raw,
      spec.points,
      why(
        'INCORRECT',
        'More options were selected than there are correct ones, so the score is zero.',
        {
          method,
          selected: chosen.length,
          correctCount: applied.correctCount,
        },
      ),
      [],
      raw,
    );
  }

  const exact = applied.correctCount === keySet.size && applied.incorrectCount === 0;
  const code: RationaleCode = exact
    ? 'CORRECT'
    : raw > 0 && raw < spec.points
      ? 'PARTIAL'
      : 'INCORRECT';

  /**
   * A NEGATIVE RAW SCORE IS FLAGGED, because `points` will read zero and a marker looking at `points` alone
   * would see an ordinary wrong answer rather than a penalised one.
   */
  const flags: GradeFlag[] = applied.negative ? ['NEEDS_HUMAN'] : [];
  const explanation = applied.negative
    ? `Scored ${String(raw)} of ${String(spec.points)}, below zero, because method ${method} deducts for ` +
      'incorrect selections. The zero floor is applied in the attempt total; this item does not apply it.'
    : exact
      ? 'Every correct option and nothing else.'
      : code === 'PARTIAL'
        ? 'Some credit earned.'
        : 'No credit earned.';

  return emit(
    raw,
    spec.points,
    why(code, explanation, {
      method,
      hits: applied.correctCount,
      correctCount: applied.correctCount,
    }),
    flags,
    raw,
  );
};

const gradeTrueFalse = (
  spec: ResponseOf<'true_false'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'true_false', 'value', (key) =>
    typeof key.value === 'boolean' ? key.value : null,
  );
  if (!('key' in read)) return read;
  if (typeof response.value !== 'boolean') {
    return malformed(spec.points, why('UNPARSEABLE', 'No true/false answer was returned.'));
  }
  const correct = response.value === read.value;
  return emit(
    correct ? spec.points : 0,
    spec.points,
    correct
      ? why('CORRECT', 'Correct.')
      : why('INCORRECT', 'Incorrect.', { given: response.value }),
    [],
  );
};

/**
 * NUMERIC, and BOTH halves of "correct" FROM `plans/07` §91.
 *
 * "Correct only if within tolerance **and** stated to at least the required significant figures." Those are
 * different failures: 9.8 is close to 9.81 and may still be wrong to the precision the question demanded, and
 * 9.81 written as `9.810000` is not made more correct by the trailing zeros. So the tolerance is checked and
 * then the sig figs are checked, and failing the second is a real zero rather than a rounding courtesy.
 *
 * ## AND THE SIGNIFICANT-FIGURE COUNT IS DONE ON THE WRITTEN FORM
 *
 * Counting digits on `String(value)` counts the representation the student typed only if the value came from
 * their input untouched. `Number('9.810')` is `9.81`, so the trailing zero is already gone by the time the
 * number reaches here. The response carries the raw text alongside the value for exactly this reason, and this
 * is why the sig-fig rule is checked against `response.raw` when it is present and skipped when it is not --
 * SKIPPED, not assumed-passed, and the difference is reported in the rationale.
 */
const gradeNumeric = (
  spec: ResponseOf<'numeric'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'numeric', 'value', (key) => asNumber(key.value));
  if (!('key' in read)) return read;
  const expected = read.value;
  const value = asNumber(response.value);
  if (value === null) {
    /**
     * ABSENT IS A BLANK AND UNREADABLE IS A FAULT, AND THE TWO WERE CONFLATED HERE.
     *
     * A numeric field the student never filled in arrives as `{value: null}` or as `{}` -- a browser sends `null`
     * for a cleared input. That is an UNANSWERED question, and `plans/07`'s `BLANK` code exists for exactly it.
     * Reporting `UNPARSEABLE` instead raised a `MALFORMED_RESPONSE` flag on every unanswered numeric question, so
     * a marker saw a list of platform faults on a paper where nothing had gone wrong.
     *
     * A value that is PRESENT and unreadable -- a string, an object, `NaN` -- is still a fault, and still malformed.
     * So is an object with no `value` that is carrying something ELSE: see `leftEmpty`.
     */
    if (leftEmpty(response, 'value')) {
      return emit(0, spec.points, why('BLANK', 'No number was returned.'));
    }
    return malformed(spec.points, why('UNPARSEABLE', 'The number returned could not be read.'));
  }
  /**
   * THE BOUND IS THE LOOSER OF THE TWO, AND AN ABSENT ONE IS ZERO RATHER THAN INFINITY.
   *
   * The first version wrote `absolute ?? Infinity` and then SUMMED: `absolute + relative * |expected|`. With a
   * relative-only tolerance -- a perfectly ordinary authoring choice, and the only sensible one when the
   * expected value spans orders of magnitude -- `Infinity + anything` is `Infinity`, so the bound was
   * infinite and **every number was within tolerance**. A question authored with `tolerance: {relative: 0.01}`
   * and a key of 100 marked 200 as correct, and `tolerance: {}` marked everything correct.
   *
   * The arithmetic is the other half of the bug: summing means "absolute AND relative", which is the TIGHTER
   * of the two, and no convention reads "absolute/relative tolerance" that way.
   *
   * So: an absent bound is zero, and the two are compared with `Math.max`. A question with neither declared
   * gets a bound of zero and therefore requires exact equality -- which is the correct reading of "no
   * tolerance" and the opposite of treating the absence as unlimited.
   */
  /**
   * THE KEY'S VALUE AND THE TOLERANCE, BOTH READ AS UNTRUSTED.
   *
   * `expected` is coerced to a number with a fallback of 0 rather than read as `spec.key.value`, because a key
   * whose value is a string would make every `Math.abs` below compare against NaN and quietly mark everything
   * wrong. `tolerance` is checked as a record because `plans/07` §4's totality is about runtime input, and this
   * spec came out of a JSON column.
   */
  const tolerance = isRecord((spec as { tolerance?: unknown }).tolerance)
    ? (spec as { tolerance: { absolute?: number; relative?: number } }).tolerance
    : {};
  const absolute = tolerance.absolute ?? 0;
  const relative = (tolerance.relative ?? 0) * Math.abs(expected);
  const bound = Math.max(absolute, relative);
  const within = Math.abs(value - expected) <= bound;
  if (!within) {
    return emit(
      0,
      spec.points,
      why('INCORRECT', 'Outside the allowed tolerance.', {
        given: value,
        expected,
        bound,
      }),
      [],
    );
  }

  const required = spec.significantFigures;
  if (required === undefined) {
    return emit(
      spec.points,
      spec.points,
      why('CORRECT', 'Within tolerance.', { given: value, expected }),
      [],
    );
  }

  const raw = asString(response.raw);
  if (raw === null) {
    return emit(
      spec.points,
      spec.points,
      /**
       * THE SIG-FIG RULE IS SKIPPED, NOT ASSUMED PASSED, and the rationale says so.
       *
       * A client that sends only `{value}` has destroyed the information the rule needs, and silently treating
       * that as "correct to the required precision" would award full marks on an unanswerable question. The
       * mark is right -- the number IS within tolerance -- and the explanation is honest about what was not
       * checked, so a marker can see it.
       */
      why(
        'CORRECT',
        'Within tolerance; significant figures not checkable without the written form.',
        {
          given: value,
          requiredFigures: required,
        },
      ),
      [],
    );
  }

  const written = significantFigures(raw);
  const enough = written >= required;
  return emit(
    enough ? spec.points : 0,
    spec.points,
    enough
      ? why('CORRECT', 'Within tolerance and stated precisely enough.', {
          given: value,
          written,
          required,
        })
      : why('INCORRECT', 'Within tolerance but not stated to enough significant figures.', {
          written,
          required,
        }),
    [],
  );
};

/**
 * SIGNIFICANT FIGURES IN A WRITTEN NUMBER, with the leading-zero rules that make it correct.
 *
 * `0.00981` has THREE significant figures, not five: the zeros after the leading zero and before the first
 * non-zero digit are placeholders, not information. A naive `String(x).replace('.', '').length` counts them and
 * would mark a correct answer wrong on exactly the numbers where precision is the point -- which is the whole
 * reason the rule exists.
 *
 * Scientific notation is read as written: `9.81e-2` is three figures, not six.
 */
export const significantFigures = (raw: string): number => {
  const trimmed = raw.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (match === null) return 0;
  /**
   * BOTH `?? ''`s ARE LOAD-BEARING, and I removed them once on the reasoning that `(\d*)` always participates.
   *
   * That is true of group 2 and FALSE of group 3, because group 3 sits inside an OPTIONAL group:
   * `(?:\.(\d*))?` matches nothing at all when there is no decimal point, so `match[3]` is `undefined` for
   * `100` and the cast to `string` changes nothing at RUNTIME. The result was
   * `` `${'1'}${undefined}` `` -> `'1undefined'`, nine digits, so `100` reported as nine significant figures
   * and every test of it failed at once.
   *
   * A cast silences the compiler without changing the value, which is the same lesson as the rest-spread in
   * `publicCommon`: the annotation was not a lie to the reader, it was a lie to the runtime.
   */
  /**
   * GROUP 2 IS `(\d*)` AND GROUP 3 IS INSIDE AN OPTIONAL `(?:\.(\d*))?`, so THEY DIFFER.
   *
   * `match[2]` always participates -- zero-or-more digits matches the empty string rather than declining -- so
   * its `?? ''` is unreachable and is NOT written. `match[3]` sits inside an optional group that matches
   * nothing when there is no decimal point, so for `100` it really is `undefined` and its `?? ''` is
   * load-bearing: `'1' + undefined` is the nine-character string `'1undefined'`, and `100` came out as nine
   * significant figures.
   *
   * I removed both once on the reasoning that `(\d*)` always participates. True of one, false of the other,
   * and every sig-fig test failed at once. The lesson is the same as the rest-spread in `publicCommon`: a
   * regular-expression group and a cast are both things that LOOK like they have already been ruled out, and
   * only running the value tells you which.
   */
  const whole = match[2] as string;
  const fraction = match[3] ?? '';
  /**
   * THE TWO HALVES ARE TREATED DIFFERENTLY, AND GETTING THAT WRONG MARKS A CORRECT ANSWER INCORRECT.
   *
   * Trailing zeros are placeholders in the INTEGER part and significant in the FRACTION: `100` is one figure
   * written imprecisely, and `9.810` is four, stated to four. The first version stripped trailing zeros from
   * the concatenated digits and so reported 3 for `9.810`, failing exactly the case the rule is for -- a
   * student who wrote one more figure than asked and was marked wrong for it.
   *
   * Leading zeros are placeholders in BOTH halves: `0.00981` is three figures, not six.
   */
  const trimmedWhole = whole.replace(/0+$/, '');
  const digits = `${trimmedWhole}${fraction}`.replace(/^0+/, '');
  return digits === '' ? 0 : digits.length;
};

/**
 * `short_text` -- DELEGATES, AND PUTS THE TOKEN DIFF IN THE RATIONALE.
 *
 * The matching itself lives in `./text.ts` and is already covered there. What is added here is the SHAPE:
 * `plans/07` section 3.4 requires the rationale to show a diff "because a teacher must never be asked to trust an
 * opaque score", and a diff that is not in the `GradeOutput` is a diff nobody sees.
 *
 * `REGEX_SET` is the one matcher that can be broken by the AUTHOR rather than the student -- a pattern that
 * does not compile matches nothing -- so it raises `NEEDS_HUMAN`. Reporting that as a plain zero would mark a
 * student's paper wrong for a typo in a question bank.
 */
const gradeShortText = (
  spec: ResponseOf<'short_text'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'short_text', 'text', (key) => asString(key.text));
  if (!('key' in read)) return read;
  const text = asString(response.text);
  if (text === null) {
    // As for `numeric`: absent is a blank, present-and-unreadable is a fault, and `leftEmpty` says which.
    if (leftEmpty(response, 'text')) {
      return emit(0, spec.points, why('BLANK', 'No text was returned.'));
    }
    return malformed(spec.points, why('UNPARSEABLE', 'The text returned could not be read.'));
  }
  /**
   * WHITESPACE IS A BLANK, NOT AN ANSWER.
   *
   * `EXACT` would score `'   '` against a key of `'photosynthesis'` as simply wrong, so the mark is zero either
   * way -- but the RATIONALE differs, and `BLANK` is what tells a marker the difference between a question left
   * empty and one the student tried and got wrong. `gradePaper`'s `clearedOwnField` trims for the same reason, so
   * without this the two layers disagreed about the same response.
   */
  if (text.trim() === '') {
    return emit(0, spec.points, why('BLANK', 'No text was returned.'));
  }
  const verdict = matchShortText(read.value, text, {
    matcher: spec.matcher,
    ...(spec.matchers ?? {}),
  });
  const flags: GradeFlag[] = [];
  if ((verdict.invalidPatterns ?? []).length > 0) flags.push('NEEDS_HUMAN');
  return emit(
    verdict.correct ? spec.points : 0,
    spec.points,
    verdict.correct
      ? why('CORRECT', `Matched with ${verdict.matcher}.`, { matcher: verdict.matcher })
      : why('INCORRECT', `No ${verdict.matcher} match.`, {
          matcher: verdict.matcher,
          matched: verdict.diff.matched.join(' '),
          missing: verdict.diff.missing.join(' '),
          extra: verdict.diff.extra.join(' '),
          ...(verdict.invalidPatterns === undefined
            ? {}
            : { invalidPatterns: verdict.invalidPatterns.join(' ') }),
        }),
    flags,
  );
};

/**
 * `ordering` -- THE FRACTION OF CORRECTLY ORDERED ADJACENT PAIRS, times the question's points.
 *
 * ## WHY ADJACENCY AND NOT "MATCHES THE KEY SOMEWHERE"
 *
 * The thing being assessed by an ordering question is the SEQUENCE, so a response that contains every item in
 * the right order but with two adjacent items transposed is not correct -- and a method that only checked
 * membership would mark it correct. Counting correct transitions measures what was taught.
 *
 * `misorderedPairs` names the specific transitions in the rationale for the same reason the token diff is in
 * the short-text one: a marker looking at "3 of 4" needs to be told WHICH pair to look at.
 *
 * And a response that is not a permutation of the key is NOT this function's problem -- unknown items are
 * skipped by the pair count, so the score is bounded by construction rather than by a check that could be
 * forgotten.
 */
const gradeOrdering = (
  spec: ResponseOf<'ordering'>,
  response: Record<string, unknown>,
): GradeOutput => {
  const read = readTypedKey(spec, 'ordering', 'itemIds', (key) => asStrictStringArray(key.itemIds));
  if (!('key' in read)) return read;
  const keyIds = read.value;
  const given = asStringArray(response.itemIds);
  if (given === null) {
    return malformed(spec.points, why('UNPARSEABLE', 'No ordering was returned.'));
  }
  /**
   * A BLANK IS REPORTED AS A BLANK, not as a wrong ordering.
   *
   * `orderingCredit` scores an empty response zero, which stops it being marked correct -- but "the student
   * ordered nothing" and "the student ordered it wrongly" are different events, and only the first of those is
   * something a marker or a re-sit decision needs to see. `BLANK` is in the closed rationale set for exactly
   * this, and the distinction survives into the attempt total rather than being flattened to a zero here.
   */
  if (given.length === 0) {
    return emit(0, spec.points, why('BLANK', 'No ordering was returned.'));
  }
  const fraction = orderingCredit(keyIds, given);
  const correct = fraction >= 1;
  const wrongPairs = misorderedPairs(keyIds, given);
  return emit(
    spec.points * fraction,
    spec.points,
    correct
      ? why('CORRECT', 'Every adjacent pair is in order.')
      : why('PARTIAL', `${wrongPairs.length} adjacent pair(s) out of order.`, {
          fraction,
          misordered: wrongPairs.join(' '),
        }),
  );
};

// ───────────────────────────────────────────────────────────── the entry point

/**
 * `grade(input)` — PURE, TOTAL, IDEMPOTENT.
 *
 * A function of its arguments and nothing else: no clock, no I/O, no randomness, no network. `variant` and
 * `seed` are read and reported, never used to generate anything, because a grader that DRAWS would be a
 * different function each time it was called with the same values.
 *
 * ## EVERY PATH RETURNS, INCLUDING THE ONES THAT SHOULD BE IMPOSSIBLE
 *
 * The switch covers each type, `HANDLED` covers the implemented subset, and both `default` arms end in
 * `never`. A spec whose `type` is not in `HANDLED` returns `NEEDS_HUMAN` rather than throwing, and a response
 * that is not a record returns `MALFORMED_RESPONSE` rather than throwing on a field read. Those two are the
 * difference between a grader that can be made to skip a student's paper and one that cannot.
 */
export function grade(input: GradeInput): GradeOutput {
  const spec = input.spec;
  const response = input.response;

  // A SPEC IS NOT AN OBJECT EITHER. The signature types it, but `grade` is exported and callable from a route
  // handler that may have decoded a body rather than looked one up.
  if (!isRecord(spec)) {
    return emit(0, 0, why('UNKNOWN_QUESTION_TYPE', 'The question could not be read.'), [
      'UNKNOWN_TYPE',
    ]);
  }
  const maxPoints = asNumber(spec.points) ?? 0;

  if (!isAutoGradable(spec as QuestionSpec)) {
    // MANUAL BY DECLARATION, which is not a failure. Marking a `free_response` is the plan's main product, and
    // an auto-grader that second-guessed it would be pre-empting a marker on every essay.
    return emit(
      0,
      maxPoints,
      why('MANUAL_REQUIRES_HUMAN', 'This question is marked by hand.', {
        type: String((spec as { type?: unknown }).type ?? 'unknown'),
      }),
      ['NEEDS_HUMAN'],
    );
  }

  if (!isRecord(response)) {
    return malformed(maxPoints, why('UNPARSEABLE', 'The response could not be read as an answer.'));
  }

  // The cast is checked by `HANDLED` above and by the compiler's exhaustiveness in each handler.
  switch ((spec as { type: QuestionType }).type) {
    case 'single_choice':
      return gradeSingleChoice(spec as ResponseOf<'single_choice'>, response);
    case 'multi_select':
      return gradeMultiSelect(spec as ResponseOf<'multi_select'>, response);
    case 'true_false':
      return gradeTrueFalse(spec as ResponseOf<'true_false'>, response);
    case 'numeric':
      return gradeNumeric(spec as ResponseOf<'numeric'>, response);
    case 'short_text':
      return gradeShortText(spec as ResponseOf<'short_text'>, response);
    case 'ordering':
      return gradeOrdering(spec as ResponseOf<'ordering'>, response);
    /**
     * THE DEFAULT, AND IT IS WHAT ANSWERS "no auto-grader is registered for this type".
     *
     * There was also a `HANDLED.includes(...)` guard ABOVE this switch returning the same answer, which wrote
     * the list of implemented types down twice and made this arm unreachable -- so `plans/07` §4's "100% branch"
     * was unreachable for a reason that had nothing to do with grading. A guard that duplicates what it guards
     * is a second thing to forget, and this copy is the one that would have been missed.
     *
     * The switch is now the only list. A type added without a handler lands HERE, returns a bounded
     * `NEEDS_HUMAN`, and cannot crash, which is the `total` property holding at the one place a new type will
     * actually be forgotten.
     */
    default:
      return emit(
        0,
        maxPoints,
        why(
          'UNKNOWN_QUESTION_TYPE',
          `No auto-grader is registered for ${String((spec as { type?: unknown }).type)}.`,
          {
            type: String((spec as { type?: unknown }).type ?? 'unknown'),
            // NAMED, so a report of ungraded questions says which task owns them.
            // `simulation` is the only remaining entry, and it names a FILE rather than a task number,
            // because its handler exists: the grade comes from a sandboxed bundle as a promise, so it cannot
            // be reached from a synchronous pure function without breaking one of those words.
            planned: 'grading/simulation.ts',
          },
        ),
        ['UNKNOWN_TYPE', 'NEEDS_HUMAN'],
      );
  }
}

/**
 * A GRADER'S VERSION IS A CONSTANT, NOT A FUNCTION OF ITS INPUT.
 *
 * There was an accessor here taking a `GradeInput` and ignoring it, which read as though the version could
 * depend on the input -- so a caller could reasonably expect a `variant` carrying its own `graderVersion` to
 * change the answer. It cannot: this module IS one version. The caller's claim is deliberately not consulted,
 * because a caller claiming to be a different grader while running this one produces a version string that
 * disagrees with the marks, and the audit of "which grader produced this" stops meaning anything.
 *
 * `GRADER_VERSION` is exported and is stamped on every `GradeOutput`, including the ones produced by hostile
 * input. There is nothing to look up.
 */
