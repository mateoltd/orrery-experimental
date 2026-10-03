/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 23)
 *
 * ## THE FIRST SIMULATION WHOSE STATE IS A HISTORY RATHER THAN A POSITION
 *
 * Twenty-two simulations so far, and every one's state is a position: a day, a step, a point, an angle.
 * This one ACCUMULATES. Sorting a list means remembering which pairs were compared and which pairs swapped,
 * and the whole question is *how many* — so the history IS the state, and the counters are its length rather
 * than a field somebody has to keep in step with it.
 *
 * That distinction is why this file stores a list of comparisons instead of a count. A count answers "how
 * many" but not "which", and the questions worth asking about a sort — which pair was compared most often,
 * what was the first swap — are questions about the list.
 *
 * ## AND THE LIST IS DERIVED FROM A SEED, NOT TYPED IN
 *
 * `plans/10` lists no array-valued manifest parameter, and the schema agrees: `paramProperty` allows only
 * number, integer, boolean, string and enum. A first draft took the numbers as a `number[]` parameter, which
 * no host could ever deliver — every manifest validation and every conformance run would have failed on a
 * parameter that does not exist in the vocabulary. So the parameter is a SEED and the list comes out of it.
 *
 * This is better teaching anyway. With one fixed list, `n(n-1)/2` is the same number for every student at a
 * given size and a whole class can compare notes. With a seed, two students at the same size get different
 * counts, so the answer is a fact about *their* array and `n(n-1)/2` is visibly only the ceiling.
 */

export interface SortItem {
  /** The value being sorted. Separate from the identity so two equal values stay distinguishable. */
  readonly value: number;
  /** Which item this is, and stays. A sort moves items; it does not relabel them. */
  readonly id: number;
}

export interface Comparison {
  readonly left: number;
  readonly right: number;
  /** Which pass made it. Step numbers alone cannot tell a second pass from a first. */
  readonly pass: number;
}

export interface Swap {
  readonly left: number;
  readonly right: number;
  readonly pass: number;
}

export interface SortState {
  readonly items: readonly SortItem[];
  readonly comparisons: readonly Comparison[];
  readonly swaps: readonly Swap[];
  readonly passes: number;
  /** True once a whole pass made no swap: the evidence that the sort is finished. */
  readonly finished: boolean;
}

export const MIN_SIZE = 5;
export const MAX_SIZE = 14;
export const MAX_SEED = 999;

export const clampSize = (raw: unknown): number => {
  const size = Number(raw);
  // 5..14. Below five there are too few pairs to reason about; above fourteen the worst case is 91
  // comparisons and the blocks stop being distinguishable at any honest canvas width.
  return Number.isFinite(size) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size))) : 9;
};

export const clampSeed = (raw: unknown): number => {
  const seed = Number(raw);
  return Number.isFinite(seed) ? Math.min(MAX_SEED, Math.max(0, Math.round(seed))) : 7;
};

export interface SortParams {
  readonly size: number;
  readonly seed: number;
}

export const clampParams = (raw: Partial<SortParams> | undefined): SortParams => ({
  size: clampSize(raw?.size),
  seed: clampSeed(raw?.seed),
});

/**
 * THE LIST FOR A SEED.
 *
 * ## XORSHIFT32, NOT `Math.random()`
 *
 * `Math.random()` would make the question unanswerable: a student cannot count comparisons on a list that
 * changes on every reload. The generator is chosen because it is four lines, has no dependency, and does not
 * repeat itself for neighbouring seeds — which a test asserts over a spread of them.
 *
 * ## AND THE VALUES ARE DISTINCT
 *
 * Two equal neighbours make bubble sort's decision unobservable: the pair is compared, nothing moves, and the
 * student cannot tell a working sort from one that skipped the check. Shuffling a run of consecutive integers
 * guarantees distinctness, so every comparison either swaps or is visibly a real "leave it alone".
 */
export function valuesOf(seed: number, size: number): number[] {
  const values = Array.from({ length: clampSize(size) }, (_, index) => index);
  let state = Math.imul(clampSeed(seed) + 0x9e37, 0x85ebca6b) >>> 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    // xorshift32. `>>> 0` keeps the word unsigned so `>>` never introduces a negative state.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const other = state % (index + 1);
    const held = values[index];
    if (held === undefined) continue;
    values[index] = values[other] ?? held;
    values[other] = held;
  }
  return values;
}

export const initialItems = (values: readonly number[]): SortItem[] =>
  values.map((value, index) => ({ value, id: index }));

export const initialState = (params: SortParams): SortState => ({
  items: initialItems(valuesOf(params.seed, params.size)),
  comparisons: [],
  swaps: [],
  passes: 0,
  finished: false,
});

