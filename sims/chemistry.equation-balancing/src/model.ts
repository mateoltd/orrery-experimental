/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 12)
 *
 * ## THE STUDENT WRITES A SENTENCE, AND THAT IS A DIFFERENT GRADING PROBLEM
 *
 * Every other simulation's answer is a number, a set, or a list. This one's is a line of chemical
 * algebra, typed as text. That is how the answer is actually written in a chemistry course, and it is the
 * first thing on the curriculum a student cannot reduce to a number in a box.
 *
 * ## SO WHAT COUNTS AS THE SAME ANSWER
 *
 * The same equation can be written with the reactants on the right, with terms in either order inside a
 * bracket, with `1` written or omitted, and with `H2O` or `H2O(l)`. A grader that compares strings
 * accepts exactly one of those, so it marks most correct answers wrong and teaches a student that the
 * question is about matching a string rather than balancing an equation.
 *
 * The comparison is therefore on a NORMAL FORM: split into terms, each term split into an element and a
 * count, sorted, and compared as sets of pairs. `2 H2 + O2 -> 2 H2O`, `O2 + 2H2 = 2H2O` and `H2 + 1/2 O2
 * -> H2O` are then one answer rather than three.
 *
 * ## MULTIPLYING AN EQUATION IS NOT A DIFFERENT BALANCED EQUATION
 *
 * `H2 + O2 -> H2O` is not balanced; `2H2 + O2 -> 2H2O` is. But `2H2 + O2 -> 2H2O` and `4H2 + 2O2 ->
 * 4H2O` are the SAME equation multiplied, and a student who writes the second has not done different
 * chemistry. The comparison is by RATIO, so the multiplier cancels -- otherwise the question is really
 * asking for one particular whole-number reduction, which is not what balancing means.
 */

/** The equation as given: deliberately UNBALANCED, because that is the question. */
export const GIVEN = { left: 'H2 + O2', right: 'H2O' } as const;

/** The stoichiometric ratio, which is what "balanced" means. */
export const BALANCED = {
  left: ['H', 2],
  right: null,
} as const;

/**
 * No parameters, deliberately.
 *
 * The first version declared a `context` parameter typed as a NUMBER with `min: 0, max: 0` -- a value that
 * can only be zero, used to carry a sentence. A parameter is an input a host can set, and one that can
 * only ever be 0 is a lie about the interface. The framing sentence belongs to the simulation.
 */
export interface BalanceParams {
  readonly readonly: true;
}

/** The framing, which is a property of the simulation and not of the lesson. */
export const CONTEXT = 'Hydrogen burns in oxygen to make water.';

export interface Term {
  readonly element: string;
  readonly count: number;
}

const ELEMENT_PATTERN = /([A-Z][a-z]?)(\d*(?:\.\d+)?)/gu;
const STATE_SUFFIX = /\((?:s|l|g|aq)\)/giu;

/**
 * One side of an equation, as a sorted list of element/count pairs.
 *
 * An empty side is legal -- `-> ` with nothing on the right is a student's common first attempt -- and is
 * represented as an empty list rather than a parse error.
 */
export function parseSide(side: string): Term[] {
  const cleaned = side.replace(STATE_SUFFIX, '');
  const totals = new Map<string, number>();
  for (const raw of cleaned.split(/->|[=+\u2192]/u)) {
    const term = raw.trim();
    if (term === '') continue;
    const coefficientMatch = /^(\d*(?:\.\d+)?)/u.exec(term);
    const coefficient = Number(coefficientMatch?.[1] || '1');
    const elementPart = term.slice(coefficientMatch?.[1].length ?? 0).trim();
    const matches = [...elementPart.matchAll(ELEMENT_PATTERN)];
    if (matches.length === 0) {
      throw new Error(`TERM: ${JSON.stringify(term)} is not an element`);
    }
    // EVERY ELEMENT IN THE TERM, NOT ONLY THE FIRST.
    //
    // `2H2O` is the most ordinary term in chemistry and the first version read only the first match, so
    // it scored as four hydrogens and dropped the oxygen entirely. Nothing then balanced, the conformance
    // cell reported `expect.grade was 4, the grader awarded 0`, and the manifest was right: the answer
    // `O2 + 2H2 = 2H2O` is balanced.
    for (const match of matches) {
      const element = match[1] ?? '?';
      const subscript = match[2];
      const per = subscript === undefined || subscript === '' ? 1 : Number(subscript);
      totals.set(element, (totals.get(element) ?? 0) + coefficient * per);
    }
  }
  // Deduplicate: a side written `H2 + H` means H3, and two terms of one element are one term.
  return [...totals.entries()]
    .map(([element, count]): Term => ({ element, count }))
    .sort((a, b) => a.element.localeCompare(b.element));
}

/** Multiply a side by a factor, which is what scaling the whole equation does. */
export const scale = (terms: readonly Term[], factor: number): Term[] =>
  terms
    .map((term) => ({ element: term.element, count: term.count * factor }))
    .sort((a, b) => a.element.localeCompare(b.element));

/**
 * The normal form: sides scaled by the LARGEST coefficient on the left, then sorted.
 *
 * Cancelling the common multiplier is what makes `2H2 + O2 -> 2H2O` and `4H2 + 2O2 -> 4H2O` the same
 * answer. Dividing by the largest left-hand count is enough because every balanced equation's ratio is
 * fixed; no general-purpose divisor search is warranted for a stoichiometry question.
 */
export function signature(side: string): string {
  const terms = parseSide(side);
  if (terms.length === 0) return '';
  const largest = Math.max(...terms.map((term) => term.count));
  if (largest === 0) return '';
  return scale(terms, 1 / largest)
    .map((term) => `${term.element}:${round(term.count)}`)
    .join(',');
}

export const isBalanced = (left: string, right: string): boolean =>
  parseSide(left).length > 0 && signature(left) === signature(right);

/** One side as the student would read it back. */
export function describeEquation(): string {
  return (
    `${CONTEXT} Write the balanced equation for ${GIVEN.left} reacting to give ${GIVEN.right}, as a ` +
    `single line. Whole numbers are fine, and the equation may be written in either direction.`
  );
}

export function round(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}
