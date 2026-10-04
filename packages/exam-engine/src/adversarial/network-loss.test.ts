/**
 * ADVERSARIAL: network loss.  (P8-T15, `plans/09` §7, `U-2`, `B10`)
 *
 * ## THE TWO QUEUES FAIL IN OPPOSITE DIRECTIONS, AND THIS FILE IS ABOUT THE ONE THAT IS ALLOWED TO LOSE
 *
 * `plans/09` §7: "telemetry may be incomplete, and that is acceptable. Saves are not." The answer half of that lives
 * in `apps/web` (the outbox, which grows) and is attacked there. This file attacks the telemetry half, and the thing
 * under attack is not that events are lost -- they are meant to be -- but that **the loss is recorded**.
 *
 * `RN-02` is why that matters more than it sounds. The students whose queues overflow are the students on unstable
 * connections. A timeline with silent holes under-counts for them and reads as complete, so a teacher comparing two
 * students compares a full record with a partial one and does not know it. `U-2` puts the count on the attempt
 * (`droppedEventCount`) precisely so the hole is visible.
 *
 * ## WHAT IS A PROPERTY HERE AND WHY
 *
 * `evidence.test.ts` drops one event from a queue of three. The cases a hand-written test does not reach are the
 * interleavings: overflow DURING a failed flush, a flush between two overflows, a refusal mid-queue. So the batcher
 * is driven by a random script and checked against a bookkeeping model, and the model is deliberately dumb -- it only
 * remembers which `seq` went where.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type BatchTransport, EvidenceBatcher, type EvidenceRecord } from '../evidence.js';
import { mayShed, NEVER_SHED, overflowResponseFor, SHEDDABLE, WRITE_PATHS } from '../shedding.js';

const T0 = 1_800_000_000_000;
const RUNS = 400;

type Step =
  | { readonly op: 'record' }
  | { readonly op: 'forge' }
  | { readonly op: 'flush'; readonly outcome: 'ok' | 'refused' | 'threw' };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<Step>({ op: 'record' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ op: 'forge' }) },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom<'ok' | 'refused' | 'threw'>('ok', 'refused', 'threw')
      .map((outcome): Step => ({ op: 'flush', outcome })),
  },
);

interface Run {
  /** How many events the batcher accepted. They are numbered 0..accepted-1. */
  readonly accepted: number;
  /** `seq`s the transport acknowledged. */
  readonly delivered: readonly number[];
  /** `seq`s handed to a transport that refused or threw. Gone, and not re-queued. */
  readonly lostInFlight: readonly number[];
  /** Every `seq` the transport was ever shown, in the order it was shown. */
  readonly offered: readonly number[];
  readonly failedFlushes: number;
  readonly batcher: EvidenceBatcher;
}

/** Drive a real batcher through a script. The transport's behaviour for each flush is the script's, not a mock's guess. */
const run = async (steps: readonly Step[], batchSize: number, maxQueued: number): Promise<Run> => {
  let next: 'ok' | 'refused' | 'threw' = 'ok';
  const delivered: number[] = [];
  const lostInFlight: number[] = [];
  const offered: number[] = [];
  let failedFlushes = 0;
  let accepted = 0;

  const transport: BatchTransport = async (batch) => {
    const seqs = batch.events.map((event: EvidenceRecord) => event.seq);
    offered.push(...seqs);
    if (next === 'ok') {
      delivered.push(...seqs);
      return true;
    }
    lostInFlight.push(...seqs);
    failedFlushes += 1;
    if (next === 'threw') throw new Error('connection reset');
    return false;
  };

  const batcher = new EvidenceBatcher(
    { batchSize, maxQueued, transport },
    { now: () => T0 },
    'attempt',
    'tab',
    () => 'sig',
  );

  for (const step of steps) {
    if (step.op === 'record') {
      if (batcher.record('NETWORK_LOST')) accepted += 1;
    } else if (step.op === 'forge') {
      batcher.record('VIOLATION_THRESHOLD_REACHED');
    } else {
      next = step.outcome;
      await batcher.flushOnce();
    }
  }
  return { accepted, delivered, lostInFlight, offered, failedFlushes, batcher };
};

const scriptArb = fc.record({
  steps: fc.array(stepArb, { maxLength: 80 }),
  batchSize: fc.integer({ min: 1, max: 6 }),
  maxQueued: fc.integer({ min: 1, max: 8 }),
});

