/**
 * ADVERSARIAL: clock skew.  (P8-T15, `plans/09` §5, `plans/17` §3.5 "A client whose system clock is wrong by days")
 *
 * ## THREE DIFFERENT THINGS ARE CALLED "SKEW", AND ONLY ONE OF THEM IS A FINDING
 *
 *  · a clock that is WRONG -- minutes or days off, and steady. Ordinary on a school laptop with a dead CMOS battery.
 *  · a clock nobody has MEASURED -- never synced, or every round trip too slow to trust.
 *  · a clock that MOVED -- the offset jumped between two measurements.
 *
 * Only the third is something `detectSkew` may report, and none of the three may change what the server accepts.
 * `plans/09` §5.1 says it in one line: "A client whose clock is three days wrong behaves identically to a correct
 * one."
 *
 * Each test below is one way of breaking that sentence. The first two would turn a property of a student's DEVICE
 * into an entry in their timeline, which is the `RN-02` failure exactly: the students with the worst hardware and the
 * worst connections collect the most events.
 *
 * The watchdog half -- that `clockGuard` reaches its verdict from samples and never from a clock read -- is in
 * `apps/web/src/features/exam/watchdogs/adversarial-clock-and-resume.test.ts`, because the guard lives there.
 */

import { DAY, MINUTE } from '@orrery/clock';
import {
  DEFAULT_SKEW_THRESHOLDS,
  detectSkew,
  type OffsetSample,
  offsetFromRoundTrip,
} from '@orrery/clock/skew';
import { evaluateWrite, type WriteRequest } from '@orrery/contracts/policy/deadline';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { countsAsStrike, EVIDENCE_RULES, type StrikePolicyView } from '../evidence.js';

const T0 = 1_800_000_000_000;
const RUNS = 400;

/** Integer offsets, so a shifted median is exactly the median shifted and the comparison below needs no epsilon. */
const sampleArb: fc.Arbitrary<OffsetSample> = fc.record({
  offsetMs: fc.integer({ min: -20_000, max: 20_000 }),
  rttMs: fc.integer({ min: 0, max: 8_000 }),
});

const seriesArb = fc.array(sampleArb, { maxLength: 8 });

/** Every policy a teacher can configure, as far as a strike decision can see it. */
const policyViews: readonly StrikePolicyView[] = ['OFF', 'WARN', 'BLOCK'].flatMap(
  (requireFullscreen) =>
    ['OFF', 'WARN', 'BLOCK'].flatMap((requirePointerLock) =>
      ['WARN', 'BLOCK'].flatMap((multiTabPolicy) =>
        [false, true].flatMap((blockCopyPaste) =>
          [false, true].map((blockPrintSave) => ({
            requireFullscreen,
            requirePointerLock,
            multiTabPolicy,
            blockCopyPaste,
            blockPrintSave,
          })),
        ),
      ),
    ),
);

describe('a clock that is WRONG but steady is not a finding', () => {
  it('reaches the same verdict however far off the device clock is', () => {
    /**
     * TRANSLATION INVARIANCE: add any constant to every offset and the status, the warning and the discards are
     * unchanged, and the believed offset moves by exactly that constant.
     *
     * What breaks without it: any rule of the form "an offset larger than X is suspicious". It reads as common sense
     * and it reports every student whose device clock is wrong, on every sync, for something they did not do and
     * cannot fix mid-exam.
     */
    fc.assert(
      fc.property(seriesArb, fc.integer({ min: -3 * DAY, max: 3 * DAY }), (series, wrongBy) => {
        const honest = detectSkew(series);
        const shifted = detectSkew(
          series.map((sample) => ({ ...sample, offsetMs: sample.offsetMs + wrongBy })),
        );

        expect(shifted.status).toBe(honest.status);
        expect(shifted.shouldWarnStudent).toBe(honest.shouldWarnStudent);
        expect(shifted.discarded).toEqual(honest.discarded);
        // Only where there was something to believe: an empty series reports 0 and has nothing to shift.
        if (series.length > 0) expect(shifted.offsetMs).toBe(honest.offsetMs + wrongBy);
      }),
      { numRuns: RUNS },
    );
  });

  it('calls a device ten minutes out, measured consistently, STABLE', () => {
    // The concrete case, so the property above is not the only place the number appears.
    const tenMinutesSlow = [-10 * MINUTE, -10 * MINUTE + 40, -10 * MINUTE - 25].map((offsetMs) => ({
      offsetMs,
      rttMs: 120,
    }));
    const verdict = detectSkew(tenMinutesSlow);
    expect(verdict.status).toBe('STABLE');
    expect(verdict.shouldWarnStudent).toBe(false);
    expect(verdict.offsetMs).toBe(-10 * MINUTE);
  });
});

