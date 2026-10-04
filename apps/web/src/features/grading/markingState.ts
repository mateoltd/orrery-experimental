/**
 * What a response IS, as far as marking goes -- and what it is not.  (P9-T2)
 *
 * ## `NEEDS_HUMAN` IS NOT ZERO, AND THIS MODULE IS WHERE THE SCREEN LEARNS THE DIFFERENCE
 *
 * `grade()` returns `points: 0` in two completely different situations: the student answered and was wrong, and the
 * grader declined to judge. The number is the same. `plans/07` is explicit that they are different facts -- "a
 * student is never auto-zeroed because our code failed" (`INV-SIM-2`), and `computeScore` counts a `needsHuman`
 * response in `maxTotal` and not in `rawTotal` precisely because it has earned nothing YET.
 *
 * A screen that renders `points` therefore renders a wrong answer for every unmarked essay. So nothing in the
 * workspace reads `auto.points` directly. It reads `markingStateOf`, and for `AWAITING_MARK` that carries NO NUMBER AT
 * ALL -- there is no field to render as a zero, by construction rather than by remembering not to.
 *
 * ## THIS DESCRIBES THE MARKING, NEVER THE STUDENT, AND IT PRODUCES NO SCORE
 *
 * `integrity/timeline.ts` deliberately has no function that derives a verdict from evidence, on the reasoning that
 * one would eventually be called. The same holds here. `markingStateOf` answers "has anybody marked this, and if not,
 * why did the machine not" -- every reason in `AwaitingReason` is about the question, the key, the grader or the
 * platform. There is no function in this lane that looks at an answer and proposes a mark, ranks a response, or
 * says anything about the person who wrote it (`D13`).
 */

import type { GradeFlag, Rationale } from '@orrery/contracts/grading';
import type { SimOutcome } from '@orrery/contracts/grading/simulation';
import type { TeacherQuestionSpec } from '@orrery/contracts/question';

/** The stored auto-grade: `GradeOutput` as `QuestionResponse` keeps it. */
export interface AutoMark {
  readonly points: number;
  /** Before the zero floor. `NG` and `PM` drive this negative BY DESIGN (`plans/07` §3.2). */
  readonly rawPoints: number;
  readonly maxPoints: number;
  readonly rationale: Rationale;
  readonly flags: readonly GradeFlag[];
  readonly graderVersion: string;
}

export interface ManualMark {
  readonly points: number;
  readonly feedback: string;
  readonly bandId: string | null;
}

/** What is stored about a simulation answer. Read, not recomputed: re-running the grader is P9-T7. */
export interface SimEvidence {
  readonly title: string;
  /** `null` when no outcome is stored at all. */
  readonly outcome: SimOutcome | null;
  /** The bounded interaction trace, as stored. Entries are opaque here and shown as stored. */
  readonly trace: readonly unknown[];
}

export interface ResponseFacts {
  readonly responseId: string;
  readonly questionId: string;
  /** The teacher projection, key included. This object never goes to a student surface. */
  readonly spec: TeacherQuestionSpec;
  readonly prompt: string;
  /** As stored. It came out of a JSON column and is read as untrusted. */
  readonly answer: unknown;
  readonly isOmitted: boolean;
  /** `V-4`: blank because the clock ran out, which is a different fact from blank by choice. */
  readonly notReached: boolean;
  readonly isExcused: boolean;
  readonly flagged: boolean;
  readonly needsHuman: boolean;
  readonly auto: AutoMark | null;
  readonly manual: ManualMark | null;
  readonly sim?: SimEvidence;
  /** Changes whenever the stored response or its mark changes. A draft records the one it was written against. */
  readonly version: string;
}

