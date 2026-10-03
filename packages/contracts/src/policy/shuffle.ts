/**
 * Per-student shuffles for options and questions.  (P7-T8)
 *
 * ## THE SHUFFLE IS NOT THE INTERESTING PART, AND THE CAUTIONS ARE
 *
 * `plans/06` §5 lists three levers and gives option shuffling this caution: "**Never shuffle when an option is
 * 'all of the above' or 'none of the above'; never shuffle when option order carries meaning** (steps in an
 * ordered list, a numeric scale, a Likert row)".
 *
 * Both refusals exist because a permuted option list is not a cosmetic change. A student who has learned that
 * "all of the above" is usually correct has been given a real strategy, and shuffling hides which option that
 * is — but a shuffle that moved "none of the above" to the top of a five-option list has changed the ANSWER's
 * position, not just its label. And shuffling a Likert row from "Strongly disagree … Strongly agree" to
 * "Strongly agree … Strongly disagree" does not randomise anything: it inverts the scale, and a student who
 * answers honestly is marked wrong.
 *
 * `Rng.shuffle` already does the permutation. What does not exist anywhere is the decision of WHETHER to
 * permute, and that decision is the whole reason this file is here.
 *
 * ## AND A SHUFFLE MUST BE RE-DERIVABLE FROM ITS SEED, OR A RE-GRADE IS IMPOSSIBLE
 *
 * `INV-RNG-1`: "All randomness flows through seeded `@orrery/rng`; the seed is stored". The seed being stored is
 * not for reproducibility of the display — it is so that a regrade months later can put option `c` back where it
 * was. A shuffle that used `Math.random` would make every stored response unresolvable, because nothing would
 * say which permutation the student saw.
 *
 * So every function here takes the seed explicitly and derives a LABELLED sub-stream with `rng.fork(label)`.
 * Forking by label rather than drawing from one stream is what makes the result independent of how many other
 * draws happened first — otherwise adding a new lever to an existing paper would change every student's variant.
 */

/**
 * `@orrery/rng` IS A DEPENDENCY RATHER THAN A COPY OF ITS ALGORITHM, and the reason is `INV-RNG-1`.
 *
 * The rule is "all randomness flows through seeded `@orrery/rng`; the seed is stored", and the second half is
 * load-bearing: a shuffle that used a local FNV-1a plus a local Fisher-Yates would be a second implementation of
 * a seeded PRNG, and the day the two drifted a paper would shuffle differently on the server than on the client,
 * or a regrade would reproduce a permutation nobody can verify. `rng` is a leaf package with no dependencies, so
 * this edge creates no cycle, and `db` and `sim-sdk` already depend on it.
 */
import { createRng } from '@orrery/rng';

/** The lever's result: what the student saw, and the seed that produced it. */
export interface ShuffleResult<T> {
  readonly items: readonly T[];
  /** The seed, STORED, so a regrade can re-derive this exact permutation. */
  readonly seed: string;
  /** Why no shuffle happened, when none did. Empty rather than undefined for a stable shape. */
  readonly skipped: ShuffleSkipReason | null;
}

export type ShuffleSkipReason =
  | 'FEWER_THAN_THREE_OPTIONS'
  | 'CATCH_ALL_OPTION'
  | 'ORDERED_SCALE'
  | 'ORDER_CARRIES_MEANING'
  | 'SHUFFLE_DISABLED'
  | 'SINGLETON';

/**
 * TEXT THAT MAKES AN OPTION A CATCH-ALL, matched on the option's own words rather than on a flag.
 *
 * A flag would be better engineering and is not available: the option text is authored content, and a bank
 * imported from another system has no flags. Matching the text catches the case that actually happens, and the
 * failure mode of a false positive -- one question not shuffled that could have been -- is much cheaper than
 * the false negative, which is a student losing marks on a question whose answer moved.
 *
 * The patterns are deliberately anchored on "all/none/both/either of the above" plus a following noun, so an
 * option that merely CONTAINS the word "all" ("Call the titration") is not mistaken for one.
 */
const CATCH_ALL = [
  /\b(?:all|none|both|either|neither)\s+of\s+the\s+above\b/iu,
  /\b(?:all|none)\s+of\s+these\b/iu,
  /\ball\s+of\s+the\s+following\b/iu,
  /\bnone\s+of\s+(?:the\s+)?(?:above|these|them)\b/iu,
];

/** An option text that reads as a catch-all, so this question's options must keep their order. */
export const hasCatchAllOption = (options: readonly { readonly text: string }[]): boolean =>
  options.some((option) => CATCH_ALL.some((pattern) => pattern.test(option.text)));

/**
 * TEXT THAT MARKS AN ORDERED SCALE, where position IS the answer.
 *
 * A Likert row or a 1-to-5 scale is not a set of options, it is an axis, and permuting the axis inverts every
 * response a student gives. These are matched on the SCALE WORDS rather than on the question type, because the
 * plan's caution is about the option list's meaning and a question type does not know what its options mean.
 */
const ORDERED_SCALE = [
  /\bstrongly\s+(?:agree|disagree)\b/iu,
  /\b(?:very\s+|slightly\s+|strongly\s+)?(?:agree|disagree)\s+strongly\b/iu,
  /\b(?:very|extremely)\s+(?:unlikely|likely)\b/iu,
  /\b(?:0|1)\s*(?:to|–|-|\.\.)\s*(?:5|7|10)\b/iu,
  /\bfrom\s+\d+\s+to\s+\d+\b/iu,
  /\b(?:not\s+at\s+all|extremely)\b[\s\S]{0,20}\b(?:very|extremely)\b/iu,
];

