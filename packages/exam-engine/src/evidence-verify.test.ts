/**
 * VERIFYING THE EVIDENCE SIGNATURE — the half of `TM-17` that did not exist.  (P14-T17)
 *
 * ## WHAT WAS TRUE BEFORE THIS FILE
 *
 * `evidence.ts` computed a signature (`signBatch`), transmitted it (`BatchTransport` takes the whole `SignedBatch` since
 * `ADV-E4`), and **nothing in the repository verified one**. The only verifier was three lines inside
 * `adversarial/forged-events.test.ts:57-63` — a test file, which is the right place to prove a property and the wrong
 * place to leave a guarantee, for the reason `D-35` exists: a guarantee that lives only in a test is one refactor from
 * being deleted along with the test.
 *
 * And two comments described the opposite of the code:
 *
 *  · `evidence.ts` claimed *"the HMAC was computed, tested, and never left the batcher"* — fixed by `ADV-E4` years ago.
 *  · `forged-events.test.ts` claimed *"`flushOnce` … passes the transport every field EXCEPT the signature; `flushOnUnload`
 *    does not sign at all"* — also fixed, and `forged-events.test.ts:420` itself now asserts the signature IS present.
 *
 * **A comment that describes a bug that was fixed is how the bug gets "re-fixed"**, so both were deleted and the property
 * is now a function somebody can call.
 *
 * ## AND THE MOST IMPORTANT THING IN THIS FILE IS WHAT IT DOES *NOT* DO
 *
 * **A valid signature proves the bytes were produced by somebody holding the key. It does not prove the evidence is
 * true.** A student can sign a perfectly valid batch of complete fabrications, because the key is theirs — that is the
 * design: the signature is there so the server can tell a client's *account* from a client's *invention*, and
 * `batchSigningInput`'s comment says exactly that. Nothing here, and nothing that could be added here, turns a signed lie
 * into an unsigned truth.
 *
 * That limit is asserted by a test rather than asserted in prose, because prose asserting a limit is how the limit gets
 * lost: see `a valid signature over entirely invented evidence verifies` below. It is the single most important test in
 * this file and it asserts something that *looks* wrong.
 *
 * ## WHY THE MAC IS INJECTED AND `node:crypto` IS NOT IMPORTED
 *
 * `evidence.ts` is imported by `apps/web` — the batcher runs in a browser — and a module-scope `import 'node:crypto'`
 * would break that bundle for a check only the server ever performs. So the verifier takes the signing function as an
 * argument, exactly as `EvidenceBatcher` takes its `sign` (`evidence.ts:481`) and exactly as
 * `packages/contracts/src/grading/receipt.ts`'s `verifyReceiptSignature` takes its `Mac`.
 *
 * **The constant-time comparison is copied from `receipt.ts`, not invented here**, and the reason is in that file's
 * header: a byte-by-byte `===` on a MAC returns at the first difference, so a forger improves a forgery one byte at a
 * time. Two implementations of the same comparison is two chances to write the `===` version by accident, so this one
 * points at the original.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  batchSigningInput,
  type EvidenceRecord,
  type EvidenceSignatureVerdict,
  type EvidenceType,
  type SignedBatch,
  verifyEvidenceBatch,
} from './evidence.js';

const T0 = 1_800_000_000_000;
const KEY = 'per-attempt-session-key';

const hmac = (input: string): string => createHmac('sha256', KEY).update(input).digest('hex');
const hmacWith =
  (key: string) =>
  (input: string): string =>
    createHmac('sha256', key).update(input).digest('hex');

const events = (...types: readonly EvidenceType[]): EvidenceRecord[] =>
  types.map((type, index) => ({ seq: index, type, at: T0 + index }));

/**
 * READ AN EVENT OUT OF A BATCH WITHOUT `!`.
 *
 * Every probe below edits a batch, which means indexing it, and `noNonNullAssertion` is on. The alternative — an
 * assertion helper that throws — reads better than eight `!`s and gives a real message when a fixture shrinks, so this is
 * that helper rather than a suppression.
 */
const at = (
  batch: { readonly events: readonly EvidenceRecord[] },
  index: number,
): EvidenceRecord => {
  const event = batch.events[index];
  if (event === undefined) throw new Error(`fixture has no event at ${String(index)}`);
  return event;
};

