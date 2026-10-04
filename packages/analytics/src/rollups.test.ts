/**
 * Analytics rollups.  (P11-T11)
 *
 * The distinction these tests defend is not "stale versus fresh". It is that a stale figure with NO MARK ON IT is
 * worse than no figure, because nothing in the interface distinguishes it from one computed a minute ago -- and a
 * teacher acting on a figure computed from scores that no longer exist is acting on a fiction.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  emptyRollup,
  freshness,
  type InvalidationReason,
  invalidate,
  type Rollup,
  recompute,
  serve,
} from './rollups.js';

const T0 = 1_800_000_000_000;
const figure = { facility: 0.72 };

const built = (): Rollup<typeof figure> => recompute(emptyRollup('as1'), figure, T0);

describe('a computed rollup is CURRENT, with an age', () => {
  it('reports CURRENT and the age from the injected instant', () => {
    const state = freshness(built(), T0 + 5_000);
    expect(state.state).toBe('CURRENT');
    expect(state.ageMs).toBe(5_000);
  });

  it('gives CURRENT a notice too, because a warning that only appears when wrong trains readers to look for its absence', () => {
    expect(freshness(built(), T0).notice).toContain('current');
  });

  it('reports a rollup that has never been computed as such, rather than as a zero', () => {
    const state = freshness(emptyRollup('as1'), T0);
    expect(state.state).toBe('CURRENT');
    expect(state.notice).toBe('not computed yet');
    expect(state.ageMs).toBeNull();
  });
});

describe('STALE and RECOMPUTING are different states with different handling', () => {
  it('treats new responses as STALE, where serving is allowed with the timestamp shown', () => {
    const rollup = invalidate(built(), 'NEW_RESPONSES', T0 + 1_000);
    const state = freshness(rollup, T0 + 2_000);
    expect(state.state).toBe('STALE');
    expect(state.notice).toContain('stale');
    // Allowed: a reader who knows it is out of date can weigh it.
    expect(serve(rollup, T0 + 2_000).served).toBe(true);
  });

  it('treats a REGRADE as RECOMPUTING, where serving is REFUSED', () => {
    const rollup = invalidate(built(), 'REGRADE', T0 + 1_000, 'teacher-1');
    const state = freshness(rollup, T0 + 2_000);
    expect(state.state).toBe('RECOMPUTING');
    /**
     * The refusal that matters. A figure computed from scores that no longer exist is WORSE than no figure, because it
     * is wrong in a way that looks right.
     */
    expect(serve(rollup, T0 + 2_000).served).toBe(false);
  });

  it('treats a RELEASE as RECOMPUTING as well', () => {
    const rollup = invalidate(built(), 'RELEASE', T0 + 1_000);
    expect(freshness(rollup, T0 + 2_000).state).toBe('RECOMPUTING');
  });

  it('treats an ACCOMMODATION as STALE, since it changes the population rather than the scores', () => {
    const rollup = invalidate(built(), 'ACCOMMODATION_APPLIED', T0 + 1_000);
    expect(freshness(rollup, T0 + 2_000).state).toBe('STALE');
  });

  it('says WHAT the recomputing figure is, not only that it is not ready', () => {
    // "Recomputing" alone leaves a reader unable to tell whether the figure is briefly wrong or gone.
    const notice = freshness(invalidate(built(), 'REGRADE', T0 + 1), T0 + 2).notice;
    expect(notice).toContain('scores that have since changed');
    expect(notice).toContain('not shown');
  });

  it('names every reason in a STALE notice, so a reader knows what happened', () => {
    const rollup = invalidate(
      invalidate(built(), 'NEW_RESPONSES', T0 + 1),
      'ACCOMMODATION_APPLIED',
      T0 + 2,
    );
    const notice = freshness(rollup, T0 + 3).notice;
    expect(notice).toContain('NEW_RESPONSES');
    expect(notice).toContain('ACCOMMODATION_APPLIED');
  });
});

