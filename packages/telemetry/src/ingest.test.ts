/**
 * The ingestion endpoint.  (P14-T14, TM-10, TM-17, `INV-TELEMETRY-2`, `INV-ACC-1`)
 *
 * ## THE CORPUS IS BUILT BY THE REAL WRITER, NOT HAND-WRITTEN
 *
 * Every well-formed batch below is produced by `EvidenceBatcher` — the only place an `EvidenceRecord` is constructed —
 * signed by a real hex HMAC, and captured from a real transport. A hand-written batch would audit a shape no production
 * code produces, which is exactly how `audit-seals.mjs`'s first version audited nothing and passed.
 *
 * The two cases the batcher cannot build are built by hand and SAID to be: an unrecognised event type and the
 * server-only one. `record()` refuses both by construction, and a corpus that could only contain legal batches would be
 * a corpus that never tested the two refusals that matter most.
 */

import { createHmac } from 'node:crypto';
import { FrozenClock, HOUR, MINUTE, type Millis } from '@orrery/clock';
import {
  batchSigningInput,
  EvidenceBatcher,
  type SignedBatch,
  verifyEvidenceBatch,
} from '@orrery/exam-engine/evidence';
import { describe, expect, it } from 'vitest';
import {
  type IncomingTelemetryBody,
  ingestTelemetry,
  type StoredTelemetryEvent,
  type TelemetryIngestDependencies,
  type TelemetrySession,
} from './ingest.js';

const T0: Millis = 1_800_000_000_000;
const ATTEMPT = 'at-1';
const SESSION = 'se-1';
const CLASSROOM = 'cl-1';

/** 32 bytes, and not a round number chosen to look secure. */
const KEY = 'telemetry-ingestion-test-key-01';

/**
 * THE STUDENT'S OWN KEY, as a REAL hex HMAC, and SYNCHRONOUS because that is the shape both halves require.
 *
 * `EvidenceBatcher` and `verifyEvidenceBatch` both take `(input: string) => string`, because the batcher runs in a browser
 * where the key is already materialised — and WebCrypto has no synchronous HMAC, so a test signer cannot use it. This
 * one uses `node:crypto`, exactly as `scripts/audit-payloads.mjs:63-64` does.
 *
 * **AND IT IS REAL FOR THE REASON `audit-payloads.mjs:478-488` RECORDS AT LENGTH.** Its first signer was
 * `(input) => \`hmac:${String(input.length)}\``, and the moment a real verifier was wired in the gate refused the batch
 * the gate had produced itself with `MALFORMED_SIGNATURE`. A corpus signed by a stand-in exercises the writer and never
 * the bytes.
 */
const hmac = (input: string): string => createHmac('sha256', KEY).update(input).digest('hex');

const session = (over: Partial<TelemetrySession> = {}): TelemetrySession => ({
  attemptId: ATTEMPT,
  sessionUserId: 'st-1',
  attemptStudentId: 'st-1',
  sessionId: SESSION,
  classroomId: CLASSROOM,
  endedAt: null,
  policy: {
    requireFullscreen: 'REQUIRE',
    requirePointerLock: 'REQUIRE',
    multiTabPolicy: 'BLOCK',
    blockCopyPaste: true,
    blockPrintSave: true,
  },
  relaxations: [],
  ...over,
});

interface Harness {
  readonly deps: TelemetryIngestDependencies;
  readonly rows: StoredTelemetryEvent[];
  readonly reserves: { attemptId: string; sessionId: string; count: number }[];
}

const harness = (over: Partial<TelemetrySession> = {}, clockAt: Millis = T0): Harness => {
  const rows: StoredTelemetryEvent[] = [];
  const reserves: { attemptId: string; sessionId: string; count: number }[] = [];
  const facts = session(over);
  return {
    rows,
    reserves,
    deps: {
      clock: new FrozenClock(clockAt),
      /**
       * THE LOOKUP HONOURS ITS ARGUMENT, and that is not a formality.
       *
       * A harness that returned the session whatever the token could not express "no cookie", which is the 401 every
       * unauthenticated caller gets and the reason the refusal exists. A fake that cannot produce its own failure mode
       * makes the failure mode untested.
       */
      lookupSession: async (token) => (token === null || token === '' ? null : facts),
      sink: {
        reserveSeq: async (input) => {
          reserves.push(input);
          return rows.length + 1;
        },
        append: async (incoming) => {
          rows.push(...incoming);
        },
      },
      sign: hmac,
    },
  };
};

