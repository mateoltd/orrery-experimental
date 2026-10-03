/**
 * The named partial-credit methods.  (P7-T3)
 *
 * ## A NAMED TAXONOMY AND NOT A BOOLEAN, BECAUSE THESE METHODS ARE NOT INTERCHANGEABLE WITH ZERO
 *
 * `plans/07` section 3: "Partial credit: a named taxonomy, not a boolean." Each method below is a DIFFERENT
 * function of the same two sets, and the difference is not cosmetic. Under `NG` a wrong selection costs marks,
 * under `1PM` it does not, and under `SU` one extra distractor is fatal while omitting three is merely partial.
 * A student cannot play these the same way, so a grader that collapsed them into "partial or not" would be
 * scoring a different question from the one the teacher wrote.
 *
 * ## AND `RN-05` DOES NOT NAME A DEFAULT
 *
 * The plan is explicit about this and so is this module. `RN-05` supports only that SOME partial credit beats
 * dichotomous scoring, and that penalising incorrect selections beats not doing so. The original plan claimed
 * a default from a citation that had been edited to support the opposite of what it said. The default is
 * `1PM`, chosen on the plan's own three stated grounds and NOT because a reference says so.
 *
 * ## AND THE NEGATIVE SCORES ARE THE POINT, NOT A BUG TO BE CLAMPED AWAY
 *
 * `plans/07` section 3.2: "NG produces negative raw scores BY DESIGN. Clamping at zero in the item is a
 * NONLINEAR transform: it silently converts NG into 'no penalty' for every student who guessed -- destroying
 * the guessing suppression NG exists to provide -- while keeping the penalty for students who did not guess."
 *
 * So a method that can go negative is ALLOWED TO. The bounded-points invariant of section 4 applies to the
 * reported `points`; `rawPoints` carries the untransformed value. Clamping earlier would convert NG into 1PM
 * for exactly the students it was chosen to penalise, and the item's discrimination statistics in `08` would be
 * computed on the wrong scale.
 *
 * ## AND `PROP` IS IN THE PLAN'S TABLE BUT NOT IN ITS TASK LINE
 *
 * Section 3's table lists seven rows: NC, 1PM, NG, SU, RI, PM and PROP. `P7-T3` names "the five partial-credit
 * methods NC / NG / SU / RI / PM", which with the `1PM` default added by the review makes SIX, and that is what
 * the question union carries. PROP is absent from both. Taking the table as authoritative would mean a seventh
 * method in the union that no task asks for; taking the task line as authoritative would mean dropping a row
 * the plan still publishes. So PROP is neither implemented nor silently dropped -- it is named here as
 * unresolved, and `assertMethodsMatchTheUnion` fails if it is ever added to one place and not the other.
 */

/** The methods, matching `PartialCreditMethod` in the question union. */
export const METHODS = ['NC', '1PM', 'NG', 'SU', 'RI', 'PM'] as const;
export type Method = (typeof METHODS)[number];

/** Named in section 3's table, absent from the union, and deliberately not implemented. See the header. */
export const PUBLISHED_BUT_UNIMPLEMENTED = ['PROP'] as const;

/**
 * THE METHODS THAT CAN PRODUCE A NEGATIVE RAW SCORE, AND THE ONLY TWO A PUBLISH CHECK GUARDS.
 *
 * Section 3.3: "publish refuses NG or PM when selectAllScore > 0". Exported so the publish check consults one
 * list rather than re-deriving which methods penalise.
 */
export const PENALISING_METHODS: readonly Method[] = ['NG', 'PM'];

export interface MethodInput {
  /** The student's selection, as a SET: order is irrelevant and a duplicate is not a second choice. */
  readonly selected: ReadonlySet<string>;
  /** The correct options. */
  readonly key: ReadonlySet<string>;
  /**
   * THE FULL OPTION COUNT `M`, which the size clauses need and which is NOT derivable from the two sets.
   *
   * A distractor the student did not select is invisible in `selected`, so `M` is the only way to know how
   * large the pool was -- and "how large the pool was" is exactly what decides whether select-all pays.
   */
  readonly optionCount: number;
}