const signedBatch = (
  attemptId: string,
  tabId: string,
  batch: readonly EvidenceRecord[],
): SignedBatch => {
  const unsigned = {
    attemptId,
    tabId,
    fromSeq: batch[0]?.seq ?? 0,
    toSeq: batch[batch.length - 1]?.seq ?? 0,
    events: batch,
  };
  return { ...unsigned, signature: hmac(batchSigningInput(unsigned)) };
};

describe('a valid signature is accepted', () => {
  it('verifies a batch it just signed', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN', 'TAB_VISIBLE'));
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });

  it('verifies a batch whose events have a SEQ GAP, because a gap is a dropped event and not a forgery', () => {
    /**
     * **THIS TEST IS A BAN ON A PLAUSIBLE FUTURE RULE.** `EvidenceBatcher.record()` drops the OLDEST event when the queue
     * is full (`evidence.ts`, `if (this.#queue.length >= maxQueued)`), so a batch with `seq` 0, 2, 5 is the NORMAL shape
     * of a batch from a struggling connection, and `droppedEventCount` is computed from exactly those holes. A verifier
     * that required `seq` to be contiguous would refuse every batch that reported its own loss correctly — and the
     * students whose telemetry is worth having are the ones on those connections.
     */
    const gapped: EvidenceRecord[] = [
      { seq: 0, type: 'TAB_HIDDEN', at: T0 },
      { seq: 2, type: 'TAB_VISIBLE', at: T0 + 2 },
      { seq: 5, type: 'WINDOW_FOCUSED', at: T0 + 5 },
    ];
    const batch = signedBatch('attempt-1', 'tab-1', gapped);
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });

  it('verifies an EMPTY batch, which is what a transport that flushed nothing produces', () => {
    const batch = signedBatch('attempt-1', 'tab-1', []);
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });
});

