/**
 * Grading helpers. Pure, DOM-free, deterministic — and the reason a simulation can be an exam
 * question graded by a server.  (P6-T3)
 *
 * ## A GRADE IS POINTS AND A REASON, NEVER JUST A BOOLEAN
 *
 * `boolean correct` throws away the partial credit that most real marks have, and the one thing a
 * teacher needs to explain a mark is the reason for it. So `correct` exists but is derived, and every
 * helper produces a `feedback` a teacher can put in a comment.
 *
 * ## `code` AND `feedback` ARE THE TWO HALVES OF WHAT THE PRODUCT ACTUALLY READS
 *
 * `packages/contracts/src/grading/simulation.ts:229` (`readAward`) is the ONLY place the product
 * builds a mark from a simulation's own return value, and it reads exactly three fields: `points`,
 * `maxPoints` and `code`. `code` is the machine-readable half, because the host has to `switch` on it
 * exhaustively; `feedback` is the prose half, because a student who lost a mark has to be told which
 * part of their working was wrong.
 *
 * **This interface was missing `code`, so `readAward`'s `code` read was dead on arrival** -- it fell
 * through to `typeof code === 'string' ? code : 'CORRECT'` (`simulation.ts:241`) and every simulation
 * item reported `CORRECT` regardless of what the grader said. The field was added here because the
 * consumer is in the repository and named it, not because a type was widened to make a check pass.
 *
 * ## EVERY COMPARISON IS SYMMETRIC, AND THAT IS THE POINT
 *
 * A student's answer and the expected answer have no privileged order — they are two spellings of a
 * claim. So `tolerance(a, b)` and `tolerance(b, a)` must agree, and the tests check that directly on
 * every helper. An asymmetric tolerance is the bug that marks 4.999 wrong when 5.001 is right, and
 * it is invisible until a real student's number lands near the boundary.
 */

export type GradingStrategy =
  | 'EXACT'
  | 'TOLERANCE'
  | 'SET'
  | 'BAG'
  | 'ORDER'
  | 'NUMERIC'
  | 'RUBRIC';

/**
 * THE CODES THE SDK ITSELF EMITS, which are the codes the product already knows.
 *
 * `packages/contracts/src/grading/index.ts:76-81` (`RATIONALE_CODES`) is the host's closed set, and
 * every name here is one of its members -- so a grade produced by `tolerance` or `exact` needs no
 * translation to be switched on by the host, and the fallback at `simulation.ts:241` is never reached.
 *
 * A SIM MAY DECLARE ITS OWN beyond these, and several do: `G_TEN` (used g=10 where the item wants
 * 9.8), `CELSIUS`, `STEPS_NOT_SECONDS`. Those are per-item diagnoses that belong to the simulation's
 * subject matter, so they are not collected here -- a central list of thirty domain diagnoses is a list
 * nobody maintains. `code` is therefore `string`, and `readAward` is the place that decides what an
 * unknown code means.
 */
export const GRADE_CODES = ['CORRECT', 'INCORRECT', 'PARTIAL', 'UNPARSEABLE', 'BLANK'] as const;
export type GradeCode = (typeof GRADE_CODES)[number];