describe('a clock nobody has measured is UNKNOWN, and UNKNOWN accuses nobody', () => {
  it('stays UNKNOWN while every round trip is too slow to trust, however wild the offsets', () => {
    // A student on a congested link produces exactly this: every sample slow, the offsets all over the place. If slow
    // samples were merely down-weighted rather than discarded, their scatter would read as a jump.
    const slow = fc.record({
      offsetMs: fc.integer({ min: -3 * DAY, max: 3 * DAY }),
      rttMs: fc.integer({ min: DEFAULT_SKEW_THRESHOLDS.rttToleranceMs + 1, max: 120_000 }),
    });
    fc.assert(
      fc.property(fc.array(slow, { maxLength: 8 }), (series) => {
        const verdict = detectSkew(series);
        expect(verdict.status).toBe('UNKNOWN');
        expect(verdict.shouldWarnStudent).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it('stays UNKNOWN on one usable sample among any number of unusable ones', () => {
    // One point cannot show movement. The trap is counting the DISCARDED samples towards "enough data".
    const slowArb = fc.record({
      offsetMs: fc.integer({ min: -3 * DAY, max: 3 * DAY }),
      rttMs: fc.constant(DEFAULT_SKEW_THRESHOLDS.rttToleranceMs + 1),
    });
    fc.assert(
      fc.property(
        fc.array(slowArb, { maxLength: 6 }),
        fc.integer({ min: -3 * DAY, max: 3 * DAY }),
        fc.nat(),
        (slow, offsetMs, position) => {
          const series: OffsetSample[] = [...slow];
          series.splice(position % (slow.length + 1), 0, { offsetMs, rttMs: 50 });
          const verdict = detectSkew(series);
          expect(verdict.status).toBe('UNKNOWN');
          expect(verdict.shouldWarnStudent).toBe(false);
          expect(verdict.offsetMs).toBe(offsetMs);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('warns the student ONLY for a jump, never for drift and never for not knowing', () => {
    // `shouldWarnStudent` interrupts an exam. It is tied to one status so that no second route to it can appear.
    fc.assert(
      fc.property(seriesArb, (series) => {
        const verdict = detectSkew(series);
        expect(verdict.shouldWarnStudent).toBe(verdict.status === 'SKEWED');
      }),
      { numRuns: RUNS },
    );
  });
});

describe('skew is advisory under every policy a teacher can write', () => {
  it('never counts `CLOCK_SKEW_DETECTED` as a strike', () => {
    // Written against the event NAME and all 72 policy views rather than read off the table's `strike: 'never'`, so
    // changing the table is what fails this.
    expect(policyViews).toHaveLength(72);
    for (const policy of policyViews) {
      expect(countsAsStrike('CLOCK_SKEW_DETECTED', policy), JSON.stringify(policy)).toBe(false);
    }
    // And it is not filed with violations: a VIOLATION-severity row is what a teacher's eye goes to first.
    expect(EVIDENCE_RULES.CLOCK_SKEW_DETECTED.severity).not.toBe('VIOLATION');
  });
});

describe('skew never grants time, in either direction', () => {
  const base: WriteRequest = {
    attemptStatus: 'IN_PROGRESS',
    deadlineAt: T0 + 60 * MINUTE,
    questionDeadlineAt: null,
    expectedRevision: 3,
    serverRevision: 3,
    idempotencyKeySeen: false,
  };

  it('decides a write from the server instant alone, whatever the request claims about time', () => {
    /**
     * The acceptance predicate has no parameter for the client's clock, and this pins that it does not grow one.
     *
     * A client three days slow sincerely believes it is early. If any client-supplied timestamp were consulted --
     * `clientTs` is already on the wire, the route reads it -- "skew" would be a way to buy time. So every request is
     * decorated with the claims a lying client would make, and the decision must not move.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: -2 * 60 * MINUTE, max: 2 * 60 * MINUTE }),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: -3 * DAY, max: 3 * DAY }),
        (serverOffsetFromDeadline, gracePeriodSec, clientSkew) => {
          const serverNow = T0 + 60 * MINUTE + serverOffsetFromDeadline;
          const honest = evaluateWrite({ gracePeriodSec }, base, serverNow);

          const claims = {
            ...base,
            clientTs: serverNow + clientSkew,
            clientNow: serverNow + clientSkew,
            now: serverNow + clientSkew,
            sentAt: serverNow + clientSkew,
          } as WriteRequest;
          expect(evaluateWrite({ gracePeriodSec }, claims, serverNow)).toEqual(honest);

          // And the decision is the one the plan writes down: inclusive of the last millisecond of grace.
          const inside = serverNow <= T0 + 60 * MINUTE + gracePeriodSec * 1000;
          expect(honest.accept).toBe(inside);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('recovers server time from one round trip to within half of it, for a device days out', () => {
    /**
     * The DISPLAY half of "behaves identically". The device's clock is `wrongBy` off; one exchange measures it; the
     * corrected reading must be the server's time, give or take the asymmetry of the path -- which is bounded by half
     * the round trip and does not grow with `wrongBy`.
     *
     * What breaks without it: the `PF-3` sign error. `+ rtt / 2` is off by a whole round trip on a symmetric path,
     * always in the direction that shows a student more time than they have, and this bound catches it at any `rtt`
     * above zero.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: -3 * DAY, max: 3 * DAY }),
        fc.integer({ min: 0, max: 4_000 }),
        fc.integer({ min: 0, max: 4_000 }),
        fc.integer({ min: 0, max: 60 * MINUTE }),
        (wrongBy, outboundMs, inboundMs, sinceSync) => {
          // True (server) instants of the exchange.
          const sent = T0;
          const atServer = sent + outboundMs;
          const received = atServer + inboundMs;
          // What the DEVICE reads at the two instants it can see.
          const t1 = sent + wrongBy;
          const t4 = received + wrongBy;

          const offset = offsetFromRoundTrip(t1, atServer, atServer, t4);

          // Any later moment: the device reads its own wrong clock and adds the offset.
          const trueLater = received + sinceSync;
          const corrected = trueLater + wrongBy + offset;
          const rtt = outboundMs + inboundMs;
          expect(Math.abs(corrected - trueLater)).toBeLessThanOrEqual(rtt / 2);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
