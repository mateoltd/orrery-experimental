'use client';

/**
 * The IndexedDB adapter for the outbox.  (P7-T6)
 *
 * The store's items are `QueuedWrite`, imported as a TYPE only: the reducer is the sole writer of answers, and an
 * outbox entry is a queued write rather than a second copy of the truth.
 *
 * ## ALL THE LOGIC IS IN `outbox.ts`, AND THIS FILE HAS NONE
 *
 * Four operations, and each is a single transaction. The ordering, the stop-on-failure rule and the dead-letter
 * escape are all in the queue, so this file cannot get them wrong -- it can only fail to store a write, which is
 * a different class of problem and a much easier one to see.
 *
 * ## WHY THE STORE IS OPENED BY THE CALLER AND CACHED HERE
 *
 * `indexedDB.open` is asynchronous and the attempt screen cannot afford to wait for it on the first autosave, so
 * the connection is opened once and shared. `resetOutboxConnection` exists because a test -- and a browser that
 * has deleted the database out from under a long-lived tab -- needs to force a reopen, and a cached promise that
 * cannot be cleared is a connection that cannot recover.
 *
 * ## AND A WRITE THAT CANNOT BE STORED IS REPORTED, NOT SWALLOWED
 *
 * A quota failure or a blocked upgrade must not look like a successful autosave. `put` resolves or it throws; the
 * caller decides, and the durability indicator above says `Saving…` rather than `All answers saved` until the
 * server has acknowledged. Silently dropping an unstoreable write would leave the student believing an answer was
 * saved when the only copy was in a JavaScript object about to be garbage collected.
 */

import type { QueuedWrite } from './answerStore';

/** The schema. One store, keyed by `seq`, because the queue's order IS the key order. */
const DB_NAME = 'orrery-outbox';
const DB_VERSION = 1;
const STORE = 'writes';

/** One connection, shared. `null` until something asks for it. */
let connection: Promise<IDBDatabase> | null = null;

/**
 * OPENS (OR REUSES) THE CONNECTION.
 *
 * `onblocked` is handled explicitly because it is the one case where the promise would otherwise hang for ever:
 * another tab is holding an older version open, and the browser will not upgrade until it closes. A student with
 * two tabs open would sit there forever, so this resolves the failure and lets the caller surface it.
 */
export const outboxConnection = (): Promise<IDBDatabase> => {
  if (connection !== null) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // `keyPath: 'seq'` with no autoIncrement: the reducer allocates `seq` and it must survive a reload, so
        // the database must never be the thing that decides it.
        db.createObjectStore(STORE, { keyPath: 'seq' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // If ANOTHER tab upgrades the schema, this connection becomes stale and every later transaction throws.
      // Closing on the event is what stops a second tab's autosave from failing with an inscrutable error.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('the outbox could not be opened'));
    request.onblocked = () =>
      reject(new Error('another tab is holding the outbox open; close it and reload to continue'));
  });
  // A rejected promise cached for ever would make every later autosave fail for the life of the tab.
  connection.catch(() => {
    connection = null;
  });
  return connection;
};

/** Drops the cached connection. For tests, and for a tab whose database was deleted underneath it. */
export const resetOutboxConnection = (): void => {
  connection = null;
};

/** One transaction, resolved on `complete` rather than on the request's own success. */
const transact = async <T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await outboxConnection();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    /**
     * RESOLVED ON THE TRANSACTION'S `complete`, NOT THE REQUEST'S `success`.
     *
     * A request's `success` fires when the request is done; the transaction commits afterwards. Awaiting the
     * request would report a write as saved before it is durable, and a tab closed in between loses it — which is
     * the exact failure an outbox exists to prevent.
     */
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('the outbox transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('the outbox transaction was aborted'));
  });
};

/**
 * THE ADAPTER. Four methods, no logic, and the order of `all()` is deliberately unspecified.
 *
 * `all()` does not sort: `flush` sorts, because the queue owns the ordering and a store that also sorted would
 * be a second place for the two to disagree about what order means.
 */
export const indexedDbOutboxStore = () => ({
  /**
   * `getAll()` returns whatever was put, and `put` was handed a `QueuedWrite`, so the result is one. The cast
   * goes through `unknown` because `IDBRequest<any[]>` and `IDBRequest<readonly QueuedWrite[]>` do not overlap
   * enough for TypeScript to allow it directly -- and the cast is confined to THIS line rather than to the
   * `OutboxStore` interface, so nothing else in the queue is trusting an assertion it has not checked.
   */
  all: () =>
    transact<readonly QueuedWrite[]>(
      'readonly',
      (store) => store.getAll() as unknown as IDBRequest<readonly QueuedWrite[]>,
    ),
  put: (entry: { readonly seq: number }) => transact('readwrite', (store) => store.put(entry)),
  remove: (seq: number) => transact('readwrite', (store) => store.delete(seq)),
  clear: () => transact('readwrite', (store) => store.clear()),
});
