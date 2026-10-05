/**
 * THE CORRECTNESS HALF OF THE LOAD LEG, AND IT IS PURE SO IT CAN BE TESTED WITHOUT A DATABASE.  (P8-T16)
 *
 * `plans/18` §11: *"Latency without correctness assertions is how teams ship a load test that passes while the product
 * loses student answers."* These are the assertions. They take the **promises the system made** and the **rows that
 * exist afterwards**, and they are the only thing in this package that can fail a run.
 *
 * ## WHY THE UNIT OF COMPARISON IS A PROMISE AND NOT A RESPONSE
 *
 * A load driver records what the server *said*: `saved`, revision 4. The database holds `AnswerRevision` rows. The
 * question is whether every promise has a row behind it, with the revision it was acknowledged with.
 *
 * **NOT THE RESPONSE ROW.** `submitAnswer` upserts `questionResponse`, so it is last-write-wins: a revision that was
 * acknowledged and then overwritten is **invisible there** while the student was told it was saved. Checking the
 * response row would pass a run that lost the answer, which is the exact failure `plans/18` §11 names.
 *
 * ## AND EVERY DISCREPANCY IS NAMED, WITH BOTH SIDES
 *
 * A count of `4` is a number a reader has to trust. `lostAcknowledgedSaves: [{questionId, seq, revision}]` is a claim
 * they can check, and it is the difference between a load report that helps and one that is merely green. The reason a
 * save goes missing is almost always about *which* question and *which* revision, and the first question anyone asks
 * is exactly that.
 */

/** What the driver was told. One per attempted save. */
export interface Acknowledgement {
  readonly attemptId: string;
  readonly questionId: string;
  /** The `idempotencyKey` sent, so a discrepancy names the exact request. */
  readonly idempotencyKey: string;
  /** `null` when the write was refused or threw. */
  readonly outcome: 'saved' | 'replayed' | 'rejected' | 'threw';
  /** The revision the server said this write became. `null` unless `saved`. */
  readonly acknowledgedRevision: number | null;
  /** The HTTP-ish status, or 0 for a thrown transport. Feeds the 5xx rate. */
  readonly status: number;
}

export interface StoredRevision {
  readonly attemptId: string;
  /** Absent when the revision's response was erased, so it has no question and cannot match a promise. */
  readonly questionId?: string;
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly answerBytes: string;
}

/** One promise that has no row behind it. Both sides, so the report is checkable rather than merely counted. */
export interface LostSave {
  readonly attemptId: string;
  readonly questionId: string;
  readonly idempotencyKey: string;
  readonly acknowledgedRevision: number;
  /** What the database actually holds for that question, or `null` when it holds nothing. */
  readonly stored: readonly StoredRevision[] | null;
  readonly why: string;
}

export interface CorrectnessReport {
  readonly lostAcknowledgedSaves: readonly LostSave[];
  readonly partiallyReleased: readonly {
    readonly batchId: string;
    readonly released: number;
    readonly total: number;
  }[];
  readonly outcomes: Readonly<Record<Acknowledgement['outcome'], number>>;
  readonly errorRate5xx: number;
  readonly attempts: number;
  readonly totalSaves: number;
}

/**
 * EVERY ACKNOWLEDGED SAVE MUST HAVE A ROW, WITH THE REVISION IT WAS ACKNOWLEDGED WITH.
 *
 * `replayed` is deliberately NOT a promise about a NEW row: a replay returns the ORIGINAL stored bytes and appends
 * nothing, by design, so requiring a row for one would fail every legitimate retry. It is counted and excluded, and
 * that exclusion is stated here because "we ignored some acknowledgements" is exactly the kind of thing that should be
 * argued with rather than discovered.
 */
