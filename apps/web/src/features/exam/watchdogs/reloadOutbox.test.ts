/**
 * A RELOAD DOES NOT COST AN ANSWER.  (`ADV-W6`)
 *
 * The outbox is in IndexedDB and survives a reload. The reducer's state is in memory and does not. `ADV-W6` was the
 * two being put back together wrongly: a state that numbered from 1 again, over a store that replaced whatever was
 * already at 1.
 *
 * There are two guarantees here and they are deliberately independent, because the first one depends on a caller
 * doing something and the second does not:
 *
 *  · `initialAttemptState({ unsent })` -- a state told what the outbox holds continues from it.
 *  · `OutboxStore.put` -- a state that was NOT told still cannot replace a write that has not been sent.
 *
 * ## WHAT IS AND IS NOT EXERCISED
 *
 * Everything below runs against `memoryOutboxStore`, which is `outboxOver` an in-memory plug. `outboxIndexedDb.ts` is
 * a plug too, and the last block checks -- at COMPILE time only -- that it has to go through `outboxOver` to be
 * flushed. No test here opens an IndexedDB, and there is still no reload path in `apps/web` to drive.
 */

import { resolvePolicy } from '@orrery/contracts/policy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type AttemptState,
  durabilityLabel,
  initialAttemptState,
  type QueuedWrite,
  reduceAttempt,
  unanswered,
} from '../answerStore';
import {
  admit,
  flush,
  memoryOutboxStore,
  type OutboxPlug,
  type OutboxStore,
  outboxOver,
} from '../outbox';
import { indexedDbOutboxStore } from '../outboxIndexedDb';

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const paper = {
  attemptId: 'attempt',
  policy: resolvePolicy({ mode: 'EXAM', versionPolicy: { totalTimeLimitSec: 3600 } }),
  deadlineAt: T0 + 60 * MINUTE,
  slots: ['q1', 'q2', 'q3', 'q4'].map((questionId) => ({ questionId, questionDeadlineAt: null })),
};

const answer = (state: AttemptState, questionId: string, value: string, at: number): AttemptState =>
  reduceAttempt(state, {
    type: 'ANSWER',
    questionId,
    answer: value,
    idempotencyKey: `key-${questionId}-${value}`,
    at,
  });

/** `seq` is the only thing `admit` may change, so nothing else here is derived from it. */
const write = (seq: number, key: string, questionId = 'q1'): QueuedWrite => ({
  seq,
  questionId,
  answer: key,
  revision: 1,
  idempotencyKey: key,
  issuedAt: T0,
});