export interface Grade {
  /** Points awarded, within `maxPoints`. Never negative, never above the maximum. */
  readonly points: number;
  /**
   * The ceiling. Named `maxPoints` and not `max` because that is what the product READS.
   *
   * `readAward` destructures `maxPoints` (`packages/contracts/src/grading/simulation.ts:229`) and
   * refuses the whole return value when it is absent -- `unreadable("the grader returned
   * maxPoints=undefined, so there is no range to read points=4 against")`. Every simulation grader
   * emitted `max`, so **every simulation question was reaching that refusal and going to `NEEDS_HUMAN`**:
   * not one wrong mark, but no mark computed at all. A field name is a wire format, and this one was
   * on the wrong side of it.
   */
  readonly maxPoints: number;
  /** The machine-readable diagnosis. The host switches on this; `feedback` is what it shows. */
  /**
   * **NOT `GradeCode`. DELIBERATELY, AND THIS IS THE WHOLE FINDING.**
   *
   * `GRADE_CODES` below reads like a closed taxonomy and is not one. Counting the literals the tree actually emits:
   *
   *     UNPARSEABLE 33 · INTERNAL 24 · CORRECT 24 · MISSING 9 · STATE_INVALID 7 · HANDSHAKE_FAILED 5 ·
   *     WRONG 4 · PARAM_DEFAULT_INVALID 4 · … and ~18 single-use per-sim labels such as `G_TEN`,
   *     `CELSIUS`, `HALF_SWING`, `MIDPOINT_INCOMPLETE`, `NOT_A_TRIANGLE`.
   *
   * **32 distinct strings, of which `GRADE_CODES` names five and the helpers emit none.** Narrowing this field to
   * `GradeCode` was tried and **fails to compile at 41 sites** -- the sims emit `INTERNAL` and `MISSING`, which the union
   * does not contain. So the union is a fiction, and `code: string` is the honest type even though it enforces nothing.
   *
   * **THE CONSEQUENCE, STATED SO IT IS NOT DISCOVERED BY `P11`:** nothing guarantees `code` is a closed set, so item
   * analysis **cannot group by it as a classification**. What is missing is a split between a general classification and
   * a simulation's own feedback label -- `G_TEN` is a label for one mark, not a category -- and deciding that is a
   * change to the simulation contract, which `P6`/`P12` own. Recorded here rather than guessed at.
   */
  readonly code: string;
  /** The sentence a student or a marker can act on. Written for them, not about the type system. */
  readonly feedback: string;
  /**
   * DERIVED, so a hand-written grade is not asked to state it.
   *
   * It is `points >= maxPoints` (`grading.ts`'s own comment on `finish` calls it an equality on the
   * CLAMPED points, so `4/4` and `4.0000001/4` agree). The SDK's helpers fill it; a grader that writes
   * its own return value does not have to, and could get it wrong by restating a rule that already
   * exists in one place. Nothing outside this package reads it.
   */
  readonly correct?: boolean;
  /** Which helper decided it. Filled by the helpers; absent on a hand-written grade, whose `code` says. */
  readonly strategy?: GradingStrategy;
}

export interface ToleranceSpec {
  /** Absolute tolerance in the item's own unit. */
  readonly abs?: number;
  /** Relative tolerance, as a fraction: 0.02 is 2% of the expected value. */
  readonly rel?: number;
  readonly maxPoints: number;
  readonly partialCredit?: boolean;
  /** Tolerances beyond the boundary over which partial credit decays to zero. Defaults to 2. */
  readonly partialCreditBand?: number;
}

/** The `code` for an outcome, from the points and the ceiling. The one place `correct` is decided. */
const codeFor = (points: number, maxPoints: number): GradeCode =>
  points >= maxPoints ? 'CORRECT' : points > 0 ? 'PARTIAL' : 'INCORRECT';

/**
 * `code` IS DERIVED HERE UNLESS A CALLER KNOWS SOMETHING THE POINTS CANNOT SAY.
 *
 * `codeFor` reads only `(points, maxPoints)`, so it cannot distinguish "the student got it wrong" from "the student's
 * answer never parsed". Those are **different facts about a distractor**, and `P11`'s item analysis reads this field --
 * a blank folded into `INCORRECT` makes an item nobody could answer look like an item they mis-conceived, which is the
 * distortion `GRADE_CODES` exists to prevent.
 *
 * So `finish` accepts an override for the branches that already know. **A derived value that cannot be wrong is better
 * than one nobody can override**, because the branches that need the distinction are precisely the ones holding it.
 */
const finish = (
  points: number,
  maxPoints: number,
  strategy: GradingStrategy,
  feedback: string,
  code?: GradeCode,
): Grade => {
  // Clamped at ONE place. A helper that computes -0.1 or 1.0000001 must not be able to ship it, and
  // the alternative — trusting five helpers to each be careful — is how the bug happens.
  const bounded = Math.min(maxPoints, Math.max(0, points));
  const rounded = Math.round(bounded * 1e6) / 1e6;
  return {
    points: rounded,
    maxPoints,
    correct: rounded >= maxPoints,
    // The code is derived from the same clamped pair as `correct`, so a grade cannot claim to be
    // `CORRECT` while its own arithmetic says otherwise — which is the disagreement `readAward` would
    // hand to a marker with no way to resolve it.
    code: code ?? codeFor(rounded, maxPoints),
    feedback,
    strategy,
  };
};

