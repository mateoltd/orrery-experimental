/**
 * Short-text matching and ordering adjacency.  (P7-T4)
 *
 * ## A TEACHER MUST NEVER BE ASKED TO TRUST AN OPAQUE SCORE
 *
 * `plans/07` section 3.4: the fuzzy matcher "shows a TOKEN DIFF so a teacher can sanity-check the machine's
 * judgement. A teacher must never be asked to trust an opaque score."
 *
 * So every matcher returns the comparison it actually made -- which tokens matched, which were missing, which
 * were extra, and the overlap fraction -- and the rationale quotes them. A grader that returned `0.83` would be
 * asking a marker to take it on faith, and the first teacher who disagreed with it would have no way to show
 * why.
 *
 * ## AND EVERY MATCHER IS PURE AND TOTAL, LIKE THE REST OF THE CORE
 *
 * No clock, no randomness, and no throw for a string the author did not anticipate. `REGEX_SET` compiles
 * author-supplied patterns, which is the one place in this module that can fail at runtime, so an invalid
 * pattern yields NO match rather than an exception: a malformed regex in a question bank must not be able to
 * fail a student's submission.
 */

/** Words carrying no meaning for comparison. Deliberately short: an aggressive list erases real answers. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
]);

/** SUFFIXES stripped to a crude stem. Crude ON PURPOSE: a real Porter stemmer changes answers a teacher recognises. */
const SUFFIXES = [
  'ational',
  'iveness',
  'fulness',
  'ousness',
  'ization',
  'ations',
  'ingly',
  'edly',
  'ation',
  'ities',
  'ively',
  'ness',
  'ment',
  'ing',
  'ies',
  'ers',
  'est',
  'ive',
  'ed',
  'es',
  'ly',
  's',
];

/**
 * A DELIBERATELY CRUDE STEM.
 *
 * Longest suffix first, so `ational` is stripped before `al` rather than leaving `ation`. Only suffixes of four
 * characters or more are considered except for `s`, which is the one that matters for plurals -- stripping `ed`
 * off `bed` and `red` would turn three different words into one.
 */
export const stem = (word: string): string => {
  const lower = word.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (suffix.length >= 4 && lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower.endsWith('s') && lower.length > 3 ? lower.slice(0, -1) : lower;
};

/** Tokens after normalisation: lowercased, split on anything non-alphabetic, stopwords and stems removed. */
export const tokenise = (text: string): string[] => {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== '' && !STOPWORDS.has(word));
  return words.map(stem);
};

/** WHAT A COMPARISON FOUND. The teacher-facing half of every matcher below. */
export interface TokenDiff {
  /** Tokens from the key that the response also produced. */
  readonly matched: readonly string[];
  /** Key tokens the response did not produce. */
  readonly missing: readonly string[];
  /** Response tokens the key does not contain. */
  readonly extra: readonly string[];
  /** `matched / keyTokens.length`, which is 1 for an empty key rather than NaN. */
  readonly overlap: number;
}

export const diffTokens = (expected: readonly string[], actual: readonly string[]): TokenDiff => {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const matched = [...expectedSet].filter((token) => actualSet.has(token));
  const missing = [...expectedSet].filter((token) => !actualSet.has(token));
  const extra = [...actualSet].filter((token) => !expectedSet.has(token));
  // AN EMPTY KEY IS 1, NOT NaN. `0 / 0` is NaN, and `NaN >= threshold` is false, so a question with an empty
  // key would match NOTHING rather than everything -- the opposite of the intent, and invisible in a test that
  // only used non-empty keys.
  const overlap = expectedSet.size === 0 ? 1 : matched.length / expectedSet.size;
  return { matched, missing, extra, overlap };
};

export interface ShortTextVerdict {
  readonly correct: boolean;
  readonly diff: TokenDiff;
  /** Which matcher decided it, so the rationale can say so. */
  readonly matcher: string;
  /** Set when a `REGEX_SET` pattern would not compile, so the rationale can say why nothing matched. */
  readonly invalidPatterns?: readonly string[];
}

/**
 * `EXACT` -- verbatim, with `caseSensitive` the only lever.
 *
 * No normalisation at all, because "exact" means exact. A student who writes "Paris" against a key of "paris"
 * is wrong under this matcher and the rationale says the comparison was case-sensitive, so the marker can see
 * that rather than infer it.
 */
export const exactMatch = (key: string, response: string, caseSensitive = false): boolean =>
  caseSensitive ? key === response : key.trim().toLowerCase() === response.trim().toLowerCase();