const post = (batch: unknown, cookie = '__Host-orrery-session=tok-1'): Request =>
  new Request('http://localhost/api/exam/v1/telemetry', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });

/**
 * PRODUCE A BATCH THROUGH THE REAL WRITER.
 *
 * `hostile` exists for the two shapes `record()` refuses; the cast is stated rather than hidden, because a corpus that
 * quietly could not contain a server-only event would not have tested the refusal.
 */
const batcherFor = async (
  clockAt: Millis,
  records: { readonly type: string; readonly detail?: Record<string, unknown> }[],
): Promise<SignedBatch> => {
  let captured: SignedBatch | null = null;
  const batcher = new EvidenceBatcher(
    {
      batchSize: 1_000,
      maxQueued: 10_000,
      transport: async (batch) => {
        captured = batch;
        return true;
      },
    },
    { now: () => clockAt },
    ATTEMPT,
    'tab-1',
    hmac,
  );
  for (const record of records) {
    // The cast is the point: `record()` REFUSES both of the shapes below, so a corpus built without it would be a corpus
    // in which those refusals had never been tested.
    const accepted = batcher.record(record.type as 'TAB_HIDDEN', record.detail as never);
    if (!accepted) throw new Error(`the batcher refused ${record.type} unexpectedly`);
  }
  await batcher.flushOnce();
  if (captured === null) throw new Error('the batcher sent nothing');
  return captured;
};

/**
 * RE-SIGN A DOCTORED BATCH, because a doctored batch that kept the original signature is only testing the verifier.
 *
 * Every hostile case below replaces an event AFTER the batcher signed, so without this they would all fail at
 * `SIGNATURE_MISMATCH` and none of them would reach the decision it exists to test. `batchSigningInput` is the function
 * `EvidenceBatcher` itself signs over, so this reproduces the real material rather than a second guess at it.
 */
const resign = (batch: SignedBatch): IncomingTelemetryBody => {
  const events = batch.events;
  return {
    ...batch,
    signature: hmac(
      batchSigningInput({
        attemptId: batch.attemptId,
        tabId: batch.tabId,
        events,
      }),
    ),
  } as unknown as IncomingTelemetryBody;
};

const batchOf = async (
  clockAt: Millis,
  records: { readonly type: string; readonly detail?: Record<string, unknown> }[],
): Promise<IncomingTelemetryBody> => {
  const batch = await batcherFor(clockAt, records);
  return { ...batch } as unknown as IncomingTelemetryBody;
};

describe('THE ORDINARY REQUEST: a live exam, a live session, a genuine batch', () => {
  it("accepts the batch, and the rows carry the SERVER stamp rather than the client's", async () => {
    const { deps, rows } = harness({}, T0 + 40_000);
    const body = await batchOf(T0, [{ type: 'TAB_HIDDEN', detail: { awayForMs: 12 } }]);

    const result = await ingestTelemetry(post(body), deps);

    expect(result.status).toBe(200);
    if (!result.body.ok) throw new Error('expected an acceptance');
    expect(result.body.accepted).toBe(1);
    expect(rows).toHaveLength(1);
    // The client's clock said T0; the server stamped T0 + 40s, and the retention clock reads the server's value.
    expect(rows[0]?.receivedAt).toBe(T0 + 40_000);
    expect(rows[0]?.clientTs).toBe(T0);
    expect(rows[0]?.seq).toBe(1);
    expect(rows[0]?.clientSeq).toBe(0);
    expect(rows[0]?.payload).toEqual({ awayForMs: 12 });
  });

  it('THE PROPERTY: the response echoes no stored field back, so this endpoint is not a read path', async () => {
    const { deps } = harness();
    const body = await batchOf(T0, [{ type: 'TAB_HIDDEN', detail: { awayForMs: 12 } }]);
    const result = await ingestTelemetry(post(body), deps);
    if (!result.body.ok) throw new Error('expected an acceptance');
    // A telemetry endpoint that returns what it stored is a telemetry endpoint a client can enumerate attempts with.
    // Counts are safe to return; rows are not.
    expect(Object.keys(result.body).sort()).toEqual([
      'accepted',
      'clamped',
      'countsAsStrike',
      'detailStripped',
      'ok',
      'receivedAt',
      'rejected',
      'unknownTypes',
    ]);
  });
});