/** Did the student's answer parse as a number at all? Units are accepted and ignored, deliberately. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // Units are accepted because "25 m/s" and "25" are the same claim, and refusing the first teaches
    // students to strip units rather than to check their answer. Degrees and m/s² survive.
    const cleaned = value.replace(/[^\d.eE+-]/gu, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Numeric equality within an absolute or relative bound. Symmetric.
 *
 * The bound is `max(abs, rel * max(|a|, |b|))`, not `min`. Taking the LARGER bound is what makes it
 * symmetric, because the larger magnitude decides; and for values near zero, where a relative bound
 * is meaningless, the absolute one keeps working.
 */
export function withinTolerance(
  given: number,
  expected: number,
  spec: { readonly abs?: number; readonly rel?: number },
): boolean {
  const difference = Math.abs(given - expected);
  const magnitude = Math.max(Math.abs(given), Math.abs(expected));
  const relative = (spec.rel ?? 0) * magnitude;
  const absolute = spec.abs ?? 0;
  // ZERO TOLERANCE MEANS EXACT, NOT "NOTHING IS WITHIN IT".
  //
  // This guard existed to stop an ABSENT tolerance accepting everything, and it keyed on the value being
  // zero rather than on it being undefined -- so it also rejected a deliberately exact one. A grader that
  // wrote `abs: 0, rel: 0`, which is the natural way to say "this is a count, match it exactly", scored
  // every CORRECT answer zero: `withinTolerance(4, 4, {abs: 0, rel: 0})` was `false`.
  //
  // `difference <= 0` is the honest reading and it is STRICTER than the old guard, not looser: an absent
  // spec now accepts only an exact match rather than rejecting everything. No simulation declared a zero
  // tolerance until the tenth one, which is why this sat unnoticed through nine gold simulations and a
  // green matrix.
  return difference <= Math.max(absolute, relative);
}

/** `TOLERANCE` grading: partial credit proportional to how close, when asked for. */
/** How many tolerances beyond the boundary partial credit survives. Two is a steep, honest slope. */
const PARTIAL_CREDIT_BAND = 2;