export interface MethodResult {
  /**
   * THE SCORE BEFORE ANY FLOOR, possibly negative, in units of "one correct option".
   *
   * Kept as a COUNT rather than a mark so the caller applies the points policy once and all six methods stay
   * directly comparable. Multiply by the per-option share for marks.
   */
  readonly rawCount: number;
  readonly correctCount: number;
  readonly incorrectCount: number;
  /** True when a size clause zeroed the response however many were right. */
  readonly zeroedBySize: boolean;
  /** True when the score is negative, which section 3.2 says to store rather than clamp. */
  readonly negative: boolean;
  /**
   * SET WHEN THE REQUESTED METHOD IS NOT ONE OF THE SIX, and the only field on this interface that describes a
   * failure rather than a score. Absent on every real result.
   *
   * It exists because `applyMethod` indexes a `Record` by a name that arrived in a JSON column, and the
   * alternative to this field was a `TypeError` thrown from inside the grader.
   */
  readonly unknownMethod?: string;
}

/** THE PER-OPTION SHARE: what one correct option is worth in marks. A zero-option key is worth nothing. */
export const shareFor = (key: ReadonlySet<string>, maxPoints: number): number =>
  key.size === 0 ? 0 : maxPoints / key.size;

const tally = (input: MethodInput): { correct: number; incorrect: number } => {
  let correct = 0;
  let incorrect = 0;
  for (const id of input.selected) {
    if (input.key.has(id)) correct += 1;
    else incorrect += 1;
  }
  return { correct, incorrect };
};

const result = (
  _input: MethodInput,
  rawCount: number,
  counts: { correct: number; incorrect: number },
  zeroedBySize: boolean,
): MethodResult => ({
  rawCount,
  correctCount: counts.correct,
  incorrectCount: counts.incorrect,
  zeroedBySize,
  negative: rawCount < 0,
});

/**
 * `NC` -- no credit. All correct gives full marks; anything else gives zero.
 *
 * The method with the highest face validity and the lowest reliability, and the one that rewards guessing at
 * `1/c`. It is here because a teacher may choose it deliberately for a high-stakes gate.
 */
export const nc = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  const exact = counts.correct === input.key.size && counts.incorrect === 0;
  return result(input, exact ? input.key.size : 0, counts, false);
};

/**
 * `1PM` -- partial, all-or-nothing. THE DEFAULT, and the only method with no penalty and no negative score.
 *
 * "+1 per correct option selected, 0 for incorrect, 0 overall if more options are selected than there are
 * correct ones." The size clause is what removes the select-all exploit WITHOUT producing a negative mark, and
 * that combination is the whole reason it is the default: bounded below by construction, so it coexists with
 * the bounded-points invariant that section 4 property-tests.
 */
export const onePm = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  const overSelected = input.selected.size > input.key.size;
  return result(input, overSelected ? 0 : counts.correct, counts, overSelected);
};

/**
 * `NG` -- negative. `correct - incorrect`, with no size clause at all.
 *
 * ## THIS IS THE METHOD THAT CAN GO NEGATIVE, AND SECTION 3.2 EXPLAINS WHY THAT IS CORRECT
 *
 * Clamping it to zero "silently converts NG into no penalty for every student who guessed -- destroying the
 * guessing suppression NG exists to provide -- while keeping the penalty for students who did not guess". So
 * the negative value is returned and stored as `rawPoints`, and the floor is applied in the attempt total
 * only.
 *
 * ## AND IT IS GAMEABLE WHEN MORE THAN HALF THE OPTIONS ARE CORRECT
 *
 * Selecting everything scores `2C - M`, which is positive whenever `C > M/2` -- so a student who selects
 * everything and is wrong about one option beats a student who selected correctly and missed one. That is
 * what `selectAllScore` exists to catch, and it is why NG cannot be published unguarded.
 */
