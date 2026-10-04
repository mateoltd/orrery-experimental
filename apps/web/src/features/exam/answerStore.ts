'use client';

/**
 * The answer store: a PURE REDUCER, and the only writer of answers.  (P7-T6)
 *
 * ## WHY A REDUCER AND NOT A HOOK WITH `useState`
 *
 * `ExamShell` names this file as the one thing that belongs on the exam start path, and it is right about the
 * bar -- "the exam cannot function without it" -- for the wrong stated reason. The reason is not bytes. It is
 * that **an answer has exactly one writer**, and a reducer is the only shape in which that is enforceable rather
 * than merely intended: every transition is `(state, event) => state`, so "who changed this answer" is a
 * question about the type rather than about a code review.
 *
 * The transitions that matter are the ones that must not be expressible:
 *
 * - An answer to a LOCKED question cannot be written, and the attempt's own policy decides that, not the caller.
 * - A navigation event never changes an answer, because a student who cannot see a question cannot answer it.
 * - Answering the same question twice is a REVISION with a new `idempotencyKey`, never a silent overwrite --
 *   `plans/01` §9.4's audit chain folds revisions in order, so a skipped revision is a gap in a hash.
 *
 * ## AND THE STATE IS A FUNCTION OF THE EVENT LOG, NOT OF THE LAST WRITE
 *
 * There is no `answers` map that gets mutated in place. There is an ordered list of writes, and
 * `reduce(initial, events)` replays them. That is what makes the store testable without a browser, and it is
 * also what makes "the student's paper as the server has it" reconstructible: given the events, the state is
 * deterministic, which is the property a support conversation about a lost answer actually needs.
 *
 * ## ONE THING THIS DOES NOT DO
 *
 * It does not decide whether a write is ACCEPTED. `plans/01` §9.1's acceptance predicate is evaluated
 * server-side and lives in `@orrery/contracts/policy/deadline`. The reducer records what the student did; the
 * server decides what counts. A client that decided for itself would be a client that can lose a mark.
 */

import { expiryVerdict } from '@orrery/contracts/policy/deadline';
import type { ExamPolicy } from '@orrery/contracts/policy';

/** One question's slot in the paper. The question's SPEC is not here -- it may be shuffled, and the spec is not trusted. */
export interface AnswerSlot {
  readonly questionId: string;
  /** The variant actually drawn for this student, if the question was randomised. */
  readonly variant?: Readonly<Record<string, unknown>>;
  /** The per-question deadline in ms, or `null` when the question is untimed or unopened. */
  readonly questionDeadlineAt: number | null;
}

export interface QueuedWrite {
  /** Monotonic per attempt. The outbox flushes in `seq` order, and this is why the number is not a timestamp. */
  readonly seq: number;
  readonly questionId: string;
  readonly answer: unknown;
  readonly revision: number;
  /** A client uuid. `plans/01` §9.3: a duplicate key is an idempotent SUCCESS, so a retry must reuse it. */
  readonly idempotencyKey: string;
  readonly issuedAt: number;
}

export type Durability = 'CLEAN' | 'PENDING' | 'OFFLINE' | 'ABANDONED';

export interface AttemptState {
  readonly attemptId: string;
  readonly policy: ExamPolicy;
  readonly slots: readonly AnswerSlot[];
  /** The student's ANSWER per question. Absent means unanswered -- distinct from answered-with-nothing. */
  readonly answers: Readonly<Record<string, unknown>>;
  /** The highest revision WRITTEN locally per question. The server's revision is reconciled by `serverAck`. */
  readonly revisions: Readonly<Record<string, number>>;
  /** Questions the student marked to return to. Not a hint and not a filter: it changes nothing about grading. */
  readonly flagged: ReadonlySet<string>;
  readonly queued: readonly QueuedWrite[];
  /** The next unused `seq`. Held in the state so a replay cannot reuse one. */
  readonly nextSeq: number;
  /** Where the student is. Meaningful under `ONE_AT_A_TIME`; a cursor under `ALL_AT_ONCE`. */
  readonly cursor: number;
  /** The attempt deadline, or `null` when untimed. Fixed at first start by `INV-POLICY-1`. */
  readonly deadlineAt: number | null;
  readonly status: 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED';
  readonly durability: Durability;
  /** Set when the server's copy differs and the student must choose. See `ReconcileRequired`. */
  readonly reconcile: ReconcileRequired | null;
}