describe('THE FIVE REFUSALS, each with its own name', () => {
  it('a body that is not JSON is a 400, not an exception', async () => {
    const { deps } = harness();
    const request = new Request('http://localhost/api/exam/v1/telemetry', {
      method: 'POST',
      headers: { cookie: '__Host-orrery-session=tok-1' },
      body: 'not json',
    });
    expect((await ingestTelemetry(request, deps)).body).toEqual({
      ok: false,
      code: 'MALFORMED_BODY',
      reason: 'the request body is not a JSON object',
    });
  });

  it.each([
    ['events is not an array', { events: {} }],
    ['an event is not an object', { events: ['x'] }],
    ['seq is negative', { events: [{ seq: -1, type: 'TAB_HIDDEN', at: 0 }] }],
    ['seq is fractional', { events: [{ seq: 0.5, type: 'TAB_HIDDEN', at: 0 }] }],
    ['type is not a string', { events: [{ seq: 0, type: 12, at: 0 }] }],
    ['at is not finite', { events: [{ seq: 0, type: 'TAB_HIDDEN', at: 'soon' }] }],
    ['detail is an array', { events: [{ seq: 0, type: 'TAB_HIDDEN', at: 0, detail: [] }] }],
    ['the signature is missing', { signature: undefined }],
  ])('%s is refused as MALFORMED_BODY', async (_what, patch) => {
    const { deps } = harness();
    const body = {
      ...(await batchOf(T0, [{ type: 'TAB_HIDDEN' }])),
      ...patch,
    } as IncomingTelemetryBody;
    const result = await ingestTelemetry(post(body), deps);
    expect(result.status).toBe(400);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.code).toBe('MALFORMED_BODY');
  });

  it('no session is a 401, and the signature is never even reached', async () => {
    const { deps } = harness();
    const body = await batchOf(T0, [{ type: 'TAB_HIDDEN' }]);
    for (const cookie of [null, '', '__Host-orrery-session=']) {
      const result = await ingestTelemetry(post(body, cookie ?? ''), deps);
      expect(result.status).toBe(401);
      if (result.body.ok) throw new Error('expected a refusal');
      expect(result.body.code).toBe('NO_SESSION');
    }
  });

  it("a batch naming a DIFFERENT attempt is refused, so a session cannot write into somebody else's sitting", async () => {
    const { deps, rows } = harness();
    const batch = await batchOf(T0, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post({ ...batch, attemptId: 'at-somebody-else' }), deps);
    expect(result.status).toBe(403);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.code).toBe('NOT_THIS_ATTEMPT');
    expect(rows).toHaveLength(0);
  });

  it("THE PROPERTY: a session whose user is not the attempt's student is refused", async () => {
    // This is the ownership check, and it goes through `isSameActor` because the authz-ownership gate forbids
    // comparing an owner id to an actor id anywhere else. A lookup that returned the wrong join would write a student's
    // telemetry into somebody else's attempt, and every row would look right.
    const { deps, rows } = harness({ sessionUserId: 'st-2', attemptStudentId: 'st-1' });
    const body = await batchOf(T0, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post(body), deps);
    expect(result.status).toBe(403);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.code).toBe('NOT_THIS_ATTEMPT');
    expect(rows).toHaveLength(0);
  });
});

