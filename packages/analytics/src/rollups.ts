/**
 * Analytics rollups: freshness, and invalidation on regrade.  (P11-T11)
 *
 * `plans/08` §9 asks for "precomputed rollups per assignment, invalidated on regrade and on release, with the
 * freshness timestamp shown", and §6 for "a freshness timestamp on every figure, and an explicit 'recomputing' state
 * after a regrade, rather than a stale number presented as current".
 *
 * ## THE PROBLEM IS NOT STALENESS, IT IS A STALE NUMBER WITH NO MARK ON IT
 *
 * A stale figure is survivable: a reader who knows it is a day old can weigh it. A stale figure that LOOKS current is
 * not, because nothing in the interface distinguishes it from one computed a minute ago, and the reader has no way to
 * notice. So this module's job is not to prevent staleness -- it is to make staleness **visible**, and to refuse to
 * serve a figure whose invalidation is in flight.
 *
 * ## AND `STALE` IS NOT THE SAME AS `RECOMPUTING`
 *
 * They need different handling and conflating them is the bug this avoids:
 *
 *  · **stale** -- the rollup is out of date but the recomputation has not been requested. Serving it is allowed, and
 *    the timestamp says so.
 *  · **recomputing** -- a regrade has landed and the rollup does not reflect it. Serving it is REFUSED, because it is a
 *    number computed from scores that no longer exist, and a teacher acting on it is acting on a fiction.
 *
 * ## AND `DIRTY` IS NOT A FLAG ANYONE MAY SET CASUALLY
 *
 * `invalidate` takes the REASON it was invalidated and records it, because the two reasons have different urgencies:
 * a regrade means the numbers changed and students may be notified; a release means the batch went out and the rollup
 * must be recomputed before anything is published. A boolean loses that, and a rollup that knows it is dirty but not
 * why cannot tell a teacher which of the two happened.
 */

import type { Millis } from '@orrery/clock';

/** Why a rollup stopped being current. The reason is recorded, not just the fact. */
export type InvalidationReason =
  /** A regrade changed scores, so every derived figure over them is now wrong. */
  | 'REGRADE'
  /** A release published the batch, so anything derived from unpublished state must not be served. */
  | 'RELEASE'
  /** New responses landed for the assignment. */
  | 'NEW_RESPONSES'
  /** An accommodation was applied, which changes the population the figures describe. */
  | 'ACCOMMODATION_APPLIED';

export type RollupState =
  /** Current: computed at or after every invalidation. */
  | 'CURRENT'
  /** Out of date, recomputation not yet requested. Serving is allowed with the timestamp shown. */
  | 'STALE'
  /** A regrade or release has landed and this does not reflect it. Serving is REFUSED. */
  | 'RECOMPUTING';

export interface Invalidation {
  readonly reason: InvalidationReason;
  readonly at: Millis;
  /** Who or what caused it. `null` for a system-triggered one such as `NEW_RESPONSES`. */
  readonly actor: string | null;
}

export interface Rollup<T> {
  readonly assignmentId: string;
  readonly computedAt: Millis;
  /** Every invalidation since the last computation, oldest first -- NOT just the latest. */
  readonly invalidatedBy: readonly Invalidation[];
  /** The computed value. Present even when stale, because a stale figure plus a timestamp is information. */
  readonly value: T | null;
  /** True while a recomputation is in flight, which `invalidate` sets and `recompute` clears. */
  readonly isRecomputing: boolean;
}

/** The reasons that make a rollup unservable rather than merely out of date. */
const BLOCKING: ReadonlySet<InvalidationReason> = new Set<InvalidationReason>([
  'REGRADE',
  'RELEASE',
]);

export const emptyRollup = <T>(assignmentId: string): Rollup<T> => ({
  assignmentId,
  computedAt: 0,
  invalidatedBy: [],
  value: null,
  isRecomputing: false,
});

/**
 * MARK A ROLLUP OUT OF DATE, and record WHY.
 *
 * The reason list APPENDS rather than replacing. A rollup invalidated by a regrade and then by new responses has been
 * invalidated by both, and a reader deciding whether the figure is safe to act on needs both facts -- a single
 * "invalidated" field would let a later, less serious invalidation erase the regrade that actually matters.
 */
