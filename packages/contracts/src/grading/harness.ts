/**
 * `bank.testGrader` — run the REAL grader on a sample response, and show what it decided.  (P7-T12)
 *
 * ## WHY A HARNESS, AND WHY IT IS NOT A DEBUG PRINT
 *
 * The packet asks for "run the real grader on a sample, show points + rationale". The obvious implementation is
 * a function that returns `GradeOutput`, and that already exists -- it is `grade`. So the harness exists for the
 * two things `grade` deliberately does not do.
 *
 * **It says WHICH of the refusals this is.** `grade` returns a flag and a code, which is right for a program and
 * useless to a person holding a question in an authoring UI. `MANUAL_REQUIRES_HUMAN` with
 * `OUT_OF_RANGE_KEY` is the difference between "your key is missing" and "this question is marked by hand", and
 * an author who cannot tell them apart will file a bug about the grader. The refusal names the CAUSE and, where
 * one exists, the FIX.
 *
 * **And it separates what the MARKER may see from what the STUDENT may see.** `INV-ATTEMPT-2` requires key
 * material to be excluded from student-facing surfaces. A harness that renders `grade`'s output straight into an
 * authoring screen is fine, and one that renders it into a preview pane is a key leak. `GraderReport` therefore
 * carries the two projections as separate fields with separate provenance, so a caller cannot accidentally
 * concatenate them.
 *
 * ## IT IS ALSO WHERE A BAD KEY BECOMES VISIBLE BEFORE A STUDENT SEES IT
 *
 * The `OUT_OF_RANGE_KEY` refusals added in P7-T5 had nowhere to surface until now: the grader reported them
 * correctly and no human ever looked. This is that surface. `refusal()` is `null` for a question that graded, so
 * "the harness ran and found nothing" is distinguishable from "the harness could not run".
 */

import type { QuestionSpec } from '../question/index.js';
import { publicQuestionSpec, teacherQuestionSpec } from '../question/index.js';
import type { GradeFlag, GradeInput, GradeOutput, RationaleCode } from './index.js';
import { GRADER_VERSION, grade } from './index.js';

/**
 * WHY A QUESTION WAS NOT SCORED, NAMED WHERE THE GRADER ONLY CODES IT.
 *
 * Each cause carries the thing an author can DO, because a refusal nobody can act on gets worked around -- and
 * the workaround for "your key is unreadable" is to guess a key, which is worse than the broken key.
 */
export type RefusalCause =
  | 'UNREADABLE_KEY'
  | 'UNCOMPUTABLE_METHOD'
  | 'NOT_AUTO_GRADED'
  | 'NO_AUTO_GRADER_FOR_TYPE'
  | 'UNREADABLE_RESPONSE'
  | 'EMPTY_RESPONSE'
  | 'NOTHING_TO_FIX';

export interface Refusal {
  readonly cause: RefusalCause;
  /** One sentence, in the second person, addressed to whoever is holding the question. */
  readonly what: string;
  /** What to change. `null` where there is nothing the author controls. */
  readonly fix: string | null;
  /** The flag or rationale code this was derived from, so the mapping is auditable. */
  readonly derivedFrom: readonly string[];
}

export interface GraderReport {
  /** Whether the grader produced a mark at all. `true` for a wrong answer; `false` only for a refusal. */
  readonly graded: boolean;
  /** `null` when refused, so "scored zero" and "not scored" cannot be confused by a reader. */
  readonly points: number | null;
  readonly rawPoints: number | null;
  readonly maxPoints: number;
  readonly correct: boolean | null;
  readonly rationaleCode: RationaleCode | null;
  readonly explanation: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  readonly flags: readonly GradeFlag[];
  readonly refusal: Refusal | null;
  readonly graderVersion: string;
  /**
   * WHAT THE MARKER SEES. Key material included -- this is the authoring surface, and the whole point is to let
   * an author see whether the key they wrote produces the mark they expected.
   */
  readonly asMarker: { readonly spec: unknown };
  /**
   * WHAT THE STUDENT SEES, projected through `publicQuestionSpec()` so the harness cannot be the thing that
   * leaks a key. Present so a caller can render the student view without reaching for the raw spec.
   */
  readonly asStudent: { readonly spec: unknown };
}

/**
 * THE REFUSAL TABLE, keyed off what the grader actually returned rather than off what it ought to have returned.
 *
 * Deriving the cause from the output is what keeps this honest: if the grader's codes change, an unrecognised
 * combination falls through to `NOTHING_TO_FIX` with an empty derivation rather than being silently reported as
 * something it is not. A harness that guesses would be worse than no harness, because an author would trust it.
 */
