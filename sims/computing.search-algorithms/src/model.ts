/**
 * The model. Pure, DOM-free, deterministic.  (P12-T2, card 70 `computing.search-algorithms`)
 *
 * ## THE ANSWER IS A COUNT, AND A RELATIVE BAND ON A COUNT IS SLACK
 *
 * The card names tolerance class T-A and says why: "a relative band on it would accept a linear search that
 * happened to get lucky, which is precisely the misconception the row targets." A `rel: 0.02` band on a
 * count of 12 accepts 11.76 to 12.24 — and the counts this simulation produces include several pairs that
 * differ by one, which is the whole question. So every count here is compared EXACTLY and `withinTolerance`
 * is never given a non-zero bound.
 *
 * ## THE MIDPOINT CONVENTION IS DECLARED, AND IT IS THE LOWER MIDDLE
 *
 * A binary search on an even-length range has two defensible midpoints and they give different counts. The
 * shipped `computing.binary-search` uses `low + floor((high − low) / 2)`, so this simulation declares the
 * same convention and the grader uses the same one — a simulation that silently used the other convention
 * would mark a correct trace wrong for a reason the question never stated.
 *
 * ## THE UNSORTED CASE IS A REFUSAL, NOT A WRONG ANSWER
 *
 * Binary search on an array that is not ascending has no defined result. Rather than return a plausible
 * wrong number the model returns a REFUSAL with a reason, which the browser shows and the grader reports
 * under its own code. The alternative — quietly returning a count — is how a student learns that binary
 * search finds a value that is present in an unsorted list, which is misconception (3) on the card.
 *
 * The shipped `computing.binary-search` answers a narrower question (binary search alone, on an array that is
 * sorted by construction). This simulation is the COMPARISON: both algorithms on the same list, the declared
 * precondition, and the worst-case bound.
 */

export type Algorithm = 'binary' | 'linear';

export interface SearchParams {
  /** Which search the student runs. */
  readonly algorithm: Algorithm;
  /** How many elements the list holds. */
  readonly size: number;
  /** The value being searched for. */
  readonly target: number;
  /** Whether the list is in ascending order. A binary search's DECLARED precondition. */
  readonly ascending: boolean;
}

export const MIN_SIZE = 4;
export const MAX_SIZE = 64;

/** Declared, used by both searches, and stated in the text alternative. */
export const MIDPOINT = 'lower' as const;

/**
 * What `index` is when the target is not there.
 *
 * A DECLARED SENTINEL rather than `null`, because `asNumber(null)` is `null` and a grader asked to compare a
 * student's `null` with an expected `null` reports UNPARSEABLE — which says the comparison could not be
 * made, and it can. A student who searched and did not find it types -1 and is told what -1 means.
 */
export const INDEX_WHEN_ABSENT = -1;

/**
 * Read a yes/no answer, because `asNumber` returns `null` for a boolean and `numeric` would then report
 * UNPARSEABLE for a student who answered `true`. The three spellings are the ones a select, a checkbox and a
 * text box produce.
 */
export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

export const clamp = (raw: Partial<SearchParams>): SearchParams => {
  const size = Math.round(Number(raw.size));
  const target = Math.round(Number(raw.target));
  return {
    algorithm: raw.algorithm === 'linear' ? 'linear' : 'binary',
    size: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Number.isFinite(size) ? size : 16)),
    target: Math.min(999, Math.max(-999, Number.isFinite(target) ? target : 9)),
    ascending: raw.ascending !== false,
  };
};

/**
 * The list, in the order the DECLARED input puts it.
 *
 * `ascending: false` swaps the first and last values rather than reversing the list, which is deliberate:
 * a reversed list is still a list every binary search fails on in the same way, whereas a swap of the
 * extremes is the ordinary student error of typing the values in without ordering them — and the list still
 * CONTAINS every value, which is exactly what makes misconception (3) tempting.
 */
export function haystack(params: SearchParams): number[] {
  const list = Array.from({ length: params.size }, (_, index) => index + 1);
  if (params.ascending) return list;
  const swapped = [...list];
  const last = swapped.length - 1;
  const first = swapped[0] ?? 0;
  swapped[0] = swapped[last] ?? first;
  swapped[last] = first;
  return swapped;
}

/** The precondition, CHECKED rather than asserted in a comment. */
export function isAscending(list: readonly number[]): boolean {
  return list.every(
    (value, index) => index === 0 || value > (list[index - 1] ?? Number.POSITIVE_INFINITY),
  );
}

export interface SearchStep {
  readonly index: number;
  readonly value: number;
  readonly outcome: 'less' | 'greater' | 'found' | 'exhausted';
  readonly comparisons: number;
}

export interface SearchResult {
  readonly steps: SearchStep[];
  readonly comparisons: number;
  readonly found: boolean;
  readonly index: number | null;
  /** Non-null when the search was REFUSED, with the reason it was refused. */
  readonly refusal: string | null;
}

