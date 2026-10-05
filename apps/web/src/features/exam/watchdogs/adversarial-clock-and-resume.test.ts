// @vitest-environment jsdom

/**
 * ADVERSARIAL: clock skew at the watchdog, and a reload mid-exam at the client.  (P8-T15, `plans/09` §5.1, §9)
 *
 * The pure halves of both axes are in `packages/exam-engine/src/adversarial/` (`clock-skew`, `replay-and-resume`).
 * This is what only the client can get wrong.
 *
 * ## SKEW IS DETECTED BY SAMPLING, AND A WATCHDOG THAT COMPARES CLOCKS IS A DIFFERENT, WORSE DETECTOR
 *
 * There are two ways to notice a clock is off. One compares a series of measured offsets against each other, which is
 * what `detectSkew` does. The other compares "now" against something -- the last tick, a deadline, a server timestamp
 * -- inside the guard. The second fires on every laptop that sleeps, every throttled background tab and every device
 * whose clock is simply wrong, and those are the students `RN-02` is about. So the guard's verdict must be a function
 * of the samples it is handed and of nothing else, and the first block pins that from three directions.
 *
 * ## A RELOAD IS THE MOMENT THE CLIENT'S STATE AND THE OUTBOX CAN DISAGREE
 *
 * The outbox is in IndexedDB and survives a reload. The reducer's state is in memory and does not. Everything that
 * goes wrong on resume is a consequence of rebuilding the second without consulting the first.
 *
 * **There is no production reload path to test.** Nothing in `apps/web` rebuilds an `AttemptState` from a persisted
 * outbox, so the reload tests below compose the public pieces the way that path will have to -- a fresh
 * `initialAttemptState` over the same store -- and say so where it matters (`ADV-W6`).
 */

import { FrozenClock } from '@orrery/clock';
import { DEFAULT_SKEW_THRESHOLDS } from '@orrery/clock/skew';
import { resolvePolicy } from '@orrery/contracts/policy';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AttemptState,
  initialAttemptState,
  type QueuedWrite,
  reduceAttempt,
} from '../answerStore';
import { flush, memoryOutboxStore, type WriteOutcome } from '../outbox';
import { resumePrompt } from '../resumePrompt';
import { correctedNow, displayOffset, offsetFromRoundTrip } from '../serverClock';
import { ClockGuard } from './clockGuard';
import type { Evidence } from './watchdog';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const RUNS = 300;

const host = { addEventListener: () => undefined, removeEventListener: () => undefined };

const guardWith = (clock: { now(): number }) => {
  const seen: Evidence[] = [];
  const guard = new ClockGuard(
    clock,
    (evidence) => {
      seen.push(evidence);
    },
    host,
  );
  guard.attach();
  return { guard, seen };
};

