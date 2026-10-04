/**
 * Session issuance, the clock handshake, and preflight.  (P8-T3)
 *
 * ## WHY THE PAYLOAD BUILDERS LIVE HERE AND NOT IN A ROUTE
 *
 * INV-RELEASE-2 says no score may be *inferable* before release, and enumerates how thoroughly that has to hold: "no
 * score field in any endpoint, no count of correct answers, no toast, no difference in status code, no difference in
 * payload size, no cache-header variance, no analytics event." Every clause of that is a property of the DTO, not of
 * the handler that sends it -- and a handler that assembles its own object literal is where the clause gets broken,
 * because adding one field to the literal is invisible everywhere else.
 *
 * So the payloads are BUILT here, from a frozen policy snapshot and the attempt's state, and `assertScoreFree` is a
 * test that runs against every one of them using `findScoreBearingKeys` from `@orrery/interop` -- the same 23-key
 * corpus `audit:seals` uses (PF-1: it already existed).
 *
 * ## WHY `sync` REPEATS THE POLICY EVERY TIME
 *
 * The start response carries the frozen policy because the client needs it to render. `sync` carries it again, every 30
 * seconds, which looks redundant until you consider what `sync` is for: a client that has been asleep, on a stale tab,
 * or through a reconnect has no guarantee it is still looking at the same policy. Repeating it is what makes "the
 * snapshot never changes" checkable from the client side, rather than merely true on the server.
 */

import type { Millis } from '@orrery/clock';
import type { ExamPolicy } from '@orrery/contracts/policy';

/** What the client reports about itself at `start`. The shape is `plans/04`'s, verbatim. */
export interface PreflightReport {
  readonly browser: {
    readonly storage: boolean;
    readonly pageLifecycle: boolean;
    readonly broadcastChannel: boolean;
  };
  readonly network: {
    readonly rttMs: number;
    readonly effectiveType: string;
    readonly saveData: boolean;
  };
  readonly a11y: {
    readonly reducedMotion: boolean;
    readonly forcedColors: boolean;
    /**
     * A GUESS, and treated as one.
     *
     * No browser reports a screen reader reliably, so this is a heuristic the client supplies. It must never gate
     * anything on its own: a false negative relaxes a policy for a student who did not need it, and a false positive
     * tightens one for a student who did. `notes` carries it so a human can see why a relaxation was applied.
     */
    readonly screenReaderGuess: string | null;
  };
}

export type Relaxation =
  /** Persistence is unavailable, so unsent writes could be lost. Surfaced, not silently ignored. */
  | 'NO_STORAGE'
  /** Multi-tab detection cannot work, so a second tab cannot be warned about. */
  | 'NO_MULTI_TAB'
  /**
   * The Page Lifecycle API is unavailable, so the client cannot report when it was frozen or backgrounded.
   *
   * This one was being ACCEPTED AND DROPPED for a while: the field was in the report, nothing read it, and the test
   * that asserted one note per relaxation is what noticed. A capability the client bothers to measure and the engine
   * ignores is worse than one it never asks for, because it looks like it is being handled.
   */
  | 'NO_PAGE_LIFESTYLE'
  /** A slow or metered connection: telemetry is degraded and the banner says so. */
  | 'DEGRADED_NETWORK'
  /** `saveData` is set. Treated as a relaxation of anything that costs bandwidth. */
  | 'SAVE_DATA'
  /** A reduced-motion preference was detected. */
  | 'REDUCED_MOTION'
  /** Forced colours are on, so the exam's own colours may be overridden by the platform. */
  | 'FORCED_COLORS';

export interface PreflightVerdict {
  /** `OK` when nothing needed relaxing; otherwise the relaxations themselves, so a client can render them. */
  readonly status: 'OK' | 'RELAXED' | 'BLOCKED';
  readonly relaxations: readonly Relaxation[];
  /** Human-readable reasons. A relaxation with no explanation cannot be challenged by a student. */
  readonly notes: readonly string[];
}

/** RTT beyond this and the exam is not really offline-capable, whatever the browser claims. */
const RTT_DEGRADED_MS = 400;

/**
 * EVALUATE A PREFLIGHT REPORT.
 *
 * This RECOMMENDS; it does not decide. `plans/09`'s accommodations work (P8-T12) is what grants a relaxation, and this
 * function's output is the evidence for that decision. The distinction matters: a client that quietly relaxed its own
 * policy would be a client enforcing something the server never agreed to.
 */