describe('a forged or tampered batch is refused, and the verdict says why', () => {
  /**
   * `expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: false, reason: 'SIGNATURE_MISMATCH' })` on every case below.
   *
   * **The reason is asserted on every one rather than only `ok: false`,** because a boolean cannot tell a reader whether
   * a batch was refused for a missing key or for a bad signature, and "does not match" is the answer that sends a
   * teacher through a whole paper — the same objection `SignatureVerdict` in `packages/contracts/src/grading/receipt.ts`
   * was introduced to answer. A verdict that collapses every failure to one reason is a verdict nobody can act on.
   */
  const refused = (
    batch: SignedBatch,
    reason: EvidenceSignatureVerdict extends { ok: false; reason: infer R } ? R : never,
  ) => {
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: false, reason });
  };

  it('refuses a batch whose EVENTS were edited — the forgery `RN-01` is about', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN', 'TAB_VISIBLE'));
    refused(
      { ...batch, events: [{ ...at(batch, 0), type: 'TAB_VISIBLE' }, at(batch, 1)] },
      'SIGNATURE_MISMATCH',
    );
  });

  it('refuses a batch that was REPLAYED onto another attempt', () => {
    // `attemptId` is inside the signed material precisely so a valid signature cannot be moved between sittings.
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    refused({ ...batch, attemptId: 'attempt-2' }, 'SIGNATURE_MISMATCH');
  });

  it('refuses a batch replayed onto another tab', () => {
    // The tab id is CLIENT-chosen, so this is the replay an attacker can actually perform.
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    refused({ ...batch, tabId: 'tab-2' }, 'SIGNATURE_MISMATCH');
  });

  it('refuses a batch whose EVENTS were TRIMMED — the one that removes evidence', () => {
    const batch = signedBatch(
      'attempt-1',
      'tab-1',
      events('TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_FOCUSED'),
    );
    /**
     * `RANGE_MISMATCH`, NOT `SIGNATURE_MISMATCH`, and the distinction is the point rather than an accident.
     *
     * **This test asserted `SIGNATURE_MISMATCH` and failed**, which is worth recording because the failure was the
     * verifier being better than the test: dropping the middle event leaves the stated `fromSeq`/`toSeq` describing a
     * range the batch no longer covers, so the range check fires first and names the actual fault. Reporting it as a
     * forgery would have sent whoever is on call looking for a client attack at a transport that is merely miscounting.
     *
     * The next test pins that the SIGNATURE still catches a trim whose range was made consistent — otherwise the two
     * checks could be one check wearing two names.
     */
    refused({ ...batch, events: batch.events.slice(1) }, 'RANGE_MISMATCH');
  });

  it('refuses a trim even when the RANGE was updated to match, because the body is signed too', () => {
    const batch = signedBatch(
      'attempt-1',
      'tab-1',
      events('TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_FOCUSED'),
    );
    const trimmed = batch.events.slice(1);
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === undefined || last === undefined) throw new Error('trimmed fixture is empty');
    refused(
      { ...batch, fromSeq: first.seq, toSeq: last.seq, events: trimmed },
      'SIGNATURE_MISMATCH',
    );
  });

  it('refuses a batch whose events were REORDERED', () => {
    // Reversing a three-event batch puts a different `seq` first, so the range no longer describes the events.
    const batch = signedBatch(
      'attempt-1',
      'tab-1',
      events('TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_FOCUSED'),
    );
    refused({ ...batch, events: [...batch.events].reverse() }, 'RANGE_MISMATCH');
  });

  it('refuses a MIDDLE reorder whose range still matches, because the canonical body is order-sensitive', () => {
    // The case above is caught by the range check alone, so without this one "the signature catches reordering" would be
    // an unproven claim: `seq` 0,2,1,3 keeps `fromSeq` 0 and `toSeq` 3 and differs only in the signed body.
    const original = events('TAB_HIDDEN', 'TAB_VISIBLE', 'WINDOW_FOCUSED', 'ATTEMPT_SUBMITTED').map(
      (event, index) => ({ ...event, seq: [0, 2, 1, 3][index] ?? index, at: T0 + index }),
    );
    const batch = signedBatch('attempt-1', 'tab-1', original);
    const [first, second, third, fourth] = original;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error('fixture is short');
    }
    const swapped = [first, third, second, fourth];
    expect(batch.fromSeq).toBe(first.seq);
    expect(batch.toSeq).toBe(fourth.seq);
    refused({ ...batch, events: swapped }, 'SIGNATURE_MISMATCH');
  });

  it('refuses a batch EXTENDED with an event the signer never saw', () => {
    // The range is inside the signed material, so an appended event moves `toSeq` as well as the body.
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    refused(
      {
        ...batch,
        toSeq: 1,
        events: [...batch.events, { seq: 1, type: 'VIOLATION_THRESHOLD_REACHED', at: T0 + 1 }],
      },
      'SIGNATURE_MISMATCH',
    );
  });

  it('refuses a batch whose `detail` was edited — the case a name-based scan would miss', () => {
    const batch = signedBatch('attempt-1', 'tab-1', [
      { seq: 0, type: 'POINTERLOCK_LOST', at: T0, detail: { escapePossiblyInvolved: null } },
    ]);
    refused(
      { ...batch, events: [{ ...at(batch, 0), detail: { escapePossiblyInvolved: false } }] },
      'SIGNATURE_MISMATCH',
    );
  });

  it('refuses a batch signed with A DIFFERENT KEY', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    expect(verifyEvidenceBatch(batch, hmacWith(`${KEY}-other`))).toEqual({
      ok: false,
      reason: 'SIGNATURE_MISMATCH',
    });
  });

  it('refuses a batch whose SIGNATURE was replaced with a valid-looking hex string', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    refused({ ...batch, signature: 'f'.repeat(64) }, 'SIGNATURE_MISMATCH');
  });
});