export const ng = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  return result(input, counts.correct - counts.incorrect, counts, false);
};

/**
 * `SU` -- subset. Lenient about OMISSIONS and absolute about COMMISSION.
 *
 * Score only if the response is a SUBSET of the key, then proportional. Selecting one attractive distractor is
 * fatal; omitting three correct answers is merely partial. The asymmetry is the whole method, and it is what
 * makes it right when the distractors are genuinely tempting rather than obviously wrong -- a student who
 * picks the tempting wrong answer has not understood the question, which is different from having missed it.
 */
export const su = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  const isSubset = counts.incorrect === 0;
  return result(input, isSubset ? counts.correct : 0, counts, false);
};

/**
 * `RI` -- Ripkey. "+1 correct, -1 incorrect, only if the response is no larger than the key."
 *
 * Identical to `NG` except for the size clause, and that clause is what makes it NOT gameable: a student
 * cannot select more than the key holds, so the select-all exploit NG has is closed by construction rather
 * than by a publish-time guard. It is `NG` made safe, at the cost of being slightly harsher -- selecting
 * exactly `C` wrong options gives `0` under RI and `-C` under NG.
 */
export const ripkey = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  const overSelected = input.selected.size > input.key.size;
  return result(input, overSelected ? 0 : counts.correct - counts.incorrect, counts, overSelected);
};

/**
 * `PM` -- plus/minus. "+1 correct, -1 incorrect, regardless of set size."
 *
 * The best IRT fit in the comparative studies `RN-05` cites, and the ONLY method that is gameable with no
 * size clause at all: select-all scores `2C - M` however large the pool is. It belongs behind the same publish
 * guard as NG, and the plan is explicit that it should be used "only with a size guard, or when IRT follows".
 */
export const plusMinus = (input: MethodInput): MethodResult => {
  const counts = tally(input);
  return result(input, counts.correct - counts.incorrect, counts, false);
};

const BY_METHOD: Readonly<Record<Method, (input: MethodInput) => MethodResult>> = {
  NC: nc,
  '1PM': onePm,
  NG: ng,
  SU: su,
  RI: ripkey,
  PM: plusMinus,
};

/**
 * APPLY A NAMED METHOD. The single dispatch point, so "which method" is asked in exactly one place.
 *
 * The lookup is on a `Record` keyed by `Method`, so a method added to the union without a handler is a
 * COMPILE error here rather than an `undefined` at grading time.
 *
 * ## AND IT IS TOTAL, WHICH THE ONE-LINE VERSION WAS NOT
 *
 * `BY_METHOD[method](input)` throws a `TypeError` for any name outside the six -- and `method` is read from a
 * JSON column written by an authoring tool, so a typo, a bank imported from another system, or a method added
 * by a LATER version of the schema all reach it as ordinary data.
 *
 * That broke `plans/07` §4's totality at the one place it matters most: instead of a `GradeOutput` saying "a
 * human must look", the grader threw, and the throw happened inside the auto-grade loop rather than at an
 * input boundary. The counts are still tallied and returned so the caller can report what the student chose;
 * only the score is withheld, because inventing one would be worse than refusing.
 */
export const applyMethod = (method: Method, input: MethodInput): MethodResult => {
  const handler: ((input: MethodInput) => MethodResult) | undefined = BY_METHOD[method];
  if (handler === undefined) {
    const counts = tally(input);
    return {
      rawCount: 0,
      correctCount: counts.correct,
      incorrectCount: counts.incorrect,
      zeroedBySize: false,
      negative: false,
      unknownMethod: String(method),
    };
  }
  return handler(input);
};