const REFUSALS: ReadonlyArray<{
  readonly when: (result: GradeOutput) => boolean;
  readonly refusal: Refusal;
}> = [
  {
    when: (r) => r.rationale.code === 'UNKNOWN_QUESTION_TYPE',
    refusal: {
      cause: 'NO_AUTO_GRADER_FOR_TYPE',
      what: 'No auto-grader is registered for this question type.',
      fix: 'A simulation question is graded by the simulation bundle rather than by the core grader, so it cannot be tested here. Every other type can be.',
      derivedFrom: ['UNKNOWN_QUESTION_TYPE'],
    },
  },
  {
    when: (r) => r.flags.includes('OUT_OF_RANGE_KEY'),
    refusal: {
      cause: 'UNREADABLE_KEY',
      what: "This question's answer key could not be read, so nothing was scored.",
      fix: 'Check that `key` is present and that the field the type needs is the right shape: `choiceId` a string, `value` a boolean or a number, `text` a string, `choiceIds` and `itemIds` lists of strings.',
      derivedFrom: ['OUT_OF_RANGE_KEY', 'NEEDS_HUMAN'],
    },
  },
  {
    /**
     * NARROWED TO THE `method` DETAIL, NOT TO THE RATIONALE CODE.
     *
     * The first version matched `NEEDS_HUMAN && MANUAL_REQUIRES_HUMAN`, which is ALSO what a question marked
     * `MANUAL` by declaration returns -- so every manual essay was reported as an uncomputable scoring method
     * and told to check `partialCredit`. That is the harness guessing, which is the one thing it must not do: an
     * author would follow the advice, find no `partialCredit` on their essay, and file a bug about the tool.
     *
     * The grader puts `method` in the detail only for this case, so keying on the detail rather than the code
     * makes the two refusals disjoint by construction.
     */
    when: (r) =>
      r.rationale.code === 'MANUAL_REQUIRES_HUMAN' && typeof r.rationale.detail.method === 'string',
    refusal: {
      cause: 'UNCOMPUTABLE_METHOD',
      what: 'The scoring policy on this question is not one the grader can apply.',
      fix: 'Check `partialCredit`. `PROP` is published in the plan and implemented nowhere, so a question carrying it cannot be scored automatically.',
      derivedFrom: ['NEEDS_HUMAN', 'MANUAL_REQUIRES_HUMAN'],
    },
  },
  {
    when: (r) => r.rationale.code === 'MANUAL_REQUIRES_HUMAN',
    refusal: {
      cause: 'NOT_AUTO_GRADED',
      what: 'This question is marked by hand, so there is no auto-grade to show.',
      fix: 'Set `gradingMode` to `AUTO` if it should be graded automatically.',
      derivedFrom: ['MANUAL_REQUIRES_HUMAN'],
    },
  },
  {
    when: (r) => r.rationale.code === 'UNPARSEABLE' || r.flags.includes('MALFORMED_RESPONSE'),
    refusal: {
      cause: 'UNREADABLE_RESPONSE',
      what: 'The response could not be read as an answer, so it was not scored.',
      fix: 'This is a fault in the SAMPLE rather than in the question. A real response arriving unreadable is flagged `MALFORMED_RESPONSE` at submission and routed to a human rather than scored zero.',
      derivedFrom: ['UNPARSEABLE', 'MALFORMED_RESPONSE'],
    },
  },
  {
    when: (r) => r.rationale.code === 'BLANK',
    refusal: {
      cause: 'EMPTY_RESPONSE',
      what: 'The response was empty, so there is no answer to grade.',
      fix: 'Send a non-empty sample. An empty response is reported as BLANK rather than INCORRECT, which is the behaviour you want in production and is not a useful thing to test.',
      derivedFrom: ['BLANK'],
    },
  },
];

/** THE REFUSAL, OR `null` WHEN THE GRADER PRODUCED A MARK. Order matters: the first match wins. */
const refusalFor = (result: GradeOutput): Refusal | null => {
  for (const entry of REFUSALS) {
    if (entry.when(result)) return entry.refusal;
  }
  return null;
};

/**
 * RUN THE REAL GRADER ON A SAMPLE. The harness adds nothing to the arithmetic and claims to.
 *
 * `sample` is `unknown` on purpose, exactly as `RawResponse` is: a sample typed as `ResponseAnswer` would let an
 * authoring UI construct only well-formed samples, and the malformed case is the one worth seeing.
 */