/**
 * ONE PASS OF BUBBLE SORT.
 *
 * ## EVERY PAIR LOOKED AT IS COUNTED, SWAP OR NOT
 *
 * This is the distinction the whole simulation is about. The count is of PAIRS, not of exchanges, so a pass
 * over nine numbers always costs eight comparisons even when it changes nothing. A version that counted
 * swaps instead answered "how many comparisons" with a number about a different event, and it agreed with
 * `n(n-1)/2` only when every single comparison swapped.
 *
 * ## AND `finished` IS EVIDENCE, NOT A STEP COUNT
 *
 * It becomes true when a whole pass finishes without a swap — not when the pass count reaches `n-1`, which is
 * the worst case rather than what happened. An already-sorted list finishes on pass 1 whatever its size.
 */
export function pass(state: SortState, maxPasses: number): SortState {
  if (state.finished || state.passes >= maxPasses) return state;

  const items = [...state.items];
  const comparisons: Comparison[] = [...state.comparisons];
  const swaps: Swap[] = [...state.swaps];
  const number = state.passes + 1;
  let swapped = false;

  // THE WINDOW SHRINKS BY ONE EACH PASS, and this is the whole reason `n(n-1)/2` is a real number.
  //
  // Each pass carries the largest unsorted value to the end, so the tail is already final and must not be
  // compared again: pass 1 costs n-1, pass 2 costs n-2, and the total is bounded by n(n-1)/2. The first
  // version walked the whole list every pass, which made pass 2 cost another n-1 — so a five-item list used
  // 16 comparisons against a stated ceiling of 10, and 26 of the first 30 seeds "exceeded the worst case".
  // The count was not bubble sort's count at all, and the question the simulation asks had no stable answer.
  //
  // It also made `finished` unreachable in the intended sense: no shrinking window means no clean pass to
  // detect. Shrinking is not an optimisation here, it is the definition.
  const limit = items.length - number + 1;

  for (let index = 0; index + 1 < limit; index += 1) {
    const left = items[index];
    const right = items[index + 1];
    if (left === undefined || right === undefined) continue;
    // COUNTED FIRST, BEFORE ANY DECISION. The count is a property of looking, not of acting.
    comparisons.push({ left: left.id, right: right.id, pass: number });
    if (left.value > right.value) {
      items[index] = right;
      items[index + 1] = left;
      swaps.push({ left: left.id, right: right.id, pass: number });
      swapped = true;
    }
  }

  return { items, comparisons, swaps, passes: number, finished: !swapped };
}

/**
 * RUN `n` PASSES FROM THE START.
 *
 * ## PURE, AND THAT IS THE ONLY REASON SCRUBBING WORKS
 *
 * A stepper whose state accumulates cannot go backwards — there is no "un-compare". So each step is recomputed
 * from step zero, which is what lets the scrub slider sit anywhere and show the same thing twice. The history
 * is therefore *stored* (the questions need it) but never *accumulated across calls* (the stepper needs
 * purity), and those two facts sit in different places on purpose.
 */
export function runTo(params: SortParams, n: number, maxPasses = MAX_SIZE): SortState {
  const bounded = Math.min(Math.max(Math.round(n), 0), maxPasses);
  let state = initialState(params);
  for (let index = 0; index < bounded; index += 1) {
    if (state.finished) break;
    state = pass(state, maxPasses);
  }
  return state;
}

/** How many pairs `n` numbers have, and so the most comparisons any bubble sort of them can make. */
export const maxComparisons = (size: number): number => (size * (size - 1)) / 2;

/** How many passes could possibly be needed: at most `n-1`, plus the clean pass that proves it. */
export const maxPassesFor = (size: number): number => size;

/** THE ANSWER, DERIVED FROM THE SAME TRACE THE STUDENT WATCHES. Never a constant typed into the grader. */
export function totalComparisons(params: SortParams): number {
  return runTo(params, maxPassesFor(params.size)).comparisons.length;
}

export const isSorted = (items: readonly SortItem[]): boolean =>
  items.every((item, index) => index === 0 || (items[index - 1]?.value ?? 0) <= item.value);

export const round = (value: number): number => {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function format(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  return String(Number(value.toFixed(4)));
}

export const describeList = (params: SortParams): string =>
  `The list is ${valuesOf(params.seed, params.size)
    .map((value) => String(value))
    .join(', ')}.`;

/** THE QUESTION. It asks for the comparison count and says nothing at all about swaps. */
export function describeTask(params: SortParams): string {
  return (
    `Bubble sort walks along the list comparing each pair of neighbours, swapping a pair when the left one ` +
    `is bigger, and stops when a whole pass swaps nothing. ${describeList(params)} Work out how many ` +
    `comparisons the sort makes on this list before it stops.`
  );
}

export function describeAlternative(params: SortParams): string {
  return (
    `A list of ${String(params.size)} different numbers is sorted by repeatedly comparing each pair of ` +
    `neighbours and swapping them when the left is bigger, stopping once a whole pass swaps nothing. ` +
    `${describeList(params)} The task is to work out how many comparisons that takes.`
  );
}