const sampleArb = fc.record({
  offsetMs: fc.integer({ min: -20_000, max: 20_000 }),
  rttMs: fc.integer({ min: 0, max: 8_000 }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('`clockGuard` reaches its verdict from the samples, never from a clock', () => {
  it('reports the same thing whatever the injected clock does between syncs', () => {
    /**
     * Two guards are fed the SAME samples. One has a clock that never moves; the other's leaps forwards and
     * backwards by up to three days between every sync -- a suspended laptop, a corrected RTC, a student changing
     * the system time. If the guard compared instants, the second would report and the first would not.
     */
    fc.assert(
      fc.property(
        fc.array(sampleArb, { maxLength: 16 }),
        fc.array(fc.integer({ min: -3 * DAY, max: 3 * DAY }), { minLength: 16, maxLength: 16 }),
        (samples, jumps) => {
          const still = guardWith(new FrozenClock(T0));
          const wild = new FrozenClock(T0);
          const moving = guardWith(wild);

          const stillStatuses = samples.map((sample) =>
            still.guard.record(sample.offsetMs, sample.rttMs),
          );
          const movingStatuses = samples.map((sample, index) => {
            wild.set(T0 + (jumps[index] ?? 0));
            return moving.guard.record(sample.offsetMs, sample.rttMs);
          });

          expect(movingStatuses).toEqual(stillStatuses);
          expect(moving.seen.map((e) => e.detail?.status)).toEqual(
            still.seen.map((e) => e.detail?.status),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not read the host clock at all, on any path', () => {
    // `INV-TIME-1` is a lint rule; this is the same rule as behaviour, so a `Date.now()` behind a helper is caught too.
    const dateNow = vi.spyOn(Date, 'now');
    const perfNow = vi.spyOn(performance, 'now');
    const { guard, seen } = guardWith(new FrozenClock(T0));
    for (let n = 0; n < 12; n += 1) guard.record(n < 6 ? 1_000 : 40_000, 100);

    expect(seen.length).toBeGreaterThan(0);
    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });

  it('does report when the SAMPLES jump, with a clock that has not moved a millisecond', () => {
    // The converse, or the two tests above would pass for a guard that never reports anything.
    const { guard, seen } = guardWith(new FrozenClock(T0));
    guard.record(1_000, 100);
    guard.record(1_020, 100);
    guard.record(46_000, 100);
    guard.record(46_010, 100);
    expect(seen.map((e) => e.kind)).toContain('CLOCK_SKEW_DETECTED');
  });

  it('puts nothing in the timeline for a client that cannot be measured, however long that lasts', () => {
    // Never synced, or every round trip too slow: `UNKNOWN`. A student on a bad link sits here for the whole exam,
    // and "we could not tell" must not accumulate into something that reads as "something was wrong".
    const slow = fc.record({
      offsetMs: fc.integer({ min: -3 * DAY, max: 3 * DAY }),
      rttMs: fc.integer({ min: DEFAULT_SKEW_THRESHOLDS.rttToleranceMs + 1, max: 120_000 }),
    });
    fc.assert(
      fc.property(fc.array(slow, { maxLength: 40 }), (samples) => {
        const { guard, seen } = guardWith(new FrozenClock(T0));
        for (const sample of samples)
          expect(guard.record(sample.offsetMs, sample.rttMs)).toBe('UNKNOWN');
        expect(seen).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('puts nothing in the timeline for a device that is wrong by days and steady', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3 * DAY, max: 3 * DAY }),
        fc.array(fc.integer({ min: -400, max: 400 }), { minLength: 2, maxLength: 20 }),
        (wrongBy, jitter) => {
          const { guard, seen } = guardWith(new FrozenClock(T0));
          for (const wobble of jitter) guard.record(wrongBy + wobble, 120);
          expect(seen).toEqual([]);
          expect(guard.verdict?.status).toBe('STABLE');
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('never tells the student, and says in the evidence that the server is what enforces time', () => {
    fc.assert(
      fc.property(fc.array(sampleArb, { maxLength: 24 }), (samples) => {
        const { guard, seen } = guardWith(new FrozenClock(T0));
        for (const sample of samples) guard.record(sample.offsetMs, sample.rttMs);
        for (const evidence of seen) {
          expect(evidence.kind).toBe('CLOCK_SKEW_DETECTED');
          expect(evidence.detail).toMatchObject({
            advisory: true,
            enforcedByServer: true,
            studentWarned: false,
          });
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a reload cannot reopen a paper because the device clock is wrong', () => {
  const deadlineAt = T0 + 60 * MINUTE;

  it('says TIME_PASSED exactly when the SERVER’s deadline has passed, for a device up to three days out', () => {
    /**
     * The whole client chain: one round trip measures the offset, the median picks it, `correctedNow` applies it,
     * and the resume screen decides. The device's clock is `wrongBy` off throughout.
     *
     * What breaks without the offset: a device ten minutes slow resumes a paper that closed ten minutes ago and is
     * shown an open one. The server will refuse every write, so nothing is gained -- and the student spends those
     * ten minutes answering questions that are not being stored.
     *
     * Instants within half a round trip of the deadline are skipped: that is the estimator's honest error, pinned
     * separately in `clock-skew.test.ts`.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: -3 * DAY, max: 3 * DAY }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: -30 * MINUTE, max: 30 * MINUTE }),
        (wrongBy, rtt, relativeToDeadline) => {
          fc.pre(Math.abs(relativeToDeadline) > rtt);

          // The sync, in true time; the device reads its own clock at both ends.
          const sentTrue = T0;
          const offset = displayOffset([
            offsetFromRoundTrip(sentTrue + wrongBy, sentTrue + rtt / 2, sentTrue + rtt + wrongBy),
          ]);

          // The resume, at some true instant either side of the deadline.
          const resumeTrue = deadlineAt + relativeToDeadline;
          const clientNow = resumeTrue + wrongBy;
          expect(Math.abs(correctedNow(clientNow, offset) - resumeTrue)).toBeLessThanOrEqual(
            rtt / 2,
          );

          const prompt = resumePrompt(
            { queued: [], durability: 'CLEAN', deadlineAt },
            { clientNow, offset },
          );
          expect(prompt?.kind === 'TIME_PASSED').toBe(resumeTrue > deadlineAt);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('gets it WRONG without the offset, which is what the test above is protecting against', () => {
    // The control. A device ten minutes slow, five minutes after the paper closed, asked with no correction.
    const clientNow = deadlineAt + 5 * MINUTE - 10 * MINUTE;
    const uncorrected = resumePrompt(
      { queued: [], durability: 'CLEAN', deadlineAt },
      { clientNow, offset: 0 },
    );
    expect(uncorrected).toBeNull();

    const corrected = resumePrompt(
      { queued: [], durability: 'CLEAN', deadlineAt },
      { clientNow, offset: 10 * MINUTE },
    );
    expect(corrected?.kind).toBe('TIME_PASSED');
  });

  it('never restarts a question’s clock by opening it again, which is what a reload does to every open question', () => {
    const start = initialAttemptState({
      attemptId: 'attempt',
      policy: resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { totalTimeLimitSec: 3600, perQuestionTimeLimitSec: 120 },
      }),
      deadlineAt,
      slots: [{ questionId: 'q1', questionDeadlineAt: null }],
    });
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 * MINUTE }), { minLength: 1, maxLength: 10 }),
        (later) => {
          let state = reduceAttempt(start, { type: 'OPEN_QUESTION', questionId: 'q1', at: T0 });
          const first = state.slots[0]?.questionDeadlineAt;
          for (const gap of later) {
            state = reduceAttempt(state, { type: 'OPEN_QUESTION', questionId: 'q1', at: T0 + gap });
          }
          expect(first).toBe(T0 + 120_000);
          expect(state.slots[0]?.questionDeadlineAt).toBe(first);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('a reload cannot double-count or lose a queued answer', () => {
  const start = (): AttemptState =>
    initialAttemptState({
      attemptId: 'attempt',
      policy: resolvePolicy({ mode: 'EXAM', versionPolicy: { totalTimeLimitSec: 3600 } }),
      deadlineAt: T0 + 60 * MINUTE,
      slots: ['q1', 'q2', 'q3', 'q4'].map((questionId) => ({
        questionId,
        questionDeadlineAt: null,
      })),
    });

  const answer = (
    state: AttemptState,
    questionId: string,
    value: string,
    at: number,
  ): AttemptState =>
    reduceAttempt(state, {
      type: 'ANSWER',
      questionId,
      answer: value,
      idempotencyKey: `key-${questionId}-${value}`,
      at,
    });

  it('re-sends an unacknowledged write under the SAME key and the same bytes, however many flushes it takes', async () => {
    /**
     * The client's half of "a replay is not a write". The server can only recognise a retry by its key, so a write
     * whose acknowledgement was lost must go out again byte for byte -- across flushes, and across a reload, because
     * the store is what survives one. A retry that minted a new key would be a second revision.
     *
     * The transport fails on a random schedule, including after the server has stored the write (the lost-ack case).
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
        async (failures) => {
          let state = start();
          for (const [index, questionId] of ['q1', 'q2', 'q3', 'q4'].entries()) {
            state = answer(state, questionId, `v${String(index)}`, T0 + index);
          }
          const store = memoryOutboxStore(state.queued);

          const offered: QueuedWrite[] = [];
          const storedByServer = new Map<string, unknown>();
          let call = 0;
          const send = async (write: QueuedWrite): Promise<WriteOutcome> => {
            offered.push(write);
            // The server stores it either way; only the ACK is in doubt.
            if (!storedByServer.has(write.idempotencyKey)) {
              storedByServer.set(write.idempotencyKey, write.answer);
            }
            const lostAck = failures[call % failures.length] ?? false;
            call += 1;
            return lostAck ? { kind: 'RETRY', message: 'timeout' } : { kind: 'ACK' };
          };

          // Flush until drained. Each flush after the first stands for a reconnect -- or a reload over the same store.
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const result = await flush(store, send);
            if (result.kind !== 'STOPPED') break;
          }

          // Every offer of a given `seq` carried the same key and the same answer.
          const bySeq = new Map<number, QueuedWrite>();
          for (const write of offered) {
            const earlier = bySeq.get(write.seq);
            if (earlier !== undefined) expect(write).toEqual(earlier);
            bySeq.set(write.seq, write);
          }
          // So the server holds one write per `seq` it was ever offered, not one per attempt.
          expect(storedByServer.size).toBe(bySeq.size);
          // And nothing overtook anything: first offers are in `seq` order.
          const firstOffers = [...new Set(offered.map((write) => write.seq))];
          expect(firstOffers).toEqual([...firstOffers].sort((a, b) => a - b));
        },
      ),
      { numRuns: 150 },
    );
  });

  it('keeps every answer written during an outage of any length: the answer queue does not shed', async () => {
    // `B10`, at the queue a mark depends on. Five thousand answers offline is absurd for a student and ordinary for
    // an autosave that fires on every keystroke; the telemetry queue would have dropped 4 500 of them.
    let state = reduceAttempt(start(), { type: 'OFFLINE' });
    for (let n = 0; n < 5_000; n += 1) {
      state = answer(state, `q${String((n % 4) + 1)}`, `v${String(n)}`, T0 + n);
    }
    expect(state.queued).toHaveLength(5_000);
    expect(state.queued.map((write) => write.seq)).toEqual(
      Array.from({ length: 5_000 }, (_, n) => n + 1),
    );

    const sent: number[] = [];
    const result = await flush(memoryOutboxStore(state.queued), async (write) => {
      sent.push(write.seq);
      return { kind: 'ACK' };
    });
    expect(result).toEqual({ kind: 'DRAINED', sent: 5_000 });
    expect(sent).toEqual(state.queued.map((write) => write.seq));
  });

  it('never tells a returning student their answers are saved while any are still waiting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom<AttemptState['durability']>('CLEAN', 'PENDING', 'OFFLINE', 'ABANDONED'),
        (count, durability) => {
          let state = start();
          for (let n = 0; n < count; n += 1) state = answer(state, 'q1', `v${String(n)}`, T0 + n);
          const prompt = resumePrompt(
            { queued: state.queued, durability, deadlineAt: state.deadlineAt },
            { clientNow: T0 + 1_000, offset: 0 },
          );
          expect(prompt?.kind).toBe('UNSAVED');
          expect(prompt?.blocking).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * `ADV-W6` -- KNOWN DEFECT in `answerStore.ts`, outside this lane. **This one loses an answer.**
   *
   * `outboxIndexedDb.ts` keys the outbox by `seq` and says why: "the reducer allocates `seq` and it must survive a
   * reload". It does not survive one. `initialAttemptState` hard-codes `nextSeq: 1` and takes no argument that could
   * say otherwise, so a reloaded client numbers its first new write `1` -- and `put` on a store keyed by `seq`
   * REPLACES whatever unsent write was already at 1.
   *
   * Below: two answers are queued and not yet sent, the page reloads, the student answers a third question, and the
   * first answer is gone from the outbox without ever having been offered to the server. No error, no conflict.
   *
   * The same missing rehydration resets `revisions` to empty, so after a reload the first edit to an already-answered
   * question is sent as revision 1 and comes back a 409 -- "this answer was changed somewhere else" -- about the
   * student's own earlier save.
   *
   * No reload path exists in `apps/web` yet, so this is the hazard waiting for whoever writes it, composed from the
   * only public pieces there are.
   */
  it('ADV-W6: does not overwrite an unsent write when the page reloads and the student keeps answering', async () => {
    // Before the reload: two answers, queued and persisted, the network down.
    let before = start();
    before = answer(before, 'q1', 'first', T0);
    before = answer(before, 'q2', 'second', T0 + 1);
    const store = memoryOutboxStore();
    for (const write of before.queued) await store.put(write);

    // The reload: memory is gone, the store is not.
    let reloaded = start();
    reloaded = answer(reloaded, 'q3', 'third', T0 + 2);
    for (const write of reloaded.queued) await store.put(write);

    const delivered: string[] = [];
    await flush(store, async (write) => {
      delivered.push(write.questionId);
      return { kind: 'ACK' };
    });
    expect(delivered.sort()).toEqual(['q1', 'q2', 'q3']);
  });
});