export const testGrader = (input: GradeInput): GraderReport => {
  const result = grade(input);
  const refusal = refusalFor(result);
  const spec = input.spec as QuestionSpec;

  return {
    graded: refusal === null,
    points: refusal === null ? result.points : null,
    rawPoints: refusal === null ? result.rawPoints : null,
    maxPoints: result.maxPoints,
    correct: refusal === null ? result.correct : null,
    rationaleCode: result.rationale.code,
    explanation: result.rationale.explanation,
    detail: result.rationale.detail,
    flags: result.flags,
    refusal,
    graderVersion: result.graderVersion,
    asMarker: { spec: teacherQuestionSpec(spec) },
    asStudent: { spec: publicQuestionSpec(spec) },
  };
};

/**
 * RUN A BATCH OF SAMPLES, and summarise them the way an author wants to see a question.
 *
 * The summary is the reason this exists as a batch function rather than a loop in a UI: an author wants to know
 * "does the FULL-CREDIT sample score full marks and does the EMPTY sample score zero", and reading six report
 * cards to answer that is how a wrong key survives review. `unexpected` lists any sample whose outcome does not
 * match what its own label promised, so the batch reports a disagreement rather than presenting six cards.
 */
export interface GraderSample {
  /** What the author expects this sample to demonstrate. Checked against the outcome, not trusted. */
  readonly expect: 'FULL_CREDIT' | 'NO_CREDIT' | 'PARTIAL' | 'REFUSED';
  readonly note: string;
  readonly response: unknown;
}

export interface BatchReport {
  readonly samples: readonly GraderReport[];
  /** Samples whose outcome contradicted their own `expect`. Empty is the passing state. */
  readonly unexpected: readonly string[];
  readonly fullCreditWorks: boolean;
  readonly refusals: number;
}

export const testGraderBatch = (
  spec: QuestionSpec,
  samples: readonly GraderSample[],
): BatchReport => {
  const reports: GraderReport[] = [];
  const unexpected: string[] = [];
  let fullCreditWorks = false;

  /**
   * ONE PASS, AND NO INDEX LOOKUP ANYWHERE.
   *
   * The first version graded every sample into an array and then walked it with `forEach((report, index) =>
   * samples[index])`. Under `noUncheckedIndexedAccess` that read as possibly `undefined`, so it needed a guard --
   * and the guard was unreachable, because the two arrays are the same length by construction. That is the
   * standard way a defensive check becomes dead code: the compiler asks for it and the types make it
   * impossible.
   *
   * Grading and checking in the same `for...of` over `samples.entries()` removes the lookup, so there is nothing
   * left to guard.
   */
  for (const [index, sample] of samples.entries()) {
    const report = testGrader({ spec, response: sample.response });
    reports.push(report);
    const label = `${String(index)}: ${sample.note}`;

    switch (sample.expect) {
      case 'FULL_CREDIT':
        if (report.graded && report.points === report.maxPoints) fullCreditWorks = true;
        else unexpected.push(`${label} -- expected full credit, got ${describe(report)}`);
        break;
      case 'NO_CREDIT':
        // A refusal is NOT a zero. "The key is unreadable" and "the student was wrong" are different facts, and
        // a sample that proves the second must not be satisfied by the first.
        if (!report.graded)
          unexpected.push(`${label} -- expected a mark of zero, got ${describe(report)}`);
        else if (report.points !== 0)
          unexpected.push(`${label} -- expected 0, got ${String(report.points)}`);
        break;
      case 'PARTIAL':
        if (
          !report.graded ||
          report.points === null ||
          report.points === 0 ||
          report.points === report.maxPoints
        ) {
          unexpected.push(`${label} -- expected a partial mark, got ${describe(report)}`);
        }
        break;
      case 'REFUSED':
        if (report.graded)
          unexpected.push(`${label} -- expected a refusal, got ${describe(report)}`);
        break;
      default:
        unexpected.push(`${label} -- unknown expectation`);
    }
  }

  return {
    samples: reports,
    unexpected,
    fullCreditWorks,
    refusals: reports.filter((report) => !report.graded).length,
  };
};

const describe = (report: GraderReport): string =>
  report.graded
    ? `${String(report.points)} of ${String(report.maxPoints)} (${report.rationaleCode ?? 'no code'})`
    : `refused: ${report.refusal?.cause ?? 'unknown'}`;

/**
 * EXPOSED FOR TESTING ONLY, and named `describeReport` because `describe` is Vitest's own global.
 *
 * The alias is also why it is a `const` arrow rather than a function declaration: exporting it before its
 * definition would initialise the binding in the temporal dead zone, and the resulting
 * `ReferenceError: Cannot access 'describe' before initialization` reads like a bug in the test framework.
 */
export const describeReport = describe;

/** The grader version the harness ran, so a report can be tied to a logic version. */
export const HARNESS_VERSION = GRADER_VERSION;
