/**
 * The sealed/released boundary type, and the rule that only released grades may cross it.
 * (P5-T13)
 *
 * ## WHAT THIS IS FOR, AND WHY IT IS HERE IN P5
 *
 * `D-9` was a direct circular dependency: `P16-T1` (interop) needed to know what it may send
 * outside, and `P10-T10` (the sealed student view) needed to know what it may show. So the two
 * waited for each other and the plan's own closing note contradicted `P16-T1`'s stated dependency.
 * The fix is this file: one boundary type, defined once, in a package with no dependencies, with
 * both sides depending on it. That is a skeleton for a dependency, not an abstraction for its own
 * sake.
 *
 * ## THE SEALED ARM HAS NO SCORE FIELD TO OMIT
 *
 * This is the whole design and it is borrowed from `D-25`, which calls it the most important gate
 * in the plan. The obvious way to express a withheld grade is an optional score:
 *
 * ```ts
 * type Grade = { released: boolean; score?: number };
 * ```
 *
 * and that type is wrong in a way no amount of careful code fixes. The score field exists. Every
 * consumer now has a branch where it is populated and a branch where it is not, the branches are
 * written by different people, and the reviewer's job becomes finding all of them. The failure is
 * found by a student, on a real exam, at the moment the teacher releases nothing.
 *
 * So the sealed arm is a DIFFERENT TYPE with no score in it. A leak is a compile error, and a
 * compile error cannot ship at 17:55 on a Friday. `expectTypeError` below is not a formality: it is
 * the assertion that the compiler still refuses.
 *
 * ## INV-RELEASE-2 IS ABOUT INFERENCE, NOT ABOUT THE FIELD
 *
 * "No score field" is necessary and not sufficient. A `total` is a score. A count of correct
 * answers is a score. So is a percentage, and so is anything else a student could divide. The
 * sealed arm therefore carries only facts about the work the student did themselves: when they
 * submitted, what they answered, and the receipt hash. Nothing derived from the key — not even a
 * partial one.
 *
 * ## THE COMPARISON IS AN ERROR, NOT A FALLBACK
 *
 * A builder that receives a sealed grade and a "released" flag and shrugs is the leak. There is no
 * boolean parameter anywhere in this file. If a caller holds a sealed value and wants a score,
 * they must go and read the database, which is where the permission check lives.
 */

import { scoreDigest } from './digest.js';

/** What a student is always allowed to know about their own work. */
export interface AttemptReceipt {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly submittedAt: string;
  /** Immutable, so two receipts for one submission can be compared. */
  readonly receiptHash: string;
  readonly answers: readonly {
    readonly questionId: string;
    readonly answer: unknown;
    readonly submittedAt: string;
  }[];
}

/**
 * Before release. There is no `score`, no `total`, no `correctCount`, no `percentage` and no
 * `outcome`. Not optional, not null, not rounded: absent.  (`INV-RELEASE-2`)
 */
export interface SealedGrade {
  readonly state: 'SEALED';
  readonly receipt: AttemptReceipt;
}

/** The numbers themselves, named so the boundary's argument type can refer to them. */
export interface ReleasedScore {
  readonly rawTotal: number;
  readonly maxTotal: number;
  readonly percentage: number | null;
  readonly perQuestion: readonly {
    readonly questionId: string;
    readonly score: number;
    readonly max: number;
    readonly outcome: 'CORRECT' | 'PARTIAL' | 'INCORRECT' | 'EXCUSED';
    readonly feedback: string | null;
    readonly correctAnswer: string | null;
  }[];
}

/** After release. Everything above, plus the grade. */
export interface ReleasedGrade {
  readonly state: 'RELEASED';
  readonly receipt: AttemptReceipt;
  readonly score: ReleasedScore;
  readonly releasedAt: string;
  /** True when a regrade landed after release, so the student is told why the number moved. */
  readonly regradeNotice: string | null;
}

export type Grade = SealedGrade | ReleasedGrade;

/**
 * Is this a number a student could divide?
 *
 * Score-bearing outbound payloads pass through here, which is why it accepts `unknown` — a codec
 * is handed whatever the caller built and the check must not depend on a type the caller
 * cooperated with.
 *
 * ## WHY THE LIST HAS THE NAMES IN IT
 *
 * `maxTotal` is in the list, and a total is not a score. That is deliberate: `maxTotal` travels
 * with `rawTotal` and a student holding both can compute a percentage, and `releasedAt` says
 * plainly which attempt is which. `excusedCount` is here for the same reason — the denominator
 * moves with it. Every one of these was a "harmless" field at some point.
 */
export const SCORE_BEARING_KEYS = new Set([
  'score',
  'scores',
  'rawTotal',
  'total',
  'maxTotal',
  'percentage',
  'percent',
  'grade',
  'grades',
  'outcome',
  'outcomes',
  'correctCount',
  'incorrectCount',
  'correct',
  'isCorrect',
  'excusedCount',
  'rubricScore',
  'manualScore',
  'autoScore',
  'finalScore',
  'answerKey',
  'correctAnswer',
  'modelAnswer',
]);

export interface PayloadViolation {
  readonly path: string;
  readonly key: string;
}

