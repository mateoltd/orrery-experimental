'use client';

/**
 * The IndexedDB outbox: unsent writes, flushed in `seq` order.  (P7-T6)
 *
 * ## THE POLICY IS HERE AND THE INDEXEDDB IS A PLUG
 *
 * `plans/01` §9.3: "An IndexedDB outbox holds unsent writes and flushes in `seq` order on reconnect." Everything
 * that is hard about that sentence is in the ORDERING and in what happens when a flush fails part-way, and
 * neither of those is IndexedDB's business. So the queue is a pure function of an injected `OutboxStore`, and
 * `outboxIndexedDb.ts` is a thin adapter with no logic in it -- including the rule that a `put` never replaces a
 * different write, which is `admit` below and is applied in front of whatever plug is supplied.
 *
 * That split is what makes the interesting cases testable without a browser: a flush where the third write
 * returns a 500, a reconnect after ten minutes, a duplicate `seq`, a device that ran out of quota. None of those
 * need IndexedDB to reproduce, and all of them are where a queue loses a student's work.
 *
 * ## WHY ORDER MATTERS MORE THAN IT LOOKS
 *
 * The server applies writes with a `revision` check, and a stale revision is a `409`. If two writes for the same
 * question were sent out of order -- revision 3 arriving before revision 2 -- then revision 2 would be refused as
 * stale and the server would keep revision 2's value, having discarded the student's later answer. So the queue
 * is strictly ordered by `seq` and **a failed write STOPS the flush** rather than being skipped.
 *
 * Skipping is the tempting behaviour and it is wrong here: writes to DIFFERENT questions are independent, so
 * skipping looks harmless, and the harm is that a permanently-failing write (a 409 that never resolves, a
 * question that was withdrawn) then blocks every write behind it for ever. So the policy is: stop, report, and
 * let the caller decide -- with an explicit `DEAD_LETTER` escape for a write that must not block the queue.
 */

import type { QueuedWrite } from './answerStore';

/**
 * THE PLUG: four operations, no queries, no cursors, and NO RULES. `outboxIndexedDb.ts` is one of these.
 *
 * `put` on a plug REPLACES whatever is at that `seq`. That is what a key-value store does, and it is exactly why a
 * plug is never handed to the queue directly -- see `OutboxStore`.
 */
export interface OutboxPlug {
  /** All entries, in ANY order. The queue sorts; the store need not. */
  all(): Promise<readonly QueuedWrite[]>;
  put(entry: QueuedWrite): Promise<unknown>;
  remove(seq: number): Promise<unknown>;
  clear(): Promise<unknown>;
}

/**
 * THE PERSISTENCE THE QUEUE NEEDS: a plug whose `put` CANNOT replace a different write. (`ADV-W6`)
 *
 * `neverOverwrites` is a real member with a literal type, so a bare plug is not assignable here and `flush` on one is
 * a compile error. The only way to get an `OutboxStore` is `outboxOver`, and that is where the rule lives.
 */
export interface OutboxStore {
  readonly neverOverwrites: true;
  all(): Promise<readonly QueuedWrite[]>;
  /** Stores `entry` unless it is already held. May store it under a LATER `seq` than it asked for; see `admit`. */
  put(entry: QueuedWrite): Promise<void>;
  remove(seq: number): Promise<void>;
  clear(): Promise<void>;
}

/**
 * WHAT `put` ACTUALLY STORES: the entry, the entry renumbered, or nothing.
 *
 * ## THE LOSS THIS EXISTS FOR
 *
 * The outbox is keyed by `seq` and survives a reload. The reducer's state does not, and a client rebuilt without
 * being told what the outbox holds numbers its first new write `1`. `put` then REPLACED the unsent write already at
 * 1: an answer the student typed, saw acknowledged as "saved on this device", and lost -- never offered to the
 * server, with no error and no conflict anywhere.
 *
 * `initialAttemptState`'s `unsent` is the fix for the numbering. This is the fix for the consequence, and it does not
 * depend on anybody remembering the first one: **a write that is in the outbox leaves it by being sent, and by no
 * other route.**
 *
 *  · The same `idempotencyKey` is the same write -- a retried `put`, or a caller persisting its whole queue after
 *    every answer. Nothing is stored, and what is held is not disturbed: it may already be in flight.
 *  · A free `seq` is taken as asked.
 *  · A `seq` held by a DIFFERENT write means the two were numbered by clients that did not know about each other.
 *    The newcomer goes after everything already queued, because it was written after all of it.
 *
 * A renumbered write no longer has the `seq` the reducer gave it, so that reducer's count of what is waiting is
 * wrong until it is rebuilt from `all()`. It was wrong already -- it did not know the write it collided with
 * existed -- and a wrong count can be put right, where a replaced write cannot be got back.
 */
export const admit = (held: readonly QueuedWrite[], entry: QueuedWrite): QueuedWrite | null => {
  if (held.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) return null;
  if (!held.some((existing) => existing.seq === entry.seq)) return entry;
  const highest = held.reduce((most, existing) => Math.max(most, existing.seq), entry.seq);
  return { ...entry, seq: highest + 1 };
};

/**
 * A PLUG, WITH THE RULE IN FRONT OF IT.
 *
 * `put` reads and then writes, so two of them must not interleave: both would see the `seq` free and the second
 * would replace the first, which is the loss again by a shorter road. They are chained, one behind the other, and a
 * `put` that rejects does not break the chain for the next.
 *
 * That makes it safe within one tab. Across tabs it is not atomic -- the read and the write are separate
 * transactions on a real database -- and one writer per attempt is `tabCoordination.ts`'s job.
 */