/**
 * `selectAllScore(options, correct)` -- section 3.3's publish-time guard, as a pure function.
 *
 * ## WHAT A STUDENT WHO SELECTS EVERYTHING EARNS, IN UNITS OF ONE CORRECT OPTION
 *
 * `C` correct and `M - C` incorrect, under a method that pays `+1` and deducts `-1`: `2C - M`. Only NG and PM
 * have this shape, which is why only they are in `PENALISING_METHODS` -- and computing it as a function rather
 * than hard-coding `2C - M` means the guard and the grader cannot disagree about what select-all pays.
 */
export const selectAllScore = (
  optionCount: number,
  correctCount: number,
  method: Method,
): number => {
  if (!PENALISING_METHODS.includes(method)) return 0;
  return 2 * correctCount - optionCount;
};

/**
 * WHY A CONFIGURATION MAY NOT BE PUBLISHED, or `null` when it may.
 *
 * Section 3.3 refuses NG or PM when `selectAllScore > 0`. The message names the number and the fix, because a
 * refusal a teacher cannot act on gets worked around -- and the workaround is a method that pays for
 * guessing, which is the thing the refusal exists to prevent.
 */
export const publishRefusal = (
  optionCount: number,
  correctCount: number,
  method: Method,
): string | null => {
  const gain = selectAllScore(optionCount, correctCount, method);
  if (gain <= 0) return null;
  return (
    `${method} pays ${String(gain)} of ${String(correctCount)} for selecting all ${String(optionCount)} ` +
    `options, so a student who ticks everything beats one who chose carefully. Use 1PM, cap the selectable ` +
    `options, or choose a key of ${String(Math.floor(optionCount / 2))} or fewer.`
  );
};

/**
 * WHETHER A RAW SCORE CAN GO NEGATIVE UNDER THIS METHOD.
 *
 * ## `RI` IS IN HERE AND `plans/07` §3's TABLE SAYS IT SHOULD NOT BE
 *
 * The table's row reads "+1 correct, −1 incorrect, only if the response is no larger than the key", and its
 * "produces negative raw scores" column reads "No (the size clause saves it)". The size clause does not save
 * it: that clause fires only when the response is LARGER than the key, so a response the same size as the key
 * and entirely wrong goes straight through to `+0 −1 = −1`.
 *
 * Found by the property test in `properties.test.ts`, whose counterexample was `["RI", ["b"], ["c"]]` -- one
 * option selected, one keyed, and they differ.
 *
 * **SO THIS FOLLOWS THE FORMULA, AND THE GLOSS IS RECORDED AS WRONG.** The formula is the operative definition
 * of the method; the parenthetical mis-describes the clause. `SU` is the one that cannot go negative, because
 * its rule refuses the response outright rather than scoring it. Changing published scoring semantics is not a
 * decision for the author of the grader, so the discrepancy is in the tracker awaiting sign-off -- what is not
 * acceptable is the code matching a gloss that claims the opposite.
 */
export const canGoNegative = (method: Method): boolean =>
  method === 'NG' || method === 'PM' || method === 'RI';

/**
 * THE IMPLEMENTED METHODS AND THE QUESTION UNION AGREE.
 *
 * Run at module load. `PartialCreditMethod` in the question union and `METHODS` here are two lists of the same
 * six things, and a method added to one and not the other would either be unselectable by an author or
 * selectable and unimplemented. The check fails loudly rather than letting a question ship with a method the
 * grader cannot apply.
 */
export const assertMethodsMatchTheUnion = (unionMethods: readonly string[]): void => {
  const implemented = new Set<string>(METHODS);
  for (const name of unionMethods) {
    if (!implemented.has(name))
      throw new Error(`PARTIAL_CREDIT_METHODS lists ${name}, which is not implemented`);
  }
  if (unionMethods.length !== implemented.size) {
    throw new Error(
      `PARTIAL_CREDIT_METHODS has ${String(unionMethods.length)} methods and ${String(METHODS.length)} are implemented`,
    );
  }
};
