import { describe, expect, it } from 'vitest';

import {
  type Acknowledgement,
  assess,
  countOutcomes,
  errorRate,
  verifyAcknowledgedSaves,
  verifyNoPartialRelease,
} from './correctness.js';

const ack = (over: Partial<Acknowledgement> = {}): Acknowledgement => ({
  attemptId: 'at1',
  questionId: 'q1',
  idempotencyKey: 'k1',
  outcome: 'saved',
  acknowledgedRevision: 1,
  status: 200,
  ...over,
});

const row = (
  over: Partial<{
    attemptId: string;
    questionId: string;
    idempotencyKey: string;
    revision: number;
    answerBytes: string;
  }> = {},
) => ({
  attemptId: 'at1',
  questionId: 'q1',
  idempotencyKey: 'k1',
  revision: 1,
  answerBytes: '{"a":1}',
  ...over,
});

describe('a save the server acknowledged MUST have a row behind it', () => {
  it('passes when the row is there with the acknowledged revision', () => {
    expect(verifyAcknowledgedSaves([ack()], [row()])).toEqual([]);
  });

  /**
   * THE CASE A RESPONSE-ROW CHECK WOULD MISS, and the reason this module exists.
   *
   * `submitAnswer` upserts `questionResponse`, so the row there is last-write-wins. An acknowledged revision that was
   * later overwritten leaves the response row holding the NEWER answer and nothing wrong with it -- and the student was
   * told the older one was saved. Checking the response row passes a run that lost the answer.
   */
  it('names a save whose row is missing ENTIRELY, with both sides', () => {
    const lost = verifyAcknowledgedSaves([ack()], []);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.why).toMatch(/no revision row exists/);
    expect(lost[0]?.stored).toBeNull();
    // Named, not counted: the first question anyone asks is which question and which revision.
    expect(lost[0]?.idempotencyKey).toBe('k1');
    expect(lost[0]?.acknowledgedRevision).toBe(1);
  });

  it('names a row that exists under a DIFFERENT key -- a chain re-written under it', () => {
    const lost = verifyAcknowledgedSaves(
      [ack({ idempotencyKey: 'k1' })],
      [row({ idempotencyKey: 'other' })],
    );
    expect(lost[0]?.why).toMatch(/no revision row carries the idempotency key/);
    // ...and it shows what IS there, because the evidence is what makes the report checkable.
    expect(lost[0]?.stored).toHaveLength(1);
  });

  /**
   * THE ROW EXISTS WITH THE WRONG REVISION, which is the more interesting failure.
   *
   * `plans/01` §9.4 folds revisions IN ORDER into the submission receipt, so a gap or an overwrite here produces a
   * receipt that will not verify -- and `verify-receipt` reports the divergence weeks later with nobody able to say
   * which write caused it.
   */
  it('names a row whose revision is not the acknowledged one', () => {
    const lost = verifyAcknowledgedSaves(
      [ack({ acknowledgedRevision: 4 })],
      [row({ revision: 2 })],
    );
    expect(lost).toHaveLength(1);
    expect(lost[0]?.why).toMatch(/revision 2, not the 4 acknowledged/);
  });

  it('matches on the KEY and not the question alone, so concurrent questions do not cross', () => {
    const acks = [
      ack({ questionId: 'q1', idempotencyKey: 'a1', acknowledgedRevision: 1 }),
      ack({ questionId: 'q2', idempotencyKey: 'a2', acknowledgedRevision: 1 }),
    ];
    const rows = [
      row({ questionId: 'q1', idempotencyKey: 'a1', revision: 1 }),
      row({ questionId: 'q2', idempotencyKey: 'a2', revision: 1 }),
    ];
    expect(verifyAcknowledgedSaves(acks, rows)).toEqual([]);
  });

  /**
   * A `replayed` APPENDS NOTHING, BY DESIGN, and requiring a row for one would fail every legitimate retry.
   *
   * `C18` made recomputing a replay's body desynchronise the client, and the idempotency ledger exists so a retry
   * after a dropped connection returns the original stored bytes. So the exclusion is a design decision and it is
   * stated rather than left to be discovered as a mysterious failure.
   */
  it('does NOT require a row for a replay, a refusal, or a throw', () => {
    const acks = [
      ack({ outcome: 'replayed', acknowledgedRevision: null, idempotencyKey: 'r1' }),
      ack({ outcome: 'rejected', acknowledgedRevision: null, idempotencyKey: 'j1' }),
      ack({ outcome: 'threw', acknowledgedRevision: null, status: 0, idempotencyKey: 't1' }),
    ];
    expect(verifyAcknowledgedSaves(acks, [])).toEqual([]);
  });

  it('reports EVERY lost save rather than stopping at the first', () => {
    const acks = [
      ack({ questionId: 'q1', idempotencyKey: 'a1' }),
      ack({ questionId: 'q2', idempotencyKey: 'a2' }),
    ];
    expect(
      verifyAcknowledgedSaves(acks, [row({ questionId: 'q1', idempotencyKey: 'a1' })]),
    ).toHaveLength(1);
    expect(verifyAcknowledgedSaves(acks, [])).toHaveLength(2);
  });
});