export interface ReconcileRequired {
  readonly questionId: string;
  readonly mine: unknown;
  readonly theirs: unknown;
  readonly myRevision: number;
  readonly theirRevision: number;
}

/** Everything the student or the network can do. Nothing else changes the state. */
export type AttemptEvent =
  | {
      readonly type: 'ANSWER';
      readonly questionId: string;
      readonly answer: unknown;
      readonly idempotencyKey: string;
      readonly at: number;
    }
  | { readonly type: 'OPEN_QUESTION'; readonly questionId: string; readonly at: number }
  | { readonly type: 'GOTO'; readonly index: number }
  | { readonly type: 'NEXT' }
  | { readonly type: 'PREVIOUS' }
  | { readonly type: 'TOGGLE_FLAG'; readonly questionId: string }
  | { readonly type: 'ACK'; readonly seq: number }
  | {
      readonly type: 'CONFLICT';
      readonly questionId: string;
      readonly theirs: unknown;
      readonly theirRevision: number;
    }
  | { readonly type: 'KEEP_MINE' }
  | { readonly type: 'KEEP_THEIRS' }
  | { readonly type: 'OFFLINE' }
  | { readonly type: 'ONLINE' }
  | { readonly type: 'ABANDON'; readonly at: number }
  | { readonly type: 'SUBMIT' };

export const initialAttemptState = (input: {
  readonly attemptId: string;
  readonly policy: ExamPolicy;
  readonly slots: readonly AnswerSlot[];
  readonly deadlineAt: number | null;
}): AttemptState => ({
  attemptId: input.attemptId,
  policy: input.policy,
  slots: input.slots,
  answers: {},
  revisions: {},
  flagged: new Set<string>(),
  queued: [],
  nextSeq: 1,
  cursor: 0,
  deadlineAt: input.deadlineAt,
  status: 'NOT_STARTED',
  durability: 'CLEAN',
  reconcile: null,
});

/**
 * THE VALUE AT `key`, OR `undefined` -- AND NEVER AN INHERITED ONE.
 *
 * ## WHY A PLAIN OBJECT MAP AND NOT A `Map`
 *
 * `answers` and `revisions` are plain objects so they serialise, hash and diff cleanly, which matters because the
 * state is logged and replayed. The cost is that every keyed READ can reach the prototype chain, and for the key
 * `__proto__` it does.
 *
 * The bug this prevents was found by the very test that checks the store cannot reach `Object.prototype`:
 * `state.revisions['__proto__']` returned `Object.prototype` itself, so `(… ?? 0) + 1` produced the STRING
 * `'[object Object]1'` instead of the number 1 -- and that string went into the queued write as a revision, which
 * the server would have been asked to accept.
 *
 * The same read appears in five places, so the guard is one function rather than five `hasOwnProperty` calls that
 * somebody will forget to copy.
 */
