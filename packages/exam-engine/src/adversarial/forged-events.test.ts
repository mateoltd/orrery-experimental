/**
 * ADVERSARIAL: forged events.  (P8-T15, `plans/17` §3.5 "Forged telemetry, replayed events, out-of-order `seq`")
 *
 * ## WHAT A FORGER WANTS, AND WHY THERE ARE TWO OF THEM
 *
 * The obvious forger is a student removing evidence. The one `RN-01` is about is the other one: **anything that puts
 * an accusation in a timeline that the student's own behaviour did not** -- a looped event, a replayed batch, a client
 * that announces its own escalation. `ADR-0017` makes telemetry evidence for a human, so a forged entry cannot cost a
 * mark; it can still freeze an attempt and put a teacher in front of a student, and that is harm enough to test for.
 *
 * ## THE SIGNATURE TESTS USE A REAL HMAC, AND THE VERIFIER IS WRITTEN HERE BECAUSE THERE IS NO OTHER
 *
 * `evidence.test.ts` signs with `(input) => \`signed:${input.length}\``, which proves the signer is called and cannot
 * prove a forgery is refused: two inputs of the same length sign identically. So these use `node:crypto`.
 *
 * `verify` below is three lines and lives in a test file, and that is a FINDING rather than a convenience: **nothing
 * in the repository verifies an evidence signature.** `signBatch` produces one, and `flushOnce` then hands the
 * transport a batch with the signature left off (`BatchTransport` takes `Omit<SignedBatch, 'signature'>`). So what is
 * pinned here is what the signed BYTES make possible for a verifier, not what any server does today. `ADV-E4` below is
 * the test that goes red when that changes.
 *
 * ## THE `it.fails` TESTS ARE DEFECTS IN `evidence.ts`, WHICH THIS LANE MAY NOT EDIT
 *
 * Each asserts the guarantee as it should hold and is marked `it.fails`, so the suite is green today and the test
 * turns RED the moment the defect is fixed -- at which point the marker comes off and the guarantee is pinned for
 * good. A characterisation test asserting the wrong behaviour would do the opposite: go red on the fix.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  batchSigningInput,
  canonicalEvent,
  countsAsStrike,
  EVIDENCE_RULES,
  EvidenceBatcher,
  type EvidenceRecord,
  type EvidenceType,
  SERVER_ONLY_EVENTS,
  type SignedBatch,
  type StrikePolicyView,
} from '../evidence.js';

const T0 = 1_800_000_000_000;
const RUNS = 300;

const KEY = 'per-attempt-session-key';
const hmac =
  (key: string) =>
  (input: string): string =>
    createHmac('sha256', key).update(input).digest('hex');

/** The least a server could do: recompute over what was PRESENTED and compare in constant time. */
const verify = (
  presented: Pick<SignedBatch, 'attemptId' | 'tabId' | 'events' | 'signature'>,
  key = KEY,
): boolean => {
  const expected = Buffer.from(hmac(key)(batchSigningInput(presented)), 'hex');
  const given = Buffer.from(presented.signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const ALL_TYPES = Object.keys(EVIDENCE_RULES) as EvidenceType[];
const CLIENT_TYPES = ALL_TYPES.filter((type) => !SERVER_ONLY_EVENTS.has(type));

const STRICTEST: StrikePolicyView = {
  requireFullscreen: 'BLOCK',
  requirePointerLock: 'BLOCK',
  multiTabPolicy: 'BLOCK',
  blockCopyPaste: true,
  blockPrintSave: true,
};

const batcherFor = (
  attemptId: string,
  tabId: string,
  seen: Omit<SignedBatch, 'signature'>[] = [],
  maxQueued = 500,
): EvidenceBatcher =>
  new EvidenceBatcher(
    {
      batchSize: 25,
      maxQueued,
      transport: async (batch) => {
        seen.push(batch);
        return true;
      },
    },
    { now: () => T0 },
    attemptId,
    tabId,
    hmac(KEY),
  );

/** Realistic ids: the server issues the attempt id and the tab id is a uuid. See `ADV-E3` for the unrealistic ones. */
const idArb = fc.uuid();

const detailArb = fc.dictionary(
  fc.stringMatching(/^[a-z][A-Za-z]{0,8}$/),
  fc.oneof(fc.string({ maxLength: 12 }), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 3 },
);

/** Events as the batcher numbers them: strictly ascending `seq`, not necessarily contiguous (drops leave holes). */
const eventsArb: fc.Arbitrary<EvidenceRecord[]> = fc
  .array(
    fc.record({
      gap: fc.integer({ min: 1, max: 3 }),
      type: fc.constantFrom(...CLIENT_TYPES),
      at: fc.integer({ min: T0, max: T0 + 10_800_000 }),
      detail: fc.option(detailArb, { nil: undefined }),
    }),
    { minLength: 2, maxLength: 8 },
  )
  .map((rows) => {
    let seq = -1;
    return rows.map((row) => {
      seq += row.gap;
      return row.detail === undefined
        ? { seq, type: row.type, at: row.at }
        : { seq, type: row.type, at: row.at, detail: row.detail };
    });
  });

const sign = (attemptId: string, tabId: string, events: readonly EvidenceRecord[]): SignedBatch =>
  batcherFor(attemptId, tabId).signBatch(events);

describe('a client cannot announce its own escalation', () => {
  it('refuses every server-only type, whatever is queued and whatever detail it carries', () => {
    // What breaks without it: the ladder acts on the CLIENT's count. One forged `VIOLATION_THRESHOLD_REACHED` and a
    // student is frozen on evidence no teacher has seen -- or a classmate's client freezes them.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...CLIENT_TYPES), { maxLength: 20 }),
        fc.constantFrom(...SERVER_ONLY_EVENTS),
        fc.option(detailArb, { nil: undefined }),
        (before, forged, detail) => {
          const batcher = batcherFor('attempt', 'tab');
          for (const type of before) batcher.record(type);
          const stats = batcher.stats;

          expect(batcher.record(forged, detail)).toBe(false);
          // Not queued, not counted as dropped: a refusal is not a loss, and reporting it as one would put a hole in
          // the timeline that reads as shed telemetry.
          expect(batcher.stats).toEqual(stats);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('spends no sequence number on a refusal, so a forgery cannot manufacture a GAP', () => {
    // A gap in `seq` is how a server learns telemetry was lost (`droppedEventCount`, `U-2`). If a refused forgery
    // consumed a number, a client could make its own timeline look shed -- or an attacker could make a victim's look
    // tampered with -- without sending a single accepted event.
    const seen: Omit<SignedBatch, 'signature'>[] = [];
    const batcher = batcherFor('attempt', 'tab', seen);
    batcher.record('TAB_HIDDEN');
    for (let n = 0; n < 50; n += 1) batcher.record('VIOLATION_THRESHOLD_REACHED');
    batcher.record('TAB_VISIBLE');

    expect(batcher.takeBatch().map((event) => event.seq)).toEqual([0, 1]);
  });

  it('never lets a refused type reach the transport, on the flush path or the unload path', async () => {
    const seen: Omit<SignedBatch, 'signature'>[] = [];
    const batcher = batcherFor('attempt', 'tab', seen);
    batcher.record('VIOLATION_THRESHOLD_REACHED');
    batcher.record('WINDOW_BLURRED');
    batcher.record('VIOLATION_THRESHOLD_REACHED');
    await batcher.flushOnce();
    batcher.record('VIOLATION_THRESHOLD_REACHED');
    batcher.flushOnUnload();

    const types = seen.flatMap((batch) => batch.events.map((event) => event.type));
    expect(types).toEqual(['WINDOW_BLURRED']);
  });

  it('treats every `*_THRESHOLD_REACHED` type in the table as server-only', () => {
    // `survivesShedding` recognises a crossing by this suffix. A second crossing type added to the table and not to
    // `SERVER_ONLY_EVENTS` would be the one record that must survive shedding AND one any client could emit.
    const crossings = ALL_TYPES.filter((type) => type.endsWith('_THRESHOLD_REACHED'));
    expect(crossings).toContain('VIOLATION_THRESHOLD_REACHED');
    for (const type of crossings) expect(SERVER_ONLY_EVENTS.has(type), type).toBe(true);
  });

  it('gives a server-only type no strike of its own, so replaying the SERVER’s row cannot count twice', () => {
    // The crossing is computed FROM strikes. If it also counted as one, a replayed crossing would raise the count
    // that produced it.
    for (const type of SERVER_ONLY_EVENTS) expect(countsAsStrike(type, STRICTEST)).toBe(false);
  });
});

describe('an event type with no rule is an error, never "no strike"', () => {
  it('throws for any name the table does not hold', () => {
    // What breaks without the throw: a new event type added without a row silently un-strikes itself, and a typo in a
    // route (`TAB_HIDEN`) turns a policed event into an unpoliced one with no failing test anywhere.
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }).filter((name) => !(name in EVIDENCE_RULES)),
        (name) => {
          expect(() => countsAsStrike(name as EvidenceType, STRICTEST)).toThrow(/no evidence rule/);
        },
      ),
      { numRuns: RUNS },
    );
  });

  /**
   * `ADV-E1` -- KNOWN DEFECT in `evidence.ts`, outside this lane.
   *
   * `EVIDENCE_RULES[type]` is a plain property read on an object literal, so `constructor`, `toString`, `__proto__`
   * and every other `Object.prototype` name resolve to something that is not `undefined`. The guard passes, `rule.strike`
   * is `undefined`, the switch reaches `default: return false` -- the lenient default the guard's own comment says
   * must never happen. It is the `__proto__` read `answerStore.ts` already fixed with `Object.hasOwn`, in a second
   * place.
   *
   * Reachability is low while a closed schema validates `type` first. It is not zero: no telemetry route exists yet,
   * and the function's contract is that a missing rule throws.
   */
  it.fails('ADV-E1: throws for names inherited from Object.prototype too', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(() => countsAsStrike(name as EvidenceType, STRICTEST), name).toThrow();
    }
  });

  it('has no rule whose strike decision falls through to the switch default', () => {
    // The `default` arm returns `false`. Every declared rule must be decided by a NAMED arm, so a fifth `strike` value
    // added to the union cannot quietly mean "never".
    const named = new Set(['never', 'always', 'when_fullscreen_required', 'when_policy_says']);
    for (const type of ALL_TYPES) expect(named.has(EVIDENCE_RULES[type].strike), type).toBe(true);
  });
});