/** An option text that reads as one end of an ordered scale. */
export const hasOrderedScale = (options: readonly { readonly text: string }[]): boolean =>
  options.some((option) => ORDERED_SCALE.some((pattern) => pattern.test(option.text)));

/**
 * SHUFFLE A QUESTION'S OPTIONS, unless one of the plan's cautions applies.
 *
 * `meaningfulOrder` is the author's explicit override for the case the heuristics cannot see: a chemistry
 * question whose options are "solid / liquid / gas" in phase order, or a list whose order the lesson depends on.
 * It is a parameter rather than a spec field because `QuestionSpec` is frozen by P7-T1 and adding a field means
 * a version bump; the caller reads it from whatever authoring metadata it has.
 *
 * ## WHY TWO OPTIONS ARE LEFT ALONE
 *
 * A two-option question has exactly one non-identity permutation, so shuffling it either does nothing or flips
 * it -- and a binary question is the one most likely to be answered by position ("the first one"). Flipping it
 * removes a cue without adding any variation, so the threshold is three.
 */
export const shuffleOptions = <T extends { readonly text: string }>(
  options: readonly T[],
  seed: string,
  opts: { readonly enabled: boolean; readonly meaningfulOrder?: boolean },
): ShuffleResult<T> => {
  const skip = (reason: ShuffleSkipReason): ShuffleResult<T> => ({
    items: options,
    seed,
    skipped: reason,
  });

  if (!opts.enabled) return skip('SHUFFLE_DISABLED');
  // An author who says the order means something outranks every heuristic below.
  if (opts.meaningfulOrder === true) return skip('ORDER_CARRIES_MEANING');
  if (options.length <= 1) return skip('SINGLETON');
  if (options.length === 2) return skip('FEWER_THAN_THREE_OPTIONS');
  if (hasCatchAllOption(options)) return skip('CATCH_ALL_OPTION');
  if (hasOrderedScale(options)) return skip('ORDERED_SCALE');

  return { items: createRng(seed).fork('options').shuffle(options), seed, skipped: null };
};

/**
 * SHUFFLE THE QUESTION ORDER for a paper.
 *
 * ## AND THE CAUTION APPLIES TO THE PAPER AS WELL AS TO THE OPTIONS
 *
 * `plans/06`'s caution says "never shuffle when option order carries meaning", and a paper's own order carries
 * meaning far more often: a scaffolded worksheet builds each question on the last, an instruction says "using
 * your answer to part (a)", and a simulation question may introduce a parameter the next question asks about.
 * So `meaningfulOrder` is the DEFAULT for question order and shuffling it is the exception a paper opts into.
 *
 * That is the opposite default to option shuffling, and deliberately: a permuted option list is a within-question
 * nuisance, while a permuted paper changes what the student is able to do.
 */
export const shuffleQuestionOrder = <T>(
  questions: readonly T[],
  seed: string,
  opts: { readonly enabled: boolean },
): ShuffleResult<T> => {
  const skip = (reason: ShuffleSkipReason): ShuffleResult<T> => ({
    items: questions,
    seed,
    skipped: reason,
  });
  if (!opts.enabled) return skip('SHUFFLE_DISABLED');
  // An EMPTY paper is refused as a singleton rather than shuffled: `[].shuffle()` returns `[]`, which is
  // indistinguishable from "the shuffle declined", and a blueprint slot that matched nothing should be visible
  // rather than silently produce a shorter paper.
  if (questions.length <= 1) return skip('SINGLETON');
  // A two-question paper has one non-identity permutation too, and flipping it decides which half of the
  // material the student meets first -- which is not a variation anyone wants by accident.
  if (questions.length === 2) return skip('FEWER_THAN_THREE_OPTIONS');
  return { items: createRng(seed).fork('questions').shuffle(questions), seed, skipped: null };
};

/**
 * A SEED PER STUDENT PER ATTEMPT, from values the server already has.
 *
 * Built by string concatenation rather than by hashing, because the inputs are already strings and the only
 * requirement is that two different (student, attempt, variant) triples cannot collide. The separator is a
 * character that cannot appear in a UUID, so `("a-b", "c")` and `("a", "b-c")` cannot produce the same seed --
 * a real hazard when the parts are ids a caller assembled from user input.
 *
 * Nothing secret goes in: the seed is stored on the attempt and printed in a receipt, and `hashSeed` is FNV-1a,
 * which is not a security primitive and is not used as one. It only has to be stable across platforms.
 */
export const shuffleSeedFor = (parts: {
  readonly assignmentId: string;
  readonly studentId: string;
  readonly attemptId: string;
  readonly variantLabel?: string;
}): string => {
  const separator = '\u0000';
  for (const [name, value] of Object.entries(parts)) {
    if (value.includes(separator)) {
      // A separator collision would make two different students share a permutation, which shows up as two
      // identical papers and is very hard to trace back. Refusing is better than hashing the whole thing.
      throw new Error(
        `shuffleSeedFor: ${name} contains the separator, so the seed would be ambiguous`,
      );
    }
  }
  return [parts.assignmentId, parts.studentId, parts.attemptId, parts.variantLabel ?? ''].join(
    separator,
  );
};