/** Why the machine did not decide. Every member is about the question, the key, the grader or the platform. */
export type AwaitingReason =
  /** The question is marked by a person. Not a failure of anything. */
  | 'MARKED_BY_HAND'
  /** The simulation's grader threw, timed out, or returned nothing usable. Ours, not the student's. */
  | 'SIMULATION_FAULT'
  /** A penalising method scored this below zero. A real mark exists; a person is shown it before it stands. */
  | 'PENALISED_BELOW_ZERO'
  /** The question has no readable answer key. */
  | 'KEY_UNREADABLE'
  /** No grader exists for this question type or scoring method. */
  | 'NO_GRADER'
  /** The stored answer could not be read as an answer to this question. */
  | 'ANSWER_UNREADABLE'
  /** Nothing has graded this yet. */
  | 'NOT_YET_GRADED'
  /** Marked as needing a person, with no further detail recorded. */
  | 'REFERRED';

export type MarkingState =
  | { readonly kind: 'EXCUSED' }
  | { readonly kind: 'MARKED'; readonly points: number; readonly maxPoints: number }
  /** NO `points` FIELD. See the note at the top of this file. */
  | { readonly kind: 'AWAITING_MARK'; readonly why: AwaitingReason; readonly maxPoints: number }
  /** Sealed. Visible, and not editable here (`plans/07` §5.1). */
  | {
      readonly kind: 'MARKED_AUTOMATICALLY';
      readonly points: number;
      readonly maxPoints: number;
    };

const awaitingReason = (facts: ResponseFacts): AwaitingReason => {
  const { auto } = facts;
  if (facts.sim?.outcome?.kind === 'NEEDS_HUMAN') return 'SIMULATION_FAULT';
  if (auto === null)
    return facts.spec.gradingMode === 'MANUAL' ? 'MARKED_BY_HAND' : 'NOT_YET_GRADED';
  if (auto.rawPoints < 0) return 'PENALISED_BELOW_ZERO';
  // A `REGEX_SET` pattern that does not compile is the author's typo, not the student's answer, and the grader
  // refers it for that reason. It is a key nobody can apply, which is the same thing to a marker as a missing one.
  if (auto.flags.includes('OUT_OF_RANGE_KEY') || 'invalidPatterns' in auto.rationale.detail) {
    return 'KEY_UNREADABLE';
  }
  if (auto.flags.includes('UNKNOWN_TYPE')) return 'NO_GRADER';
  if (facts.spec.gradingMode === 'MANUAL') return 'MARKED_BY_HAND';
  if (auto.rationale.code === 'MANUAL_REQUIRES_HUMAN') return 'NO_GRADER';
  if (auto.flags.includes('MALFORMED_RESPONSE')) return 'ANSWER_UNREADABLE';
  return 'REFERRED';
};

/**
 * THE MARKING STATE.
 *
 * Precedence, and why: an excuse removes the question from both sums, so nothing else about it matters; a mark a
 * person entered outranks whatever the machine said; and anything the machine did not decide is AWAITING -- including
 * a response with no auto-grade at all, which is "nobody has looked", not "nothing was earned".
 */
export const markingStateOf = (facts: ResponseFacts): MarkingState => {
  if (facts.isExcused) return { kind: 'EXCUSED' };
  if (facts.manual !== null) {
    return { kind: 'MARKED', points: facts.manual.points, maxPoints: facts.spec.points };
  }
  if (facts.needsHuman || facts.auto === null || facts.auto.flags.includes('NEEDS_HUMAN')) {
    return { kind: 'AWAITING_MARK', why: awaitingReason(facts), maxPoints: facts.spec.points };
  }
  return {
    kind: 'MARKED_AUTOMATICALLY',
    points: facts.auto.points,
    maxPoints: facts.auto.maxPoints,
  };
};

/**
 * MAY THE AUTOMATIC MARK BE ACCEPTED AS IT STANDS?
 *
 * Only where one EXISTS and was referred so that a person would see it: a penalising method's negative raw score.
 * The alternative offered to the teacher is a hand-entered mark, and a hand-entered mark is bounded at zero
 * (`rubric.ts`) -- so "confirming" a penalised response by typing `0` would erase the penalty for that one student,
 * which is the nonlinear transform §3.2 exists to forbid. Accepting writes no `manualScore` and leaves the raw score
 * where the attempt total can floor it.
 *
 * It is never offered for the other reasons, because there the stored `points: 0` is not a mark.
 */