describe('invalidations APPEND, and a later one cannot erase an earlier one', () => {
  it('keeps every invalidation since the last computation', () => {
    const rollup = invalidate(
      invalidate(invalidate(built(), 'REGRADE', T0 + 1), 'NEW_RESPONSES', T0 + 2),
      'ACCOMMODATION_APPLIED',
      T0 + 3,
    );
    expect(rollup.invalidatedBy).toHaveLength(3);
    // A single "invalidated" field would let a later, less serious invalidation erase the regrade that actually
    // matters, and the reader deciding whether the figure is safe to act on needs both facts.
    expect(rollup.invalidatedBy[0]?.reason).toBe('REGRADE');
  });

  it('reports the reasons oldest first', () => {
    const rollup = invalidate(invalidate(built(), 'NEW_RESPONSES', T0 + 1), 'REGRADE', T0 + 2);
    expect(freshness(rollup, T0 + 3).reasons).toEqual(['NEW_RESPONSES', 'REGRADE']);
  });

  it('clears the history on recomputation, which is the only place it is cleared', () => {
    const rollup = invalidate(invalidate(built(), 'REGRADE', T0 + 1), 'NEW_RESPONSES', T0 + 2);
    expect(rollup.invalidatedBy).toHaveLength(2);
    const done = recompute(rollup, figure, T0 + 3);
    expect(done.invalidatedBy).toEqual([]);
    expect(freshness(done, T0 + 4).state).toBe('CURRENT');
  });

  it('records the actor, and accepts its absence for a system trigger', () => {
    const byTeacher = invalidate(built(), 'REGRADE', T0 + 1, 'teacher-9');
    const bySystem = invalidate(built(), 'NEW_RESPONSES', T0 + 1);
    expect(byTeacher.invalidatedBy[0]?.actor).toBe('teacher-9');
    expect(bySystem.invalidatedBy[0]?.actor).toBeNull();
  });

  it('keeps RECOMPUTING set once a blocking reason arrives, even if a stale one follows', () => {
    // A teacher reading a figure while a regrade is in flight must not see it become servable because new responses
    // arrived afterwards.
    const rollup = invalidate(invalidate(built(), 'REGRADE', T0 + 1), 'NEW_RESPONSES', T0 + 2);
    expect(rollup.isRecomputing).toBe(true);
    expect(serve(rollup, T0 + 3).served).toBe(false);
  });
});

describe('serve refuses rather than throwing', () => {
  it('refuses a rollup that was never computed', () => {
    const served = serve(emptyRollup('as1'), T0);
    expect(served.served).toBe(false);
    if (!served.served) expect(served.reason).toBe('NOT_COMPUTED');
  });

  it('returns the value AND the freshness together, so a caller cannot show one without the other', () => {
    // The whole module exists to stop a caller rendering a number without the state it was in.
    const served = serve(invalidate(built(), 'NEW_RESPONSES', T0 + 1), T0 + 2);
    expect(served.served).toBe(true);
    if (served.served) {
      expect(served.value).toEqual(figure);
      expect(served.freshness.state).toBe('STALE');
    }
  });
});

describe('properties over the whole state machine', () => {
  it('never reports a negative age, whatever the instant', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (delta) => {
        const state = freshness(built(), T0 + delta);
        return state.ageMs === null || state.ageMs >= 0;
      }),
      { numRuns: 300 },
    );
  });

  it('only ever serves a rollup whose value exists and whose state is not RECOMPUTING', () => {
    const reasons: readonly InvalidationReason[] = [
      'REGRADE',
      'RELEASE',
      'NEW_RESPONSES',
      'ACCOMMODATION_APPLIED',
    ];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...reasons), { maxLength: 4 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.boolean(),
        (applied, delta, didRecompute) => {
          let rollup = built();
          for (const [index, reason] of applied.entries()) {
            rollup = invalidate(rollup, reason, T0 + index + 1);
          }
          if (didRecompute) rollup = recompute(rollup, figure, T0 + delta);
          const served = serve(rollup, T0 + delta);
          if (served.served) {
            return served.value !== null && served.freshness.state !== 'RECOMPUTING';
          }
          return served.reason === 'RECOMPUTING' || served.reason === 'NOT_COMPUTED';
        },
      ),
      { numRuns: 400 },
    );
  });

  it('is CURRENT if and only if nothing has invalidated it since the last computation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<InvalidationReason>('REGRADE', 'RELEASE', 'NEW_RESPONSES'), {
          maxLength: 3,
        }),
        (applied) => {
          let rollup = built();
          for (const reason of applied) rollup = invalidate(rollup, reason, T0 + 1);
          return (
            (rollup.invalidatedBy.length === 0) === (freshness(rollup, T0 + 2).state === 'CURRENT')
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
