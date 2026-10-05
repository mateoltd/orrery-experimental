/**
 * THE VERDICT DECISION RULES, AS A PURE FUNCTION.  (P11-T8, completing `P8-T14`'s reader)
 *
 * ## WHY THIS FILE EXISTS AT ALL, GIVEN THE MODEL AND A WRITER COULD HAVE HELD THE RULES
 *
 * Because **a rule held only in a `prisma.update` is a rule nobody can check.** `IntegrityVerdict` has existed in the
 * schema since `P8-T14` and **has no writer anywhere in the tree** — the model, the required `reason` column and the
 * `attemptId` unique constraint were all "enforced" by the existence of a table nobody wrote to. That is the exact shape
 * `P14`'s threat model keeps finding: a property asserted in a comment and backed by nothing.
 *
 * The decision is therefore a pure function of plain data, and `decideIntegrityVerdict` is where every rule lives.
 * `writeIntegrityVerdict` (the database half) may only add the things a function cannot know — that the attempt exists,
 * that the teacher is a member of its classroom, that the row is not already written.
 *
 * ## AND THE RULES ARE STRICTER THAN THE COLUMN LIST SUGGESTS, IN FOUR PLACES
 *
 * 1. **`VOIDED` IS REFUSED UNLESS THE ATTEMPT IS FROZEN.** This is not a workflow preference. `escalation.ts:390` states
 *    the same rule for `reinstate` and gives the reason: **freezing is the step at which a teacher can still change their
 *    mind, so voiding first skips it.** A void decided without a freeze is a teacher disposing of a paper having
 *    considered no evidence.
 *
 * 2. **`NO_CONCERN` IS NOT A NEUTRAL OUTCOME.** It is a *recorded conclusion that nothing was found*, which is different
 *    from having recorded nothing — and the difference matters, because an attempt with no verdict and an attempt cleared
 *    are indistinguishable at the point someone later asks "was this looked at?". **So `NO_CONCERN` still requires a
 *    reason**, and the reason is what distinguishes "checked, nothing found" from "never checked".
 *
 * 3. **A VERDICT IS WRITTEN ONCE.** `attemptId` is `@unique`, so a second write would be rejected by the database with a
 *    unique-violation rather than a decision. **An amendment is a different fact and wants a different route**, because a
 *    silent overwrite would destroy the record of what was concluded first — and the first conclusion is the one a student
 *    may later ask about.
 *
 * 4. **ACCESSIBILITY CONTEXT IS AN EXPLICIT FIELD, NOT AN INFERENCE.** `consideredAccessibilityContext` exists because of
 *    `U-6`: *an inferred disability status must never be a hidden, durable teacher-visible field.* So the verdict records
 *    whether it was **considered**, and **the caller must say so** — the function cannot infer it from the facts, because
 *    inferring it is the thing `U-6` forbids. That is why this is a required input rather than an optional flag.
 *
 * ## AND THE REASON IS NOT FREE TEXT
 *
 * `MIN_REASON` characters, and it is validated **here** rather than by the caller or by a form. `escalation.ts` uses the
 * same floor for the same reason, quoted there: *a reversal with no record is indistinguishable from a freeze that never
 * happened.* **A verdict is the most consequential record this system writes about a student**, so the minimum is set by
 * the consequence of the record being absent, not by what forms are convenient.
 */

/** The four outcomes the schema's comment names. Mirrored as a union so a typo cannot reach the database. */
export const VERDICT_OUTCOMES = ['NO_CONCERN', 'NOTED', 'REVIEW', 'VOIDED'] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

/** The floor, and the reason for it is in the header. `escalation.ts` uses the same number for the same reason. */
export const MIN_REASON = 20;

/** A reason longer than this is stored, but is almost certainly not a reason. */
export const MAX_REASON = 2_000;

export interface VerdictFacts {
  /** `true` when the attempt has been frozen. Read from the attempt, never from the request. */
  readonly frozen: boolean;
  /** A verdict already exists for this attempt. `attemptId` is `@unique`, so this is a refusal rather than a merge. */
  readonly existingVerdict: boolean;
  /**
   * Whether accessibility context was CONSIDERED. Required, and deliberately not optional: `U-6` forbids a hidden
   * inferred disability field, so the caller must state it rather than the function guessing.
   */
  readonly consideredAccessibilityContext: boolean;
}

export interface VerdictInput extends VerdictFacts {
  readonly outcome: VerdictOutcome;
  readonly reason: string;
  /** Who is deciding. Blank is refused: only a human disposes of a paper. */
  readonly decidedById: string;
}

export type VerdictRefusal =
  | 'OUTCOME_UNKNOWN'
  | 'NO_DECIDED_BY'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'VOID_REQUIRES_FREEZE'
  | 'ALREADY_DECIDED';

export type VerdictDecision =
  | { readonly ok: true; readonly reason: string; readonly outcome: VerdictOutcome }
  | { readonly ok: false; readonly refusal: VerdictRefusal; readonly message: string };

/**
 * THE REFUSAL MESSAGES ARE FOR A HUMAN AUTHOR, NOT A LOG LINE, and they say what to do rather than what failed.
 *
 * `escalation.ts` sets this register deliberately — "a teacher decision needs an author, because only a human disposes"
 * is a sentence a teacher can act on, and it is why the reasoning travels with the refusal instead of living in a comment
 * the reader never reaches.
 */
export const decideIntegrityVerdict = (input: VerdictInput): VerdictDecision => {
  if (!VERDICT_OUTCOMES.includes(input.outcome))
    return {
      ok: false,
      refusal: 'OUTCOME_UNKNOWN',
      message: 'that is not one of the four outcomes a verdict can record',
    };

  if (input.decidedById.trim().length === 0)
    return {
      ok: false,
      refusal: 'NO_DECIDED_BY',
      message: 'a verdict needs an author, because only a human disposes of a paper',
    };

  /**
   * TRIMMED, AND THE TRIMMED VALUE IS WHAT WOULD BE STORED.
   *
   * Validating `"                    "` as a 20-character reason would pass a length check on whitespace, which is the
   * cheapest possible way to satisfy a "reason required" rule and produces a verdict with no reason in it.
   */
  const reason = input.reason.trim();

  if (reason.length < MIN_REASON)
    return {
      ok: false,
      refusal: 'REASON_REQUIRED',
      message:
        `that needs a reason of at least ${String(MIN_REASON)} characters, because a verdict with no record ` +
        'cannot be told apart from a decision nobody made',
    };

  if (reason.length > MAX_REASON)
    return {
      ok: false,
      refusal: 'REASON_TOO_LONG',
      message: `keep the reason under ${String(MAX_REASON)} characters, so it is a reason and not a document`,
    };

  /**
   * THE FROZEN CHECK COMES BEFORE THE UNIQUE CHECK ON PURPOSE.
   *
   * A teacher re-opening a decided void learns first that the reason was inadequate, which is the thing they can act on,
   * rather than being told the record already exists — which is true and useless when the record is what they are trying
   * to correct.
   */
  if (input.outcome === 'VOIDED' && !input.frozen)
    return {
      ok: false,
      refusal: 'VOID_REQUIRES_FREEZE',
      message:
        'freezing comes first, because it is the point where a paper can still be looked at again before it is disposed of',
    };

  if (input.existingVerdict)
    return {
      ok: false,
      refusal: 'ALREADY_DECIDED',
      message:
        'this attempt already has a verdict, and the first conclusion is the one that has to stay readable — amend it ' +
        'rather than replacing it',
    };

  return { ok: true, outcome: input.outcome, reason };
};
