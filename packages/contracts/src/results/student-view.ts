/**
 * The student-facing attempt view, and the type-level half of INV-RELEASE-2.  (P10-T5, P10-T8a)
 *
 * ## WHY THERE ARE TWO TYPES AND NOT ONE TYPE WITH NULLABLE SCORES
 *
 * INV-RELEASE-2: "no score may be *inferable* before release." The obvious way to model a pre-release view is one type
 * with `finalScore: number | null`, and that model cannot enforce anything: a handler that forgets the branch sends
 * `finalScore: 0`, and nothing complains. `null` is indistinguishable at the type level from a real zero, which is the
 * entire hazard.
 *
 * So the sealed view has **no score field at all**. Not nullable -- absent. A handler that tries to read or send a score
 * from a sealed view does not compile. That is `D-25`'s mechanism (a) and it is the strongest guarantee available: it
 * costs nothing at runtime and cannot be forgotten.
 *
 * ## AND THE SEALED VIEW IS REASSURING *AND* HONEST, WHICH ARE IN TENSION
 *
 * The task says "reassuring, score-free, honest". Reassuring alone becomes "we'll let you know soon!" for a result that
 * was marked three weeks ago and is sitting behind a moderation step. Honest alone becomes a status line. So the copy
 * states what is actually true and what is actually happening, and it never implies the student did badly -- because a
 * student reading "results pending" on an exam they sat for two hours concludes the worst available conclusion, which
 * is that they failed.
 *
 * ## AND IT NEVER IMPLIES THE STUDENT HAS A RESULT THEY CANNOT SEE
 *
 * A sealed view that says "0 of 10 answered" is a score-bearing statement about a partial state. Nothing here reports
 * counts, ratios or progress towards a mark.
 */

/**
 * `Millis` is declared here rather than imported from `@orrery/clock`.
 *
 * `@orrery/clock` is deliberately not a dependency of `@orrery/contracts`: the clock package's only real-time source is
 * its `systemClock`, and a contracts package that can read the host clock can be imported somewhere it should not be.
 * The TYPE is all this module needs, and duplicating a type alias is cheaper than a dependency that exists only to be
 * imported for one.
 */
type Millis = number;

/** The states a student's view can be in. Not the attempt's status -- the VIEW's. */
export type StudentViewState =
  /** Not started. */
  | 'NOT_STARTED'
  /** In progress, autosaving. */
  | 'IN_PROGRESS'
  /** Submitted, not yet graded or graded but not released. */
  | 'SUBMITTED'
  /** With a teacher, moderation or marking in progress. */
  | 'WITH_TEACHER'
  /** Graded and released. The only state with a score. */
  | 'RELEASED';

/**
 * THE SEALED VIEW. There is no score field, and that is the entire design.
 *
 * Note what is absent and not merely undefined: no `finalScore`, no `percentage`, no `maxScore`, no `correctCount`, no
 * `rawTotal`, no per-question score, no letter grade, no grade band. Adding any of them is a change to this interface
 * and belongs in `ReleasedAttemptView`, where the release state makes it honest.
 */
export interface SealedAttemptView {
  readonly state: Exclude<StudentViewState, 'RELEASED'>;
  readonly attemptId: string;
  readonly assignmentTitle: string;
  readonly openedAt: Millis | null;
  /** `null` once submitted. Present while open, so a student can see their own deadline. */
  readonly deadlineAt: Millis | null;
  readonly submittedAt: Millis | null;
  /** How many questions are saved, as a COUNT OF SAVES and not of marks. Never a ratio. */
  readonly savedQuestionCount: number;
  readonly totalQuestionCount: number;
  /**
   * Whether the exam carried an accommodation that is in force.
   *
   * A MARKER, and deliberately not the accommodation itself. The student already knows what they were granted; naming
   * it in a payload a third party can see is disclosure they did not ask for. P10-T4's released view shows the detail.
   */
  readonly hasAccommodation: boolean;
  /** What to tell the student. See `sealedCopy`. */
  readonly notice: SealedNotice;
}

/**
 * THE RELEASED VIEW, which extends rather than replaces.
 *
 * `extends SealedAttemptView` is what makes the relationship checkable: a released view is a sealed view plus marks, so
 * every guarantee about the sealed half holds for the released half too.
 */
