/**
 * Grading helpers. Pure, DOM-free, deterministic — and the reason a simulation can be an exam
 * question graded by a server.  (P6-T3)
 *
 * ## A GRADE IS POINTS AND A RATIONALE, NEVER A BOOLEAN
 *
 * `boolean correct` throws away the partial credit that most real marks have, and the one thing a
 * teacher needs to explain a mark is the reason for it. So `correct` exists but is derived, and every
 * helper produces a `because` a teacher can put in a comment.
 *
 * ## EVERY COMPARISON IS SYMMETRIC, AND THAT IS THE POINT
 *
 * A student's answer and the expected answer have no privileged order — they are two spellings of a
 * claim. So `tolerance(a, b)` and `tolerance(b, a)` must agree, and the tests check that directly on
 * every helper. An asymmetric tolerance is the bug that marks 4.999 wrong when 5.001 is right, and
 * it is invisible until a real student's number lands near the boundary.
 */

export type GradingStrategy = 'EXACT' | 'TOLERANCE' | 'SET' | 'ORDER' | 'NUMERIC' | 'RUBRIC';

export interface Grade {
  /** Points awarded, within `maxPoints`. Never negative, never above the maximum. */
  readonly points: number;
  readonly maxPoints: number;
  readonly correct: boolean;
  /** What a teacher can paste into a comment. */
  readonly rationale: string;
  /** Which dimension decided it, for the item-analysis tools. */
  readonly strategy: GradingStrategy;
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

const finish = (
  points: number,
  maxPoints: number,
  strategy: GradingStrategy,
  rationale: string,
): Grade => {
  // Clamped at ONE place. A helper that computes -0.1 or 1.0000001 must not be able to ship it, and
  // the alternative — trusting five helpers to each be careful — is how the bug happens.
  const bounded = Math.min(maxPoints, Math.max(0, points));
  const rounded = Math.round(bounded * 1e6) / 1e6;
  return {
    points: rounded,
    maxPoints,
    // Full credit is an equality on the clamped points, so `4/4` and `4.0000001/4` agree.
    correct: rounded >= maxPoints,
    rationale,
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