describe('THE SIGNATURE IS VERIFIED, AND A DEPLOYMENT THAT CANNOT VERIFY REFUSES DIFFERENTLY', () => {
  it('a forged batch is refused as SIGNATURE_MISMATCH, and nothing is written', async () => {
    const { deps, rows } = harness();
    const batch = await batchOf(T0, [{ type: 'TAB_HIDDEN' }]);
    const forged = { ...batch, signature: 'f'.repeat(64) };
    const result = await ingestTelemetry(post(forged), deps);
    expect(result.status).toBe(403);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.reason).toBe('SIGNATURE_MISMATCH');
    expect(rows).toHaveLength(0);
  });

  it('an EDITED `detail` fails the signature, which is the tampering case the signature is for', async () => {
    const { deps } = harness();
    const batch = await batchOf(T0, [{ type: 'TAB_HIDDEN', detail: { awayForMs: 12 } }]);
    const edited = {
      ...batch,
      events: batch.events.map((event) => ({ ...event, detail: { awayForMs: 999_999 } })),
    };
    const result = await ingestTelemetry(post(edited), deps);
    expect(result.status).toBe(403);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.reason).toBe('SIGNATURE_MISMATCH');
  });

  it('a batch that describes a range it does not cover is refused SEPARATELY, because it is a different incident', async () => {
    // "This transport is describing its batches wrongly" is not "this batch was forged", and an operator needs to know
    // which one happened. `verifyEvidenceBatch` checks the range before the MAC for exactly this reason.
    const { deps } = harness();
    const batch = await batchOf(T0, [{ type: 'TAB_HIDDEN' }, { type: 'TAB_VISIBLE' }]);
    const result = await ingestTelemetry(post({ ...batch, toSeq: 99 }), deps);
    expect(result.status).toBe(403);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.reason).toBe('RANGE_MISMATCH');
  });

  it('no configured key is a 503 and NOT a 403, so an unconfigured deployment does not read as an attack', async () => {
    const { deps } = harness();
    const body = await batchOf(T0, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post(body), { ...deps, sign: null });
    expect(result.status).toBe(503);
    if (result.body.ok) throw new Error('expected a refusal');
    expect(result.body.code).toBe('TELEMETRY_UNVERIFIABLE');
  });

  it('and the corpus this file is built from really does verify, so the corpus is not exercising nothing', async () => {
    // `audit-payloads.mjs` made the same check after its first signer turned out to be a fake one and the gate refused
    // the batch it had produced itself. A verifier nothing can fail is not a verifier.
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN', detail: { awayForMs: 12 } }]);
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });
});