export interface ReleasedAttemptView extends Omit<SealedAttemptView, 'state' | 'notice'> {
  readonly state: 'RELEASED';
  /** Percentage, 0-100, already rounded for display. Null when the paper was entirely excused. */
  readonly percentage: number | null;
  readonly finalScore: number;
  readonly maxScore: number;
  /** The receipt the student's own copy verifies against. P7-T12's `verify-receipt`. */
  readonly receipt: string;
  readonly feedback: string | null;
  /** Per-question outcomes, only where the policy allows correct answers to be shown. */
  readonly questions: readonly ReleasedQuestionOutcome[];
  /** The accommodation in force, in full. See `SealedAttemptView.hasAccommodation`. */
  readonly accommodation: string | null;
}

export interface ReleasedQuestionOutcome {
  readonly questionId: string;
  readonly position: number;
  readonly awarded: number;
  readonly possible: number;
  /** `null` unless `showCorrectAnswersAfterRelease` permits it. */
  readonly correctAnswer: string | null;
  readonly feedback: string | null;
}

/**
 * WHAT THE SEALED VIEW SAYS.
 *
 * Each is a claim about the world that is TRUE, not a reassurance that happens to be true. That distinction is the
 * whole difference between "with your teacher" and "we'll let you know soon", and a student who sat an exam reads the
 * difference immediately.
 */
export type SealedNotice =
  | 'NOT_STARTED_YET'
  | 'IN_PROGRESS'
  | 'SUBMITTED_AWAITING_MARKING'
  | 'WITH_TEACHER'
  /** Assigned but never opened and the window has passed. Says so, without implying a mark. */
  | 'WINDOW_PASSED';

export interface SealedCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * THE COPY, and each entry is written to be true first.
 *
 * ## NO ENTRY SUGGESTS THE STUDENT DID BADLY
 *
 * "Results pending" on a two-hour exam reads as failure. Every string below says what is happening and what happens
 * next, and none of them contains a word about performance.
 */
export const sealedCopy: Readonly<Record<SealedNotice, SealedCopy>> = Object.freeze({
  NOT_STARTED_YET: {
    title: 'Not started yet',
    body: 'This exam is available to you. It has not been started, so nothing has been recorded yet.',
  },
  IN_PROGRESS: {
    title: 'In progress',
    body: 'Your answers are being saved as you go. You can leave and come back before the time runs out.',
  },
  SUBMITTED_AWAITING_MARKING: {
    title: 'Submitted',
    body: 'Your answers are in. They have not been marked yet, and marking has not started.',
  },
  WITH_TEACHER: {
    title: 'With your teacher',
    body: 'Your answers have been marked and are being checked before results are published. Nothing is needed from you.',
  },
  WINDOW_PASSED: {
    title: 'Time has passed',
    body: 'The time for this exam has passed and it was not started. If that is not right, contact your teacher.',
  },
});

/** The facts needed to build either view. Deliberately not carrying the marks at all. */
export interface SealedViewInput {
  readonly attemptId: string;
  readonly attemptStatus: string;
  readonly assignmentTitle: string;
  readonly openedAt: Millis | null;
  readonly deadlineAt: Millis | null;
  readonly submittedAt: Millis | null;
  readonly savedQuestionCount: number;
  readonly totalQuestionCount: number;
  readonly hasAccommodation: boolean;
  /** Whether the attempt's release batch has gone out. The ONE input that chooses the arm. */
  readonly isReleased: boolean;
  /**
   * The instant this view is for. Passed in rather than read, so INV-TIME-1 is satisfied and the whole function is pure.
   *
   * It is needed for exactly one decision, and getting that decision wrong is the bug the tests caught: an unopened
   * attempt with a deadline THREE DAYS AWAY must not be told the time has passed.
   */
  readonly now: Millis;
}

/**
 * WHICH SEALED STATE, from the attempt's facts.
 *
 * The order is the specification. In particular `WINDOW_PASSED` is decided by `openedAt === null` rather than by
 * comparing dates, because an attempt with no `openedAt` has no business being described as "in progress" regardless of
 * what the clock says.
 */
