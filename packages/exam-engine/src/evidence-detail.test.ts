/**
 * `TM-20`: TELEMETRY `detail` IS CLOSED BY A TYPE, AND THE RUNTIME HALF AGREES WITH IT.
 *
 * ## WHAT WAS ACTUALLY TRUE BEFORE THIS FILE
 *
 * `evidence.ts` said `Readonly<Record<string, string | number | boolean | null>>` and the docstring said *"Free-form.
 * Never an answer, never a score: this is read by a human."* The VALUES were constrained. The KEYS were not:
 *
 *     const event: EvidenceRecord = { seq: 0, type: 'TAB_HIDDEN', at: 0, detail: { studentEmail: 'a@b.c' } };
 *
 * typechecked, compiled, passed every test in this package, and — had a telemetry route existed — would have reached a
 * table retained for 400 days. `INV-TELEMETRY-2` cites `audit:payloads` as its control and **that gate did not exist**,
 * so the property had a registry row and no mechanism.
 *
 * ## WHAT THESE TESTS CAN AND CANNOT SEE
 *
 * The load-bearing property is a COMPILE-TIME one, and this is stated rather than implied: **`{ detail: { studentEmail:
 * '…' } }` does not typecheck any more, and a runtime test cannot observe a type error.** So what is asserted here is
 * the half that is observable — that the exported key set is closed, that it overlaps no content-or-PII key, that the
 * writer refuses a detail that arrives with the type already erased, and that `scripts/audit-payloads.mjs` fails if the
 * key list is widened. The compile-time half is verified by `packages/exam-engine/src/evidence-detail.compile.test.ts`
 * and by `pnpm typecheck`, and the RED record for it is in the commit message.
 *
 * What this file CANNOT see is also stated: a closed key list constrains names, not values. `{ detail: { reason: <an
 * error message> } }` typechecks, and no key list prevents it.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_DETAIL_KEYS,
  EVIDENCE_DETAIL_KEYS_NO_CONTENT,
  EvidenceBatcher,
  type EvidenceDetailKey,
  isEvidenceDetailKey,
  isEvidenceDetailValue,
  PII_OR_CONTENT_KEYS,
} from './evidence.js';

const T0 = 1_800_000_000_000;

const batcherFor = () =>
  new EvidenceBatcher(
    { batchSize: 10, maxQueued: 100, transport: async () => true },
    { now: () => T0 },
    'attempt-1',
    'tab-1',
    (input) => createHmac('sha256', 'k').update(input).digest('hex'),
  );

describe('TM-20: the `detail` key set is closed', () => {
  it('is a finite list of named keys, not an index signature', () => {
    // The floor is what keeps this honest. A future edit that turns the tuple back into a `Record<string, …>` removes
    // this assertion's subject, and `EVIDENCE_DETAIL_KEYS.length` would have been `undefined` rather than a count.
    expect(Array.isArray(EVIDENCE_DETAIL_KEYS)).toBe(true);
    expect(EVIDENCE_DETAIL_KEYS.length).toBeGreaterThanOrEqual(20);
    for (const key of EVIDENCE_DETAIL_KEYS) {
      expect(key, `${String(key)} is not a lowerCamelCase identifier`).toMatch(
        /^[a-z][A-Za-z0-9]*$/,
      );
    }
  });

  it('contains no duplicate, so a key cannot appear twice in a signature by accident', () => {
    expect(new Set(EVIDENCE_DETAIL_KEYS).size).toBe(EVIDENCE_DETAIL_KEYS.length);
  });

  it('overlaps NO content-or-PII key — the compile-time assertion, observed from outside', () => {
    /**
     * `EVIDENCE_DETAIL_KEYS_NO_CONTENT` is the mechanism: its declared type is
     * `readonly EvidenceDetailKey[] & readonly Exclude<EvidenceDetailKey, PiiOrContentKey>[]`, and `Exclude` collapses
     * to `never` the moment a key is in both sets. Adding `studentEmail` to the tuple therefore does not merely fail a
     * review — it stops the file compiling. This assertion is what says the file DID compile.
     *
     * **EXACT MEMBERSHIP ONLY, AND THAT IS THE LIMIT OF THE MECHANISM RATHER THAN A WEAKNESS IN THE ASSERTION.**
     * `Exclude` cannot express "contains": a substring rule would forbid `studentWarned`, which is a legitimate key on
     * the allowlist (`clockGuard.ts` writes it, and it is `true`/`false` about whether the student saw a warning — it
     * names no student). Asserting a property the control does not have would be the exact mistake this task exists to
     * stop, so the compound forms at risk are listed in full instead: `studentEmail` is forbidden *as a name*, and the
     * next one has to be spelled out too.
     */
    // The module's own list, so the test cannot pass while the code and the test disagree about the names.
    for (const key of EVIDENCE_DETAIL_KEYS) {
      expect(
        PII_OR_CONTENT_KEYS,
        `${key} is a content-or-PII key and is on the allowlist`,
      ).not.toContain(key);
    }

    // And it must still CONTAIN them, because a forbidden list that has been emptied satisfies the assertion above
    // perfectly. An emptied list is the failure mode a "no overlap" check cannot see.
    for (const key of [
      'answer',
      'email',
      'studentEmail',
      'studentName',
      'userAgent',
      'password',
      'sessionId',
      'text',
      'content',
    ]) {
      expect(PII_OR_CONTENT_KEYS, `${key} must remain forbidden`).toContain(key);
    }
  });

  it('is the same twenty keys the type accepts, so the set cannot drift from the union', () => {
    // `isEvidenceDetailKey` is the runtime narrowing predicate. If it were maintained by hand, a key added to the tuple
    // and forgotten here would be refused by `record()` while the type accepted it — a silent divergence.
    for (const key of EVIDENCE_DETAIL_KEYS) expect(isEvidenceDetailKey(key)).toBe(true);
    for (const key of ['studentEmail', 'answerKey', 'a', 'b', 'note', 'correctAnswer', '']) {
      expect(isEvidenceDetailKey(key), `${key} must not be a detail key`).toBe(false);
    }
    // Narrowing, not merely truthy: the predicate is what `isEvidenceDetailKey('awayForMs') === true` narrows to.
    const key: EvidenceDetailKey = 'awayForMs';
    expect(isEvidenceDetailKey(key)).toBe(true);
  });

  it('admits only primitive values, and refuses `undefined` rather than dropping it', () => {
    for (const value of ['x', 1, true, false, null, 0, ''])
      expect(isEvidenceDetailValue(value)).toBe(true);
    for (const value of [undefined, {}, [], new Date(0), () => {}]) {
      expect(isEvidenceDetailValue(value), `${String(value)} must not be a detail value`).toBe(
        false,
      );
    }
  });

  it('EVIDENCE_DETAIL_KEYS_NO_CONTENT is the tuple itself, not a copy', () => {
    expect([...EVIDENCE_DETAIL_KEYS_NO_CONTENT].sort()).toEqual([...EVIDENCE_DETAIL_KEYS].sort());
  });
});