export function tolerance(given: unknown, expected: unknown, spec: ToleranceSpec): Grade {
  const a = asNumber(given);
  const b = asNumber(expected);
  if (a === null || b === null) {
    return finish(
      0,
      spec.maxPoints,
      'TOLERANCE',
      `expected the number ${String(expected)}, received ${JSON.stringify(given) ?? 'nothing'}`,
      'UNPARSEABLE',
      /**
       * `UNPARSEABLE`, NOT `INCORRECT` -- AND THE DISTINCTION IS `P11`'s, NOT COSMETIC.
       *
       * The comparison could not parse, so no number was ever compared with another. That is not a wrong answer, and
       * item analysis has to be able to say so: **an item every student leaves blank is a different intervention from
       * an item everyone mis-conceives**, and reporting `INCORRECT` makes the two indistinguishable in exactly the
       * report meant to tell them apart.
       *
       * **BOTH `a === null` AND `b === null` LAND HERE, DELIBERATELY, AND THE COMMENT SAYS SO RATHER THAN PRETENDING
       * OTHERWISE.** A null `expected` is *our* bug rather than the student's, and "student wrote nonsense" is the
       * wrong label for it. Telling those two apart is a real requirement and it is **NOT met here**: it needs a
       * separate axis (whose failure it was), not a second meaning for one code, and inventing one now would put a
       * lie in a field `P11` reads. It is recorded rather than papered over.
       *
       * `BLANK` IS LIKEWISE UNREACHED: a blank answer arrives as `null`/`''` and so becomes `UNPARSEABLE`. **`GRADE_CODES`
       * therefore advertises five codes and the helpers reach four.** Declaring a code nothing produces is how an
       * enumeration quietly becomes decoration, so the honest options are to emit it or to stop advertising it; emitting
       * it needs the same axis and is `P11`'s to define.
       */
    );
  }
  if (withinTolerance(a, b, spec)) {
    return finish(
      spec.maxPoints,
      spec.maxPoints,
      'TOLERANCE',
      `${String(a)} is within tolerance of ${String(b)}`,
    );
  }
  if (spec.partialCredit === true) {
    // Linear in the RELATIVE error, which is the only way to be symmetric: `1 - diff/scale` where
    // `scale` is the same on both sides. A grade computed from `|given - expected| / expected` alone
    // would award different points for a student who is 10% high and one who is 10% low.
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    const relativeError = Math.abs(a - b) / scale;
    // CREDIT IS MEASURED IN TOLERANCES, NOT IN PERCENT, AND IT ENDS.
    //
    // Two defects in one line. `1 - relativeError` is unbounded -- a student 1000x out still earned
    // 0.087 of 4, because the formula only reaches zero at 100% error and `max(|a|,|b|)` saturated it at
    // 97.8%. But simply dividing by the tolerance was no better: it made every answer outside tolerance
    // score zero, which is not partial credit, it is a cliff.
    //
    // So credit decays linearly from the tolerance boundary and reaches zero `PARTIAL_CREDIT_BAND`
    // tolerances further out. The declared tolerance is the unit, the band is the end of it, and a wild
    // guess scores nothing at all.
    // THE UNIT IS THE TOLERANCE THAT WAS ACTUALLY DECLARED.
    //
    // It used to be `spec.rel > 0 ? spec.rel : 1`, and the `1` is a 100% tolerance: a grader declaring
    // `abs: 0.5, rel: 0` -- an ABSOLUTE tolerance, which is the only kind that makes sense for a count or
    // a duration -- got a tolerance unit of one, so an answer 88% wrong sat inside it and scored FULL
    // MARKS. `computing-science.download-time` found it the moment it graded a transfer time.
    //
    // An absolute-only tolerance therefore measures in units of the absolute tolerance, and if neither
    // tolerance is declared there is nothing to decay from and nothing is credited.
    const relativeUnit = spec.rel !== undefined && spec.rel > 0 ? spec.rel : null;
    const absoluteUnit = spec.abs !== undefined && spec.abs > 0 ? spec.abs / scale : null;
    const toleranceUnit = relativeUnit ?? absoluteUnit;
    if (toleranceUnit === null || toleranceUnit <= 0) {
      return finish(
        0,
        spec.maxPoints,
        'TOLERANCE',
        `${String(a)} is outside tolerance of ${String(b)} and no tolerance was declared to scale ` +
          'partial credit from',
      );
    }
    const band = spec.partialCreditBand ?? PARTIAL_CREDIT_BAND;
    const past = (relativeError - toleranceUnit) / (toleranceUnit * band);
    // CLAMPED AT BOTH ENDS. `relativeError` can be SMALLER than `toleranceUnit` while `withinTolerance`
    // still said no -- when the absolute tolerance is the one in force, `max(abs, rel)` and the relative
    // test disagree -- and `1 - past` then exceeded 1, so the answer scored MORE than the maximum.
    const credit = Math.min(1, Math.max(0, 1 - past));
    return finish(
      spec.maxPoints * credit,
      spec.maxPoints,
      'TOLERANCE',
      `${String(a)} is not within tolerance of ${String(b)}; partial credit from the ${(relativeError * 100).toFixed(1)}% error`,
    );
  }
  return finish(
    0,
    spec.maxPoints,
    'TOLERANCE',
    `${String(a)} is outside tolerance of ${String(b)} (abs ${String(spec.abs ?? 0)}, rel ${String(spec.rel ?? 0)})`,
  );
}

/** `EXACT` grading, on a normalised string or a deep value. */
export function exact(given: unknown, expected: unknown, maxPoints: number): Grade {
  const matches = canonicalText(given) === canonicalText(expected);
  return finish(
    matches ? maxPoints : 0,
    maxPoints,
    'EXACT',
    matches
      ? 'exact match'
      : `expected ${JSON.stringify(expected)}, received ${JSON.stringify(given)}`,
  );
}

/** `NUMERIC` grading: exact after parsing, for a mark that is right or wrong with nothing between. */
export function numeric(given: unknown, expected: unknown, maxPoints: number): Grade {
  const a = asNumber(given);
  const b = asNumber(expected);
  if (a === null || b === null) {
    return finish(
      0,
      maxPoints,
      'NUMERIC',
      `expected the number ${String(expected)}, received ${JSON.stringify(given) ?? 'nothing'}`,
    );
  }
  const matches = a === b;
  return finish(
    matches ? maxPoints : 0,
    maxPoints,
    'NUMERIC',
    matches ? `${String(a)} is exactly ${String(b)}` : `${String(a)} is not exactly ${String(b)}`,
  );
}

