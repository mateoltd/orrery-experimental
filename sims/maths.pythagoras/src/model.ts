/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 5)
 *
 * ## A QUESTION WITH MORE THAN ONE ANSWER
 *
 * "Which side is the longest?" has three possible answers and a student may name either of the two
 * equal ones when there is a tie. So the answer is a SET, and the grader is set grading — the first gold
 * sim to need it. That matters beyond this sim: `plans/20` requires set-match grading in P7, and building
 * it here means the SDK's set helpers are exercised by a simulation rather than only by their own tests.
 *
 * ## THE STUDENT MAY ENTER THE VALUE OR THE NAME
 *
 * "12", "hypotenuse" and "c" all answer the same question correctly, and refusing two of them would be
 * pedantry dressed as rigour. Both are accepted, and both produce the same set.
 */

export interface TriangleParams {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** When false, the student must name the side rather than give its length. */
  readonly giveLengths: boolean;
}

/** The names a student may use for a side, and what each is called in a right-angle triangle. */
export const SIDE_NAMES = ['opposite', 'adjacent', 'hypotenuse'] as const;
export type SideName = (typeof SIDE_NAMES)[number];

export const isSideName = (value: unknown): value is SideName =>
  typeof value === 'string' && (SIDE_NAMES as readonly string[]).includes(value);

/**
 * The VERTEX a right angle sits at, which is `'a' | 'b' | 'c'`.
 *
 * **THIS IS NOT `SideName`, AND CONFUSING THE TWO WAS A REAL BUG.** `SideName` is the vocabulary a
 * STUDENT uses to name a side (`opposite` / `adjacent` / `hypotenuse`), and `rightAngles` returned
 * `angle: SideName` while pushing `'a'`, `'b'` and `'c'` — the vertex labels. The three pushes were
 * type errors, and the drawing code that consumed the result tested `entry.angle === 'a'`, which can
 * never be true of a `SideName`, so the right-angle marker was drawn at the `c` vertex for EVERY
 * triangle: a 3-4-5 and a triangle right-angled at `a` were drawn identically.
 *
 * A vertex and a side name are different things that happen to be spelled differently in the diagram,
 * so they get different types.
 */
export type VertexName = 'a' | 'b' | 'c';

/** Every right angle that this triangle has. A non-triangle has none. */
export function rightAngles(params: TriangleParams): Array<{ angle: VertexName; degrees: number }> {
  const angles: Array<{ angle: VertexName; degrees: number }> = [];
  if (isRightAngleAt(params, 'a')) angles.push({ angle: 'a', degrees: 90 });
  if (isRightAngleAt(params, 'b')) angles.push({ angle: 'b', degrees: 90 });
  if (isRightAngleAt(params, 'c')) angles.push({ angle: 'c', degrees: 90 });
  return angles;
}

/**
 * Is there a right angle AT side `x`?
 *
 * The parameter is load-bearing and the first version ignored it, checking all three sides regardless —
 * which made `rightAngles` push a 90° entry for every side in any triangle that happened to be right,
 * and made the isosceles case report three right angles instead of two.
 */
export const isRightAngleAt = (params: TriangleParams, x: 'a' | 'b' | 'c'): boolean => {
  const { a, b, c } = params;
  const squares = { a: a * a, b: b * b, c: c * c };
  if (x === 'a') return Math.abs(squares.a - (squares.b + squares.c)) <= 1e-9;
  if (x === 'b') return Math.abs(squares.b - (squares.a + squares.c)) <= 1e-9;
  return Math.abs(squares.c - (squares.a + squares.b)) <= 1e-9;
};

export function isTriangle(params: TriangleParams): boolean {
  const { a, b, c } = params;
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Number.isFinite(c) &&
    a > 0 &&
    b > 0 &&
    c > 0 &&
    a + b > c &&
    a + c > b &&
    b + c > a
  );
}

export function isRightTriangle(params: TriangleParams): boolean {
  return isTriangle(params) && rightAngles(params).length > 0;
}