describe('a verifier that cannot check is a refusal, not a pass', () => {
  /**
   * `receipt.ts` calls this out and it is the single most important behaviour in the file: `ok: true` from a verifier
   * holding no key would be a deployment believing in an authenticity check it never performed. Both of these cases assert
   * `ok: false`.
   */
  it('refuses when there is NO KEY, rather than reporting no problems', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    expect(verifyEvidenceBatch(batch, null)).toEqual({ ok: false, reason: 'NO_KEY' });
  });

  it('refuses an UNSIGNED batch rather than reporting no problems', () => {
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    expect(verifyEvidenceBatch({ ...batch, signature: '' }, hmac)).toEqual({
      ok: false,
      reason: 'NOT_SIGNED',
    });
  });

  it('refuses a MALFORMED signature, and distinguishes it from a mismatch', () => {
    // `'not hex'` and `'abc'` are both wrong, and they are wrong in different ways: one is not a digest at all and the
    // other is too short to be one. Collapsing them into `SIGNATURE_MISMATCH` would send an operator to look for a key
    // problem when the transport is sending garbage.
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN'));
    expect(verifyEvidenceBatch({ ...batch, signature: 'not hex' }, hmac)).toEqual({
      ok: false,
      reason: 'MALFORMED_SIGNATURE',
    });
    expect(verifyEvidenceBatch({ ...batch, signature: 'abc' }, hmac)).toEqual({
      ok: false,
      reason: 'MALFORMED_SIGNATURE',
    });
  });

  it('refuses a batch whose SEQUENCE RANGE contradicts its events', () => {
    /**
     * A claim the signature does not cover, and it is here because `fromSeq`/`toSeq` are the two fields a reader trusts
     * when reconstructing a timeline. They are inside the signed material, so a contradiction is either a broken transport
     * or an attempt to describe a batch as covering a range it does not — and neither should reach `report-integrity.ts`
     * as a fact.
     */
    const batch = signedBatch('attempt-1', 'tab-1', events('TAB_HIDDEN', 'TAB_VISIBLE'));
    // Stated range 7..99 over events whose real range is 0..1. The signer IGNORES the stated range — `batchSigningInput`
    // re-derives it from the events — so the signature below is over the TRUE range and is perfectly valid. The
    // contradiction is therefore the only thing wrong with this batch, which is what makes it a clean probe.
    const contradicted = { ...batch, fromSeq: 7, toSeq: 99 };
    const signOverTheTrueRange = () => hmac(batchSigningInput(batch));
    expect(verifyEvidenceBatch(contradicted, signOverTheTrueRange)).toEqual({
      ok: false,
      reason: 'RANGE_MISMATCH',
    });
  });
});

describe('THE LIMIT, ASSERTED: a valid signature proves ISSUANCE, not TRUTH', () => {
  it('accepts a valid signature over entirely INVENTED evidence', () => {
    /**
     * **THIS TEST LOOKS WRONG AND IS THE POINT.**
     *
     * Every event below is a fabrication — a student claiming they never left fullscreen when they did — and the signature
     * over it is genuine, because the key belongs to the student. The verdict is `ok: true` and it has to be: the key
     * exists so the server can tell a client's ACCOUNT from a client's INVENTION, and a verifier that returned `ok: false`
     * for this would be claiming to detect dishonesty, which is the false-positive claim `plans/09` refuses to make in
     * prose and which `non-accusation.test.ts` exists to hold the rest of the system to.
     *
     * **What this test protects is the sentence in the file header.** A future change that adds a plausibility check to
     * `verifyEvidenceBatch` — "a student cannot really have zero tab hides" — would make this go red, and the red would be
     * the correct outcome: a false-positive rate reported as accuracy.
     */
    const invented: EvidenceRecord[] = [
      { seq: 0, type: 'EXAM_STARTED', at: T0 },
      { seq: 1, type: 'FULLSCREEN_ENTERED', at: T0 + 1 },
      { seq: 2, type: 'POINTERLOCK_ENTERED', at: T0 + 2, detail: { outcome: 'granted' } },
      { seq: 3, type: 'ATTEMPT_SUBMITTED', at: T0 + 3 },
    ];
    const batch = signedBatch('attempt-1', 'tab-1', invented);
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });

  it("accepts an event type that is not in the rules table, because the schema is the ingestion route's job", () => {
    /**
     * `forged-events.test.ts` pins that the batcher queues an event type the table has never heard of, and records that
     * `plans/09` §7 puts the closed-schema check on the SERVER. Verification is not that check and must not become it: a
     * verifier that also validated the event vocabulary would report `SIGNATURE_MISMATCH` for what is a schema error, and
     * the two need different responses from whoever is on call.
     *
     * A signature over an invented TYPE is still a signature over those bytes. Whether the type is legal is decided at
     * ingestion, and it is a separate refusal with a separate reason.
     */
    const batch = signedBatch('attempt-1', 'tab-1', [
      { seq: 0, type: 'INVENTED_BY_THE_CLIENT' as EvidenceType, at: T0 },
    ]);
    expect(verifyEvidenceBatch(batch, hmac)).toEqual({ ok: true });
  });
});