/** Normalisation for string comparison: case, whitespace and the punctuation a keyboard adds. */
export function canonicalText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    // An object's KEY ORDER is not part of its meaning, so two objects that differ only in
    // insertion order compare equal. Sorting here is why `exact({a:1,b:2},{b:2,a:1})` passes.
    const record = value as Record<string, unknown>;
    const inner = Object.keys(record)
      .sort()
      .map((key) => `${key}:${canonicalText(record[key])}`)
      .join(',');
    return `{${inner}}`;
  }
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * `SET` grading with partial credit — the strategy for a Punnett square or a set of selections,
 * where a student who gets three of five has demonstrated something.
 *
 * ## PARTIAL CREDIT IS JACCARD, NOT "RATIO OF COUNTS"
 *
 * `(correct ∩ given) / |correct ∪ given|` penalises an answer that omits a selection as well as one
 * that adds a wrong one, which is right: in a genetics Punnett square, "3 of 5" is 3/6 = 0.5 and not
 * 3/5 = 0.6, because the two omitted cells are part of what was being asked for.
 *
 * Duplicates in the student's answer are collapsed first, so answering "AA, AA, aa" is not a way to
 * inflate an intersection.
 */
export function setMatch(
  given: unknown,
  expected: readonly string[] | string[],
  spec: {
    readonly maxPoints: number;
    readonly partialCredit?: boolean;
    readonly caseSensitive?: boolean;
  },
): Grade {
  // Case folding is right for a list of selectable options and WRONG for a Punnett square, where
  // `AA` and `aa` are different genotypes. The first version folded unconditionally, so a genetics
  // item silently compared one phenotype against the other and marked the recessive answer correct.
  // Hence the option, and hence `biology.genetics-punnett` turning it on.
  const fold = spec.caseSensitive === true ? (value: string): string => value : canonicalText;
  const givenSet = toSet(given, fold);
  const expectedSet = toSet(expected, fold);
  const maxPoints = spec.maxPoints;

  if (expectedSet.size === 0) {
    return finish(0, maxPoints, 'SET', 'the expected set is empty, so nothing can be credited');
  }
  const intersection = [...givenSet].filter((item) => expectedSet.has(item));
  const union = new Set([...givenSet, ...expectedSet]);
  if (intersection.length === expectedSet.size && givenSet.size === expectedSet.size) {
    return finish(
      maxPoints,
      maxPoints,
      'SET',
      `all ${String(expectedSet.size)} expected selections, and no others`,
    );
  }
  if (intersection.length === 0) {
    return finish(
      0,
      maxPoints,
      'SET',
      `none of the ${String(givenSet.size)} selections was expected (${[...expectedSet].join(', ')})`,
    );
  }
  if (spec.partialCredit === true) {
    const jaccard = intersection.length / union.size;
    return finish(
      maxPoints * jaccard,
      maxPoints,
      'SET',
      `${String(intersection.length)} of ${String(expectedSet.size)} expected, and ${String(givenSet.size - intersection.length)} extra; partial credit from the ${(jaccard * 100).toFixed(1)}% Jaccard overlap`,
    );
  }
  return finish(
    0,
    maxPoints,
    'SET',
    `${String(intersection.length)} of ${String(expectedSet.size)} expected, which does not earn partial credit here`,
  );
}

/** `RUBRIC` grading: a human decided, and the machine records it without re-deciding. */
/**
 * `ORDER` grading: a SEQUENCE, where position is part of the answer.
 *
 * ## WHY THIS IS NOT `setMatch`
 *
 * `setMatch` compares a SET, because the order a quadratic's roots are written in is not part of the
 * answer. Ordering a set of stages IS the question in a sequencing task, and reusing the set matcher
 * there would mark a completely reversed sequence as a perfect score -- the exact inversion of the
 * mistake `setMatch` exists to prevent.
 *
 * ## CREDIT IS PER POSITION, NOT PER ITEM
 *
 * Partial credit counts how many POSITIONS hold the right item. That is not the same as how many items
 * are somewhere correct: with `[A, B, C, D]` given against `[A, C, B, D]` expected, four items are all
 * present and two positions are right, so the two counts differ. Credit per position is the honest
 * reading of "how much of the sequence is right", and it is also the harder one to inflate: a student
 * cannot keep full marks by getting the set right and the order wrong, which is precisely the mistake
 * this strategy is for.
 *
 * ## AN EXTRA ITEM IS A MISSED POSITION
 *
 * A list longer than the expected one cannot earn marks for its surplus, because each surplus entry
 * occupies a position that should hold the right item. Its score is reported rather than hidden.
 */
