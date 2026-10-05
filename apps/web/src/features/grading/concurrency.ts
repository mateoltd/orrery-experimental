import type { DraftStore } from './draft';
import type { ResponseFacts } from './markingState';

export interface GradingPresence {
  graderId: string;
  name: string;
  responseId: string | null;
  expiresAt: number;
}

/** Leases advise; only a version check can refuse a write. A crashed tab stops being present. */
export const activeGraders = (leases: readonly GradingPresence[], graderId: string, now: number) =>
  leases.filter((lease) => lease.graderId !== graderId && lease.expiresAt > now);

const COUNTER = /^(0|[1-9][0-9]*)$/;

/** The database token is `revision`, a counter. Anything else is opaque and only ever compared for equality. */
const olderThan = (a: string, b: string): boolean =>
  COUNTER.test(a) && COUNTER.test(b) && BigInt(a) < BigInt(b);

/** A refresh cannot discard the teacher's acknowledged mark or a draft still written against it. */
export const changedElsewhere = (
  held: readonly ResponseFacts[],
  incoming: readonly ResponseFacts[],
) =>
  incoming.filter((facts) => {
    const mine = held.find((row) => row.responseId === facts.responseId);
    if (!mine || mine.version === facts.version) return false;
    // An older query cache is not another teacher's later save.
    return !olderThan(facts.version, mine.version);
  });

/**
 * The newest account of each response this tab has been GIVEN: the host's refresh, or the row a refused save came
 * back with. A conflict the teacher answered "keep theirs" is still a change they are not being shown, whether or
 * not the host has refetched yet.
 */
export const newestKnown = (
  refreshed: readonly ResponseFacts[],
  fromConflicts: Readonly<Record<string, ResponseFacts>>,
): readonly ResponseFacts[] =>
  refreshed.map((facts) => {
    const conflict = fromConflicts[facts.responseId];
    return conflict !== undefined && olderThan(facts.version, conflict.version) ? conflict : facts;
  });

/** Take the newer account of every changed response, and leave the rest exactly as held. */
export const adoptChanged = (
  held: readonly ResponseFacts[],
  changed: readonly ResponseFacts[],
): readonly ResponseFacts[] =>
  held.map((row) => changed.find((facts) => facts.responseId === row.responseId) ?? row);

/**
 * Report, per response, whether its draft is on the device.
 *
 * Reloading the paper rebuilds every response from the facts and the device. A draft the device refused is in this
 * tab's memory and nowhere else, so a reload would clear it without a word; the caller needs to know before offering
 * one.
 */
export const trackingDraftStore = (
  store: DraftStore,
  report: (responseId: string, onDevice: boolean) => void,
): DraftStore => ({
  read: (key) => store.read(key),
  write: (key, stored) => {
    const result = store.write(key, stored);
    report(key.responseId, result.ok);
    return result;
  },
  remove: (key) => {
    store.remove(key);
    // Nothing is drafted any more, so there is nothing a reload could lose.
    report(key.responseId, true);
  },
});