describe('a state rebuilt from the outbox continues from it', () => {
  const beforeReload = (): AttemptState => {
    let state = initialAttemptState(paper);
    state = answer(state, 'q1', 'first', T0);
    state = answer(state, 'q2', 'second', T0 + 1);
    state = answer(state, 'q1', 'first, revised', T0 + 2);
    return state;
  };

  it('numbers the next write after the highest one waiting, not from 1', () => {
    const before = beforeReload();
    expect(before.queued.map((queued) => queued.seq)).toEqual([1, 2, 3]);

    const reloaded = initialAttemptState({ ...paper, unsent: before.queued });
    expect(reloaded.nextSeq).toBe(4);
    expect(answer(reloaded, 'q3', 'third', T0 + 3).queued.map((queued) => queued.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('takes the store’s order for nothing: the same state from the writes in any order', () => {
    // `OutboxStore.all()` promises no order, so a state that believed it would call the FIRST write to a question
    // the answer whenever the store happened to return them backwards.
    const before = beforeReload();
    fc.assert(
      fc.property(fc.shuffledSubarray([...before.queued], { minLength: 3 }), (shuffled) => {
        expect(initialAttemptState({ ...paper, unsent: shuffled })).toEqual(
          initialAttemptState({ ...paper, unsent: before.queued }),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('gives back what the student sees: the answers, the revisions, and an honest indicator', () => {
    const before = beforeReload();
    const reloaded = initialAttemptState({ ...paper, unsent: before.queued });

    expect(reloaded.answers).toEqual({ q1: 'first, revised', q2: 'second' });
    expect(reloaded.revisions).toEqual({ q1: 2, q2: 1 });
    expect(reloaded.queued).toEqual(before.queued);
    expect(unanswered(reloaded)).toEqual(['q3', 'q4']);
    expect(reloaded.status).toBe('IN_PROGRESS');
    // Never "All answers saved" over writes that have not been sent.
    expect(reloaded.durability).toBe('PENDING');
    expect(durabilityLabel(reloaded)).toBe('Saving… 3');
  });

  it('sends the next edit to an unsent answer as the NEXT revision, not as revision 1 again', () => {
    // The other half of the missing rehydration: revision 1 twice is a `409` about the student's own save.
    const reloaded = initialAttemptState({ ...paper, unsent: beforeReload().queued });
    const edited = answer(reloaded, 'q1', 'first, revised again', T0 + 3);
    expect(edited.queued.at(-1)).toMatchObject({ questionId: 'q1', revision: 3, seq: 4 });
  });

  it('treats a queued CLEAR as unanswered, which is what the student last did', () => {
    const cleared: QueuedWrite = {
      seq: 2,
      questionId: 'q1',
      answer: undefined,
      revision: 2,
      idempotencyKey: 'key-q1-cleared',
      issuedAt: T0 + 1,
    };
    const reloaded = initialAttemptState({ ...paper, unsent: [write(1, 'key-q1-first'), cleared] });
    expect(Object.hasOwn(reloaded.answers, 'q1')).toBe(false);
    expect(reloaded.revisions).toEqual({ q1: 2 });
    expect(unanswered(reloaded)).toContain('q1');
  });

  it('cannot be made to reach `Object.prototype` by a question id it did not choose', () => {
    const hostile = initialAttemptState({
      ...paper,
      unsent: [{ ...write(1, 'key-proto', '__proto__'), answer: { polluted: true }, revision: 7 }],
    });
    expect(Object.getPrototypeOf(hostile.answers)).toBe(Object.prototype);
    expect(Object.hasOwn(hostile.answers, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(hostile.revisions, '__proto__')?.value).toBe(7);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is unchanged for a paper nobody has written to', () => {
    // Every existing caller. `unsent: []` and no `unsent` at all are the same start.
    const fresh = initialAttemptState(paper);
    expect(initialAttemptState({ ...paper, unsent: [] })).toEqual(fresh);
    expect(fresh).toMatchObject({
      nextSeq: 1,
      queued: [],
      answers: {},
      revisions: {},
      status: 'NOT_STARTED',
      durability: 'CLEAN',
    });
  });

  it('delivers everything, in order, and ends CLEAN: the reload path as it has to be composed', async () => {
    // Before: two answers persisted, the network down.
    let before = initialAttemptState(paper);
    before = answer(before, 'q1', 'first', T0);
    before = answer(before, 'q2', 'second', T0 + 1);
    const store = memoryOutboxStore();
    for (const queued of before.queued) await store.put(queued);

    // The reload: the state is rebuilt FROM the store, and the student answers a third question.
    let state = initialAttemptState({ ...paper, unsent: await store.all() });
    state = answer(state, 'q3', 'third', T0 + 2);
    for (const queued of state.queued) await store.put(queued);
    // Nothing was renumbered, because nothing collided: the store and the reducer agree on every `seq`.
    expect(store.snapshot()).toEqual(state.queued);

    const delivered: string[] = [];
    const result = await flush(store, async (sent) => {
      delivered.push(sent.questionId);
      state = reduceAttempt(state, { type: 'ACK', seq: sent.seq });
      return { kind: 'ACK' };
    });
    expect(result).toEqual({ kind: 'DRAINED', sent: 3 });
    expect(delivered).toEqual(['q1', 'q2', 'q3']);
    expect(state.queued).toEqual([]);
    expect(state.durability).toBe('CLEAN');
  });
});

describe('a write in the outbox leaves it by being sent, and by no other route', () => {
  it('decides each `put` by one rule: the same write, a free `seq`, or a `seq` somebody else holds', () => {
    const held = [write(1, 'a'), write(2, 'b'), write(7, 'c')];
    // The same write again -- whatever `seq` it now claims. Nothing is stored and what is held is untouched.
    expect(admit(held, write(1, 'a'))).toBeNull();
    expect(admit(held, write(4, 'a'))).toBeNull();
    // A free `seq` is taken as asked.
    expect(admit(held, write(3, 'd'))).toEqual(write(3, 'd'));
    expect(admit([], write(1, 'd'))).toEqual(write(1, 'd'));
    // A `seq` held by a different write: after everything queued, never in its place.
    expect(admit(held, write(1, 'd'))).toEqual(write(8, 'd'));
    expect(admit(held, write(7, 'd'))).toEqual(write(8, 'd'));
  });

  it('keeps every write from any number of sessions that each numbered from 1', async () => {
    /**
     * The defect, generalised: several page loads over one store, none of them told what it holds, each persisting
     * its whole queue after every answer the way an autosave does. Every answer any of them wrote is offered to the
     * server exactly once, and nothing a later session wrote overtakes an earlier session's.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }),
        async (answersPerSession) => {
          const store = memoryOutboxStore();
          const written: string[] = [];
          for (const [session, count] of answersPerSession.entries()) {
            let state = initialAttemptState(paper);
            for (let n = 0; n < count; n += 1) {
              const value = `s${String(session)}-n${String(n)}`;
              state = answer(state, `q${String((n % 4) + 1)}`, value, T0 + n);
              written.push(value);
              for (const queued of state.queued) await store.put(queued);
            }
          }

          const seqs = store.snapshot().map((queued) => queued.seq);
          expect(new Set(seqs).size).toBe(seqs.length);

          const delivered: unknown[] = [];
          const result = await flush(store, async (sent) => {
            delivered.push(sent.answer);
            return { kind: 'ACK' };
          });
          expect(result).toEqual({ kind: 'DRAINED', sent: written.length });
          expect(delivered).toEqual(written);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps both of two `put`s that were not awaited, at the same `seq`', async () => {
    // Read-then-write, twice, interleaved: both see the `seq` free and the second replaces the first. The chain in
    // `outboxOver` is what stops it, and removing the chain turns this red.
    const store = memoryOutboxStore();
    await Promise.all([
      store.put(write(1, 'a')),
      store.put(write(1, 'b')),
      store.put(write(1, 'c')),
    ]);
    expect(store.snapshot()).toEqual([write(1, 'a'), write(2, 'b'), write(3, 'c')]);
  });

  it('reports a `put` the plug could not store, and stores the next one all the same', async () => {
    // A quota failure must not look like a save -- and must not jam every save behind it.
    let entries: readonly QueuedWrite[] = [];
    let failNext = true;
    const store = outboxOver({
      all: async () => entries,
      put: async (entry) => {
        if (failNext) {
          failNext = false;
          throw new Error('QuotaExceededError');
        }
        entries = [...entries, entry];
      },
      remove: async () => undefined,
      clear: async () => undefined,
    });

    await expect(store.put(write(1, 'a'))).rejects.toThrow('QuotaExceededError');
    await store.put(write(1, 'b'));
    expect(entries).toEqual([write(1, 'b')]);
  });

  it('cannot be BUILT holding two writes at one `seq` either', () => {
    expect(memoryOutboxStore([write(1, 'a'), write(1, 'b'), write(1, 'a')]).snapshot()).toEqual([
      write(1, 'a'),
      write(2, 'b'),
    ]);
  });

  it('makes flushing a bare plug a compile error, and the IndexedDB adapter is a bare plug', () => {
    // Checked by `tsc`, not by running: nothing here opens a database. If the adapter ever became assignable to
    // `OutboxStore` without going through `outboxOver`, the `@ts-expect-error` lines would themselves stop compiling.
    const typesOnly = (plug: OutboxPlug): readonly OutboxStore[] => {
      // @ts-expect-error -- a plug's `put` replaces; an `OutboxStore`'s cannot, and says so in its type.
      const refused: OutboxStore = plug;
      // @ts-expect-error -- so the real adapter cannot be flushed directly...
      void flush(indexedDbOutboxStore(), async () => ({ kind: 'ACK' }));
      // ...and can be once the rule is in front of it.
      return [refused, outboxOver(plug), outboxOver(indexedDbOutboxStore())];
    };
    expect(typeof typesOnly).toBe('function');
    expect(memoryOutboxStore().neverOverwrites).toBe(true);
  });
});