export const sealedState = (input: SealedViewInput): Exclude<StudentViewState, 'RELEASED'> => {
  if (input.attemptStatus === 'NOT_STARTED' || input.openedAt === null) {
    return 'NOT_STARTED';
  }
  if (input.attemptStatus === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (input.attemptStatus === 'SUBMITTED' || input.attemptStatus === 'AUTO_SUBMITTED')
    return 'SUBMITTED';
  return 'WITH_TEACHER';
};

/** BUILD THE SEALED VIEW. Refuses outright if asked for one that is released. */
export const toSealedView = (input: SealedViewInput): SealedAttemptView => {
  if (input.isReleased) {
    /**
     * A THROW, NOT A FALLBACK.
     *
     * Returning a sealed view for a released attempt would tell a student their marks are with their teacher when they
     * have been published -- and it would do so silently, in a handler that believed it had done the right thing. The
     * caller wanted `ReleasedAttemptView` and asked for the wrong function; a thrown error says so at the one place it
     * can be fixed.
     */
    throw new Error('this attempt is released; build the released view, not the sealed one');
  }

  const state = sealedState(input);

  /**
   * AN EXPLICIT MAP, and the two vocabularies are deliberately different.
   *
   * `state` is what code branches on (`NOT_STARTED`, `SUBMITTED`) and `notice` is which piece of copy to show
   * (`NOT_STARTED_YET`, `SUBMITTED_AWAITING_MARKING`). They are not the same names and pretending they are is how a
   * state ends up with no copy, or copy keyed to a state that cannot occur.
   *
   * My first version did exactly that -- assigned `state` straight to `notice` and declared the two unions compatible --
   * and the compiler caught it, which is the only reason it is worth having a compiler.
   */
  const notice: SealedNotice = ((): SealedNotice => {
    switch (state) {
      case 'NOT_STARTED':
        /**
         * THE WINDOW HAS PASSED ONLY IF IT HAS ACTUALLY PASSED.
         *
         * The first version asked only whether a `deadlineAt` existed, so an unopened attempt with three days left was
         * told "The time for this exam has passed". That is false, alarming, and the kind of thing a student screenshots
         * and emails to their teacher. Deciding it needs an instant, hence `now` on the input.
         */
        return input.deadlineAt !== null && input.now > input.deadlineAt
          ? 'WINDOW_PASSED'
          : 'NOT_STARTED_YET';
      case 'IN_PROGRESS':
        return 'IN_PROGRESS';
      case 'SUBMITTED':
        return 'SUBMITTED_AWAITING_MARKING';
      case 'WITH_TEACHER':
        return 'WITH_TEACHER';
      default: {
        /**
         * `never` HERE IS THE POINT. A new `StudentViewState` with no copy is a compile error rather than a sealed
         * view with `notice: undefined`, which would render an empty panel to a student waiting for their result.
         */
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  })();

  return {
    state,
    attemptId: input.attemptId,
    assignmentTitle: input.assignmentTitle,
    openedAt: input.openedAt,
    deadlineAt: input.deadlineAt,
    submittedAt: input.submittedAt,
    savedQuestionCount: input.savedQuestionCount,
    totalQuestionCount: input.totalQuestionCount,
    hasAccommodation: input.hasAccommodation,
    notice,
  };
};

/**
 * THE SCORE-BEARING KEY NAMES, restated here so this module can be checked without depending on `@orrery/interop`.
 *
 * `audit:seals` (P7-T10) already holds the canonical 23-key corpus and `findScoreBearingKeys` walks a value against it;
 * this is the type-level complement, and the two agree by construction because both name the same concepts. A key
 * added to one and not the other is a review finding, not a silent gap.
 */
export const SCORE_BEARING_FIELD_NAMES: readonly string[] = Object.freeze([
  'score',
  'finalScore',
  'autoScore',
  'manualScore',
  'maxScore',
  'rawScore',
  'rawTotal',
  'percentage',
  'percent',
  'grade',
  'letterGrade',
  'band',
  'correctCount',
  'numCorrect',
  'answeredCorrectly',
  'correctAnswer',
  'awarded',
  'points',
  'marks',
  'mark',
  'earned',
  'pointsAwarded',
  'weightedTotal',
]);