export const invalidate = <T>(
  rollup: Rollup<T>,
  reason: InvalidationReason,
  at: Millis,
  actor: string | null = null,
): Rollup<T> => ({
  ...rollup,
  invalidatedBy: [...rollup.invalidatedBy, { reason, at, actor }],
  /**
   * OR-ed with the existing flag, not assigned.
   *
   * The first version wrote `isRecomputing: BLOCKING.has(reason)`, so a `NEW_RESPONSES` landing AFTER a `REGRADE`
   * cleared the flag and the figure became servable again -- while still being computed from scores that had changed.
   * A teacher reading that is acting on a fiction, and the sequence that produces it is ordinary: a regrade triggers
   * recomputation, and responses keep arriving while it runs.
   */
  isRecomputing: rollup.isRecomputing || BLOCKING.has(reason),
});

/**
 * FINISH A RECOMPUTATION.
 *
 * `computedAt` comes from an injected clock so the timestamp is reproducible in a test and moves only when the caller
 * says it does. An empty reason list after this is what makes the rollup CURRENT again, which is why
 * `invalidate` appends rather than sets: the reset here is the only place the history is cleared.
 */
export const recompute = <T>(rollup: Rollup<T>, value: T, at: Millis): Rollup<T> => ({
  ...rollup,
  computedAt: at,
  value,
  invalidatedBy: [],
  isRecomputing: false,
});

export interface Freshness {
  readonly state: RollupState;
  /** Age in ms, or `null` when there is nothing to date. */
  readonly ageMs: Millis | null;
  /** Every reason the figure is not current, oldest first. */
  readonly reasons: readonly InvalidationReason[];
  /** The sentence to show. Never empty for a non-current figure. */
  readonly notice: string;
}

/**
 * THE FRESHNESS OF A ROLLUP.
 *
 * Returns a notice for every state, including CURRENT, because a report that only shows something when it is wrong
 * trains readers to look for the absence of a warning rather than at the number.
 */
export const freshness = <T>(rollup: Rollup<T>, now: Millis): Freshness => {
  const reasons = rollup.invalidatedBy.map((entry) => entry.reason);

  if (rollup.invalidatedBy.length === 0) {
    return {
      state: 'CURRENT',
      // Clamped like the other branch. A clock reading behind `computedAt` -- which happens after a pause, or when
      // the injected instant is earlier -- must not report an age that is negative.
      ageMs: rollup.computedAt === 0 ? null : Math.max(0, now - rollup.computedAt),
      reasons: [],
      notice:
        rollup.computedAt === 0
          ? 'not computed yet'
          : `current as of ${String(rollup.computedAt)}, ${String(Math.max(0, now - rollup.computedAt))} ms ago`,
    };
  }

  // No `computedAt === 0` guard here: the branch above returns for a rollup with no invalidation history, and a rollup
  // WITH a history always has a `computedAt`. The guard duplicated work and left a branch no test could reach.
  const ageMs = Math.max(0, now - rollup.computedAt);

  if (rollup.isRecomputing) {
    /**
     * `RECOMPUTING`, and the notice says what the number IS rather than only what it is not.
     *
     * "Recomputing" alone leaves a reader unable to tell whether the figure is briefly wrong or gone. The useful
     * statement is that it was computed from scores that have since changed -- which is what makes it unusable rather
     * than merely stale.
     */
    return {
      state: 'RECOMPUTING',
      ageMs,
      reasons,
      notice:
        'recomputing: these figures were calculated from scores that have since changed, so they do not describe ' +
        'the current state of the work. They are not shown until the recalculation finishes.',
    };
  }

  return {
    state: 'STALE',
    ageMs,
    reasons,
    notice:
      `stale: this figure predates ${String(reasons.length)} change(s) -- ${reasons.join(', ')} -- and will be ` +
      `recalculated shortly.`,
  };
};

/** What a caller gets when it asks for a figure, which is the decision this module exists to make explicit. */
export type Served<T> =
  | { readonly served: true; readonly value: T; readonly freshness: Freshness }
  | { readonly served: false; readonly reason: 'RECOMPUTING'; readonly freshness: Freshness }
  | { readonly served: false; readonly reason: 'NOT_COMPUTED'; readonly freshness: Freshness };

/**
 * SERVE A FIGURE, OR REFUSE.
 *
 * Refusal is a first-class outcome rather than an exception, because "this number is not available yet" is a normal
 * state of a report and a teacher should see the reason rather than an error page.
 */
export const serve = <T>(rollup: Rollup<T>, now: Millis): Served<T> => {
  const state = freshness(rollup, now);

  if (state.state === 'RECOMPUTING') {
    // The one refusal that matters. A figure computed from scores that no longer exist is worse than no figure: it is
    // wrong in a way that looks right.
    return { served: false, reason: 'RECOMPUTING', freshness: state };
  }

  if (rollup.value === null) {
    return { served: false, reason: 'NOT_COMPUTED', freshness: state };
  }

  return { served: true, value: rollup.value, freshness: state };
};
