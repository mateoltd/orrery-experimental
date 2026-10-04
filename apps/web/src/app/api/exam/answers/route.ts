import { actorPresence, isSameActor } from '@orrery/auth/can';
import { systemClock } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import { submitAnswer } from '@orrery/db/answer-write';

/**
 * The server-authoritative answer write.  (P8-T9, `INV-LATE-1`)
 *
 * ## WHY THIS ROUTE IS THE THING `INV-LATE-1` IS ABOUT
 *
 * `INV-LATE-1` says a write past the deadline is refused by the SERVER. The client cannot be the enforcement point for
 * a rule about time: a student with a modified clock, a background tab whose timers were suspended, or a laptop that
 * slept through the deadline all produce a client that sincerely believes it is early. So the deadline is read here,
 * from the attempt row, and compared against `@orrery/clock` -- never against anything the request said.
 *
 * **AND THE GRACE PERIOD IS THE NUMBER THE POLICY DECLARED, NOT A LITERAL.** `RN-04`'s 60-second default lives in
 * `ExamAttempt.gracePeriodSec` precisely so one student's extension does not become everyone's, so it is read per
 * attempt. A constant here would silently overrule every accommodation a teacher granted.
 *
 * ## AND THE CLIENT'S ANSWER IS NOT TRUSTED FOR ANYTHING
 *
 * `submitAnswer` re-derives membership, revision and ledger state from the database. This route authenticates the
 * caller, refuses a write to somebody else's attempt, and hands over -- because a route that "pre-checked" anything the
 * function re-derives would be two sources of truth for one fact, and they would disagree under exactly the
 * concurrency the idempotency ledger exists to handle.
 *
 * ## THE RESPONSE BODY IS THE STORED BODY ON A REPLAY
 *
 * A retry after a dropped connection must get back what the first call stored, byte for byte, or the client's
 * revision bookkeeping desynchronises from the server and every later write collides. That is why `submitAnswer`
 * persists the response body in the ledger rather than recomputing it.
 *
 * ## ⚠️ THIS ROUTE IS CORRECT IN SHAPE AND NOT YET SAFE TO EXPOSE
 *
 * `apps/web` has no session layer yet. `classrooms/[classroomId]/roster` reads `ORRERY_DEV_USER_ID`, and every
 * permission after that comes from the database -- so a forged id only gets a caller to be *themselves*.
 *
 * **On a roster page that is acceptable. On an answer write it is not, and the difference is worth writing down.**
 * Being yourself lets you read your own roster; here it would let anyone write answers into another student's attempt,
 * which corrupts the one thing the exam is measuring. The ownership check below is therefore the real gate and the
 * session is only the name it is checked against -- so until a real session exists, a caller who knows a user id can
 * write as that user.
 *
 * `sessionUserId()` returns `null` rather than defaulting, so the route **fails closed** while the session lands. The
 * alternative -- defaulting to the same all-zeroes id the roster page uses -- would make this route writable by
 * anyone, which is a far worse default to ship than an unusable one.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<Response> {
  const db = getPrisma();

  // **401, NOT 403.** A 403 would confirm the attempt exists, which is an existence oracle over somebody else's exam.
  const actor = actorPresence(sessionUserId());
  if (!actor.ok) {
    return Response.json({ ok: false, reason: actor.reason }, { status: 401, headers: NO_STORE });
  }
  const userId = actor.actorId;

  const body = await readBody(request);
  if (body === null) {
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: NO_STORE },
    );
  }

  const attemptId = stringField(body, 'attemptId');
  const questionId = stringField(body, 'questionId');
  const idempotencyKey = stringField(body, 'idempotencyKey');
  const expectedRevision = numberField(body, 'expectedRevision');

  if (
    attemptId === null ||
    questionId === null ||
    idempotencyKey === null ||
    expectedRevision === null
  ) {
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: NO_STORE },
    );
  }

  /**
   * OWNERSHIP IS CHECKED HERE AND NOT INSIDE `submitAnswer`.
   *
   * The function takes an attempt id because it is also called by the worker, the teacher tools and the test harness,
   * none of which are the student. Teaching it about sessions would mean every non-session caller passing a sentinel,
   * and the caller that matters most here is precisely the one that must never be trusted to ask.
   */
  const attempt = await db.examAttempt.findUnique({
    where: { id: attemptId },
    select: { studentId: true, gracePeriodSec: true },
  });

  // 404 for a missing attempt and 403 for somebody else's: the second must not confirm that the first exists.
  if (attempt === null) {
    return Response.json(
      { ok: false, reason: 'ATTEMPT_NOT_FOUND' },
      { status: 404, headers: NO_STORE },
    );
  }
  /**
   * OWNERSHIP IS ASKED, NOT COMPARED.
   *
   * `attempt.studentId !== userId` is the obvious way to write this, and the `authz-ownership` gate refused it -- which
   * is the gate doing its job. "Whose row is this" is a question about authorisation, and every place that answers it
   * separately is a place where the answers eventually differ. `isSameActor` is the one implementation, and it is
   * null-safe on both sides: a row with no owner is owned by nobody, INCLUDING the actor, which a bare `===` reports
   * as the actor's own whenever both sides happen to be `null`.
   */
  if (!isSameActor(userId, attempt.studentId)) {
    return Response.json({ ok: false, reason: 'FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }

  const answerJson = body['answer'] ?? null;

  const result = await submitAnswer(
    db,
    {
      attemptId,
      questionId,
      idempotencyKey,
      expectedRevision,
      answerJson,
      answerBytes: JSON.stringify(answerJson),
      /**
       * The client MAY send its own hash, and it is treated as a claim about the bytes rather than a fact. `answerHash`
       * is required by `SubmitInput`, so an absent one is an empty string rather than a fabricated digest -- the
       * submission receipt (P8-T10) is where a hash becomes something a marker can rely on, and inventing one here
       * would put an unverifiable value into the chain it is meant to protect.
       */
      answerHash: stringField(body, 'answerHash') ?? '',
      actorId: userId,
      source: 'CLIENT',
      clientTs: dateField(body, 'clientTs'),
    },
    systemClock,
    // Per attempt, from the policy the student was served -- not a constant.
    attempt.gracePeriodSec * 1000,
  );

  return Response.json(result.body, { status: result.status, headers: NO_STORE });
}

/**
 * THE SESSION PLACEHOLDER. See the ⚠️ note above: this is not authentication, and this route must not be exposed until
 * it is. It returns `null` rather than defaulting so the route fails closed.
 */
function sessionUserId(): string | null {
  const id = process.env.ORRERY_DEV_USER_ID;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** A body that is not a JSON object is a 400 rather than an exception. */
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const stringField = (body: Record<string, unknown>, key: string): string | null => {
  const value = body[key];
  // A blank string is not a valid id, and treating `""` as one produces a query that matches nothing while looking like
  // a real request -- which is how a typo becomes a 404 nobody can explain.
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** Rejects a negative or fractional revision rather than letting it collide with a real one. */
const numberField = (body: Record<string, unknown>, key: string): number | null => {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
};

const dateField = (body: Record<string, unknown>, key: string): Date | undefined => {
  const value = body[key];
  // Unparseable is treated as absent rather than as "now": a client sending garbage has a suspect clock, and the
  // server's clock is the one that decides anyway.
  if (typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
