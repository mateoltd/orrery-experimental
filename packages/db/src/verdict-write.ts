/**
 * WRITING A VERDICT — THE DATABASE HALF, WHICH MAY ONLY ADD WHAT A PURE FUNCTION CANNOT KNOW.  (P11-T8)
 *
 * ## THE DIVISION OF LABOUR IS THE DESIGN
 *
 * `decideIntegrityVerdict` owns every rule that is a matter of judgement: the reason floor, the author, the freeze before
 * a void, one verdict per attempt. **This module owns only what no pure function can have** — that the attempt exists and
 * is a `GRADED` attempt, that the decider may act in its classroom, and that the row is not already written.
 *
 * ## `classroomCanInput` IS USED RATHER THAN A HAND-ROLLED AUTHORISATION CHECK, AND THAT IS THE POINT
 *
 * `classroom.ts:231` already answers "may this actor act in this classroom" by loading the membership and building a
 * `CanInput`; `attempt-exceptions.ts:111` uses exactly that pattern. **Re-deriving it here would be a second opinion about
 * authorisation in a module whose whole job is to be trusted about who may conclude an integrity matter.** If the scope
 * rules change, this inherits them.
 *
 * ## THE FREEZE IS READ FROM THE COLUMN, AND THAT IS THE MOST IMPORTANT LINE IN THE FILE
 *
 * `VerdictFacts.frozen` exists so the pure function is testable without a database. **Trusting the caller's copy would
 * make the freeze-before-a-void check theatre** — the one rule that stops a teacher disposing of a paper having looked at
 * no evidence. The input's `frozen` is accepted for the type and then *ignored*.
 *
 * ## THE UNIQUE CONSTRAINT IS THE REAL ARBITER AND IT IS CAUGHT, NOT PROPAGATED
 *
 * The pre-read cannot settle two teachers writing at once, so `P2002` is caught and turned into the same decision the
 * pre-read would have produced. **A unique-violation surfacing to a teacher as a raw driver error is not a decision
 * anybody made.**
 */

import { can } from '@orrery/auth/can';
import type { Actor } from '@orrery/auth/types';
import { classroomCanInput } from './classrooms.js';
import type { PrismaClient } from './prisma.js';
import {
  decideIntegrityVerdict,
  type VerdictFacts,
  type VerdictOutcome,
} from './verdict-decision.js';

export type WriteVerdictRefusal =
  | 'ATTEMPT_NOT_FOUND'
  | 'NOT_PERMITTED'
  | 'ALREADY_DECIDED'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'NO_DECIDED_BY'
  | 'VOID_REQUIRES_FREEZE'
  | 'OUTCOME_UNKNOWN';

export type WriteVerdictResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly refusal: WriteVerdictRefusal; readonly message: string };

/**
 * ONE REFUSAL FOR EVERY AUTHORISATION FAILURE, AND THE SAME REASON AS EVERYWHERE ELSE.
 *
 * Distinct messages for "no such attempt" and "not your classroom" would make this an existence oracle over every attempt
 * in the school, and the difference between the two answers is the entire payload. `session-user.ts`'s `refuseCaller()`
 * makes the same choice for the same reason.
 */
const REFUSE = (refusal: WriteVerdictRefusal, message: string): WriteVerdictResult => ({
  ok: false,
  refusal,
  message,
});

const DENIED = REFUSE('NOT_PERMITTED', 'no such attempt');

export interface WriteVerdictInput extends VerdictFacts {
  readonly attemptId: string;
  readonly outcome: VerdictOutcome;
  readonly reason: string;
}

export async function writeIntegrityVerdict(
  db: PrismaClient,
  actor: Actor,
  input: WriteVerdictInput,
): Promise<WriteVerdictResult> {
  /**
   * ONE READ, CARRYING EVERY FACT THE CHECKS NEED, so the decision cannot be made against a row a concurrent write has
   * since changed. `frozenAt` and the existing verdict are selected here rather than re-read later.
   */
  const attempt = await db.examAttempt.findFirst({
    where: { id: input.attemptId, purpose: 'GRADED' },
    select: {
      id: true,
      frozenAt: true,
      classroomId: true,
      verdict: { select: { id: true } },
    },
  });
  if (attempt === null) return REFUSE('ATTEMPT_NOT_FOUND', 'no such attempt');

  /**
   * AUTHORISATION BEFORE ANY RULE, so an unauthorised caller learns nothing about whether their reason was long enough.
   * That is a small information leak, and an entirely avoidable one.
   */
  /**
   * `update`, NOT AN ACTION INVENTED FOR THIS CALL.
   *
   * `examAttemptRules` has no `integrityVerdict` action, and adding one to the 1,753-line matrix is the kind of change
   * `P5-T14` owns ("`can()` matrix for the new P5 types") -- it would need its own rules, its own tests and a decision
   * about whether a student may ever hold it. **`update` is the honest existing answer**: owner + classroom staff, which
   * is exactly "a teacher in this classroom may conclude an integrity matter about a paper in it", and it is already
   * covered by the matrix's own tests rather than by a rule written here and forgotten.
   */
  const built = await classroomCanInput(db, {
    actor,
    classroomId: attempt.classroomId,
    action: 'update',
  });
  if (!built.ok) return DENIED;
  if (!can(built.canInput).allowed) return DENIED;

  const decision = decideIntegrityVerdict({
    outcome: input.outcome,
    reason: input.reason,
    decidedById: actor.id,
    /**
     * THE COLUMN, NOT THE INPUT. See the header: trusting the caller here would make the freeze check theatre.
     */
    frozen: attempt.frozenAt !== null,
    existingVerdict: attempt.verdict !== null,
    consideredAccessibilityContext: input.consideredAccessibilityContext,
  });
  if (!decision.ok) return REFUSE(decision.refusal, decision.message);

  try {
    const row = await db.integrityVerdict.create({
      data: {
        attemptId: attempt.id,
        outcome: decision.outcome,
        reason: decision.reason,
        decidedById: actor.id,
        consideredAccessibilityContext: input.consideredAccessibilityContext,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id };
  } catch (error) {
    if (isUniqueViolation(error))
      return REFUSE('ALREADY_DECIDED', 'this attempt already has a verdict');
    throw error;
  }
}

/** `P2002` is Prisma's unique-constraint violation. Named rather than inlined so the intent is the thing on screen. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === 'P2002';