/**
 * `NORMALISED` -- case, surrounding whitespace, and internal runs of whitespace collapsed.
 *
 * Deliberately NOT accent-folding or punctuation-stripping. A chemistry student writing `H2O` against a key of
 * `H2O` should not be marked wrong by a stray space, but silently accepting `H-O` against `H2O` would be a
 * different matcher wearing this one's name.
 */
export const normaliseWhitespace = (text: string): string =>
  text.trim().toLowerCase().replace(/\s+/gu, ' ');

/**
 * `REGEX_SET` -- any author pattern matches. `INVALID PATTERNS MATCH NOTHING` rather than throwing.
 *
 * A question bank's patterns are DATA, and data can be malformed. `new RegExp('(')` throws, and a throw here
 * would propagate out of the grader -- which is the one thing section 4 forbids, because a student who
 * triggered a bad pattern in someone else's question would have their paper not marked.
 *
 * Compiling every pattern on every call is wasteful and, more importantly, would make a pattern that compiles
 * once and fails later a nondeterminism bug. The patterns are small and the count is small; this stays simple.
 */
export const regexSetMatch = (patterns: readonly string[], response: string): ShortTextVerdict => {
  const invalid: string[] = [];
  const hit = patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'iu').test(response);
    } catch {
      invalid.push(pattern);
      return false;
    }
  });
  return {
    correct: hit,
    matcher: 'REGEX_SET',
    diff: diffTokens(tokenise(response), tokenise(response)),
    ...(invalid.length === 0 ? {} : { invalidPatterns: invalid }),
  };
};

/**
 * `FUZZY` -- stopwords removed, stems stripped, token overlap at or above the author's threshold.
 *
 * ## AND THE THRESHOLD IS THE AUTHOR'S, WITH A DEFAULT THAT IS NOT ZERO
 *
 * `0` would mean "any single shared token is a pass", which for a one-word key is a coin flip. The default is
 * `0.6`, and it is a default rather than a requirement so an author writing a two-word key is not forced to
 * think about it.
 *
 * ## AND THE OVERLAP DIVIDES BY THE KEY, NEVER BY THE LARGER SET
 *
 * Dividing by the larger of the two would make a student who wrote a paragraph score higher than one who wrote
 * the answer, because their extra words would inflate the denominator. Overlap is "how much of the ANSWER did
 * they produce", so the key is the denominator.
 */
export const fuzzyMatch = (key: string, response: string, threshold = 0.6): ShortTextVerdict => {
  const diff = diffTokens(tokenise(key), tokenise(response));
  return { correct: diff.overlap >= threshold, diff, matcher: 'FUZZY' };
};

/**
 * `NUMERIC_TOLERANCE` on numbers EXTRACTED from the text.
 *
 * "2.5 m/s" against a key of "2.5 m/s^2" shares no tokens after stemming and scores zero under FUZZY, while the
 * student has written the number correctly. This matcher pulls the numbers out and compares them, and it
 * REQUIRES every number in the key to be matched -- so "about 2 or 3" does not pass a key of 2.5.
 */
export const numericTextMatch = (
  key: string,
  response: string,
  tolerance: { absolute?: number; relative?: number },
): ShortTextVerdict => {
  const keyNumbers = (key.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number).filter(Number.isFinite);
  const got = (response.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number).filter(Number.isFinite);
  const absolute = tolerance.absolute ?? 0;
  const relative = tolerance.relative ?? 0;
  const everyNumberMatched =
    keyNumbers.length > 0 &&
    keyNumbers.every((expected) =>
      got.some((actual) => Math.abs(actual - expected) <= absolute + relative * Math.abs(expected)),
    );
  return {
    correct: everyNumberMatched,
    matcher: 'NUMERIC_TOLERANCE',
    diff: diffTokens(tokenise(key), tokenise(response)),
  };
};