/**
 * Linear search, instrumented on the loop the animation follows.
 *
 * The count INCLUDES the comparison that ends an unsuccessful search, because the loop compares against one
 * final element before it gives up and stopping one step early is the commonest trace error there is.
 */
export function linearSearch(list: readonly number[], target: number): SearchResult {
  const steps: SearchStep[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index] ?? Number.NaN;
    const comparisons = index + 1;
    const outcome: SearchStep['outcome'] = value === target ? 'found' : 'less';
    steps.push({ index, value, outcome, comparisons });
    if (value === target) return { steps, comparisons, found: true, index, refusal: null };
  }
  // THE LAST COMPARISON IS THE EXHAUSTION, NOT ANOTHER `less`. An earlier draft pushed a second step at the
  // same index, so the animation showed one box twice and the trace had more steps than comparisons -- which
  // is the one thing a student counting comparisons would notice.
  const lastIndex = steps.length - 1;
  const final = steps[lastIndex];
  const exhausted: SearchStep =
    final === undefined
      ? { index: 0, value: Number.NaN, outcome: 'exhausted', comparisons: 0 }
      : { ...final, outcome: 'exhausted' };
  return {
    steps: [...steps.slice(0, lastIndex), exhausted],
    comparisons: list.length,
    found: false,
    index: null,
    refusal: null,
  };
}

/**
 * Binary search, with the DECLARED precondition enforced.
 *
 * The refusal is the content of misconception (3): the value may well be present, and the search still cannot
 * find it, and saying so is the only honest answer.
 */
export function binarySearch(list: readonly number[], target: number): SearchResult {
  if (!isAscending(list)) {
    return {
      steps: [],
      comparisons: 0,
      found: false,
      index: null,
      refusal:
        'Binary search needs the list in ascending order, and this one is not: it contains every value ' +
        'from 1 upwards, but not in order. There is no comparison count to report, because no search was run.',
    };
  }
  const steps: SearchStep[] = [];
  let low = 0;
  let high = list.length - 1;
  let comparisons = 0;
  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const value = list[index] ?? Number.NaN;
    comparisons += 1;
    if (value === target) {
      steps.push({ index, value, outcome: 'found', comparisons });
      return { steps, comparisons, found: true, index, refusal: null };
    }
    if (value < target) {
      steps.push({ index, value, outcome: 'less', comparisons });
      low = index + 1;
    } else {
      steps.push({ index, value, outcome: 'greater', comparisons });
      high = index - 1;
    }
  }
  // AN UNSUCCESSFUL SEARCH ENDS WITH ONE FURTHER COMPARISON, against the element just past the range the
  // last step eliminated. That element was never compared before, which is why the count is one more than
  // the number of steps inside the loop -- and it is the shipped `computing.binary-search` convention
  // (`computing.binary-search/src/model.ts:88`), so a student who met that simulation meets this one.
  const exhausted = Math.min(low, list.length - 1);
  steps.push({
    index: exhausted,
    value: list[exhausted] ?? Number.NaN,
    outcome: 'exhausted',
    comparisons: comparisons + 1,
  });
  return {
    steps,
    comparisons: comparisons + 1,
    found: false,
    index: null,
    refusal: null,
  };
}

export function search(params: SearchParams): SearchResult {
  const list = haystack(params);
  return params.algorithm === 'linear'
    ? linearSearch(list, params.target)
    : binarySearch(list, params.target);
}

/**
 * The worst-case bound for the declared algorithm, in comparisons.
 *
 * Binary search is `⌈log₂(n + 1)⌉`, which is the SMALLEST count any target can produce plus the one that
 * ends an unsuccessful search. A student who believes every binary search takes exactly `log₂(n)` steps is
 * wrong for the target at the far end, and this is the number that says so.
 */
export function worstCase(params: SearchParams): number {
  if (params.algorithm === 'linear') return params.size;
  return Math.ceil(Math.log2(params.size + 1));
}

/** The text alternative, DERIVED. It quotes the list and the count so the question is computable from text. */
export function describeSearch(params: SearchParams): string {
  const list = haystack(params);
  const result = search(params);
  const verdict = result.found
    ? `it finds ${String(params.target)} at position ${String(result.index)}`
    : 'it does not find it';
  return (
    `A list of ${String(params.size)} numbers${
      params.ascending
        ? ' in ascending order'
        : ' NOT in ascending ' +
          `order (${list.slice(0, 3).join(', ')} … ${list.slice(-3).join(', ')})`
    } is searched for ` +
    `${String(params.target)} by ${params.algorithm} search, taking the lower of the two middles when the ` +
    `remaining range has an even number of elements. It makes ${String(result.comparisons)} comparisons and ` +
    `${verdict}. Its worst case on ${String(params.size)} elements is ${String(worstCase(params))} comparisons.`
  );
}