describe('THE CLOSED SCHEMA, APPLIED TO WHAT ACTUALLY ARRIVED', () => {
  it('THE PROPERTY: a `detail` carrying `studentEmail` LOSES THE EVENT, not just the detail', async () => {
    const { deps, rows } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }]);
    const leaky = resign({
      ...batch,
      events: [
        { seq: 0, type: 'TAB_HIDDEN', at: T0, detail: { studentEmail: 'student@school.invalid' } },
      ],
    });
    const result = await ingestTelemetry(post(leaky), deps);
    if (!result.body.ok) throw new Error('expected a 200 with the event rejected');
    expect(result.body.accepted).toBe(0);
    expect(result.body.rejected).toEqual([{ clientSeq: 0, reason: 'DETAIL_KEY_NOT_ALLOWED' }]);
    // Nothing was written, and nothing was reserved, so no gap is left in the stored sequence.
    expect(rows).toHaveLength(0);
  });

  it('and a GOOD event in the same batch is still stored, because telemetry may be incomplete', async () => {
    const { deps, rows } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }, { type: 'TAB_VISIBLE' }]);
    const mixed = resign({
      ...batch,
      events: [
        { seq: 0, type: 'TAB_HIDDEN', at: T0, detail: { studentEmail: 'student@school.invalid' } },
        { seq: 1, type: 'TAB_VISIBLE', at: T0 },
      ],
    });
    const result = await ingestTelemetry(post(mixed), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.accepted).toBe(1);
    // And the sequence is contiguous: the rejected event did not leave a hole for `report-integrity.ts` to find.
    expect(rows.map((row) => row.seq)).toEqual([1]);
    expect(rows[0]?.type).toBe('TAB_VISIBLE');
  });

  it('a bad VALUE under a legal key keeps the event and drops the detail, because a gap beats a hole', async () => {
    const { deps, rows } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }]);
    const prose = resign({
      ...batch,
      events: [
        {
          seq: 0,
          type: 'TAB_HIDDEN',
          at: T0,
          detail: { reason: 'a whole sentence a student typed' },
        },
      ],
    });
    const result = await ingestTelemetry(post(prose), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.accepted).toBe(1);
    expect(result.body.detailStripped).toBe(1);
    expect(rows[0]?.payload).toBeNull();
    // The TYPE and the instant still arrived, so the timeline keeps the event and says the detail is missing.
    expect(rows[0]?.type).toBe('TAB_HIDDEN');
    expect(rows[0]?.clientTs).toBe(T0);
  });

  it('an event with no `detail` at all is stored with a null payload rather than an empty object', async () => {
    const { deps, rows } = harness();
    const result = await ingestTelemetry(post(await batchOf(T0, [{ type: 'EXAM_STARTED' }])), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(rows[0]?.payload).toBeNull();
  });
});

describe('THE EVENT TYPE IS CHECKED AGAINST THE CLOSED TABLE, AND A NEWER CLIENT IS NOT A 500', () => {
  it('an unrecognised type is counted and skipped, and the rest of the batch is stored', async () => {
    const { deps, rows } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }, { type: 'TAB_VISIBLE' }]);
    const newer = resign({
      ...batch,
      events: [
        { seq: 0, type: 'SOMETHING_FROM_A_NEWER_CLIENT', at: T0 },
        { seq: 1, type: 'TAB_VISIBLE', at: T0 },
      ],
    });
    const result = await ingestTelemetry(post(newer), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.unknownTypes).toBe(1);
    expect(result.body.accepted).toBe(1);
    expect(result.body.rejected).toEqual([{ clientSeq: 0, reason: 'UNKNOWN_TYPE' }]);
    expect(rows[0]?.type).toBe('TAB_VISIBLE');
  });

  it('THE PROPERTY: a client announcing its own escalation is refused, event by event', async () => {
    // `VIOLATION_THRESHOLD_REACHED` is emitted by the SERVER on evidence a human has not seen, and `evidence.ts` refuses
    // it in the writer. Over the wire the writer's refusal is bypassed, so it has to be refused again here — otherwise a
    // student could escalate their own ladder with a perfectly valid signature, since the key is theirs.
    const { deps, rows } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }]);
    const escalating = resign({
      ...batch,
      events: [{ seq: 0, type: 'VIOLATION_THRESHOLD_REACHED', at: T0 }],
    });
    const result = await ingestTelemetry(post(escalating), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.accepted).toBe(0);
    expect(result.body.rejected).toEqual([{ clientSeq: 0, reason: 'SERVER_ONLY_TYPE' }]);
    expect(rows).toHaveLength(0);
  });
});