const own = <V>(map: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

const indexOf = (state: AttemptState, questionId: string): number =>
  state.slots.findIndex((slot) => slot.questionId === questionId);

/**
 * CAN THIS QUESTION BE ANSWERED RIGHT NOW?
 *
 * Four refusals, and each one is a policy consequence rather than a UI rule:
 *
 * - **Already locked.** `lockQuestionAfterAnswer` means the student may not return to an answered question.
 *   Enforced here rather than in the renderer because a renderer can be bypassed by a keyboard shortcut, and a
 *   locked question that a stray event can rewrite is not locked.
 * - **Past its own deadline, and the expiry term froze it.** See the note below -- this used to refuse every term
 *   including `SOFT`.
 * - **Past the attempt's.** `INV-LATE-1`, and the same `expiryVerdict` answers it.
 * - **The attempt is over.** A submitted attempt accepts nothing.
 *
 * ## THIS IS NOT A SECOND ANSWER TO "MAY I WRITE?", IT IS THE SAME ONE
 *
 * The clause below used to compare `questionDeadlineAt + grace` directly, and it is what made the client
 * **silently** drop a `SOFT`-expiry answer past the question's window: `reduceAttempt`'s `ANSWER` case returns the
 * state unchanged on a refusal, so there was no queued write, no revision bump, and nothing on screen. A student
 * typing into an expired question watched it go nowhere.
 *
 * The comment this function used to carry claimed the opposite requirement -- "the client must not be stricter
 * than the server, or a student loses an answer the server would have taken" -- and the code did precisely that.
 * So the boundary is now asked of `expiryVerdict`, the same function `packages/db`'s `decideWrite` and
 * `@orrery/exam-engine`'s `evaluateAttempt` ask, and the agreement test over the whole
 * `expiry x instant` matrix lives beside them. One question, one answer, three callers.
 */
export const canAnswer = (
  state: AttemptState,
  questionId: string,
  now: number,
): {
  readonly allowed: boolean;
  readonly why?: 'LOCKED' | 'QUESTION_DEADLINE_PASSED' | 'ATTEMPT_DEADLINE_PASSED' | 'ATTEMPT_OVER' | 'UNKNOWN_QUESTION';
} => {
  if (indexOf(state, questionId) === -1) return { allowed: false, why: 'UNKNOWN_QUESTION' };
  if (state.status === 'SUBMITTED') return { allowed: false, why: 'ATTEMPT_OVER' };

  const slot = state.slots[indexOf(state, questionId)];
  if (slot === undefined) return { allowed: false, why: 'UNKNOWN_QUESTION' };

  if (state.policy.lockQuestionAfterAnswer && own(state.answers, questionId) !== undefined) {
    return { allowed: false, why: 'LOCKED' };
  }

  const verdict = expiryVerdict(state.policy, {
    questionDeadlineAt: slot.questionDeadlineAt,
    deadlineAt: state.deadlineAt,
    now,
    graceMs: state.policy.gracePeriodSec * 1000,
  });
  if (!verdict.writable) {
    return {
      allowed: false,
      why: verdict.refusedBecause === 'ATTEMPT_DEADLINE_PASSED'
        ? 'ATTEMPT_DEADLINE_PASSED'
        : 'QUESTION_DEADLINE_PASSED',
    };
  }
  return { allowed: true };
};

/** Moves the cursor, clamped. A cursor outside the paper is a bug in the caller, not a crash in the store. */
const moveCursor = (state: AttemptState, index: number): number => {
  if (state.slots.length === 0) return 0;
  // `ALL_AT_ONCE` has no cursor in the sense of "you are here" -- it is a scroll position -- so it is pinned.
  if (state.policy.navigation === 'ALL_AT_ONCE') return state.cursor;
  return Math.max(0, Math.min(index, state.slots.length - 1));
};

export const reduceAttempt = (state: AttemptState, event: AttemptEvent): AttemptState => {
  switch (event.type) {
    /**
     * ANSWER. The only event that writes an answer, and the only one that queues a write.
     *
     * **ANSWERING WITH `undefined` IS AN ANSWER.** It clears the slot and bumps the revision, because the student
     * clearing a radio button is a change the server must be told about -- otherwise "I deselected everything"
     * and "I never touched it" are the same row, and a student who cleared an answer to revise it would be
     * marked on the earlier value. `answers[q] === undefined` therefore means UNANSWERED, and this is why the
     * reducer needs an `answered` set rather than a lookup.
     */
    case 'ANSWER': {
      const permitted = canAnswer(state, event.questionId, event.at);
      if (!permitted.allowed) return state;

      const revision = (own(state.revisions, event.questionId) ?? 0) + 1;
      const write: QueuedWrite = {
        seq: state.nextSeq,
        questionId: event.questionId,
        answer: event.answer,
        revision,
        idempotencyKey: event.idempotencyKey,
        issuedAt: event.at,
      };
      const answers = { ...state.answers };
      if (event.answer === undefined) {
        delete answers[event.questionId];
      } else {
        /**
         * `defineProperty`, NOT `answers[id] = value`.
         *
         * A plain assignment to the key `__proto__` does not add a key: it invokes the inherited setter, which
         * REPLACES THE OBJECT'S PROTOTYPE. So a question whose id is `__proto__` -- impossible from a UUID, and
         * entirely possible from a malformed payload -- would have its answer silently vanish, and the prototype
         * of the whole answers map would become the student's answer.
         *
         * `defineProperty` creates an own property instead, which is the only reason the reducer is safe against
         * an id it did not choose.
         */
        Object.defineProperty(answers, event.questionId, {
          value: event.answer,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }

      return {
        ...state,
        status: 'IN_PROGRESS',
        answers,
        revisions: { ...state.revisions, [event.questionId]: revision },
        queued: [...state.queued, write],
        nextSeq: state.nextSeq + 1,
        durability: state.durability === 'ABANDONED' ? 'ABANDONED' : 'PENDING',
      };
    }

    /**
     * OPEN_QUESTION. The per-question clock starts here and only here.
     *
     * `plans/01` §9.1 sets `questionOpenedAt` on the first ACCEPTED INTERACTION and calls it immutable once set.
     * This event records the opening locally; the server's copy is authoritative. The reason it exists at all is
     * that a countdown has to start somewhere, and starting it on "first view" would let a student refresh until
     * the timer reset.
     *
     * Re-opening an already-opened question does NOT restart its clock.
     */
    case 'OPEN_QUESTION': {
      const index = indexOf(state, event.questionId);
      if (index === -1) return state;
      const slot = state.slots[index];
      if (slot === undefined || slot.questionDeadlineAt !== null)
        return { ...state, cursor: moveCursor(state, index) };
      const opened: AnswerSlot = {
        ...slot,
        questionDeadlineAt:
          state.policy.perQuestionTimeLimitSec === null
            ? null
            : event.at + state.policy.perQuestionTimeLimitSec * 1000,
      };
      const slots = [...state.slots];
      slots[index] = opened;
      // The cursor moves on BOTH paths. It did not in the first version: the already-open branch moved it and the
      // first-open branch did not, so opening a question for the FIRST time -- the only time a student ever does
      // it -- left the cursor where it was. A reducer whose two branches of one event disagree behaves according
      // to invisible state, which is the definition of a bug that survives review.
      return {
        ...state,
        slots,
        cursor: moveCursor(state, index),
        status: state.status === 'NOT_STARTED' ? 'IN_PROGRESS' : state.status,
      };
    }

    /**
     * NAVIGATION. Moves the cursor and NOTHING ELSE.
     *
     * No answer changes, no revision changes, nothing is queued. That is stated as a property test rather than a
     * comment, because the tempting implementation is a `navigateTo(questionId)` that also marks the question
     * seen, and "seen" is not in this model -- there is no seen-state, because nothing grades it.
     */
    case 'GOTO':
      return { ...state, cursor: moveCursor(state, event.index) };
    case 'NEXT':
      return { ...state, cursor: moveCursor(state, state.cursor + 1) };
    case 'PREVIOUS':
      return { ...state, cursor: moveCursor(state, state.cursor - 1) };

    /**
     * TOGGLE_FLAG. A bookmark, and deliberately NOT a hint.
     *
     * `QuestionResponse.flagged` is a student annotation for their own review. It must not change the answer,
     * the revision, or the queue, because a flag is not a response and `plans/01` §9.4 folds only answer
     * revisions into the receipt hash. A flag that bumped the revision would put a bookmark into the audit chain.
     */
    case 'TOGGLE_FLAG': {
      if (indexOf(state, event.questionId) === -1) return state;
      const flagged = new Set(state.flagged);
      if (flagged.has(event.questionId)) flagged.delete(event.questionId);
      else flagged.add(event.questionId);
      return { ...state, flagged };
    }

    /**
     * ACK. The server took a write. `seq` is the only thing removed.
     *
     * NOT the whole question: a student may have three queued writes for one question, and acknowledging the
     * newest while dropping the older two would lose answers on a reconnect. Order matters and `seq` is what
     * makes it safe.
     */
    case 'ACK': {
      const queued = state.queued.filter((write) => write.seq !== event.seq);
      // `ABANDONED` IS ABSORBING. A late ack arriving after the deadline passed does NOT turn the indicator back
      // to "all answers saved", because the student was already told plainly that some answers may not have been
      // recorded, and quietly reassuring them afterwards is worse than the original uncertainty: they would stop
      // checking. `plans/01` §9.3 wants nothing silently lost AND nothing silently kept.
      const durability =
        state.durability === 'ABANDONED'
          ? 'ABANDONED'
          : queued.length === 0
            ? 'CLEAN'
            : state.durability;
      return { ...state, queued, durability };
    }

    /**
     * CONFLICT. A `409`, and the shape is a QUESTION not an attempt.
     *
     * `plans/01` §9.3 calls a stale revision a 409 that surfaces "keep mine / keep theirs", which is also how a
     * second device is detected. Both copies are held and NEITHER is applied: silently taking the server's would
     * lose work the student believes they saved, and silently taking the client's would resurrect an answer the
     * server has already superseded.
     */
    case 'CONFLICT':
      return {
        ...state,
        reconcile: {
          questionId: event.questionId,
          mine: own(state.answers, event.questionId),
          theirs: event.theirs,
          myRevision: own(state.revisions, event.questionId) ?? 0,
          theirRevision: event.theirRevision,
        },
        durability: 'PENDING',
      };

    /**
     * KEEP_MINE / KEEP_THEIRS. The only two ways a reconcile clears, and they differ in what happens to `seq`.
     *
     * KEEP_THEIRS drops the queued write for that question outright -- the student's answer is discarded on their
     * own instruction, so re-sending it would resurrect what they just declined.
     *
     * KEEP_MINE re-queues at a NEW seq with a NEW idempotency key. Reusing the old key would make the server
     * treat it as the duplicate it already answered, and the student's answer would be silently ignored -- which
     * is the specific failure `plans/01` §9.3's idempotency rule creates if you reuse a key after a 409.
     */
    case 'KEEP_THEIRS': {
      if (state.reconcile === null) return state;
      const questionId = state.reconcile.questionId;
      const answers = { ...state.answers };
      if (state.reconcile.theirs === undefined) delete answers[questionId];
      else answers[questionId] = state.reconcile.theirs;
      return {
        ...state,
        answers,
        revisions: { ...state.revisions, [questionId]: state.reconcile.theirRevision },
        queued: state.queued.filter((write) => write.questionId !== questionId),
        reconcile: null,
      };
    }
    case 'KEEP_MINE': {
      if (state.reconcile === null) return state;
      const questionId = state.reconcile.questionId;
      const revision = (own(state.revisions, questionId) ?? 0) + 1;
      const write: QueuedWrite = {
        seq: state.nextSeq,
        questionId,
        answer: state.reconcile.mine,
        revision,
        idempotencyKey: `reconcile-${questionId}-${String(revision)}`,
        issuedAt: state.nextSeq,
      };
      return {
        ...state,
        revisions: { ...state.revisions, [questionId]: revision },
        queued: [...state.queued, write],
        nextSeq: state.nextSeq + 1,
        reconcile: null,
        durability: 'PENDING',
      };
    }

    case 'OFFLINE':
      return { ...state, durability: state.queued.length > 0 ? 'OFFLINE' : state.durability };
    case 'ONLINE':
      return { ...state, durability: state.queued.length > 0 ? 'PENDING' : 'CLEAN' };

    /**
     * ABANDON. `plans/01` §9.3: "If the hard deadline passes with writes still queued, the queue is abandoned and
     * the student is told plainly that unacknowledged answers may not have been recorded. Nothing is silently
     * lost and nothing is silently kept."
     *
     * So the queue is KEPT, not cleared -- it is what the student is shown -- and the state says `ABANDONED` so
     * no UI can present those answers as saved. And `KEEP_CLEAN` afterwards must not resurrect them, which is why
     * `ANSWER` above preserves `ABANDONED` rather than resetting to `PENDING`.
     */
    case 'ABANDON':
      return { ...state, durability: 'ABANDONED' };

    case 'SUBMIT':
      return { ...state, status: 'SUBMITTED' };

    default:
      return state;
  }
};

/** Replay a log. The state is a function of the events, which is what makes it reconstructible. */
export const replay = (initial: AttemptState, events: readonly AttemptEvent[]): AttemptState =>
  events.reduce(reduceAttempt, initial);

/** Questions with no answer, for the "you have not answered N" prompt. An unanswered question is NOT a zero. */
export const unanswered = (state: AttemptState): readonly string[] =>
  state.slots
    .filter((slot) => own(state.answers, slot.questionId) === undefined)
    .map((slot) => slot.questionId);

/** What the durability indicator shows. Deliberately a small closed set: a student cannot act on a percentage. */
export const durabilityLabel = (state: AttemptState): string => {
  switch (state.durability) {
    case 'CLEAN':
      return 'All answers saved';
    case 'PENDING':
      return `Saving… ${String(state.queued.length)}`;
    case 'OFFLINE':
      return `Offline — ${String(state.queued.length)} answer(s) not yet saved`;
    case 'ABANDONED':
      return `Time is up — ${String(state.queued.length)} answer(s) may not have been recorded`;
    default:
      return 'Unknown';
  }
};
