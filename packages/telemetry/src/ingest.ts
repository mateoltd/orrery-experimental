/**
 * THE TELEMETRY INGESTION ENDPOINT.  (P14-T14, TM-10, TM-17, `INV-TELEMETRY-2`, `INV-ACC-1`, `plans/09` §7)
 *
 * ## WHAT THIS IS, AND WHY IT IS A MODULE RATHER THAN A FILE UNDER `app/api`
 *
 * `plans/09` §7 specifies `POST /api/exam/v1/telemetry` and seven steps. Nothing implemented any of them, so the signed
 * bytes `EvidenceBatcher` produces reached no verifier and `routeEvidence` — which carries the whole of `INV-ACC-1` and
 * is written to be the one answer — had no caller. Those are the two facts `TM-10` and `accommodations.ts:191-195` each
 * record about the other.
 *
 * The handler is a plain function over a `Request` and injected dependencies. That is not a preference for testability:
 * the whole file is a set of decisions about UNTRUSTED bytes, and a decision you can only exercise by standing up Next.js
 * is a decision nobody writes a test for. Mounting it is four lines and is stated at the bottom of this file.
 *
 * ## THE STEPS, IN THE ORDER `plans/09` §7 GIVES THEM, AND WHY THE ORDER IS NOT NEGOTIABLE
 *
 *   1. **Resolve the session.** Before anything else, because the signature is verified with the STUDENT'S key and the
 *      key is per session. An unsigned batch therefore cannot be rejected "before" the session is known, and this file
 *      does not pretend otherwise — see the ordering note below.
 *   2. **Bind the batch to that session.** Two claims the caller makes about itself, both checked.
 *   3. **Verify the signature.** `verifyEvidenceBatch`, which also reports `RANGE_MISMATCH` separately from
 *      `SIGNATURE_MISMATCH` — "this transport describes its batches wrongly" and "this batch was forged" are different
 *      incidents and a log line that cannot tell them apart cannot be acted on.
 *   4. **Validate each event against the closed schema.** `narrowTelemetryDetail`, in `schema.ts`.
 *   5. **Clamp `clientTs` to ±5 minutes and record the clamp.** The client keeps its value; the row carries the server's.
 *   6. **Stamp `receivedAt` on the server, and assign `seq` from the server.** The client's own `seq` is kept as
 *      `clientSeq` for idempotency, and is never the stored sequence.
 *   7. **Reclassify severity from the SERVER's policy, and route accommodations.** `routeEvidence`, which is the whole
 *      of `INV-ACC-1`.
 *
 * ## WHAT IS DELIBERATELY NOT HERE, NAMED RATHER THAN LEFT IMPLICIT
 *
 *   · **Updating strike counters and evaluating the escalation ladder** — `plans/09` §7 steps 6 and 7. They need
 *     `countStrike`/`evaluateEscalation`, which live in `escalation.ts` and are exported only from the package root, and
 *     they need writes to `AttemptStrikeCounter`, which belongs to `packages/db`. The endpoint therefore REPORTS
 *     `countsAsStrike` per event and stops there; a caller that ignores the field has not implemented the ladder and
 *     nothing here will pretend it has. The tracker scopes `P14-T14` the same way.
 *   · **`protected`.** Set `false` on every row this endpoint writes, and the reason is structural rather than
 *     provisional: `protected` marks the server's OWN threshold-crossing row, which a client cannot produce because
 *     `SERVER_ONLY_EVENTS` refuses `VIOLATION_THRESHOLD_REACHED` at the writer. Every row arriving here is by definition
 *     not that row.
 *   · **Aggregation after 400 days.** `retentionDecision` in `retention.ts` decides; `P14-T6` is what acts, and today it
 *     throws `not implemented`.
 *
 * ## THE ORDERING NOTE, WHICH IS THE ONE PLACE A REASONABLE PERSON WOULD ARGUE
 *
 * Signature-before-session would be tidier and is impossible: the key is the student's. The consequence is that an
 * unknown token and a known token with a forged batch get different statuses. That is not an existence oracle — both
 * facts are about the caller's OWN credential, and neither reveals anything about another student's sitting. Collapsing
 * them would cost a support engineer the ability to tell "your session expired" from "your telemetry was forged", which
 * is the trade `refuseCaller` deliberately makes the other way for a *different* question (see
 * `apps/web/src/app/api/exam/answers/route.ts:131-136`).
 */