describe('THE TIMESTAMPS ARE OURS, AND THE CLAMP IS RECORDED', () => {
  it('THE PROPERTY: a client claiming an hour ago has its instant moved, and the movement is visible', async () => {
    const { deps, rows } = harness({}, T0 + 40_000);
    const batch = await batcherFor(T0 - HOUR, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post(batch), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.clamped).toBe(1);
    // Clamped to the ±5-minute window around the server's stamp, and by the AMOUNT it moved — a clamped timestamp that
    // reads as the client's is a lie a teacher cannot see.
    expect(rows[0]?.clientTs).toBe(T0 + 40_000 - 5 * MINUTE);
    // `HOUR - 5 * MINUTE` PLUS the 40 s the server clock advanced while the batch was in flight — which is the honest
    // number. The assertion that `clampedByMs === HOUR - 5 * MINUTE` was wrong by exactly those 40 seconds, and being
    // wrong by 40 s is the point: the movement is measured against the instant the row was stamped.
    expect(rows[0]?.clampedByMs).toBe(HOUR - 5 * MINUTE + 40_000);
    expect(rows[0]?.receivedAt).toBe(T0 + 40_000);
  });

  it('a client claiming the FUTURE is clamped in the other direction, so it cannot date an event forwards', async () => {
    const { deps, rows } = harness({}, T0);
    const batch = await batcherFor(T0 + HOUR, [{ type: 'TAB_HIDDEN' }]);
    await ingestTelemetry(post(batch), deps);
    expect(rows[0]?.clientTs).toBe(T0 + 5 * MINUTE);
  });

  it('and an instant already inside the window is left alone', async () => {
    const { deps, rows } = harness({}, T0);
    const batch = await batcherFor(T0 + 2 * MINUTE, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post(batch), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.clamped).toBe(0);
    expect(rows[0]?.clientTs).toBe(T0 + 2 * MINUTE);
    expect(rows[0]?.clampedByMs).toBe(0);
  });

  it('an event arriving hours after the attempt ended is refused, because a signature is not a licence to submit late', async () => {
    const { deps, rows } = harness({ endedAt: T0 - 3 * HOUR }, T0);
    const body = await batchOf(T0 - 3 * HOUR, [{ type: 'TAB_HIDDEN' }]);
    const result = await ingestTelemetry(post(body), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.rejected).toEqual([{ clientSeq: 0, reason: 'LATE_ARRIVAL' }]);
    expect(rows).toHaveLength(0);
  });

  it('and one arriving inside the two-hour window is kept', async () => {
    const { deps, rows } = harness({ endedAt: T0 - 30 * MINUTE }, T0);
    await ingestTelemetry(post(await batchOf(T0, [{ type: 'TAB_HIDDEN' }])), deps);
    expect(rows).toHaveLength(1);
  });
});

describe('SEVERITY AND STRIKES COME FROM THE SERVER, AND ACCOMMODATIONS WIN  (`INV-ACC-1`)', () => {
  it('THE PROPERTY: a fullscreen exit under `DISABLE_FULLSCREEN` is stored at INFO and moves no counter', async () => {
    // `accommodations.ts:9-18` states the distinction that makes this correct: ZERO VIOLATION EVENTS, and the event still
    // RECORDED. Dropping it would make an accommodation-holder's timeline indistinguishable from an unused feature.
    const { deps, rows } = harness({ relaxations: ['DISABLE_FULLSCREEN'] });
    const body = await batchOf(T0, [{ type: 'FULLSCREEN_EXITED' }]);
    const result = await ingestTelemetry(post(body), deps);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.countsAsStrike).toBe(0);
    expect(rows[0]?.severity).toBe('INFO');
    expect(rows[0]?.countsAsStrike).toBe(false);
    expect(rows[0]?.accommodationRelaxed).toBe(true);
  });

  it('and the same event without the relaxation is a VIOLATION that counts', async () => {
    const { deps, rows } = harness();
    const result = await ingestTelemetry(
      post(await batchOf(T0, [{ type: 'FULLSCREEN_EXITED' }])),
      deps,
    );
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.countsAsStrike).toBe(1);
    expect(rows[0]?.severity).toBe('VIOLATION');
    expect(rows[0]?.accommodationRelaxed).toBe(false);
  });

  it("THE PROPERTY: the severity is the TABLE's and the STRIKE is the POLICY's, so a client cannot choose either", async () => {
    // A fullscreen exit is filed at VIOLATION by `plans/09` §7.1 whatever the policy says; whether it COUNTS is the
    // policy's question. Getting those two the wrong way round is `ADV-A1`, which is why `routeEvidence` is the only
    // function called here and neither rule is restated.
    const { deps, rows } = harness({
      policy: {
        requireFullscreen: 'OFF',
        requirePointerLock: 'OFF',
        multiTabPolicy: 'WARN',
        blockCopyPaste: false,
        blockPrintSave: false,
      },
    });
    const result = await ingestTelemetry(
      post(await batchOf(T0, [{ type: 'FULLSCREEN_EXITED' }])),
      deps,
    );
    if (!result.body.ok) throw new Error('expected a 200');
    expect(rows[0]?.severity).toBe('VIOLATION');
    expect(rows[0]?.countsAsStrike).toBe(false);
    expect(result.body.countsAsStrike).toBe(0);
  });

  it('and a second tab is still counted for an accommodation-holder, because no relaxation silences it', async () => {
    const { deps, rows } = harness({ relaxations: ['DISABLE_TAB_WATCHDOG', 'ALLOW_COPY'] });
    const result = await ingestTelemetry(
      post(await batchOf(T0, [{ type: 'MULTI_TAB_DETECTED' }])),
      deps,
    );
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.countsAsStrike).toBe(1);
    expect(rows[0]?.severity).toBe('VIOLATION');
  });
});