/** THE DISPATCH, so a matcher is chosen in one place and a spelling cannot drift. */
export function matchShortText(
  key: string,
  response: string,
  options: {
    readonly matcher: string;
    readonly caseSensitive?: boolean;
    readonly patterns?: readonly string[];
    readonly tokenOverlap?: number;
    readonly numericTolerance?: { absolute?: number; relative?: number };
  },
): ShortTextVerdict {
  switch (options.matcher) {
    case 'EXACT':
      return {
        correct: exactMatch(key, response, options.caseSensitive ?? false),
        matcher: 'EXACT',
        diff: diffTokens(tokenise(key), tokenise(response)),
      };
    case 'NORMALISED':
      return {
        correct: normaliseWhitespace(key) === normaliseWhitespace(response),
        matcher: 'NORMALISED',
        diff: diffTokens(tokenise(key), tokenise(response)),
      };
    case 'REGEX_SET':
      return regexSetMatch(options.patterns ?? [], response);
    case 'FUZZY':
      return fuzzyMatch(key, response, options.tokenOverlap ?? 0.6);
    case 'NUMERIC_TOLERANCE':
      return numericTextMatch(key, response, options.numericTolerance ?? {});
    default:
      // AN UNKNOWN MATCHER MATCHES NOTHING and says so. `plans/07` closes the set, so reaching this means a
      // question names a matcher this grader version does not have -- and matching nothing is visible where a
      // silent "correct" would not be.
      return {
        correct: false,
        matcher: String(options.matcher),
        diff: diffTokens(tokenise(key), tokenise(response)),
      };
  }
}

/**
 * ORDERING: credit as the FRACTION OF CORRECTLY-ORDERED ADJACENT PAIRS.
 *
 * ## WHY ADJACENT PAIRS AND NOT "IN THE RIGHT POSITION"
 *
 * "A student with 3 of 4 in correct relative order earns most of the credit -- which is pedagogically right"
 * (section 3.4). Positional credit would give the same 1 of 4 for a student who has one pair right and one who
 * has understood four of five transitions and mis-ordered the fifth. Adjacency measures the thing being
 * taught, which is the ORDER.
 *
 * ## AND AN IDENTICAL RESPONSE IS NOT A LOOP
 *
 * A pair `(a, b)` where `a === b` is not an ordering error -- there is no transition to have got wrong -- so it
 * is counted as correct. The first version treated it as incorrect, which meant a student repeating one item
 * twice lost the mark for a list they had otherwise ordered perfectly.
 *
 * ## AND THE PAIR COUNT COMES FROM THE RESPONSE'S OWN LENGTH, WHICH HAD A HOLE IN IT
 *
 * A response with one item has no pairs at all and `0 / 0` is NaN, so one item is trivially in order and the
 * fraction is 1 -- the same reasoning as an empty key in `diffTokens`.
 *
 * **THE ORIGINAL GUARD WAS `length <= 1`, WHICH ALSO CAUGHT ZERO ITEMS, AND THAT SCORED A BLANK AS FULL
 * MARKS.** `orderingCredit` is a pure function, so nothing about it said "a blank is handled elsewhere", and the
 * caller had no reason to check. The first version to reach `grade()` therefore marked a student who submitted
 * an empty ordering as CORRECT on every ordering question they were asked -- and the test that found it was an
 * unrelated one about unreachable switch arms, which happened to hand the function an empty array.
 *
 * So the two cases are separated: an empty response scores NOTHING, and only a single-item response is trivially
 * in order. A blank is not an ordering; it is the absence of one.
 */
export function orderingCredit(key: readonly string[], response: readonly string[]): number {
  if (response.length === 0) return 0;
  if (response.length === 1) return 1;
  let correctPairs = 0;
  let counted = 0;
  for (let index = 0; index < response.length - 1; index += 1) {
    const left = response[index];
    const right = response[index + 1];
    if (left === undefined || right === undefined) continue;
    const leftPosition = key.indexOf(left);
    const rightPosition = key.indexOf(right);
    // A pair containing an item the key does not have cannot be judged, so it is not counted at all rather
    // than counted as wrong. Counting it as wrong would let a student lose marks for an option the platform
    // introduced, or for a renamed one.
    if (leftPosition === -1 || rightPosition === -1) continue;
    counted += 1;
    if (left === right || leftPosition < rightPosition) correctPairs += 1;
  }
  if (counted === 0) return 1;
  return correctPairs / counted;
}

/** The pairs that were wrong, so a rationale can name them rather than only reporting a fraction. */
export const misorderedPairs = (key: readonly string[], response: readonly string[]): string[] => {
  const wrong: string[] = [];
  for (let index = 0; index < response.length - 1; index += 1) {
    const left = response[index];
    const right = response[index + 1];
    if (left === undefined || right === undefined) continue;
    const leftPosition = key.indexOf(left);
    const rightPosition = key.indexOf(right);
    if (leftPosition === -1 || rightPosition === -1) continue;
    if (left !== right && leftPosition > rightPosition) wrong.push(`${left} before ${right}`);
  }
  return wrong;
};