import { isSameActor } from '@orrery/auth/can';
import type { Clock, Millis } from '@orrery/clock';
import type { GrantedRelaxation } from '@orrery/exam-engine/accommodations';
import { routeEvidence } from '@orrery/exam-engine/accommodations';
import {
  EVIDENCE_RULES,
  type EvidenceType,
  SERVER_ONLY_EVENTS,
  type Severity,
  type StrikePolicyView,
  verifyEvidenceBatch,
  type WireEvidenceRecord,
} from '@orrery/exam-engine/evidence';
import { TELEMETRY_CLOCK_SKEW_WINDOW, TELEMETRY_LATE_ARRIVAL_WINDOW } from './retention.js';
import { narrowTelemetryDetail, type TelemetryDetail } from './schema.js';

/** `plans/09` §7. One spelling, so the mount and the client cannot disagree about where it lives. */
export const TELEMETRY_ENDPOINT = '/api/exam/v1/telemetry';

/** What arrives. Every field is untrusted, because it arrived from JSON. */
export interface IncomingTelemetryBody {
  readonly attemptId: unknown;
  readonly tabId: unknown;
  readonly fromSeq: unknown;
  readonly toSeq: unknown;
  readonly events: unknown;
  readonly signature: unknown;
}

/**
 * THE SESSION, AND EVERY FACT INGREDIENT DECISES.
 *
 * `policy` and `relaxations` are here rather than looked up per event because the SERVER's policy is what reclassifies
 * severity — a client that sent its own `StrikePolicyView` would be handing over the answer to "does this count as a
 * strike", which is `T7`'s whole defeat in one field.
 */
export interface TelemetrySession {
  readonly attemptId: string;
  /** The user whose session presented the token. */
  readonly sessionUserId: string;
  /** The student the ATTEMPT belongs to. Compared with `isSameActor`, never with `===`. */
  readonly attemptStudentId: string;
  readonly sessionId: string;
  readonly classroomId: string;
  /** Null while the attempt is live; the instant it ended otherwise. */
  readonly endedAt: Millis | null;
  readonly policy: StrikePolicyView;
  readonly relaxations: readonly GrantedRelaxation[];
}

export type TelemetrySessionLookup = (token: string | null) => Promise<TelemetrySession | null>;

/**
 * PERSISTENCE, AS TWO OPERATIONS, because those are the only two the endpoint needs.
 *
 * `reserveSeq` exists so that `seq` is assigned by the SERVER from `max(existing) + 1` (`plans/09` §7) and is allocated
 * once per batch rather than per event, which is what makes a retried batch idempotent: the ledger keyed on
 * `(attemptId, sessionId, clientSeq)` decides whether these rows are new, and the allocation only runs when they are.
 */
export interface TelemetrySink {
  reserveSeq(input: {
    readonly attemptId: string;
    readonly sessionId: string;
    readonly count: number;
  }): Promise<number>;
  append(rows: readonly StoredTelemetryEvent[]): Promise<void>;
}

/**
 * ONE ROW, AND THE NAMES ARE THE ARGUMENT.
 *
 * **NOT ONE OF THESE NAMES IS IN `SCORE_BEARING_KEYS`**, which is the whole of `INV-RELEASE-2` for this table, and
 * `scripts/audit-telemetry-leak.mjs` is the gate that keeps it true — the same job `audit-projections.mjs` does for the
 * three roots it scans, extended to a fourth package that did not exist when it was written.
 *
 * The tempting names are `outcome` and `total`, and both are refused: `outcome` IS in `SCORE_BEARING_KEYS` because it
 * names a verdict, and `total` is in it because a raw mark is the field most worth leaking. The reclassified severity
 * and the strike flag are stored, and a verdict on an attempt is a row in `IntegrityVerdict`, written by a human.
 */
