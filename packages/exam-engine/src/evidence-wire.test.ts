/**
 * What the batcher signs, and what it hands over.  (`ADV-E2`, `ADV-E3`, `ADV-E4`, `ADV-N1`)
 *
 * `adversarial/forged-events.test.ts` and `adversarial/network-loss.test.ts` each pin one case per defect: one pair of
 * key orders, one pair of ids, one property on one batch, one throwing transport. Those are the cases the defects were
 * FOUND with. A fix that special-cased exactly those four inputs would turn all four green, so these pin the rule each
 * one is an instance of.
 *
 * The signatures here are real HMACs. `(input) => 'sig'` proves the signer was called and cannot prove that what
 * reached the transport is a signature over what reached the transport.
 */

import { createHmac } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  batchSigningInput,
  canonicalEvent,
  EvidenceBatcher,
  type EvidenceRecord,
  type SignedBatch,
} from './evidence.js';

const T0 = 1_800_000_000_000;
const RUNS = 300;
const KEY = 'per-attempt-session-key';

const hmac = (input: string): string => createHmac('sha256', KEY).update(input).digest('hex');

/** Strings made mostly of the characters that have meant something to this format: the separators and the escapes. */
const hostileString = fc
  .array(fc.constantFrom('a', 'b', 'c', '\u0000', '\n', '"', '\\', ':', ',', '{', '}', 'é'), {
    maxLength: 8,
  })
  .map((chars) => chars.join(''));

type Json = string | number | boolean | null | { readonly [key: string]: Json } | readonly Json[];

/** Nested on purpose. `detail` is typed flat, and a canonical form that is only right for the type is right by luck. */
const jsonArb: fc.Arbitrary<Json> = fc.letrec<{ value: Json }>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string({ maxLength: 6 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.dictionary(hostileString, tie('value'), { maxKeys: 4 }),
    fc.array(tie('value'), { maxLength: 3 }),
  ),
})).value;

/** The same value with every object's keys in the opposite insertion order, at every depth. What `jsonb` may do. */
const reordered = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(reordered);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as { readonly [key: string]: Json });
    return Object.fromEntries(entries.reverse().map(([key, inner]) => [key, reordered(inner)]));
  }
  return value;
};

const eventWith = (detail: unknown): EvidenceRecord =>
  ({ seq: 3, type: 'TAB_VISIBLE', at: T0, detail }) as EvidenceRecord;