/**
 * Every score-bearing key anywhere in a payload, with its path.
 *
 * Keys only, and that is deliberate: values are opaque here. A JSON *value* of `0.8` is a
 * completion ratio in one payload and a score in another, and refusing to look at values would
 * make this check a false promise in one direction while trying to be clever about it in the
 * other. Keys are where the leak actually is, and a key that means something else should not be
 * called `score`.
 */
export function findScoreBearingKeys(value: unknown, path = '$'): PayloadViolation[] {
  const out: PayloadViolation[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      // A block body, not a concise arrow: `forEach` ignores a return value, and returning
      // `walk`'s is the shape that makes a future reader wonder whether the walk is short-circuiting.
      node.forEach((element, i) => {
        walk(element, `${at}[${String(i)}]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = `${at}.${key}`;
      if (SCORE_BEARING_KEYS.has(key)) out.push({ path: here, key });
      walk(child, here);
    }
  };
  walk(value, path);
  return out;
}

export interface BoundaryInput {
  readonly released: boolean;
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly submittedAt: string;
  readonly answers: readonly { questionId: string; answer: unknown; submittedAt: string }[];
  /**
   * Present in the record, and IGNORED when `released` is false.
   *
   * A conditional type over the union was the first attempt at this and it collapsed to `never`,
   * which the compiler caught and a reviewer would not have: `Grade extends ReleasedGrade` is
   * false for a union, so the whole expression is `Omit<never, never>`. A named interface is also
   * what lets `assert.types.ts` refer to it.
   */
  readonly score: ReleasedScore | null;
  readonly releasedAt: string | null;
  readonly regradeNotice: string | null;
}

/**
 * Build the student-facing grade.  (P5-T13)
 *
 * The returned object is passed through `assertNoScoreLeak` on its way out, so a caller cannot get
 * a sealed grade carrying a score even by constructing one by hand — the function will have thrown
 * before it returns.
 */
export function buildStudentGrade(input: BoundaryInput): Grade {
  const receipt: AttemptReceipt = {
    attemptId: input.attemptId,
    assignmentId: input.assignmentId,
    submittedAt: input.submittedAt,
    // Deterministic, so "have I seen this page before?" does not become a signal and so a retry
    // of the same submission produces the same receipt in a test assertion.
    receiptHash: scoreDigest({
      attemptId: input.attemptId,
      assignmentId: input.assignmentId,
      submittedAt: input.submittedAt,
      answers: input.answers.map((a) => [a.questionId, a.submittedAt]),
    }),
    answers: input.answers,
  };

  if (!input.released) {
    // The score is IN HAND and is dropped here. There is no `score: undefined` and no
    // `...(input.score && {score})`: the sealed object is constructed from the fields we are
    // willing to say, not from the record minus its secrets.
    const sealed: SealedGrade = { state: 'SEALED', receipt };
    assertNoScoreLeak(sealed);
    return sealed;
  }

  if (input.score === null || input.releasedAt === null) {
    throw new Error(
      'RELEASED_WITHOUT_A_SCORE: a released grade needs a score and a release time. Returning a ' +
        'sealed grade here would show a student "submitted, awaiting review" for a batch that ' +
        'was already released, which is a lie with a receipt hash on it.',
    );
  }

  // NO `assertNoScoreLeak` here, and the absence is deliberate. The first version called it on
  // this arm too and rejected every released grade, because `score` IS the released payload's
  // reason to exist. The invariant is "no score may cross while SEALED", not "no score may ever
  // cross" — writing the second one would have meant deleting the feature or, worse, weakening
  // SCORE_BEARING_KEYS until the check stopped objecting.
  return {
    state: 'RELEASED',
    receipt,
    score: input.score,
    releasedAt: input.releasedAt,
    regradeNotice: input.regradeNotice,
  } satisfies ReleasedGrade;
}

export function isReleased(grade: Grade): grade is ReleasedGrade {
  return grade.state === 'RELEASED';
}

export function isSealed(grade: Grade): grade is SealedGrade {
  return grade.state === 'SEALED';
}

export function assertNoScoreLeak(value: unknown, path = '$'): void {
  const violations = findScoreBearingKeys(value, path);
  if (violations.length === 0) return;
  const detail = violations.map((v) => `${v.path} (${v.key})`).join(', ');
  throw new Error(
    `SCORE_LEAK: a payload left the sealed/released boundary carrying ${detail}. If this is a ` +
      'legitimate released payload, check the key name rather than the allowlist.',
  );
}

/**
 * The interop rule, in one line: only `RELEASED` may cross.  (P5-T13)
 *
 * `INV-RELEASE-2` holds across the boundary — not because the codecs are careful, but because
 * this function takes a `Grade` and a sealed one cannot become a payload without an explicit
 * unreachable-in-practice cast that `expectTypeError` documents.
 */
export function assertGradeIsExportable(grade: Grade): ReleasedGrade {
  if (grade.state !== 'RELEASED') {
    throw new Error(
      'SEALED_GRADE_NOT_EXPORTABLE: a sealed grade has nothing to pass back. If this came from an ' +
        'AGS or xAPI caller asking for a score before release, the answer is that the score does ' +
        'not exist yet — not a zero and not the eventual value.',
    );
  }
  return grade;
}