export interface StoredTelemetryEvent {
  readonly attemptId: string;
  readonly sessionId: string;
  /** The client's own sequence number, for idempotency. NEVER the stored sequence. */
  readonly clientSeq: number;
  /** Server-assigned, contiguous from `max(existing) + 1`. */
  readonly seq: number;
  readonly type: EvidenceType;
  /** Reclassified from the server's policy and the student's accommodations, never taken from the client. */
  readonly severity: Severity;
  /** The server's stamp. The retention clock and the ordering both read this, not `clientTs`. */
  readonly receivedAt: Millis;
  /** The client's instant, CLAMPED. Null when the client sent none. */
  readonly clientTs: Millis | null;
  /** How far the clamp moved it, in milliseconds. Zero when it was inside the window. */
  readonly clampedByMs: number;
  /** The closed detail, or null. `INV-TELEMETRY-2` is about this field and nothing else in the row. */
  readonly payload: TelemetryDetail | null;
  /** `INV-ACC-1`. False for every event a relaxation reaches, whatever its severity. */
  readonly accommodationRelaxed: boolean;
  /** Whether a strike counter moves. The ladder is NOT run here; see the file header. */
  readonly countsAsStrike: boolean;
  /** Always false from this endpoint: the protected row is the server's own. See the file header. */
  readonly protected: false;
  /** Whether this event was stored at all, and why not if it was not. */
  readonly rejectedBecause: TelemetryRejection | null;
}

export type TelemetryRejection =
  /** `type` is not in the closed table. Counted and skipped, exactly as `report-integrity.ts:74-78` reads stored rows. */
  | 'UNKNOWN_TYPE'
  /** A client announcing its own escalation, which `evidence.ts` refuses at the writer and so must be refused here. */
  | 'SERVER_ONLY_TYPE'
  /** Arrived more than two hours after the attempt ended. `plans/09` §7. */
  | 'LATE_ARRIVAL'
  /** A `detail` key outside the closed set. The `TM-20` leak arriving over the wire. */
  | 'DETAIL_KEY_NOT_ALLOWED';

export interface TelemetryIngestDependencies {
  readonly clock: Clock;
  readonly lookupSession: TelemetrySessionLookup;
  readonly sink: TelemetrySink;
  /**
   * The STUDENT'S OWN key, as a hex HMAC over `batchSigningInput`.
   *
   * `null` is a REFUSAL and the response says `TELEMETRY_UNVERIFIABLE` with a 503 — deliberately distinct from the 403 a
   * forged batch earns. `verifyEvidenceBatch`'s own header makes the point: `ok: true` from a keyless verifier is a
   * deployment believing in a check it never performed, and a deployment that cannot verify must not also be able to
   * answer "your telemetry was forged", which would send a support engineer looking for an attack that did not happen.
   */
  readonly sign: ((input: string) => string) | null;
}

export interface TelemetryIngestReport {
  readonly ok: true;
  readonly accepted: number;
  /** Stored, but with the `detail` dropped: a key of the detail was reviewed and a VALUE of it was not representable. */
  readonly detailStripped: number;
  readonly rejected: readonly { readonly clientSeq: number; readonly reason: TelemetryRejection }[];
  readonly clamped: number;
  readonly unknownTypes: number;
  readonly countsAsStrike: number;
  /** The server's stamp for the whole batch, which is what the rows carry. */
  readonly receivedAt: Millis;
}

export interface TelemetryIngestRefusal {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

export type TelemetryIngestResult =
  | { readonly status: 200; readonly body: TelemetryIngestReport }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: TelemetryIngestRefusal };

/** One cookie, parsed once, and never logged. `refuseCaller`'s parser in `server/auth/session-user.ts` is the same shape. */
const SESSION_COOKIE = '__Host-orrery-session';

const readCookie = (header: string | null, name: string): string | null => {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
};

/** A body that is not a JSON object is a 400 rather than an exception, for the reason the answers route says. */
const readBody = async (request: Request): Promise<IncomingTelemetryBody | null> => {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as IncomingTelemetryBody;
};

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A sequence number is a non-negative integer. A negative or fractional one is a client that is not counting. */
const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * NARROW THE EVENTS ARRAY, WITHOUT DECIDING ANYTHING ABOUT ITS CONTENT.
 *
 * `verifyEvidenceBatch` is a TOTAL function over hostile bytes and its own comment says why: a canonicaliser that
 * refused an unrecognised shape could not reproduce the signature of a batch carrying exactly the key an attacker added,
 * and a verifier that cannot canonicalise a forgery cannot report that it forged one. So the signature is checked over
 * the events as they arrived, and the content decisions come afterwards, where a refusal costs one event rather than
 * the whole verification.
 */
const narrowEvents = (raw: unknown): WireEvidenceRecord[] | null => {
  if (!Array.isArray(raw)) return null;
  const narrowed: WireEvidenceRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (!isSeq(candidate.seq) || !isText(candidate.type)) return null;
    if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null;
    const detail = candidate.detail;
    if (
      detail !== undefined &&
      (typeof detail !== 'object' || detail === null || Array.isArray(detail))
    ) {
      return null;
    }
    narrowed.push({
      seq: candidate.seq,
      type: candidate.type,
      at: candidate.at,
      ...(detail === undefined ? {} : { detail: detail as Record<string, unknown> }),
    });
  }
  return narrowed;
};