export const canAcceptAutomaticMark = (facts: ResponseFacts): boolean => {
  const state = markingStateOf(facts);
  return state.kind === 'AWAITING_MARK' && state.why === 'PENALISED_BELOW_ZERO';
};

/** Can a teacher enter a mark here? Not on a sealed auto-grade: that is flagged and regraded, never overridden. */
export const isMarkable = (facts: ResponseFacts): boolean =>
  markingStateOf(facts).kind !== 'MARKED_AUTOMATICALLY';

export interface MarkingCounts {
  readonly total: number;
  readonly awaiting: number;
  readonly marked: number;
  readonly markedAutomatically: number;
  readonly excused: number;
}

/**
 * COUNTS, AND DELIBERATELY NO TOTAL SCORE.
 *
 * A running total on this screen would be a number that changes as the teacher marks and that omits everything
 * still awaiting a mark -- a provisional figure with nothing saying so. `computeScore` owns the arithmetic and its
 * `isProvisional` flag; this reports progress and leaves the score to the place that can qualify it.
 */
export const countMarking = (responses: readonly ResponseFacts[]): MarkingCounts => {
  let awaiting = 0;
  let marked = 0;
  let markedAutomatically = 0;
  let excused = 0;
  for (const facts of responses) {
    const state = markingStateOf(facts);
    if (state.kind === 'AWAITING_MARK') awaiting += 1;
    else if (state.kind === 'MARKED') marked += 1;
    else if (state.kind === 'MARKED_AUTOMATICALLY') markedAutomatically += 1;
    else excused += 1;
  }
  return { total: responses.length, awaiting, marked, markedAutomatically, excused };
};

/**
 * THE NEXT RESPONSE STILL AWAITING A MARK, after `from`, wrapping once. `null` when there is none.
 *
 * "Save and advance" goes here rather than to `from + 1`, because on a paper of thirty questions with three essays
 * the next index is almost always a sealed auto-grade the teacher has nothing to do on.
 */
export const nextAwaiting = (responses: readonly ResponseFacts[], from: number): number | null => {
  for (let step = 1; step <= responses.length; step += 1) {
    const index = (from + step) % responses.length;
    const facts = responses[index];
    if (index !== from && facts !== undefined && markingStateOf(facts).kind === 'AWAITING_MARK') {
      return index;
    }
  }
  return null;
};

/* ───────────────────────────────────────────────────── reading the answer ── */

/**
 * THE STORED ANSWER, READ FOR DISPLAY.
 *
 * Three outcomes that must not be confused: the student wrote something (`PRESENT` shapes), the student wrote nothing
 * (`BLANK`), and something is stored that is not an answer to this question (`UNREADABLE`). The third is a platform
 * fault and is shown as stored. Rendering it as a blank would tell a teacher the student left the question empty.
 */