/**
 * `BAG` grading — a multiset comparison, where HOW MANY TIMES something occurs IS part of the answer.
 *
 * ## WHY THIS EXISTS: `setMatch` CANNOT GRADE A PUNNETT SQUARE, THOUGH ITS DOC NAMED ONE
 *
 * `setMatch` compares SETS, so it collapses duplicates on both sides. For a Punnett square that is not a rounding
 * difference, it is a **false-positive mark**: a cross of `Aa x Aa` produces `AA, Aa, Aa, aa`, and a student who writes
 * only `AA, Aa, aa` -- omitting one heterozygote, which is the entire content of the exercise -- produces the same
 * three-element set as the correct four-cell answer and is awarded **full marks**.
 *
 * That was found by PLANTING it rather than by reading the code: `biology.genetics-punnett` scored
 * `{ offspring: ['AA','Aa','aa'], ratio: '1:2:1' }` as `CORRECT 4/4` against a four-cell cross. `setMatch`'s own header
 * still says "the strategy for a Punnett square", so the doc and the semantics disagreed and the doc was right about the
 * simulation and wrong about the primitive.
 *
 * ## WHY `setMatch` IS NOT FIXED INSTEAD
 *
 * **`setMatch` is correct for what it is for.** Ticking "AA" and "aa" in a checkbox list means the set {AA, aa}; a
 * student cannot select "AA" twice, so collapsing duplicates is right there, and `biology.mitosis-order` already moved to
 * `orderMatch` for the opposite reason. Changing `setMatch` to count would silently break every selectable-options item in
 * the catalogue. **The primitive was missing, not wrong.**
 *
 * ## PARTIAL CREDIT IS MULTISET JACCARD, FOR THE SAME REASON `setMatch` USES JACCARD
 *
 * `sum(min(countGiven, countExpected)) / sum(max(countGiven, countExpected))`. Both halves move together: omitting a
 * heterozygote lowers the numerator, and inventing an extra one raises the denominator. So `AA, Aa, aa` scores 3/4 rather
 * than 4/4 -- and, unlike a set comparison, **cannot be inflated by repeating an answer**, because a repeat adds to the
 * denominator and never to the numerator.
 */
export function bagMatch(
  given: unknown,
  expected: readonly string[],
  spec: {
    readonly maxPoints: number;
    readonly partialCredit?: boolean;
    readonly caseSensitive?: boolean;
  },
): Grade {
  const fold = spec.caseSensitive === true ? (value: string): string => value : canonicalText;
  const givenList = toList(given, fold);
  const expectedList = expected.map((entry) => fold(entry));
  const maxPoints = spec.maxPoints;

  if (expectedList.length === 0) {
    return finish(0, maxPoints, 'BAG', 'the expected bag is empty, so nothing can be credited');
  }

  /** Counts rather than membership: the whole difference between a bag and a set. */
  const tally = (items: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return counts;
  };
  const givenCounts = tally(givenList);
  const expectedCounts = tally(expectedList);

  let matched = 0;
  let total = 0;
  for (const item of new Set([...givenCounts.keys(), ...expectedCounts.keys()])) {
    matched += Math.min(givenCounts.get(item) ?? 0, expectedCounts.get(item) ?? 0);
    total += Math.max(givenCounts.get(item) ?? 0, expectedCounts.get(item) ?? 0);
  }

  if (matched === expectedList.length && givenList.length === expectedList.length) {
    return finish(
      maxPoints,
      maxPoints,
      'BAG',
      `all ${String(expectedList.length)} entries, with the right count for each`,
    );
  }
  if (matched === 0) {
    return finish(
      0,
      maxPoints,
      'BAG',
      `none of the ${String(givenList.length)} entries was expected (${[...expectedCounts.keys()].join(', ')})`,
    );
  }
  if (spec.partialCredit === true) {
    return finish(
      maxPoints * (matched / total),
      maxPoints,
      'BAG',
      `${String(matched)} of ${String(expectedList.length)} entries correct, counting duplicates`,
    );
  }
  return finish(
    0,
    maxPoints,
    'BAG',
    `only ${String(matched)} of ${String(expectedList.length)} entries correct, counting duplicates`,
  );
}