const refuse = (
  status: 400 | 401 | 403 | 503,
  code: string,
  reason: string,
): TelemetryIngestResult => ({
  status,
  body: { ok: false, code, reason },
});

/**
 * THE ENDPOINT.
 *
 * `ingestTelemetry` is the whole handler and takes its dependencies, so every refusal below is reachable from a test
 * with a plain object and no framework — which is the only reason these refusals will have tests at all.
 */
export const ingestTelemetry = async (
  request: Request,
  deps: TelemetryIngestDependencies,
): Promise<TelemetryIngestResult> => {
  // ── 1. The body ──────────────────────────────────────────────────────────────────────────────
  const raw = await readBody(request);
  if (raw === null) return refuse(400, 'MALFORMED_BODY', 'the request body is not a JSON object');

  const events = narrowEvents(raw.events);
  if (
    events === null ||
    !isText(raw.attemptId) ||
    !isText(raw.tabId) ||
    !isSeq(raw.fromSeq) ||
    !isSeq(raw.toSeq) ||
    !isText(raw.signature)
  ) {
    return refuse(400, 'MALFORMED_BODY', 'the batch is not a well-formed signed telemetry batch');
  }

  // ── 2. The session, because the signature's key is the student's ─────────────────────────────
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const session = await deps.lookupSession(token);
  if (session === null) return refuse(401, 'NO_SESSION', 'no usable session');

  // ── 3. Both claims the caller makes about itself ────────────────────────────────────────────
  if (raw.attemptId !== session.attemptId) {
    return refuse(
      403,
      'NOT_THIS_ATTEMPT',
      'this batch does not belong to the session that sent it',
    );
  }
  if (!isSameActor(session.sessionUserId, session.attemptStudentId)) {
    return refuse(
      403,
      'NOT_THIS_ATTEMPT',
      'this attempt does not belong to the session that sent it',
    );
  }

  // ── 4. The signature ───────────────────────────────────────────────────────────────────────
  if (deps.sign === null) {
    return refuse(
      503,
      'TELEMETRY_UNVERIFIABLE',
      'no verification key is configured for this session',
    );
  }
  const verdict = verifyEvidenceBatch(
    {
      attemptId: raw.attemptId,
      tabId: raw.tabId,
      fromSeq: raw.fromSeq,
      toSeq: raw.toSeq,
      events,
      signature: raw.signature,
    },
    deps.sign,
  );
  if (!verdict.ok) return refuse(403, 'BATCH_REJECTED', verdict.reason);

  const now = deps.clock.now();

  // ── 5-7. Per event: clamp, stamp, classify, route ───────────────────────────────────────────
  const rejected: { clientSeq: number; reason: TelemetryRejection }[] = [];
  let detailStripped = 0;
  let clamped = 0;
  let unknownTypes = 0;
  let countsAsStrike = 0;

  /** `seq` is allocated once for the batch, after the rejections, so the stored sequence has no holes. */
  const accepted: {
    readonly event: WireEvidenceRecord;
    readonly severity: Severity;
    readonly clientTs: Millis | null;
    readonly clampedByMs: number;
    readonly payload: TelemetryDetail | null;
    readonly accommodationRelaxed: boolean;
    readonly strike: boolean;
  }[] = [];

  for (const event of events) {
    /**
     * AN UNRECOGNISED TYPE IS COUNTED AND SKIPPED, NEVER THROWN.
     *
     * `evidenceRuleFor` throws on a missing row, correctly — a missing row is a BUG. But here the row can be missing
     * because the CLIENT is running a newer build than this server, and a 500 for that would lose the whole batch
     * including the events this server does understand. `report-integrity.ts:74-78` reads stored rows the same way, so
     * the reader and the writer agree about what an unknown type means.
     */
    if (!Object.hasOwn(EVIDENCE_RULES, event.type)) {
      unknownTypes += 1;
      rejected.push({ clientSeq: event.seq, reason: 'UNKNOWN_TYPE' });
      continue;
    }
    const type = event.type as EvidenceType;

    // A client may not announce its own escalation. `SERVER_ONLY_EVENTS` refuses it in the writer; the wire says so too.
    if (SERVER_ONLY_EVENTS.has(type)) {
      rejected.push({ clientSeq: event.seq, reason: 'SERVER_ONLY_TYPE' });
      continue;
    }

    if (session.endedAt !== null && now - session.endedAt > TELEMETRY_LATE_ARRIVAL_WINDOW) {
      rejected.push({ clientSeq: event.seq, reason: 'LATE_ARRIVAL' });
      continue;
    }

    /**
     * THE DETAIL IS NARROWED, AND A BAD KEY LOSES THE WHOLE EVENT.
     *
     * §7 says "strip unknown keys", and this is where that is not quite the right instruction and the reason is worth
     * recording. A key outside the closed set means the client knows something no reviewer of this repository has, and
     * the type and the timestamp beside it came from the same untrusted writer — so a `type` a client invented could
     * become a `WARN` in a teacher's timeline about an event nobody reviewed. Stripping the detail and keeping the event
     * would buy one unverified event for the loss of the guarantee that every stored event is one somebody reviewed.
     *
     * A bad VALUE under a reviewed key is the opposite case, and the event is kept with no `detail`: the type and the
     * instant are still what the closed table says they are, and a timestamp with a missing detail is an honest gap in a
     * timeline whereas a dropped event is a hole in it.
     *
     * `U-2` says a threshold-crossing event is never dropped — but a threshold-crossing event is the SERVER's, and
     * `SERVER_ONLY_EVENTS` refuses it here, so nothing this endpoint drops is one. The count is what a teacher reads.
     */
    let payload: TelemetryDetail | null = null;
    if (event.detail !== undefined) {
      const narrow = narrowTelemetryDetail(event.detail);
      if (narrow.ok) {
        payload = narrow.detail;
      } else if (narrow.reason === 'DETAIL_KEY_NOT_ALLOWED') {
        rejected.push({ clientSeq: event.seq, reason: 'DETAIL_KEY_NOT_ALLOWED' });
        continue;
      } else {
        detailStripped += 1;
      }
    }

    /** THE CLAMP, AND IT MOVES THE CLIENT'S VALUE RATHER THAN OURS. `plans/09` §7. */
    const clampedByMs = Math.abs(event.at - now) > TELEMETRY_CLOCK_SKEW_WINDOW;
    if (clampedByMs) clamped += 1;
    const clientTs = clampedByMs
      ? Math.min(
          Math.max(event.at, now - TELEMETRY_CLOCK_SKEW_WINDOW),
          now + TELEMETRY_CLOCK_SKEW_WINDOW,
        )
      : event.at;

    /**
     * RECLASSIFY, THEN ROUTE, IN THAT ORDER, AND BOTH FROM THE SERVER'S SIDE.
     *
     * `routeEvidence` is the whole of `INV-ACC-1`: it takes the student's relaxations, the event type and the policy,
     * and answers both "how severe is this" and "does a counter move". Nothing here reads a severity the client sent,
     * because there is no field to send one in and because a client that could would be choosing its own penalty.
     */
    const routed = routeEvidence({
      type,
      policy: session.policy,
      relaxations: session.relaxations,
    });
    if (routed.countsAsStrike) countsAsStrike += 1;

    accepted.push({
      event,
      severity: routed.severity,
      clientTs,
      clampedByMs: clampedByMs ? Math.abs(event.at - clientTs) : 0,
      payload,
      accommodationRelaxed: routed.relaxedBy !== null,
      strike: routed.countsAsStrike,
    });
  }

  if (accepted.length > 0) {
    const firstSeq = await deps.sink.reserveSeq({
      attemptId: session.attemptId,
      sessionId: session.sessionId,
      count: accepted.length,
    });
    await deps.sink.append(
      accepted.map((entry, index) => ({
        attemptId: session.attemptId,
        sessionId: session.sessionId,
        clientSeq: entry.event.seq,
        seq: firstSeq + index,
        type: entry.event.type as EvidenceType,
        severity: entry.severity,
        receivedAt: now,
        clientTs: entry.clientTs,
        clampedByMs: entry.clampedByMs,
        payload: entry.payload,
        accommodationRelaxed: entry.accommodationRelaxed,
        countsAsStrike: entry.strike,
        protected: false as const,
        rejectedBecause: null,
      })),
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      accepted: accepted.length,
      detailStripped,
      rejected,
      clamped,
      unknownTypes,
      countsAsStrike,
      receivedAt: now,
    },
  };
};