describe('`seq` IS ALLOCATED ONCE, BY THE SERVER, AND ONLY FOR ROWS THAT SURVIVED', () => {
  it('THE PROPERTY: a wholly rejected batch reserves no sequence at all', async () => {
    const { deps, reserves } = harness();
    const batch = await batcherFor(T0, [{ type: 'TAB_HIDDEN' }]);
    const hostile = resign({
      ...batch,
      events: [{ seq: 0, type: 'VIOLATION_THRESHOLD_REACHED', at: T0 }],
    });
    await ingestTelemetry(post(hostile), deps);
    // A reservation for a batch that stored nothing is a gap in the stored sequence for a teacher to find.
    expect(reserves).toEqual([]);
  });

  it('and the count reserved is the count accepted, not the count presented', async () => {
    const { deps, reserves, rows } = harness();
    // THREE real events, so `toSeq` is 2 and the replacement's range agrees. An earlier version built two and replaced
    // three, which failed `RANGE_MISMATCH` before reaching the reservation — a corpus that cannot express the case it
    // exists for, which is the failure `P8-T9` records about a test asserting on the wrong scope.
    const batch = await batcherFor(T0, [
      { type: 'TAB_HIDDEN' },
      { type: 'TAB_VISIBLE' },
      { type: 'EXAM_STARTED' },
    ]);
    const mixed = resign({
      ...batch,
      events: [
        { seq: 0, type: 'NOPE', at: T0 },
        { seq: 1, type: 'TAB_VISIBLE', at: T0 },
        { seq: 2, type: 'TAB_HIDDEN', at: T0 },
      ],
    });
    await ingestTelemetry(post(mixed), deps);
    expect(reserves).toEqual([{ attemptId: ATTEMPT, sessionId: SESSION, count: 2 }]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });
});

describe('THE EMPTY BATCH, which is what a `pagehide` on a quiet tab actually sends', () => {
  it('is accepted, stores nothing, and touches no sequence', async () => {
    const { deps, rows, reserves } = harness();
    // The signed material is reproduced by hand rather than by the batcher, because `takeBatch()` on an empty queue
    // returns an empty array and `flushOnce()` never signs it. `plans/09` §7 says a `pagehide` on a quiet tab posts
    // exactly this, so the empty case is a real request rather than a degenerate one.
    const empty = {
      attemptId: ATTEMPT,
      tabId: 'tab-1',
      fromSeq: 0,
      toSeq: 0,
      events: [],
      signature: hmac(
        ['orrery.evidence.v1', JSON.stringify(ATTEMPT), JSON.stringify('tab-1'), '0', '0', ''].join(
          '\u0000',
        ),
      ),
    };
    const result = await ingestTelemetry(post(empty), deps);
    expect(result.status).toBe(200);
    if (!result.body.ok) throw new Error('expected a 200');
    expect(result.body.accepted).toBe(0);
    expect(rows).toHaveLength(0);
    expect(reserves).toEqual([]);
  });
});