const toList = (value: unknown, fold: (input: string) => string): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => fold(String(entry)));
};

export function orderMatch(
  given: unknown,
  expected: readonly string[],
  spec: {
    readonly maxPoints: number;
    readonly partialCredit?: boolean;
    readonly caseSensitive?: boolean;
  },
): Grade {
  const fold = spec.caseSensitive === true ? (value: string): string => value : canonicalText;
  const givenList = toList(given, fold);
  const expectedList = expected.map((value) => fold(value));
  const maxPoints = spec.maxPoints;

  if (expectedList.length === 0) {
    return finish(0, maxPoints, 'ORDER', 'nothing was expected, so nothing can be scored');
  }

  let correctPositions = 0;
  for (const [index, item] of expectedList.entries()) {
    if (givenList[index] === item) correctPositions += 1;
  }
  const extra = Math.max(0, givenList.length - expectedList.length);
  const misplaced = expectedList.length - correctPositions;

  if (correctPositions === expectedList.length && extra === 0) {
    return finish(
      maxPoints,
      maxPoints,
      'ORDER',
      `all ${String(expectedList.length)} positions are right`,
    );
  }

  if (spec.partialCredit === true) {
    // THE DENOMINATOR IS HOW MANY POSITIONS THE ANSWER OCCUPIES, not how many were expected.
    //
    // Dividing by the expected length alone gave full marks to a seven-item answer that got all six
    // expected positions right and then added one: six of six, so 4 of 4, and the surplus cost nothing.
    // An extra item occupies a position that should hold the right one, so it belongs in the count of
    // positions the student had to get right.
    const positions = Math.max(expectedList.length, givenList.length);
    const fraction = correctPositions / positions;
    return finish(
      maxPoints * fraction,
      maxPoints,
      'ORDER',
      `${String(correctPositions)} of ${String(positions)} positions hold the right item` +
        (extra > 0 ? `, and ${String(extra)} item${extra === 1 ? '' : 's'} past the end` : ''),
    );
  }

  return finish(
    0,
    maxPoints,
    'ORDER',
    `${String(correctPositions)} of ${String(expectedList.length)} positions right, ` +
      `${String(misplaced)} misplaced` +
      (extra > 0 ? `, ${String(extra)} extra` : ''),
  );
}

export function rubric(decision: {
  readonly points: number;
  readonly maxPoints: number;
  readonly reason: string;
}): Grade {
  if (decision.reason.trim() === '') {
    return finish(
      0,
      decision.maxPoints,
      'RUBRIC',
      'no reason was recorded, so the mark cannot be explained or appealed',
    );
  }
  return finish(decision.points, decision.maxPoints, 'RUBRIC', decision.reason);
}

function toSet(value: unknown, fold: (value: string) => string = canonicalText): Set<string> {
  if (Array.isArray(value)) return new Set(value.map((item) => fold(String(item))));
  if (typeof value === 'string') {
    // A comma-separated string is what a text input produces, and refusing it teaches students that
    // the sim wants a different shape rather than teaching them the biology.
    return new Set(
      value
        .split(/[,;\n]/u)
        .map((part) => fold(part))
        .filter((part) => part !== ''),
    );
  }
  if (value === null || value === undefined) return new Set();
  return new Set([fold(String(value))]);
}

/**
 * `partialCredit: false` is not a mode; it is the DEFAULT.
 *
 * A simulation item with four marks should not silently hand out two of them for half an answer
 * unless the author asked. The manifest says `partialCredit` explicitly, so the helpers take it
 * explicitly too — there is no way to get partial credit by forgetting to pass a flag.
 */
export const DEFAULT_MAX_POINTS = 4;