describe('an overflowing telemetry queue loses events and SAYS how many', () => {
  it('accounts for every accepted event exactly once: delivered, lost in flight, evicted, or still queued', async () => {
    // What breaks without it: an event that is in none of the four places was swallowed. The `dropped` counter is the
    // only one of the four the batcher has to get right by itself, so it is the one solved for.
    await fc.assert(
      fc.asyncProperty(scriptArb, async ({ steps, batchSize, maxQueued }) => {
        const result = await run(steps, batchSize, maxQueued);
        const stats = result.batcher.stats;
        const stillQueued = result.batcher.takeBatch().length + result.batcher.stats.queued;

        expect(stats.sent).toBe(result.delivered.length);
        expect(stats.batchesFailed).toBe(result.failedFlushes);
        expect(stats.queued).toBeLessThanOrEqual(maxQueued);
        // The conservation law. `dropped` is not derived from the others inside the batcher, so this is a real check.
        expect(stats.dropped).toBe(
          result.accepted - result.delivered.length - result.lostInFlight.length - stillQueued,
        );
      }),
      { numRuns: RUNS },
    );
  });

  it('evicts the OLDEST, so what survives an outage is the most recent stretch of it', async () => {
    // A queue that shed its newest events would keep the start of an outage and lose its end -- including the
    // `NETWORK_RESTORED` that explains everything before it.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 8 }),
        async (recorded, maxQueued) => {
          const steps: Step[] = Array.from({ length: recorded }, () => ({ op: 'record' }));
          const result = await run(steps, 100, maxQueued);
          const kept = result.batcher.takeBatch().map((event) => event.seq);

          const expected = Array.from({ length: recorded }, (_, n) => n).slice(-maxQueued);
          expect(kept).toEqual(expected);
          expect(result.batcher.stats.dropped).toBe(Math.max(0, recorded - maxQueued));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never shows the transport an event twice, and never out of order', async () => {
    // A retry that re-sent a batch would double every strike in it. The batcher does not retry -- telemetry is
    // allowed to be lost -- and this is the property that keeps "not retried" from quietly becoming "sent twice".
    await fc.assert(
      fc.asyncProperty(scriptArb, async ({ steps, batchSize, maxQueued }) => {
        const result = await run(steps, batchSize, maxQueued);
        const ascending = result.offered.every(
          (seq, index) => index === 0 || seq > (result.offered[index - 1] ?? -1),
        );
        expect(ascending).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('never refuses and never throws at the watchdog, however long the network has been gone', async () => {
    // The exam surface must not learn that telemetry is failing. A `record` that threw on a full queue would take the
    // guard that called it down with it, mid-exam, for the students with the worst connections.
    const steps: Step[] = [];
    for (let n = 0; n < 2_000; n += 1) {
      steps.push({ op: 'record' });
      if (n % 7 === 0) steps.push({ op: 'flush', outcome: n % 2 === 0 ? 'threw' : 'refused' });
    }
    const result = await run(steps, 5, 10);
    expect(result.accepted).toBe(2_000);
    expect(result.delivered).toEqual([]);
    expect(result.batcher.stats.queued).toBeLessThanOrEqual(10);
  });
});

describe('the loss is visible to the SERVER, not only to the client that suffered it', () => {
  it('leaves a hole in `seq` exactly as wide as the client’s own `dropped` count', async () => {
    /**
     * `droppedEventCount` lives on the attempt, so the server has to be able to arrive at it. It has two sources: the
     * client's counter and the holes in the sequence numbers it received. If they disagreed, one of them would be
     * wrong in a teacher's timeline -- and the one that is self-reported is the one a hostile client controls.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 6 }),
        async (bursts, maxQueued) => {
          const steps: Step[] = [];
          for (const burst of bursts) {
            for (let n = 0; n < burst; n += 1) steps.push({ op: 'record' });
            // Enough successful flushes to drain whatever survived the burst.
            for (let n = 0; n < maxQueued; n += 1) steps.push({ op: 'flush', outcome: 'ok' });
          }
          const result = await run(steps, 1, maxQueued);

          const last = result.delivered[result.delivered.length - 1] ?? -1;
          const holes = last + 1 - result.delivered.length;
          expect(result.batcher.stats.queued).toBe(0);
          expect(holes).toBe(result.batcher.stats.dropped);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not re-queue a failed batch, and the hole it leaves is the only record of how MANY events went', async () => {
    /**
     * PINNED AS IT IS, with the limit stated: `batchesFailed` counts batches, not events, and `dropped` is documented
     * as "dropped because the queue was full". So after a failed flush the client's own statistics cannot say how many
     * events were lost -- three here, and the only counter that moved says `1`.
     *
     * The count is still recoverable, from the `seq` hole the server sees. That is the mechanism this asserts, and it
     * is the reason the previous test matters: `seq` is the authoritative loss record and the counters are a hint.
     */
    const result = await run(
      [
        { op: 'record' },
        { op: 'record' },
        { op: 'record' },
        { op: 'flush', outcome: 'refused' },
        { op: 'record' },
        { op: 'flush', outcome: 'ok' },
      ],
      3,
      50,
    );

    expect(result.lostInFlight).toEqual([0, 1, 2]);
    expect(result.delivered).toEqual([3]);
    expect(result.batcher.stats).toEqual({ queued: 0, sent: 1, dropped: 0, batchesFailed: 1 });
    // Three events are missing below the first one that arrived, and nothing else says so.
    expect(result.delivered[0]).toBe(3);
  });
});

describe('the unload path', () => {
  it('takes events out of the queue without counting them anywhere, which is the price of not awaiting', () => {
    /**
     * PINNED AS IT IS. `flushOnUnload` cannot learn whether a beacon arrived, so it can count neither a send nor a
     * failure, and after it runs `queued + sent + dropped` no longer adds up to what was accepted. That is `plans/09`
     * §7's "fire-and-forget and may be lost", and it is another reason `seq` holes, not client counters, have to be
     * what `droppedEventCount` is computed from.
     */
    const offered: number[] = [];
    const batcher = new EvidenceBatcher(
      {
        batchSize: 10,
        maxQueued: 50,
        transport: async (batch) => {
          offered.push(...batch.events.map((event) => event.seq));
          return false;
        },
      },
      { now: () => T0 },
      'attempt',
      'tab',
      () => 'sig',
    );
    batcher.record('TAB_HIDDEN');
    batcher.record('NETWORK_LOST');
    batcher.flushOnUnload();

    expect(offered).toEqual([0, 1]);
    expect(batcher.stats).toEqual({ queued: 0, sent: 0, dropped: 0, batchesFailed: 0 });
  });

  /**
   * `ADV-N1` -- KNOWN DEFECT in `evidence.ts`, outside this lane.
   *
   * `flushOnce` wraps the transport in `try/catch`; `flushOnUnload` calls it bare. A transport that throws
   * synchronously -- `sendBeacon` on a detached document, a serialiser choking on a payload -- throws out of the
   * `pagehide` handler.
   *
   * That is not cosmetic. `pagehide` is where the ANSWER outbox gets its last flush too (`lifecycleGuard`), so a
   * caller that flushes telemetry first and answers second loses the answer flush to a telemetry failure: the one
   * priority inversion `shedding.ts` exists to forbid. (A transport that REJECTS is the same hazard as an unhandled
   * rejection; it is not asserted here because a test cannot observe one without failing the run.)
   */
  it.fails('ADV-N1: never throws into the page’s unload handler', () => {
    const batcher = new EvidenceBatcher(
      {
        batchSize: 10,
        maxQueued: 50,
        transport: () => {
          throw new Error('sendBeacon: document is detached');
        },
      },
      { now: () => T0 },
      'attempt',
      'tab',
      () => 'sig',
    );
    batcher.record('TAB_HIDDEN');
    expect(() => {
      batcher.flushOnUnload();
    }).not.toThrow();
  });
});

describe('the answer path is not a queue that sheds, for any name it might be asked under', () => {
  it('refuses to shed every path that is not EXPLICITLY telemetry', () => {
    // The default is the guarantee. A new write path -- `outbox.fileUpload`, `outbox.simState` -- is answer-bearing
    // until someone registers it otherwise, and a shedder that asked about it before then must be told no.
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (pathId) => {
        expect(mayShed(pathId)).toBe(SHEDDABLE.has(pathId));
        if (!WRITE_PATHS.some((path) => path.id === pathId)) expect(mayShed(pathId)).toBe(false);
      }),
      { numRuns: RUNS },
    );
    for (const inherited of ['constructor', '__proto__', 'toString', 'has']) {
      expect(mayShed(inherited), inherited).toBe(false);
    }
  });

  it('gives every answer-bearing path the one overflow response that loses nothing and stops nobody', () => {
    // `GROW`, by value. Not "not DROP": `BLOCK_THE_WRITER` also loses nothing, and it is the answer that ends a
    // sitting for the student whose device filled up.
    expect(NEVER_SHED.length).toBeGreaterThan(0);
    for (const id of NEVER_SHED) {
      const path = WRITE_PATHS.find((candidate) => candidate.id === id);
      expect(path?.class, id).toBe('ANSWER_BEARING');
      expect(mayShed(id), id).toBe(false);
    }
    expect(overflowResponseFor('ANSWER_BEARING')).toBe('GROW');
    expect(overflowResponseFor('TELEMETRY')).toBe('DROP_OLDEST_AND_COUNT');
  });
});
