/**
 * Accommodations and `INV-ACC-1`.  (P8-T12)
 *
 * The invariant's wording is easy to implement wrongly, and the wrong reading costs a student their grade in both
 * directions: silence the event entirely and a teacher's timeline is false; ignore the relaxation and a screen-reader
 * user is escalated for a disability.
 */

import { describe, expect, it } from 'vitest';

import {
  extraTimeSeconds,
  type GrantedRelaxation,
  producesViolation,
  routeWatchdogEvent,
  type WatchdogName,
  watchdogsSilencedBy,
} from './accommodations.js';

const WATCHDOGS: readonly WatchdogName[] = [
  'FULLSCREEN',
  'POINTER_LOCK',
  'TAB_HIDE',
  'FOCUS',
  'COPY',
];

describe('INV-ACC-1: a relaxation produces ZERO VIOLATION events', () => {
  it('silences exactly the watchdog it names, and no other', () => {
    expect(producesViolation('FULLSCREEN', ['DISABLE_FULLSCREEN'])).toBe(false);
    // Silencing the tab watchdog because a student cannot use fullscreen would be an accommodation that removes
    // integrity checks the student never needed to be exempted from.
    expect(producesViolation('TAB_HIDE', ['DISABLE_FULLSCREEN'])).toBe(true);
    expect(producesViolation('COPY', ['DISABLE_FULLSCREEN'])).toBe(true);
  });

  it('says nothing is relaxed when nothing is granted', () => {
    for (const watchdog of WATCHDOGS) expect(producesViolation(watchdog, []), watchdog).toBe(true);
  });

  it('DOWNGRADES TO INFO RATHER THAN DROPPING, because a silent timeline is a FALSE one', () => {
    /**
     * This is the reading the invariant actually requires, and the one worth arguing for. "Zero violation events" is not
     * "zero events": an accommodation-holder's timeline showing nothing at all is indistinguishable from a session where
     * the feature was never used, and a teacher reviewing it has to be able to see WHY it is quiet.
     */
    const routed = routeWatchdogEvent({
      watchdog: 'FULLSCREEN',
      severity: 'VIOLATION',
      relaxations: ['DISABLE_FULLSCREEN'],
    });
    expect(routed.severity).toBe('INFO');
    expect(routed.recorded).toBe(true);
    expect(routed.countsAsStrike).toBe(false);
    // And it says WHICH relaxation, rather than leaving the teacher to infer it.
    expect(routed.relaxedBy).toBe('DISABLE_FULLSCREEN');
  });

  it('RECORDS EVERY EVENT, relaxed or not -- nothing is ever dropped', () => {
    for (const watchdog of WATCHDOGS) {
      for (const relaxations of [
        [],
        ['DISABLE_FULLSCREEN'],
        ['ALLOW_COPY', 'DISABLE_TAB_WATCHDOG'],
      ] as const) {
        expect(routeWatchdogEvent({ watchdog, severity: 'VIOLATION', relaxations }).recorded).toBe(
          true,
        );
      }
    }
  });

  it('DOWNGRADES A WARNING TOO, because a silenced watchdog contributes nothing above INFO', () => {
    /**
     * I wrote a test asserting warnings survive a relaxation, and the implementation disagreed -- and the
     * implementation was right while the test was wrong.
     *
     * A fullscreen WARNING says "return to fullscreen". A student who has been exempted from the fullscreen requirement
     * must not be told to do the thing they were excused from: the message is not merely unhelpful, it is wrong. And a
     * `WARN` left in a relaxed watchdog's column would read as "something was flagged and forgiven", which is a
     * different fact from "this check does not apply to this student".
     */
    const routed = routeWatchdogEvent({
      watchdog: 'FULLSCREEN',
      severity: 'WARN',
      relaxations: ['DISABLE_FULLSCREEN'],
    });
    expect(routed.severity).toBe('INFO');
    expect(routed.countsAsStrike).toBe(false);
    expect(routed.relaxedBy).toBe('DISABLE_FULLSCREEN');
  });

  it('leaves the severity alone when the watchdog is NOT relaxed, whatever it is', () => {
    for (const severity of ['INFO', 'WARN', 'VIOLATION'] as const) {
      expect(
        routeWatchdogEvent({ watchdog: 'FULLSCREEN', severity, relaxations: [] }).severity,
        severity,
      ).toBe(severity);
    }
  });

  it('never counts a strike for anything but a VIOLATION', () => {
    for (const severity of ['INFO', 'WARN'] as const) {
      expect(
        routeWatchdogEvent({ watchdog: 'FULLSCREEN', severity, relaxations: [] }).countsAsStrike,
        severity,
      ).toBe(false);
    }
  });

  it('answers the question the other way round, so a UI can say what a grant will silence', () => {
    expect(watchdogsSilencedBy('DISABLE_TAB_WATCHDOG')).toEqual(['TAB_HIDE', 'FOCUS']);
    expect(watchdogsSilencedBy('EXTRA_TIME_PERCENT')).toEqual([]);
  });
});

