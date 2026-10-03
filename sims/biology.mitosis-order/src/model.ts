/**
 * The model. Pure, DOM-free, deterministic.  (P6-T11, gold sim 11)
 *
 * ## THE ANSWER IS AN ORDERED LIST, AND ORDER IS THE QUESTION
 *
 * The student puts six stages of cell division in order. Every item is present in any arrangement, so a
 * SET matcher would score a completely reversed sequence as a perfect answer — the exact inverse of the
 * mistake `setMatch` exists to prevent in a quadratic, where `3, 1` and `1, 3` are the same answer.
 *
 * This is the platform's first `ORDER` answer and its first `biology` simulation.
 *
 * ## WHY INTERPHASE IS IN THE LIST
 *
 * Interphase is not a stage of mitosis; it is the gap before it, during which the DNA is replicated.
 * Including it is deliberate, because a student who lists only the four mitotic stages has given the
 * right answer to a different question, and the simulation says plainly that the list runs from one
 * interphase to one cytokinesis.
 */

export interface Stage {
  readonly name: string;
  /** What is happening, for the stage card. Deliberately not the name, which is the answer. */
  readonly detail: string;
}

/** In order. The order here IS the answer. */
export const STAGES: readonly Stage[] = [
  {
    name: 'Interphase',
    detail: 'DNA is copied, so each chromosome now consists of two sister chromatids.',
  },
  {
    name: 'Prophase',
    detail: 'The nuclear envelope breaks down and the spindle begins to form.',
  },
  {
    name: 'Metaphase',
    detail: 'Chromosomes line up across the middle of the cell.',
  },
  {
    name: 'Anaphase',
    detail: 'Sister chromatids separate and are pulled to opposite poles.',
  },
  {
    name: 'Telophase',
    detail: 'Two nuclei form, one at each pole, around the separated chromosomes.',
  },
  {
    name: 'Cytokinesis',
    detail: 'The cytoplasm divides, producing two daughter cells.',
  },
];

export const NAMES: readonly string[] = STAGES.map((stage) => stage.name);

export interface OrderParams {
  /** How many stages the list holds. Fewer stages means a shorter question, not a different one. */
  readonly count: number;
}

export const clamp = (params: OrderParams): OrderParams => ({
  count: Math.min(
    NAMES.length,
    Math.max(2, Math.round(Number.isFinite(params.count) ? params.count : 6)),
  ),
});

/**
 * A SHUFFLE that is deterministic.
 *
 * `Math.random()` would make the simulation untestable and would put a different question in front of
 * every student, which is exactly what a seeded RNG exists to avoid. The seed comes from the host.
 */
export function shuffled(count: number, seed: number): string[] {
  const names = NAMES.slice(0, clamp({ count }).count);
  const out = [...names];
  let state = (Math.trunc(seed) || 1) >>> 0;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swap = state % (index + 1);
    const held = out[index] as string;
    out[index] = out[swap] as string;
    out[swap] = held;
  }
  // A shuffle that lands on the answer teaches nothing, and a seeded one can do that legitimately.
  if (out.every((name, index) => name === names[index])) {
    const held = out[0] as string;
    out[0] = out[out.length - 1] as string;
    out[out.length - 1] = held;
  }
  return out;
}

/** Move an item, which is how the student reorders it. Bounds are checked, not clamped silently. */
export function move(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const held = next[from] as string;
  next.splice(from, 1);
  next.splice(to, 0, held);
  return next;
}

/** How many POSITIONS are right, which is what the grader credits. */
export function correctPositions(order: readonly string[], count: number): number {
  const answer = NAMES.slice(0, count);
  let right = 0;
  for (const [index, name] of answer.entries()) {
    if (order[index] === name) right += 1;
  }
  return right;
}

export function describeOrder(count: number): string {
  return (
    `Six events from one cell division are shown as cards, each described but not named. Put them in ` +
    `the order they happen, starting from the stage in which the DNA is copied and finishing with the ` +
    `division of the cytoplasm. ${count === 6 ? '' : `This question uses ${String(count)} of them. `}` +
    `The task is to give the order.`
  );
}

/** Counts are integers, so this only has to survive a NaN reaching a feedback string. */
export const format = (value: number): string =>
  Number.isFinite(value) ? String(value) : 'undefined';