export type ReadAnswer =
  | { readonly kind: 'BLANK' }
  | { readonly kind: 'UNREADABLE'; readonly stored: string }
  | { readonly kind: 'CHOICES'; readonly selected: readonly string[] }
  | { readonly kind: 'BOOLEAN'; readonly value: boolean }
  | { readonly kind: 'NUMBER'; readonly written: string; readonly unit: string | null }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'ORDER'; readonly itemIds: readonly string[] }
  | { readonly kind: 'FILES'; readonly assetIds: readonly string[] }
  | { readonly kind: 'SIMULATION'; readonly reported: string }
  | { readonly kind: 'STEPS'; readonly steps: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly what is stored, as text. Never throws: this runs on values nobody has validated. */
export const storedText = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const unreadable = (answer: unknown): ReadAnswer => ({
  kind: 'UNREADABLE',
  stored: storedText(answer),
});

const absent = (value: unknown): boolean => value === undefined || value === null;

/** A list of strings, or `null`. A list holding anything else is not silently filtered: it is unreadable. */
const strings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : null;

const readList = (
  answer: Record<string, unknown>,
  field: string,
  build: (list: readonly string[]) => ReadAnswer,
): ReadAnswer => {
  if (absent(answer[field])) return { kind: 'BLANK' };
  const list = strings(answer[field]);
  if (list === null) return unreadable(answer);
  return list.length === 0 ? { kind: 'BLANK' } : build(list);
};

const readText = (answer: Record<string, unknown>): ReadAnswer => {
  if (absent(answer.text)) return { kind: 'BLANK' };
  if (typeof answer.text !== 'string') return unreadable(answer);
  return answer.text.trim() === '' ? { kind: 'BLANK' } : { kind: 'TEXT', text: answer.text };
};

/** A worked-solution step as stored: the text, or an object carrying it. */
const stepText = (step: unknown): string | null => {
  if (typeof step === 'string') return step;
  if (isRecord(step) && typeof step.text === 'string') return step.text;
  if (absent(step)) return '';
  return null;
};

export const readAnswer = (spec: TeacherQuestionSpec, answer: unknown): ReadAnswer => {
  if (absent(answer)) return { kind: 'BLANK' };
  if (!isRecord(answer)) return unreadable(answer);

  switch (spec.type) {
    case 'single_choice':
      if (absent(answer.choiceId)) return { kind: 'BLANK' };
      return typeof answer.choiceId === 'string'
        ? { kind: 'CHOICES', selected: [answer.choiceId] }
        : unreadable(answer);

    case 'multi_select':
      return readList(answer, 'choiceIds', (selected) => ({ kind: 'CHOICES', selected }));

    case 'true_false':
      if (absent(answer.value)) return { kind: 'BLANK' };
      return typeof answer.value === 'boolean'
        ? { kind: 'BOOLEAN', value: answer.value }
        : unreadable(answer);

    case 'numeric': {
      if (absent(answer.value) && absent(answer.raw)) return { kind: 'BLANK' };
      // AS WRITTEN when the written form was kept: `9.810` and `9.81` are the same number and different answers to
      // a question that asks for significant figures.
      const written =
        typeof answer.raw === 'string'
          ? answer.raw
          : typeof answer.value === 'number' && Number.isFinite(answer.value)
            ? String(answer.value)
            : null;
      if (written === null) return unreadable(answer);
      if (written.trim() === '') return { kind: 'BLANK' };
      return {
        kind: 'NUMBER',
        written,
        unit: typeof answer.unit === 'string' ? answer.unit : null,
      };
    }

    case 'short_text':
    case 'free_response':
      return readText(answer);

    case 'ordering':
      return readList(answer, 'itemIds', (itemIds) => ({ kind: 'ORDER', itemIds }));

    case 'file_submission':
      return readList(answer, 'assetIds', (assetIds) => ({ kind: 'FILES', assetIds }));

    case 'simulation':
      // The reported answer is the sim's own shape, so it is shown as stored. The state and trace are the replay
      // pane's.
      return absent(answer.answer)
        ? { kind: 'BLANK' }
        : { kind: 'SIMULATION', reported: storedText(answer.answer) };

    case 'worked_solution': {
      if (absent(answer.steps)) return { kind: 'BLANK' };
      if (!Array.isArray(answer.steps)) return unreadable(answer);
      const steps: string[] = [];
      for (const step of answer.steps) {
        const text = stepText(step);
        if (text === null) return unreadable(answer);
        steps.push(text);
      }
      return steps.every((text) => text.trim() === '')
        ? { kind: 'BLANK' }
        : { kind: 'STEPS', steps };
    }

    default: {
      const exhaustive: never = spec;
      return unreadable(exhaustive);
    }
  }
};

/** Why there is no answer, when there is none. `PRESENT` covers an unreadable one too: something IS stored. */
export type AnswerPresence = 'PRESENT' | 'BLANK' | 'OMITTED' | 'NOT_REACHED';

export const answerPresenceOf = (facts: ResponseFacts): AnswerPresence => {
  // `notReached` first: `V-4` exists because a trailing blank on a timed paper is the clock, not the student, and
  // the two flags can both be set.
  if (facts.notReached) return 'NOT_REACHED';
  if (facts.isOmitted) return 'OMITTED';
  return readAnswer(facts.spec, facts.answer).kind === 'BLANK' ? 'BLANK' : 'PRESENT';
};