describe('a signed batch cannot be moved, extended, trimmed or edited', () => {
  it('verifies as signed, or every refusal below would be vacuous', () => {
    fc.assert(
      fc.property(idArb, idArb, eventsArb, (attemptId, tabId, events) => {
        expect(verify(sign(attemptId, tabId, events))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused on ANOTHER attempt, which is the replay that frames a different student', () => {
    fc.assert(
      fc.property(idArb, idArb, idArb, eventsArb, (attemptId, other, tabId, events) => {
        fc.pre(attemptId !== other);
        const signed = sign(attemptId, tabId, events);
        expect(verify({ ...signed, attemptId: other })).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused from ANOTHER tab, so a second tab cannot speak for the first', () => {
    fc.assert(
      fc.property(idArb, idArb, idArb, eventsArb, (attemptId, tabId, other, events) => {
        fc.pre(tabId !== other);
        const signed = sign(attemptId, tabId, events);
        expect(verify({ ...signed, tabId: other })).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused once EXTENDED, at either end, with events the signer never saw', () => {
    fc.assert(
      fc.property(idArb, idArb, eventsArb, fc.boolean(), (attemptId, tabId, events, atEnd) => {
        const signed = sign(attemptId, tabId, events);
        const last = events[events.length - 1]?.seq ?? 0;
        const extra: EvidenceRecord = atEnd
          ? { seq: last + 1, type: 'MULTI_TAB_DETECTED', at: T0 }
          : { seq: -1, type: 'MULTI_TAB_DETECTED', at: T0 };
        const forged = atEnd ? [...events, extra] : [extra, ...events];
        expect(verify({ ...signed, events: forged })).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused once TRIMMED, which is how a return is removed and a departure kept', () => {
    // The exculpatory half of a pair is as valuable to remove as the incriminating half: `TAB_HIDDEN` without its
    // `TAB_VISIBLE` reads as a student who never came back.
    fc.assert(
      fc.property(idArb, idArb, eventsArb, fc.nat(), (attemptId, tabId, events, pick) => {
        const signed = sign(attemptId, tabId, events);
        const index = pick % events.length;
        const trimmed = events.filter((_, n) => n !== index);
        expect(verify({ ...signed, events: trimmed })).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused once REORDERED', () => {
    fc.assert(
      fc.property(idArb, idArb, eventsArb, (attemptId, tabId, events) => {
        const signed = sign(attemptId, tabId, events);
        expect(verify({ ...signed, events: [...events].reverse() })).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('is refused once any single event is RETYPED, RETIMED or RENUMBERED', () => {
    fc.assert(
      fc.property(
        idArb,
        idArb,
        eventsArb,
        fc.nat(),
        fc.constantFrom('type', 'at', 'seq'),
        (attemptId, tabId, events, pick, field) => {
          const signed = sign(attemptId, tabId, events);
          const index = pick % events.length;
          const edited = events.map((event, n): EvidenceRecord => {
            if (n !== index) return event;
            if (field === 'type') {
              // `WINDOW_FOCUSED` <-> `FULLSCREEN_EXITED`: a return turned into a violation, or the reverse.
              const type =
                event.type === 'FULLSCREEN_EXITED' ? 'WINDOW_FOCUSED' : 'FULLSCREEN_EXITED';
              return { ...event, type };
            }
            if (field === 'at') return { ...event, at: event.at + 1 };
            return { ...event, seq: event.seq + 1_000 };
          });
          expect(verify({ ...signed, events: edited })).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('is refused under a different key, so one attempt’s session cannot sign for another', () => {
    const signed = sign('attempt', 'tab', [{ seq: 0, type: 'TAB_HIDDEN', at: T0 }]);
    expect(verify(signed, KEY)).toBe(true);
    expect(verify(signed, `${KEY}-other`)).toBe(false);
  });

  it('distinguishes an EMPTY batch from a batch holding only event zero', () => {
    // Both report the range 0..0, because an empty batch has no first or last. If the body were not signed too, a
    // forger could strip the only event out of a batch and keep the signature.
    const empty = sign('attempt', 'tab', []);
    const one = sign('attempt', 'tab', [{ seq: 0, type: 'TAB_HIDDEN', at: T0 }]);
    expect(empty.fromSeq).toBe(one.fromSeq);
    expect(empty.toSeq).toBe(one.toSeq);
    expect(empty.signature).not.toBe(one.signature);
  });

  it('signs the range it DERIVES from the events, so the envelope’s own `toSeq` is an unsigned claim', () => {
    /**
     * A HAZARD FOR WHOEVER WRITES THE VERIFIER, pinned so it is read before that code exists.
     *
     * `SignedBatch` carries `fromSeq`/`toSeq` beside the events, and `batchSigningInput` ignores them: it reads the
     * first and last `seq` off the events. So the range is inside the signature only AS DERIVED. A server that
     * verifies the signature and then does its gap accounting from the envelope's `toSeq` is trusting a field the
     * client can set to anything -- "I sent you 0..499" over five events hides 495 dropped ones.
     */
    const events: EvidenceRecord[] = [
      { seq: 0, type: 'TAB_HIDDEN', at: T0 },
      { seq: 1, type: 'TAB_VISIBLE', at: T0 + 1 },
    ];
    const signed = sign('attempt', 'tab', events);
    const lying = { ...signed, fromSeq: 0, toSeq: 499 };

    expect(batchSigningInput(lying)).toBe(batchSigningInput(signed));
    expect(verify(lying)).toBe(true);
    // What a verifier must therefore compare against, and it is not the envelope:
    const range = batchSigningInput(signed).split('\u0000').slice(3, 5);
    expect(range).toEqual(['0', '1']);
  });

  /**
   * `ADV-E2` -- KNOWN DEFECT in `evidence.ts`, outside this lane.
   *
   * `canonicalEvent` sorts the event's OWN keys and then `JSON.stringify`s `detail` as it finds it, so `detail`'s key
   * order is whatever the sender's object happened to have. Its comment claims the opposite: "Keys are sorted so a
   * signature computed on a phone matches one computed on a server".
   *
   * It bites the moment a server re-derives the bytes from anything but the raw request body. Postgres `jsonb` does
   * not preserve key order, so an event stored and read back canonicalises differently and a genuine batch fails
   * verification -- a timeline flagged as tampered with when nobody touched it.
   */
  it.fails('ADV-E2: canonicalises `detail` independently of its key order', () => {
    const one = canonicalEvent({ seq: 0, type: 'TAB_VISIBLE', at: T0, detail: { a: 1, b: 2 } });
    const other = canonicalEvent({ seq: 0, type: 'TAB_VISIBLE', at: T0, detail: { b: 2, a: 1 } });
    expect(one).toBe(other);
  });

  /**
   * `ADV-E3` -- KNOWN DEFECT in `evidence.ts`, outside this lane. Low severity; stated because it is cheap to close.
   *
   * The fields are joined with `\u0000` and not length-prefixed, so a NUL inside one field moves the boundary: attempt
   * `a` with tab `b\u0000c` signs the same bytes as attempt `a\u0000b` with tab `c`. The attempt id is server-issued
   * and will not contain one. The tab id is CLIENT-chosen, and nothing constrains it.
   */
  it.fails('ADV-E3: keeps the field boundaries when an id contains the separator', () => {
    const one = batchSigningInput({ attemptId: 'a', tabId: 'b\u0000c', events: [] });
    const other = batchSigningInput({ attemptId: 'a\u0000b', tabId: 'c', events: [] });
    expect(one).not.toBe(other);
  });

  /**
   * `ADV-E4` -- KNOWN GAP, and the reason the tests above say "cannot be" about bytes rather than about a server.
   *
   * `flushOnce` calls `signBatch`, then passes the transport every field EXCEPT the signature; `flushOnUnload` does
   * not sign at all. Whatever the transport posts, it is not something a server can verify.
   */
  it.fails('ADV-E4: hands the transport the signature it computed', async () => {
    const seen: Omit<SignedBatch, 'signature'>[] = [];
    const batcher = batcherFor('attempt', 'tab', seen);
    batcher.record('TAB_HIDDEN');
    await batcher.flushOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveProperty('signature');
  });
});

describe('the batcher accepts what it is given, and that is a statement about WHERE validation must live', () => {
  it('queues an event type the table has never heard of', () => {
    /**
     * NOT a defect in the batcher -- it is client code and the compiler is its schema. Pinned because it fixes where
     * the closed-schema check has to be: `plans/09` §7 puts it on the SERVER ("validate each event against a CLOSED
     * Zod schema"), and no such route exists yet. Until it does, `countsAsStrike`'s throw is the only thing between
     * an invented event type and a strike decision, which is why `ADV-E1` matters more than it looks.
     */
    const batcher = batcherFor('attempt', 'tab');
    expect(batcher.record('INVENTED_BY_THE_CLIENT' as EvidenceType)).toBe(true);
    expect(batcher.stats.queued).toBe(1);
  });
});