export const evaluatePreflight = (report: PreflightReport): PreflightVerdict => {
  const relaxations: Relaxation[] = [];
  const notes: string[] = [];

  if (!report.browser.storage) {
    relaxations.push('NO_STORAGE');
    notes.push(
      'This browser reports no persistent storage, so answers not yet sent to the server may be lost.',
    );
  }
  if (!report.browser.broadcastChannel) {
    relaxations.push('NO_MULTI_TAB');
    notes.push(
      'This browser cannot detect a second tab, so a second window would not be warned about.',
    );
  }
  if (!report.browser.pageLifecycle) {
    relaxations.push('NO_PAGE_LIFESTYLE');
    notes.push('This browser cannot report when the exam was frozen or backgrounded.');
  }
  if (report.network.rttMs > RTT_DEGRADED_MS) {
    relaxations.push('DEGRADED_NETWORK');
    notes.push(`The connection is slow (about ${String(report.network.rttMs)} ms each way).`);
  }
  if (report.network.saveData) {
    relaxations.push('SAVE_DATA');
    notes.push('This device asks for reduced data use, so uploads and telemetry are throttled.');
  }
  if (report.a11y.reducedMotion) {
    relaxations.push('REDUCED_MOTION');
    notes.push('Reduced motion is on, so transitions are suppressed.');
  }
  if (report.a11y.forcedColors) {
    relaxations.push('FORCED_COLORS');
    notes.push('Forced colours are on, so the exam uses the system palette.');
  }
  if (report.a11y.screenReaderGuess !== null) {
    // Recorded as a note and never as a relaxation on its own. See the field's comment.
    notes.push(
      `A screen reader was guessed (${report.a11y.screenReaderGuess}). This is a heuristic and is not used to change the policy.`,
    );
  }

  // Nothing here is `BLOCKED`. That is P8-T12's decision with a human in it, and a client deciding to block a student
  // out of a capability probe is exactly the failure `plans/15` warns about.
  return {
    status: relaxations.length === 0 ? 'OK' : 'RELAXED',
    relaxations,
    notes,
  };
};

/** The facts a session needs in order to be valid, as `AttemptSession` stores them. */
export interface SessionFacts {
  readonly id: string;
  readonly attemptId: string;
  readonly tabId: string | null;
  readonly expiresAt: Millis;
  readonly revokedAt: Millis | null;
  readonly revokedReason: string | null;
}

export type SessionRefusal =
  | 'SESSION_UNKNOWN'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'ATTEMPT_CLOSED';

export type SessionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SessionRefusal; readonly message: string };

/**
 * CHECK A PRESENTED SESSION TOKEN.
 *
 * ## WHY EXPIRY IS CHECKED BEFORE REVOCATION
 *
 * Both mean "this session cannot be used", and the order decides what a teacher sees in the log. An expired session is
 * the ordinary end of a sitting; a revoked one is an event somebody decided on. Checking revocation first would file
 * every finished exam under "revoked" and make the revocation list useless exactly when it is needed.
 */
export const checkSession = (
  session: SessionFacts | null,
  attemptStatus: string,
  now: Millis,
): SessionCheck => {
  if (session === null) {
    return { ok: false, reason: 'SESSION_UNKNOWN', message: 'this session is not recognised' };
  }
  if (now >= session.expiresAt) {
    return { ok: false, reason: 'SESSION_EXPIRED', message: 'this session has expired' };
  }
  if (session.revokedAt !== null) {
    // The reason is the teacher's own words and is carried through, because "revoked" with no reason is
    // indistinguishable from a system fault.
    return {
      ok: false,
      reason: 'SESSION_REVOKED',
      message: session.revokedReason ?? 'this session was ended',
    };
  }
  if (attemptStatus !== 'IN_PROGRESS') {
    return {
      ok: false,
      reason: 'ATTEMPT_CLOSED',
      message: `this attempt is ${attemptStatus}, so the session can no longer be used`,
    };
  }
  return { ok: true };
};

/** One question's deadline in the sync payload. */
export interface QuestionDeadlineDto {
  readonly questionId: string;
  readonly deadlineAt: number | null;
  readonly state: string;
}

/**
 * THE CLOCK HANDSHAKE PAYLOAD, for `GET /session/:sessionId/sync`.
 *
 * `serverNow` is an argument rather than read here: INV-TIME-1, and it makes the builder testable at an exact instant.
 *
 * ## AND IT CARRIES NO SCORE, WHICH IS A REQUIREMENT AND NOT AN OMISSION
 *
 * `saveStateByQuestion` says whether an answer was saved. It never says whether it was RIGHT, and there is no count of
 * correct answers, no percentage, and no per-question score -- `assertScoreFree` in the tests enforces that against
 * `findScoreBearingKeys`, so adding one is a failing test rather than a review comment.
 */
export const buildSyncPayload = (input: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly attemptStatus: string;
  readonly now: Millis;
  readonly startedAt: Millis;
  readonly deadlineAt: Millis | null;
  readonly gracePeriodSec: number;
  readonly policy: ExamPolicy;
  readonly escalationState: string;
  readonly questionDeadlines: readonly QuestionDeadlineDto[];
  /** Per question, `SAVED` / `PENDING` / `FAILED`. Durability only -- never correctness. */
  readonly saveStateByQuestion: Readonly<Record<string, string>>;
}): Readonly<Record<string, unknown>> => ({
  serverNow: input.now,
  sessionValid: true,
  attemptStatus: input.attemptStatus,
  startedAt: input.startedAt,
  deadlineAt: input.deadlineAt,
  gracePeriodSec: input.gracePeriodSec,
  escalationState: input.escalationState,
  questionDeadlines: input.questionDeadlines.map((question) => ({ ...question })),
  saveStateByQuestion: { ...input.saveStateByQuestion },
  // Repeated on every sync, deliberately. See the note at the top of this file.
  policy: input.policy,
});
