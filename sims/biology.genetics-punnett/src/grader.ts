/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 14 `biology.genetics-punnett`)
 *
 * ## IT USES `bagMatch`, NOT `setMatch`, AND PLANTING THAT IS HOW THE BUG WAS FOUND
 *
 * A cross of `Aa x Aa` yields `AA, Aa, Aa, aa` and the COUNT IS THE ANSWER. `setMatch` compares sets, so it collapses
 * the duplicate: a student writing `AA, Aa, aa` -- omitting one heterozygote, which is the entire content of the
 * exercise -- produced the same three-element set as the correct four-cell answer and was awarded **CORRECT 4/4**.
 *
 * That was found by planting the wrong answer rather than by reading the code, and it is the reason `bagMatch` exists in
 * the SDK. `setMatch` is not wrong: ticking "AA" and "aa" in a checkbox list means the set {AA, aa}. **The primitive was
 * MISSING, not wrong**, and fixing `setMatch` would have silently broken every selectable-options item in the catalogue.
 *
 * ## `caseSensitive: true` IS LOAD-BEARING HERE AND NOWHERE ELSE
 *
 * `grading.ts:370` folds case unless a caller opts out, and the opt-out exists precisely for this
 * simulation: `AA` and `aa` are different genotypes, so folding case compares the recessive answer against
 * the dominant list and awards it as correct. Every other `SET` item in the catalogue is a list of
 * selectable options where folding is right, so a reader must not mistake this flag for house style.
 *
 * ## THE STATE IS NOT THE ANSWER, AND THIS GRADER NEVER READS IT
 *
 * `grade(state, params, answer)` is handed its first argument and this grader never looks at it,
 * deliberately. The question is a pure function of the RESOLVED VARIANT — the two parents and the dominant
 * allele — and `protocol.ts:41` is explicit that `params` come from the resolved variant rather than from
 * whatever the browser last rendered. A grader that read the parents out of the state would grade the
 * question the student last SAW rather than the question they were SET, which is how a replay of a stored
 * state stops reproducing a stored mark.
 */

import { bagMatch, defineSim } from '@orrery/sim-sdk/grader';
import {
  canonicalRatio,
  clamp,
  describeCross,
  GENOTYPES,
  offspring,
  ratio,
  trimEntries,
} from './model.js';

/** The marks. Two for the genotypes, two for the ratio — the card names both as the answer. */
export const OFFSPRING_MARKS = 2;
export const RATIO_MARKS = 2;
export const MAX_POINTS = OFFSPRING_MARKS + RATIO_MARKS;

const parse = (answer: unknown): { offspring: unknown; ratio: string } | null => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  const list = record.offspring;
  if (!Array.isArray(list) && typeof list !== 'string') return null;
  return { offspring: list, ratio: typeof record.ratio === 'string' ? record.ratio : '' };
};

export default defineSim({
  meta: {
    id: 'biology.genetics-punnett',
    title: 'Punnett squares',
    version: '1.0.0',
    subjects: ['biology'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    parentA: {
      type: 'enum',
      name: 'parentA',
      label: 'First parent',
      values: [...GENOTYPES],
      default: 'Aa',
    },
    parentB: {
      type: 'enum',
      name: 'parentB',
      label: 'Second parent',
      values: [...GENOTYPES],
      default: 'Aa',
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A four-cell Punnett square with both parents named along the top and the side, and two boxes for the offspring genotypes and the ratio.',
    reducedMotion: true,
    textAlternative:
      'A Punnett square with Aa along the top and Aa down the side, and A the dominant allele. The four cells hold 1 AA, 2 Aa, 1 aa, so the offspring ratio is 1:2:1.',
    summary:
      'Complete a Punnett square for a chosen pair of parents and read the offspring ratio off the cells.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    const parsed = parse(answer);
    if (parsed === null) {
      // `UNPARSEABLE` rather than `INCORRECT`: nothing was compared with anything, and item analysis has to
      // be able to tell an item nobody could answer from an item everybody mis-conceives.
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'No genotypes and no ratio were submitted, so there is nothing to score. Enter the offspring ' +
          'as a comma-separated list and the ratio as three counts separated by colons.',
      };
    }
    const params = clamp(rawParams as Partial<Parameters<typeof clamp>[0]>);
    // TRIMMED HERE AS WELL AS IN THE BROWSER, and it has to be: `setMatch` with `caseSensitive: true`
    // cannot trim, and `gradeStoredState` may be handed an answer that never came through a form. The
    // normalisation lives in `model.ts` so the two halves cannot disagree about what a genotype is.

    // `bagMatch`, not `setMatch`: see the header. Partial credit is multiset Jaccard, so an omitted
    // heterozygote costs the student marks instead of being invisible.
    const genotypes = bagMatch(trimEntries(parsed.offspring), offspring(params), {
      maxPoints: OFFSPRING_MARKS,
      partialCredit: true,
      // Both flags are load-bearing, for different reasons. See the file header.
      caseSensitive: true,
    });
    const expectedRatio = ratio(params);
    const statedRatio = canonicalRatio(parsed.ratio);
    const ratioRight = statedRatio === expectedRatio;
    const points = genotypes.points + (ratioRight ? RATIO_MARKS : 0);
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeCross(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        `Genotypes: ${genotypes.feedback}. Ratio: you wrote "${parsed.ratio}", the cells give ` +
        `"${expectedRatio}". ${describeCross(params)} The ratio is written over all three genotypes, ` +
        'so a count of zero is shown rather than left out.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const record = state as Record<string, unknown>;
    if (typeof record.parentA !== 'string') return 'the state has no `parentA` genotype string';
    if (typeof record.parentB !== 'string') return 'the state has no `parentB` genotype string';
    return null;
  },
});