describe('`ADV-E2`: the canonical form does not depend on how an object was built', () => {
  it('is the same bytes for the same value, whatever order its keys are in, at EVERY depth', () => {
    // What breaks without it: an event stored in `jsonb` and read back verifies as tampered with. Sorting `detail`
    // alone would pass the one-level case in `forged-events.test.ts` and fail this one level down.
    fc.assert(
      fc.property(fc.dictionary(hostileString, jsonArb, { maxKeys: 4 }), (detail) => {
        expect(canonicalEvent(eventWith(reordered(detail)))).toBe(
          canonicalEvent(eventWith(detail)),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('sorts a key order it was not handed sorted, two levels down', () => {
    // The property above cannot fail on an object with one key, so here is one where the order must change.
    const one = canonicalEvent(eventWith({ outer: { b: { y: 1, x: 2 }, a: 0 } }));
    const other = canonicalEvent(eventWith({ outer: { a: 0, b: { x: 2, y: 1 } } }));
    expect(one).toBe(other);
    expect(one).toContain('{"a":0,"b":{"x":2,"y":1}}');
  });

  it('loses nothing: it is exactly `JSON.stringify` of the same value with its keys sorted', () => {
    /**
     * The other half. A canonicaliser that dropped a key, or flattened a nested value, would also be order-independent.
     *
     * ## THE ORACLE IS NOT `JSON.parse`, AND THE FIRST VERSION OF THIS TEST WAS FLAKY BECAUSE IT WAS
     *
     * It read `expect(JSON.parse(canonicalEvent(event))).toEqual(JSON.parse(JSON.stringify(event)))` and failed about
     * one full-suite run in twenty, on a different input each time, never under the seed it printed. The canonical
     * form was right every time. **`JSON.parse` was returning the wrong KEY**, on Node v24.21.0 (V8 13.6.233.17):
     *
     *     JSON.parse('{"\\\\":1}');                 // one key, a backslash -- correct
     *     Object.keys(JSON.parse('{"\\"":1}'));     // ['\\'] -- should be ['"']
     *
     * A one-character key written as an escape comes back as a backslash once an object keyed by a backslash has been
     * parsed, so the answer depends on what the process parsed EARLIER. That is why it would not reproduce alone, and
     * `hostileString` is made of exactly those characters. Values are not affected, only keys.
     *
     * So the expectation is built without parsing anything: the same value, keys sorted at every depth, through the
     * standard serialiser. It is also the stronger statement -- it pins the bytes, not just what they decode to.
     *
     * The hazard outlives this test. A verifier that does `JSON.parse(body)` and canonicalises the result can be handed
     * a `detail` key that is not the one the client signed, and would report a genuine batch as tampered with.
     */
    const sortedDeep = (value: Json): Json => {
      if (Array.isArray(value)) return value.map(sortedDeep);
      if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value as { readonly [key: string]: Json });
        // Insertion order is what `JSON.stringify` follows, for every key `hostileString` can produce. It would NOT be
        // for integer-like keys, which an object always lists first and in numeric order; none are generated here.
        return Object.fromEntries(
          entries
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, inner]) => [key, sortedDeep(inner)]),
        );
      }
      return value;
    };

    fc.assert(
      fc.property(fc.dictionary(hostileString, jsonArb, { maxKeys: 4 }), (detail) => {
        const expected = { at: T0, detail: sortedDeep(detail), seq: 3, type: 'TAB_VISIBLE' };
        expect(canonicalEvent(eventWith(detail))).toBe(JSON.stringify(expected));
      }),
      { numRuns: RUNS },
    );
  });

  it('tells apart two details that the bare-key form wrote identically', () => {
    // `{key:value,...}` with unquoted keys made both of these `a:1,b:2`. `detail` keys are the sender's to choose.
    expect(canonicalEvent(eventWith({ a: 1, b: 2 }))).not.toBe(
      canonicalEvent(eventWith({ 'a:1,b': 2 })),
    );
  });

  it('drops `undefined` inside `detail` too, and still keeps an explicit `null`', () => {
    expect(canonicalEvent(eventWith({ a: 1, gone: undefined }))).toBe(
      canonicalEvent(eventWith({ a: 1 })),
    );
    expect(canonicalEvent(eventWith({ a: 1, known: null }))).not.toBe(
      canonicalEvent(eventWith({ a: 1 })),
    );
  });

  it('never emits a raw newline or NUL, which are the separators of the signing input', () => {
    fc.assert(
      fc.property(fc.dictionary(hostileString, jsonArb, { maxKeys: 4 }), (detail) => {
        /**
         * The NUL below is the SUBJECT of the assertion, not an accident in it. `noControlCharactersInRegex` exists
         * to stop a control character slipping into a pattern by mistake; here it is the whole point, because ADV-E3
         * is that a NUL inside a tab id used to shift the signed field boundaries and the fix is that the canonical
         * form ESCAPES it. The only way to test that is to match the raw character and require its absence.
         *
         * Written as `\u0000` rather than a literal byte, both because this repository has had a real incident with
         * NULs in source making a file binary, and because an escape is not a control character to any reader.
         */
        /**
         * The NUL is the SUBJECT of this assertion, not an accident in it. `noControlCharactersInRegex` and
         * `no-control-regex` exist to stop a control character slipping into a pattern by mistake; here it is the
         * whole point, because ADV-E3 is that a NUL inside a tab id used to shift the signed field boundaries and the
         * fix is that the canonical form ESCAPES it. The only way to test that is to match the raw character and
         * require its absence.
         *
         * **BOTH linters forbid this pattern and BOTH suppressions are needed, and they want to sit in different
         * places.** Biome wants its `biome-ignore` as the last comment above the offending line and ESLint wants its
         * `eslint-disable-next-line` in the same position, so the two cannot both go there; hence a trailing
         * `eslint-disable-line`. And a `biome-ignore` must be the *immediately* preceding line -- a `//` continuation
         * of the paragraph above silently breaks it, which cost three attempts here and produced a
         * `suppressions/unused` warning rather than a working suppression.
         *
         * Written as `\u0000` rather than a literal byte, because this repository has had a real incident with NULs
         * in source making a file binary.
         */
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the NUL is the SUBJECT, not an accident.
        expect(canonicalEvent(eventWith(detail))).not.toMatch(/[\n\u0000]/); // eslint-disable-line no-control-regex
      }),
      { numRuns: RUNS },
    );
  });
});

describe('`ADV-E3`: the signing input decodes to exactly one batch', () => {
  it('gives two different (attempt, tab) pairs two different inputs, whatever the ids contain', () => {
    // What breaks without it: a signature for attempt `a`, tab `b<NUL>c` is a signature for attempt `a<NUL>b`, tab `c`.
    fc.assert(
      fc.property(
        hostileString,
        hostileString,
        hostileString,
        hostileString,
        (attemptId, tabId, otherAttempt, otherTab) => {
          fc.pre(attemptId !== otherAttempt || tabId !== otherTab);
          expect(batchSigningInput({ attemptId, tabId, events: [] })).not.toBe(
            batchSigningInput({ attemptId: otherAttempt, tabId: otherTab, events: [] }),
          );
        },
      ),
      { numRuns: RUNS * 3 },
    );
  });

  it('can be read back field by field, which is what "the boundaries hold" means', () => {
    // Stronger than inequality: the first five separators are always the real ones, so a verifier can recover what was
    // signed instead of trusting that two inputs happened to differ.
    fc.assert(
      fc.property(hostileString, hostileString, fc.nat({ max: 500 }), (attemptId, tabId, seq) => {
        const events: EvidenceRecord[] = [
          { seq, type: 'TAB_HIDDEN', at: T0, detail: { note: tabId } },
          { seq: seq + 2, type: 'TAB_VISIBLE', at: T0 + 1 },
        ];
        const fields = batchSigningInput({ attemptId, tabId, events }).split('\u0000');

        expect(fields).toHaveLength(6);
        expect(fields[0]).toBe('orrery.evidence.v1');
        expect(JSON.parse(fields[1] ?? '')).toBe(attemptId);
        expect(JSON.parse(fields[2] ?? '')).toBe(tabId);
        expect(fields.slice(3, 5)).toEqual([String(seq), String(seq + 2)]);
        expect(fields[5]).toBe(events.map(canonicalEvent).join('\n'));
      }),
      { numRuns: RUNS },
    );
  });
});

const signedBatcher = (
  transport: (batch: SignedBatch) => unknown,
  sign: (input: string) => string = hmac,
): EvidenceBatcher =>
  new EvidenceBatcher(
    // Cast: several of these transports break `BatchTransport`'s type on purpose, because a real one can.
    { batchSize: 10, maxQueued: 50, transport: transport as (b: SignedBatch) => Promise<boolean> },
    { now: () => T0 },
    'attempt',
    'tab',
    sign,
  );

/** Let the promise callbacks attached inside `flushOnUnload` run. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

describe('`ADV-E4`: what reaches the transport can be verified by whoever receives it', () => {
  it('hands over a signature that is the HMAC of the batch it arrived with, on the flush path', async () => {
    // `toHaveProperty('signature')` is satisfied by any string. This recomputes it from what the transport was GIVEN.
    const seen: SignedBatch[] = [];
    const batcher = signedBatcher(async (batch) => {
      seen.push(batch);
      return true;
    });
    batcher.record('TAB_HIDDEN', { awayForMs: 12 });
    batcher.record('TAB_VISIBLE');
    await batcher.flushOnce();

    expect(seen).toHaveLength(1);
    const [batch] = seen;
    if (batch === undefined) throw new Error('no batch reached the transport');
    expect(batch.signature).toBe(hmac(batchSigningInput(batch)));
    expect(batch.events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it('signs on the UNLOAD path as well, which did not sign at all', () => {
    // The last batch of a sitting is the one most likely to hold the event a teacher is asked about.
    const seen: SignedBatch[] = [];
    const batcher = signedBatcher(async (batch) => {
      seen.push(batch);
      return true;
    });
    batcher.record('TAB_HIDDEN');
    batcher.flushOnUnload();

    expect(seen).toHaveLength(1);
    const [batch] = seen;
    if (batch === undefined) throw new Error('no batch reached the transport');
    expect(batch.signature).toBe(hmac(batchSigningInput(batch)));
  });
});

describe('`ADV-N1`: nothing the unload path touches can throw into `pagehide`', () => {
  it('counts a transport that throws synchronously, and returns', () => {
    const batcher = signedBatcher(() => {
      throw new Error('sendBeacon: document is detached');
    });
    batcher.record('TAB_HIDDEN');

    expect(() => {
      batcher.flushOnUnload();
    }).not.toThrow();
    // Not re-queued and not hidden: the batch is gone, and a failure this path KNOWS about is counted.
    expect(batcher.stats).toEqual({ queued: 0, sent: 0, dropped: 0, batchesFailed: 1 });
  });

  it('counts a transport that REJECTS, instead of leaving an unhandled rejection', async () => {
    // An unhandled rejection fails the whole run under vitest, so before the fix this test could not be written
    // without turning the suite red -- which is the note `network-loss.test.ts` leaves about it.
    const batcher = signedBatcher(async () => {
      throw new Error('connection reset');
    });
    batcher.record('TAB_HIDDEN');
    batcher.flushOnUnload();
    expect(batcher.stats.batchesFailed).toBe(0);

    await settle();
    expect(batcher.stats).toEqual({ queued: 0, sent: 0, dropped: 0, batchesFailed: 1 });
  });

  it('survives a SIGNER that throws, on both paths', async () => {
    // The signing sat outside `flushOnce`'s `try`, so a key that failed to import rejected out of a function whose one
    // promise is that it does not.
    const failing = (): string => {
      throw new Error('key not imported');
    };
    const seen: SignedBatch[] = [];
    const batcher = signedBatcher(async (batch) => {
      seen.push(batch);
      return true;
    }, failing);

    batcher.record('TAB_HIDDEN');
    await expect(batcher.flushOnce()).resolves.toBe(false);
    batcher.record('TAB_VISIBLE');
    expect(() => {
      batcher.flushOnUnload();
    }).not.toThrow();

    // Nothing unsigned was sent in its place.
    expect(seen).toEqual([]);
    expect(batcher.stats).toEqual({ queued: 0, sent: 0, dropped: 0, batchesFailed: 2 });
  });

  it('survives a transport that returns a bare boolean, as a `sendBeacon` wrapper does', async () => {
    // `navigator.sendBeacon` returns `true`, not a promise. Calling `.catch` on it would be the unload path throwing
    // after all, and counting it as a failure would be wrong: the beacon was queued.
    const batcher = signedBatcher(() => true);
    batcher.record('TAB_HIDDEN');
    expect(() => {
      batcher.flushOnUnload();
    }).not.toThrow();

    await settle();
    expect(batcher.stats).toEqual({ queued: 0, sent: 0, dropped: 0, batchesFailed: 0 });
  });

  it('still counts NOTHING for a transport that resolves, because it cannot know the beacon arrived', async () => {
    // The limit `network-loss.test.ts` pins, checked after the promise has settled rather than before it could.
    for (const answer of [true, false]) {
      const batcher = signedBatcher(async () => answer);
      batcher.record('TAB_HIDDEN');
      batcher.flushOnUnload();
      await settle();
      expect(batcher.stats, String(answer)).toEqual({
        queued: 0,
        sent: 0,
        dropped: 0,
        batchesFailed: 0,
      });
    }
  });
});
