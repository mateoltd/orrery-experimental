import { actorPresence, isSameActor } from '@orrery/auth/can';
import { systemClock } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import { submitAnswer } from '@orrery/db/answer-write';
import { requireUser } from '@/server/auth/session-runtime';
import { refuseCaller } from '@/server/auth/session-user';

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
 * ## THE SESSION IS REAL NOW, AND IT IS STILL NOT THE GATE
 *
 * `requireUser` resolves the caller from the `__Host-` session cookie and returns `null` for every failure — absent,
 * forged, expired or revoked (`server/auth/session-user.ts`). That is the change from the `ORRERY_DEV_USER_ID` placeholder
 * this route used to read, and it is what makes the ownership check below mean something: a caller can no longer *become*
 * somebody else by knowing their id, because the only thing the request can name is which attempt to write to.
 *
 * **THE OWNERSHIP CHECK IS STILL THE GATE, AND THE SESSION IS ONLY THE NAME IT IS CHECKED AGAINST.** `submitAnswer`
 * re-derives membership, revision and ledger state from the database, so a route that "pre-checked" anything the function
 * re-derives would be two sources of truth for one fact, and they would disagree under exactly the concurrency the
 * idempotency ledger exists to handle.
 *
 * ## THE TWO REFUSALS ARE ONE REFUSAL, AND `refuseCaller` IS WHY THAT IS NOT AN ACCIDENT
 *
 * An unauthenticated caller and a caller reaching for somebody else's attempt get the SAME status and the SAME body
 * (`server/auth/session-user.ts`, `refuseCaller`). This was not true before: the not-yours case answered 403 FORBIDDEN,
 * which confirms the row exists and turns an exam write route into an existence oracle over every sitting in the school.
 * One function returning one body means a future edit that wants to say "forbidden" has to change the place where the
 * reason is written down.
 *
 * **AND `submitAnswer` STILL OWNS NOTHING.** The function takes an attempt id because the worker, the teacher tools and
 * the test harness all call it too, none of whom are the student. Teaching it about sessions would mean every non-session
 * caller passing a sentinel, and the caller that matters most here is precisely the one that must never be trusted to ask.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<Response> {
  const db = getPrisma();

  /**
   * THE CALLER, FROM THE `__Host-` SESSION COOKIE. `null` for an absent, forged, expired or revoked cookie — and for a
   * caller who has no cookie at all while the local development escape hatch is not opted into.
   */
  const resolution = await requireUser(request);
  const actor = actorPresence(resolution?.caller.userId ?? null);
  if (!actor.ok) return refuseCaller();
  const userId = actor.actorId;
  // The `Set-Cookie` for a slid window, or null. Applied to EVERY response including the refusals below, because a browser
  // left holding a cookie whose expiry the database has moved past gets logged out at an arbitrary later moment.
  const refresh: Record<string, string> = resolution?.setCookie
    ? { 'Set-Cookie': resolution.setCookie }
    : {};

  const body = await readBody(request);
  if (body === null) {
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: { ...NO_STORE, ...refresh } },
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
      { status: 400, headers: { ...NO_STORE, ...refresh } },
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

  if (attempt === null) {
    return Response.json(
      { ok: false, reason: 'ATTEMPT_NOT_FOUND' },
      { status: 404, headers: { ...NO_STORE, ...refresh } },
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
   *
   * AND THE REFUSAL IS `refuseCaller()` — THE SAME RESPONSE AS HAVING NO SESSION. A 403 named FORBIDDEN would tell a
   * student that somebody else's attempt exists, which is the difference between "you may not write here" and "here is
   * the list of everyone who is sitting this exam". Both callers are refused; neither is told why.
   */
  if (!isSameActor(userId, attempt.studentId)) return refuseCaller();

  const answerJson = body.answer ?? null;

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

  return Response.json(result.body, {
    status: result.status,
    headers: { ...NO_STORE, ...refresh },
  });
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