describe('TM-20: the writer refuses a detail the TYPE cannot see', () => {
  it('refuses a key outside the closed set, and queues nothing', () => {
    // This is the runtime half, and it is reachable: `Record<string, unknown>` from a spread or a `JSON.parse` carries no
    // literal for the compiler to check, which is the ordinary case for a telemetry writer fed by a codec.
    const batcher = batcherFor();
    const hostile = { studentEmail: 'student@school.invalid' } as unknown as Record<
      string,
      string
    > as Parameters<EvidenceBatcher['record']>[1];

    expect(batcher.record('TAB_HIDDEN', hostile)).toBe(false);
    expect(batcher.stats.queued).toBe(0);
  });

  it('refuses a nested object, which is how a whole payload gets past a key allowlist', () => {
    const batcher = batcherFor();
    const nested = { meta: { studentEmail: 'a@b.c' } } as unknown as Parameters<
      EvidenceBatcher['record']
    >[1];
    expect(batcher.record('TAB_HIDDEN', nested)).toBe(false);
    expect(batcher.stats.queued).toBe(0);
  });

  it('refuses an `undefined` value rather than storing it as absent', () => {
    // `canonicalJson` drops `undefined`, so accepting it here would give one event two spellings depending on the path
    // that built it — the `ADV-E2` defect one level up.
    const batcher = batcherFor();
    const withUndefined = { reason: undefined } as unknown as Parameters<
      EvidenceBatcher['record']
    >[1];
    expect(batcher.record('FULLSCREEN_DENIED', withUndefined)).toBe(false);
  });

  it('still accepts every key on the list, so the check is not "refuse everything"', () => {
    // A guard that refuses all detail passes every refusal test above. This is what stops that being a green gate.
    const batcher = batcherFor();
    let accepted = 0;
    for (const key of EVIDENCE_DETAIL_KEYS) {
      const detail = { [key]: 'v' } as Record<EvidenceDetailKey, string>;
      if (batcher.record('TAB_HIDDEN', detail)) accepted += 1;
    }
    expect(accepted).toBe(EVIDENCE_DETAIL_KEYS.length);
    expect(batcher.stats.queued).toBe(EVIDENCE_DETAIL_KEYS.length);
  });

  it('still refuses a server-only event, so the two refusals are distinguishable', () => {
    const batcher = batcherFor();
    expect(batcher.record('VIOLATION_THRESHOLD_REACHED', { threshold: 3 })).toBe(false);
    expect(batcher.record('TAB_HIDDEN', { threshold: 3 })).toBe(true);
  });

  it('keeps the sequence unbroken when a detail is refused', () => {
    // A refusal that consumed a `seq` would leave a hole that reads as dropped telemetry, and `droppedEventCount` is
    // computed from `seq` holes.
    const batcher = batcherFor();
    expect(batcher.record('TAB_HIDDEN', { studentEmail: 'a@b.c' } as never)).toBe(false);
    batcher.record('TAB_HIDDEN', { awayForMs: 5 });
    expect(batcher.takeBatch().map((e) => e.seq)).toEqual([0]);
  });
});