export const verifyAcknowledgedSaves = (
  acks: readonly Acknowledgement[],
  stored: readonly StoredRevision[],
): readonly LostSave[] => {
  const byQuestion = new Map<string, StoredRevision[]>();
  for (const row of stored) {
    if (row.questionId === undefined) continue;
    const key = `${row.attemptId}|${row.questionId}`;
    const list = byQuestion.get(key);
    if (list === undefined) byQuestion.set(key, [row]);
    else list.push(row);
  }

  const lost: LostSave[] = [];
  for (const ack of acks) {
    // Only `saved` is a promise that a new durable row exists. `replayed` appends nothing BY DESIGN, `rejected` is a
    // refusal the client was told about, and `threw` never reached an answer.
    if (ack.outcome !== 'saved') continue;
    const rows = byQuestion.get(`${ack.attemptId}|${ack.questionId}`) ?? null;
    if (rows === null) {
      lost.push({
        attemptId: ack.attemptId,
        questionId: ack.questionId,
        idempotencyKey: ack.idempotencyKey,
        acknowledgedRevision: ack.acknowledgedRevision ?? -1,
        stored: null,
        why: 'the server acknowledged the save and no revision row exists for that question at all',
      });
      continue;
    }
    const match = rows.find((row) => row.idempotencyKey === ack.idempotencyKey);
    if (match === undefined) {
      lost.push({
        attemptId: ack.attemptId,
        questionId: ack.questionId,
        idempotencyKey: ack.idempotencyKey,
        acknowledgedRevision: ack.acknowledgedRevision ?? -1,
        stored: rows,
        why: 'no revision row carries the idempotency key that was acknowledged',
      });
      continue;
    }
    if (match.revision !== ack.acknowledgedRevision) {
      /**
       * THE ROW EXISTS WITH THE WRONG REVISION, and this is the more interesting of the two failures.
       *
       * A key with the wrong revision means something re-wrote that question's chain -- and `plans/01` §9.4 folds
       * revisions IN ORDER into the submission receipt, so a gap or an overwrite here is a receipt that will not verify.
       * The student was told revision N and the chain says M, and `verify-receipt` is the tool that will report the
       * divergence weeks later with nobody able to say which write caused it.
       */
      lost.push({
        attemptId: ack.attemptId,
        questionId: ack.questionId,
        idempotencyKey: ack.idempotencyKey,
        acknowledgedRevision: ack.acknowledgedRevision ?? -1,
        stored: rows,
        why: `the row carries revision ${String(match.revision)}, not the ${String(ack.acknowledgedRevision)} acknowledged`,
      });
    }
  }
  return lost;
};

/**
 * NO PARTIAL RELEASE. Every member of a released batch is `RELEASED`.
 *
 * `B16` is why this exists: visibility is `EXISTS(... status='RELEASED')`, so per-row writes are exactly how a batch
 * goes half-visible -- half a class can see marks and half cannot, and nobody is told. `releaseBatch` prevents it with
 * a single `updateMany` inside one transaction, and this is the assertion that says the prevention worked.
 */
export const verifyNoPartialRelease = (
  batches: readonly {
    readonly batchId: string;
    readonly total: number;
    readonly released: number;
  }[],
): readonly { batchId: string; released: number; total: number }[] =>
  batches
    /**
     * **A BATCH WITH NOTHING RELEASED IS NOT A *PARTIALLY* RELEASED ONE, AND MY FIRST PREDICATE SAID IT WAS.**
     *
     * `released !== total` flags a `DRAFT` batch with zero released members — that is **every unreleased batch in the
     * platform**, which at any moment is most of them. An assertion that reports the normal state as a failure is one
     * nobody reads, and the first real `B16` partial release would arrive buried under hundreds of false ones.
     *
     * The distinction IS the assertion: a partial release is a batch where SOME members are visible to students and
     * some are not. Zero visible is a batch nobody has released yet, which is a different fact and a correct one.
     */
    .filter((batch) => batch.total > 0 && batch.released > 0 && batch.released < batch.total)
    .map((batch) => ({
      batchId: batch.batchId,
      released: batch.released,
      total: batch.total,
    }));

/**
 * THE 5xx RATE, and a THROWN TRANSPORT COUNTS AS 5xx RATHER THAN AS "not applicable".
 *
 * A driver that catches an exception and records no status would report a clean rate for a run in which every write
 * threw. The promise a client can act on is "the save either landed or was refused", and a thrown transport is a
 * broken promise regardless of what the driver felt about it.
 */
export const errorRate = (acks: readonly Acknowledgement[]): number => {
  if (acks.length === 0) return 0;
  const failures = acks.filter((ack) => ack.outcome === 'threw' || ack.status >= 500).length;
  return failures / acks.length;
};

export const countOutcomes = (
  acks: readonly Acknowledgement[],
): Readonly<Record<Acknowledgement['outcome'], number>> => {
  const counts: Record<Acknowledgement['outcome'], number> = {
    saved: 0,
    replayed: 0,
    rejected: 0,
    threw: 0,
  };
  for (const ack of acks) counts[ack.outcome] += 1;
  return counts;
};

/** The whole correctness report in one call, so a caller cannot assert against a different set than the artefact's. */
export const assess = (input: {
  readonly acks: readonly Acknowledgement[];
  readonly stored: readonly StoredRevision[];
  readonly batches: readonly { batchId: string; total: number; released: number }[];
  readonly attempts: number;
}): CorrectnessReport => {
  const lost = verifyAcknowledgedSaves(input.acks, input.stored);
  const partial = verifyNoPartialRelease(input.batches);
  return {
    lostAcknowledgedSaves: lost,
    partiallyReleased: partial,
    outcomes: countOutcomes(input.acks),
    errorRate5xx: errorRate(input.acks),
    attempts: input.attempts,
    totalSaves: input.acks.length,
  };
};