export const outboxOver = (plug: OutboxPlug): OutboxStore => {
  let last: Promise<unknown> = Promise.resolve();
  return {
    neverOverwrites: true,
    all: () => plug.all(),
    put: (entry) => {
      const stored = last.then(async () => {
        const admitted = admit(await plug.all(), entry);
        if (admitted !== null) await plug.put(admitted);
      });
      last = stored.catch(() => undefined);
      return stored;
    },
    remove: async (seq) => {
      await plug.remove(seq);
    },
    clear: async () => {
      await plug.clear();
    },
  };
};

/** What happened to one write. `RETRY` and `DEAD_LETTER` are both refusals to continue. */
export type WriteOutcome =
  | { readonly kind: 'ACK' }
  /** A stale revision. The caller must surface "keep mine / keep theirs" -- this is not retryable. */
  | { readonly kind: 'CONFLICT'; readonly serverAnswer: unknown; readonly serverRevision: number }
  /** A transport or 5xx failure. Retryable, and it STOPS the flush. */
  | { readonly kind: 'RETRY'; readonly message: string };

export type FlushResult =
  | { readonly kind: 'DRAINED'; readonly sent: number }
  /** Stopped at `write`, having sent everything before it. `write` is still queued. */
  | {
      readonly kind: 'STOPPED';
      readonly sent: number;
      readonly write: QueuedWrite;
      readonly reason: 'RETRY' | 'CONFLICT';
    }
  /** Nothing to send. Not an error: a reconnect with an empty queue is the common case. */
  | { readonly kind: 'NOTHING_TO_DO' };

/** The send function. Injected so the queue's ordering is testable without a network or a fetch mock. */
export type SendWrite = (write: QueuedWrite) => Promise<WriteOutcome>;

/** A write that must not block the queue behind it, whatever it does. */
export interface DeadLetterRule {
  readonly matches: (write: QueuedWrite) => boolean;
  /** Why it was abandoned, kept for the student-facing message. */
  readonly because: string;
}

/**
 * FLUSH THE QUEUE IN `seq` ORDER, STOPPING AT THE FIRST NON-ACK.
 *
 * Returns rather than throws, because every failure mode here is expected: a student on a train will produce a
 * `RETRY` on most flushes, and an exception would mean the reconnect handler needs a try/catch to avoid taking
 * down the page a student is taking an exam on.
 */
export const flush = async (
  store: OutboxStore,
  send: SendWrite,
  options: { readonly deadLetters?: readonly DeadLetterRule[] } = {},
): Promise<FlushResult> => {
  const deadLetters = options.deadLetters ?? [];
  const all = await store.all();
  if (all.length === 0) return { kind: 'NOTHING_TO_DO' };

  /**
   * SORTED BY `seq`, AND THE SORT IS THE POINT.
   *
   * `store.all()` is allowed to return entries in any order, so the ordering is established here rather than
   * trusted. Sorting numerically rather than lexicographically matters at the boundary: string ordering puts
   * `'10'` before `'9'`, so a paper with ten or more writes would send the tenth revision first and the ninth
   * would come back a `409`.
   */
  const ordered = [...all].sort((a, b) => a.seq - b.seq);
  let sent = 0;

  for (const write of ordered) {
    const rule = deadLetters.find((candidate) => candidate.matches(write));
    if (rule !== undefined) {
      // Removed, not skipped: keeping it would keep it blocking the queue behind it.
      await store.remove(write.seq);
      sent += 1;
      continue;
    }

    const outcome = await send(write);
    if (outcome.kind === 'ACK') {
      await store.remove(write.seq);
      sent += 1;
      continue;
    }
    if (outcome.kind === 'CONFLICT') return { kind: 'STOPPED', sent, write, reason: 'CONFLICT' };
    return { kind: 'STOPPED', sent, write, reason: 'RETRY' };
  }

  return { kind: 'DRAINED', sent };
};

/**
 * AN IN-MEMORY STORE, for tests and for the server render.
 *
 * Also the reference implementation of the interface: if the IndexedDB adapter and this disagree about the four
 * operations, the adapter is wrong, and this is the definition it is checked against.
 *
 * It is `outboxOver` a plug like any other, so the reference and the real store share the one copy of the rule. The
 * seed goes through `admit` too: a store that could be BUILT holding two writes at one `seq` would be a store whose
 * guarantee started after construction.
 */
export const memoryOutboxStore = (
  seed: readonly QueuedWrite[] = [],
): OutboxStore & { snapshot(): readonly QueuedWrite[] } => {
  let entries: readonly QueuedWrite[] = [];
  for (const entry of seed) {
    const admitted = admit(entries, entry);
    if (admitted !== null) entries = [...entries, admitted];
  }
  const store = outboxOver({
    all: async () => entries,
    put: async (entry) => {
      entries = [...entries.filter((existing) => existing.seq !== entry.seq), entry];
    },
    remove: async (seq) => {
      entries = entries.filter((entry) => entry.seq !== seq);
    },
    clear: async () => {
      entries = [];
    },
  });
  return { ...store, snapshot: () => entries };
};

/**
 * WHETHER MORE THAN `budgetMs` HAS ELAPSED SINCE THE LAST WRITE, so a reconnect flushes at once.
 *
 * `plans/01` §9.3 says the outbox flushes "on reconnect", and this is the OTHER trigger: a student who has been
 * typing for a while with the network up has writes that have not been sent because nothing asked them to be.
 * The budget is a constant rather than a policy field because `plans/09` §4's policy has no autosave field, and
 * adding one would change `INV-POLICY-1`'s hashed snapshot for every existing attempt.
 */
export const AUTOSAVE_BUDGET_MS = 2_000;

export const shouldFlushNow = (
  lastFlushAt: number | null,
  now: number,
  budgetMs = AUTOSAVE_BUDGET_MS,
): boolean => lastFlushAt === null || now - lastFlushAt >= budgetMs;