describe('a released batch is released WHOLE, or it is not released', () => {
  /**
   * `B16`: visibility is `EXISTS(... status='RELEASED')`, so per-row writes are precisely how a batch goes half-visible
   * -- half a class sees marks, half cannot, and nobody is told. `releaseBatch` prevents it with one `updateMany`
   * inside one transaction, and this is the assertion that the prevention worked.
   */
  it('flags a batch where SOME members are released', () => {
    const partial = verifyNoPartialRelease([{ batchId: 'b1', total: 200, released: 137 }]);
    expect(partial).toEqual([{ batchId: 'b1', released: 137, total: 200 }]);
  });

  it('passes a whole batch, including a single-member one', () => {
    expect(verifyNoPartialRelease([{ batchId: 'b1', total: 200, released: 200 }])).toEqual([]);
    expect(verifyNoPartialRelease([{ batchId: 'b1', total: 1, released: 1 }])).toEqual([]);
  });

  /**
   * A BATCH WITH NOTHING RELEASED IS NOT A *PARTIALLY* RELEASED ONE, and my first predicate flagged every one of them.
   *
   * `released !== total` says a `DRAFT` batch is partial, which is true of most batches at any moment. An assertion
   * that reports the normal state as a failure is one nobody reads, and the first real `B16` partial release would be
   * buried under hundreds of false ones.
   */
  it('does NOT flag a batch with NOTHING released — that is a batch nobody has released', () => {
    expect(verifyNoPartialRelease([{ batchId: 'b1', total: 200, released: 0 }])).toEqual([]);
  });

  it('does NOT flag an EMPTY batch, because nothing is half-visible about nothing', () => {
    // A division or a percentage here would report `NaN` or `Infinity`, and a report containing either is a report
    // nobody trusts.
    expect(verifyNoPartialRelease([{ batchId: 'b1', total: 0, released: 0 }])).toEqual([]);
  });
});

describe('the 5xx RATE counts a thrown transport', () => {
  it('is zero for a clean run', () => {
    expect(errorRate([ack(), ack()])).toBe(0);
  });

  /**
   * A DRIVER THAT CATCHES AN EXCEPTION AND RECORDS NO STATUS WOULD REPORT A CLEAN RATE FOR A RUN IN WHICH EVERY WRITE
   * THREW. The promise a client can act on is "the save either landed or was refused", and a thrown transport breaks
   * it regardless of what the driver felt about it.
   */
  it('counts a thrown transport as a failure, not as "not applicable"', () => {
    expect(errorRate([ack(), ack({ outcome: 'threw', status: 0 })])).toBe(0.5);
    expect(errorRate([ack(), ack({ status: 503 })])).toBe(0.5);
  });

  it('counts a 4xx as NOT a 5xx -- a refusal is a functioning product', () => {
    expect(errorRate([ack(), ack({ outcome: 'rejected', status: 422 })])).toBe(0);
  });

  it('is 0 for an empty run rather than NaN', () => {
    expect(errorRate([])).toBe(0);
  });

  it('counts every outcome kind', () => {
    const counts = countOutcomes([
      ack(),
      ack({ outcome: 'replayed' }),
      ack({ outcome: 'rejected' }),
      ack({ outcome: 'threw' }),
    ]);
    expect(counts).toEqual({ saved: 1, replayed: 1, rejected: 1, threw: 1 });
  });
});

describe('one call produces the whole report, so a caller cannot assert a different set', () => {
  it('is consistent with the parts', () => {
    const report = assess({
      acks: [ack(), ack({ outcome: 'threw', status: 0, idempotencyKey: 't' })],
      stored: [],
      batches: [{ batchId: 'b1', total: 10, released: 4 }],
      attempts: 2,
    });
    expect(report.lostAcknowledgedSaves).toHaveLength(1);
    expect(report.partiallyReleased).toHaveLength(1);
    expect(report.errorRate5xx).toBe(0.5);
    expect(report.outcomes.saved).toBe(1);
    expect(report.attempts).toBe(2);
    expect(report.totalSaves).toBe(2);
  });

  it('is clean for a healthy run', () => {
    const report = assess({
      acks: [ack()],
      stored: [row()],
      batches: [{ batchId: 'b1', total: 1, released: 1 }],
      attempts: 1,
    });
    expect(report.lostAcknowledgedSaves).toEqual([]);
    expect(report.partiallyReleased).toEqual([]);
    expect(report.errorRate5xx).toBe(0);
  });
});