/** The interior angles, which is what a student reads off the picture. */
export function angles(params: TriangleParams): { a: number; b: number; c: number } {
  const { a, b, c } = params;
  return {
    a: (Math.acos((b * b + c * c - a * a) / (2 * b * c)) * 180) / Math.PI,
    b: (Math.acos((a * a + c * c - b * b) / (2 * a * c)) * 180) / Math.PI,
    c: (Math.acos((a * a + b * b - c * c) / (2 * a * b)) * 180) / Math.PI,
  };
}

/** The student's answer, normalised to a SET of side names. */
export function parseAnswer(answer: unknown): Set<string> {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const key = value.trim().toLowerCase();
    if (key.length === 0) return;
    if (key === 'c' || key === 'hypotenuse' || key === 'hyp') found.add('c');
    if (key === 'a' || key === 'opposite') found.add('a');
    if (key === 'b' || key === 'adjacent') found.add('b');
  };
  if (answer === null || answer === undefined) return found;
  if (Array.isArray(answer)) {
    for (const item of answer) add(item);
    return found;
  }
  if (typeof answer === 'object') {
    // The name may itself be a LIST: the sim sends `{name: ['a','b']}` when a student typed more than
    // one, and reading only a string silently produced an empty set and a mark of 0 for a correct answer.
    const name = (answer as Record<string, unknown>).name;
    if (Array.isArray(name)) {
      for (const item of name) add(item);
      return found;
    }
    add(name);
    return found;
  }
  add(answer);
  return found;
}

/** The sides that are longest, longest-but-one, and shortest. A tie shares the places. */
export function order(params: TriangleParams): { longest: Set<string>; shortest: Set<string> } {
  // ANNOTATED BEFORE THE SORT, not after it. The `as Array<[string, number]>` used to sit on the RESULT
  // of `.sort(...)`, so the comparator itself was checked against the un-annotated literal's inferred
  // element type — `(string | number)[][]` — where `y[1] - x[1]` is an arithmetic operation on
  // `string | number | undefined`. It happens to work because the numbers really are numbers, which is
  // exactly the case a cast on the wrong side of the call is unable to notice. Annotating the ARRAY and
  // then sorting it is what puts the comparator under the tuple type.
  const sides: Array<[string, number]> = [
    ['a', params.a],
    ['b', params.b],
    ['c', params.c],
  ];
  const entries = sides.sort((x, y) => y[1] - x[1]);
  const longest = new Set<string>();
  const shortest = new Set<string>();
  const top = entries[0]?.[1] ?? 0;
  const bottom = entries[entries.length - 1]?.[1] ?? 0;
  for (const [name, value] of entries) {
    if (Math.abs(value - top) <= 1e-9) longest.add(name);
    if (Math.abs(value - bottom) <= 1e-9) shortest.add(name);
  }
  return { longest, shortest };
}

/** One sentence, naming the answer and the reasoning a teacher would accept. */
export function describeTriangle(params: TriangleParams): string {
  if (!isTriangle(params)) {
    return `${format(params.a)}, ${format(params.b)} and ${format(params.c)} cannot be the sides of a triangle.`;
  }
  const right = rightAngles(params);
  const { longest } = order(params);
  const longestText =
    longest.size === 1
      ? `the side of length ${format(params[longest.values().next().value as 'a'])}`
      : `the sides of length ${format(params.a)} and ${format(params.b)}`;
  const rightText =
    right.length === 0
      ? 'It is not right-angled.'
      : right.length === 1
        ? `The right angle is opposite the ${right[0]?.angle} side.`
        : 'It has a right angle at both ends of the equal sides, so either is correct.';
  return (
    `A triangle with sides ${format(params.a)}, ${format(params.b)} and ${format(params.c)}. ` +
    `The longest is ${longestText}. ${rightText}`
  );
}

export const format = (value: number): string => {
  if (!Number.isFinite(value)) return 'undefined';
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};