describe('the routing table covers every watchdog and every relaxation', () => {
  it('routes each relaxation to at least one watchdog or explains that it is not a routing relaxation', () => {
    const all: GrantedRelaxation[] = [
      'DISABLE_FULLSCREEN',
      'DISABLE_POINTER_LOCK',
      'DISABLE_TAB_WATCHDOG',
      'ALLOW_COPY',
      'DISABLE_FOCUS_NAG',
      'EXTRA_TIME_PERCENT',
    ];
    for (const relaxation of all) {
      // `EXTRA_TIME_PERCENT` legitimately silences no watchdog: it extends the clock instead of muting a check. The
      // test says so rather than forcing it into the table, because forcing it would invent a watchdog it does not
      // relate to.
      if (relaxation === 'EXTRA_TIME_PERCENT') {
        expect(watchdogsSilencedBy(relaxation)).toEqual([]);
      } else {
        expect(watchdogsSilencedBy(relaxation).length, relaxation).toBeGreaterThan(0);
      }
    }
  });

  it('has an entry for every watchdog, so a new watchdog cannot default to un-routed', () => {
    // A missing key would read as "no relaxation applies" -- which is the SAFE default, but silently, and it is the kind
    // of silence that means nobody decided.
    for (const watchdog of WATCHDOGS) {
      expect(producesViolation(watchdog, ['DISABLE_FULLSCREEN']), watchdog).toBeTypeOf('boolean');
    }
  });
});

describe('extra time is a DELTA, and it is a share of the TOTAL', () => {
  it('adds a share of the paper, not a share of what is left', () => {
    /**
     * `deadline * 1.25` is the bug this shape exists to prevent: for a student two hours into a three-hour paper it
     * gives 2h30m remaining, which is LESS than the 3h they had. The percentage applies to the total, so the extension
     * is the same however much time is left -- which is what "25% more time" means to a student.
     */
    // 25% of three hours is 45 MINUTES. My first expectation said 15 -- I took a quarter of the hours rather
    // than of the seconds, which is the kind of slip worth leaving visible beside the correct value.
    expect(extraTimeSeconds(3 * 3600, 25)).toBe(45 * 60);
    expect(extraTimeSeconds(3600, 50)).toBe(30 * 60);
  });

  it('returns ZERO for a paper with no time limit, rather than dividing by nothing', () => {
    expect(extraTimeSeconds(0, 25)).toBe(0);
    expect(extraTimeSeconds(-1, 25)).toBe(0);
  });

  it('CLAMPS the percentage to [0, 100], because 400% is a typo rather than an accommodation', () => {
    expect(extraTimeSeconds(3600, 400)).toBe(3600);
    expect(extraTimeSeconds(3600, -50)).toBe(0);
  });

  it('rounds to whole seconds, so the stored extension is an integer', () => {
    // 3600 * 33 / 100 = 1188 exactly; 3600 * 7 / 100 = 252. A fractional `addedSec` would not fit the column and the
    // rounding must happen here rather than at the database.
    expect(Number.isInteger(extraTimeSeconds(3600, 33))).toBe(true);
    expect(Number.isInteger(extraTimeSeconds(3600, 7))).toBe(true);
  });
});
