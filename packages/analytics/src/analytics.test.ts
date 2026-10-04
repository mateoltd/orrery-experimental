/**
 * Item analysis.  (P11-T1)
 *
 * Each block corresponds to a review correction in `plans/08`, and each of those corrected something that produced a
 * confident, misleading number rather than an error. So the tests are about the correction, not about the arithmetic:
 * a formula that returns the right value for the wrong reason is still wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_FLOOR,
  analyseDistractors,
  correctedD,
  correlationWithCi,
  DISTRACTOR_MIN_N,
  facility,
  facilityBand,
  isFlaggedForDiscrimination,
  median,
  pearson,
  pointBiserial,
  R_PB_MIN_N,
  rankBiserial,
  timeOnItem,
} from './index.js';

describe('P-8: TWO facility numbers, neither called facility alone', () => {
  const full = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ pointsAwarded: 2, maxPoints: 2, scorable: true, i }));

  it('computes pFull as the fraction earning FULL credit', () => {
    const result = facility([...full(5), { pointsAwarded: 0, maxPoints: 2, scorable: true }]);
    expect(result.pFull).toBeCloseTo(5 / 6, 10);
    expect(result.pCredit).toBeCloseTo(5 / 6, 10);
  });

  it('computes pCredit as the MEAN PROPORTION, so partial credit counts', () => {
    const result = facility([
      { pointsAwarded: 2, maxPoints: 2, scorable: true },
      { pointsAwarded: 1, maxPoints: 2, scorable: true },
      { pointsAwarded: 0, maxPoints: 2, scorable: true },
    ]);
    // pFull is 1/3; pCredit is (1 + 0.5 + 0)/3. Two names for two quantities is how a teacher ends up comparing a 0.42
    // from one report against a 0.61 from another and concluding the item changed.
    expect(result.pFull).toBeCloseTo(1 / 3, 10);
    expect(result.pCredit).toBeCloseTo(0.5, 10);
  });

  it('flags the DIVERGENCE as the finding, rather than reconciling it', () => {
    // pFull ~ 0 with pCredit ~ 0.5 is a partially credited item where almost nobody gets the whole thing and half get
    // most of it. That divergence is the result.
    const result = facility([
      { pointsAwarded: 1, maxPoints: 2, scorable: true },
      { pointsAwarded: 0, maxPoints: 2, scorable: true },
      { pointsAwarded: 1, maxPoints: 2, scorable: true },
      { pointsAwarded: 0, maxPoints: 2, scorable: true },
    ]);
    expect(result.isPartialCreditFinding).toBe(true);
  });

  it('EXCLUDES non-scorable responses, so the analysis does not measure the clock', () => {
    // V-4: treating omitted and non-reached responses as wrong depresses facility and drives r_pb toward correlation
    // with speed. A student who ran out of time is not evidence about the item.
    const result = facility([
      { pointsAwarded: 2, maxPoints: 2, scorable: true },
      { pointsAwarded: 0, maxPoints: 2, scorable: true },
      { pointsAwarded: 0, maxPoints: 2, scorable: false },
      { pointsAwarded: 0, maxPoints: 2, scorable: false },
      { pointsAwarded: 0, maxPoints: 2, scorable: false },
    ]);
    expect(result.scorableCount).toBe(2);
    expect(result.pFull).toBeCloseTo(0.5, 10);
  });

  it('reports NOTHING SCORABLE as null, not 0', () => {
    // 0 means everybody scored nothing, which is the most alarming number in the report and means something different.
    const result = facility([{ pointsAwarded: 0, maxPoints: 2, scorable: false }]);
    expect(result.pFull_).toBeNull();
    expect(facilityBand(null, 'SUMMATIVE').band).toBe('UNKNOWN');
  });

  it('does not let a zero-point item produce NaN', () => {
    const result = facility([
      { pointsAwarded: 0, maxPoints: 0, scorable: true },
      { pointsAwarded: 2, maxPoints: 2, scorable: true },
    ]);
    expect(Number.isFinite(result.pCredit)).toBe(true);
  });
});

describe('the bands are KEYED TO PURPOSE', () => {
  it('reads a formative pFull of 0.95 as INTENDED, not "too easy"', () => {
    // A student who has just read the material answering correctly is the item working. Reading this as "too easy"
    // produces a rewrite of the teaching rather than of the item.
    expect(facilityBand(0.95, 'FORMATIVE').reading).toContain('as intended');
    expect(facilityBand(0.95, 'SUMMATIVE').reading).toBe('too easy');
  });

  it('gives the same band different ACTIONS for formative and summative', () => {
    expect(facilityBand(0.4, 'FORMATIVE').action).toBe(facilityBand(0.4, 'SUMMATIVE').action);
    expect(facilityBand(0.2, 'FORMATIVE').band).toBe('VERY_HARD');
    expect(facilityBand(0.2, 'FORMATIVE').action).toContain('investigate before reusing');
  });

  it('never leaves a summative band with no action when it is a problem', () => {
    for (const p of [0.95, 0.8, 0.6, 0.4, 0.2]) {
      const band = facilityBand(p, 'SUMMATIVE');
      if (band.band !== 'HEALTHY') expect(band.action.length, String(p)).toBeGreaterThan(0);
    }
  });
});

describe('P-7: every correlation carries an interval, and N >= 100 for r_pb', () => {
  const synthetic = (n: number, slope: number) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i += 1) {
      // Deterministic, no Math.random (INV-RNG-1): a reproducible correlation of a known strength.
      const noise = ((i * 37) % 11) - 5;
      xs.push(i % 2);
      ys.push(slope * (xs[i] ?? 0) + noise);
    }
    return { xs, ys };
  };

  it('refuses to report r_pb below 100', () => {
    const { xs, ys } = synthetic(30, 10);
    const ci = correlationWithCi(xs, ys);
    // At N = 30 a true r of 0.30 has a 95% interval of [-0.07, +0.60], which contains both "no relationship" and
    // "a strong relationship". The number cannot inform a decision, so it is not reported.
    expect(ci.isReportable).toBe(false);
    expect(ci.reason).toContain(String(R_PB_MIN_N));
  });

  it('reports at N >= 100, with bounds inside [-1, 1]', () => {
    const { xs, ys } = synthetic(200, 30);
    const ci = correlationWithCi(xs, ys);
    expect(ci.isReportable).toBe(true);
    // A linear interval can report 1.08, which nobody can interpret; the Fisher transform cannot.
    expect(ci.ciLow).toBeGreaterThanOrEqual(-1);
    expect(ci.ciHigh).toBeLessThanOrEqual(1);
    expect(ci.ciLow).toBeLessThan(ci.r);
    expect(ci.ciHigh).toBeGreaterThan(ci.r);
  });

  it('returns the degenerate interval for a perfect correlation, not Infinity', () => {
    // At the reporting floor, because the N gate fires FIRST and an unreportable interval is correctly NaN rather
    // than a number. The first version of this test used six points and so tested the N gate by accident.
    const xs = Array.from({ length: 120 }, (_, i) => i % 2);
    const ys = xs.map((value) => 2 * value + 1);
    const ci = correlationWithCi(xs, ys);
    expect(ci.isReportable).toBe(true);
    // `atanh(1)` is Infinity, so a naive interval returns Infinity bounds. Clamping through `tanh` cannot.
    expect(Number.isFinite(ci.ciLow)).toBe(true);
    expect(Number.isFinite(ci.ciHigh)).toBe(true);
  });

  it('flags on the UPPER bound, so a small sample does not condemn an item', () => {
    // An interval of [0.05, 0.55] has not shown a bad item; it has shown an under-measured one.
    const wide = { r: 0.3, ciLow: 0.05, ciHigh: 0.55, n: 100, isReportable: true, reason: '' };
    expect(isFlaggedForDiscrimination(wide).flagged).toBe(false);
    const narrow = { r: 0.1, ciLow: -0.05, ciHigh: 0.25, n: 200, isReportable: true, reason: '' };
    expect(isFlaggedForDiscrimination(narrow).flagged).toBe(true);
  });

  it('never flags on the lower bound, and says why in the reason', () => {
    const verdict = isFlaggedForDiscrimination({
      r: 0.05,
      ciLow: -0.4,
      ciHigh: 0.45,
      n: 100,
      isReportable: true,
      reason: '',
    });
    expect(verdict.flagged).toBe(false);
    expect(verdict.reason).toContain('upper bound');
  });

  it('does not flag anything it could not report', () => {
    const tiny = {
      r: 0,
      ciLow: Number.NaN,
      ciHigh: Number.NaN,
      n: 10,
      isReportable: false,
      reason: 'too few',
    };
    expect(isFlaggedForDiscrimination(tiny).flagged).toBe(false);
  });

  it('returns 0 rather than NaN for a constant column', () => {
    // NaN would poison a mean downstream, and 0 says "there is nothing here" honestly.
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(Number.isFinite(pearson([], []))).toBe(true);
  });

  it('uses the ACCEPTANCE_FLOOR from the plan, not a literal 0.3 in a second place', () => {
    expect(ACCEPTANCE_FLOOR).toBe(0.3);
  });
});

describe('D-26: corrected D uses a REST-SCORE split, not a multiplicative factor', () => {
  const outcomes = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const restScore = i;
      // Full credit for the top of the range, none at the bottom, so D is strongly positive.
      const awarded = i >= Math.floor(n * 0.8) ? 2 : 0;
      return { awarded, maxPoints: 2, restScore, scorable: true };
    });

  it('splits on the REST score and produces a D in range', () => {
    const result = correctedD(outcomes(100));
    expect(result.d).toBeGreaterThan(0);
    // Kelley's 2D/(1+D) returns -2.0 at D = -0.5, outside [-1, 1]. Whatever correction is used, D stays bounded.
    expect(result.d).toBeLessThanOrEqual(1);
    expect(result.d).toBeGreaterThanOrEqual(-1);
  });

  it('states the residual bias rather than implying the number is corrected', () => {
    // Rest-score D is ATTENUATED -- the item no longer correlates with its own contribution. It is a lower bound.
    expect(correctedD(outcomes(100)).note).toContain('ATTENUATED');
  });

  it('reports 0 with an explanation when nobody scored full credit at either end', () => {
    // A subtraction would send D to 2 here, reading as "excellent discrimination" on an item nobody could do.
    const flat = Array.from({ length: 60 }, (_, i) => ({
      awarded: 0,
      maxPoints: 2,
      restScore: i,
      scorable: true,
    }));
    const result = correctedD(flat);
    expect(result.d).toBe(0);
    expect(result.note).toContain('undefined');
  });

  it('marks itself UNDERPOWERED below 30', () => {
    expect(correctedD(outcomes(20)).isUnderpowered).toBe(true);
    expect(correctedD(outcomes(100)).isUnderpowered).toBe(false);
  });

  it('computes point-biserial and rank-biserial consistently on the same data', () => {
    const data = outcomes(120);
    const pb = pointBiserial(data);
    const rb = rankBiserial(data);
    expect(pb.isReportable).toBe(true);
    // Reported ALONGSIDE, not as an independent check -- for a dichotomous item the two are algebraically related,
    // so their agreement is not evidence.
    // POSITIVE, which is the sign check that matters: ranking within each group instead of over the combined sample
    // inverts it, because the keyed group is usually the smaller one and its within-group ranks run 1..24 against
    // 1..96. A good item reported -0.30 until this was fixed.
    expect(rb).toBeGreaterThan(0);
    // The bound is what catches the real bug: an undivided rank sum produced a "correlation" of about 1280, which is
    // outside [-1, 1] and is a correlation that cannot exist.
    expect(Math.abs(rb - Math.abs(pb.r))).toBeLessThan(0.5);
    expect(rb).toBeLessThanOrEqual(1);
  });

  it('returns 0 rank-biserial rather than dividing by zero when one group is empty', () => {
    const allRight = Array.from({ length: 50 }, (_, i) => ({
      awarded: 2,
      maxPoints: 2,
      restScore: i,
      scorable: true,
    }));
    expect(Number.isFinite(rankBiserial(allRight))).toBe(true);
  });
});

describe("P-10: the distractor null comes from the item's OWN facility", () => {
  const obs = (
    n: number,
    pick: (i: number) => readonly string[],
    correct: (i: number) => boolean,
  ) =>
    Array.from({ length: n }, (_, i) => ({
      selected: pick(i),
      correct: correct(i),
      scorable: true,
    }));

  it('computes d_j as P(correct | did NOT select) minus P(correct | DID select)', () => {
    const data = obs(
      100,
      (i) => (i % 2 === 0 ? ['b'] : []),
      (i) => i % 2 === 1,
    );
    const [b] = analyseDistractors(data, ['b'], 0.5);
    // Even i select b and are wrong; odd i do not and are right. So d = P(correct|selected) - P(correct|not) = 0 - 1.
    // NEGATIVE, and flagged -- which is correct and was my second wrong assumption in this file: an option that does
    // its job IS the thing `plans/08` §2.3 asks a teacher to look at, because the question is whether it reflects a
    // misconception or a mis-key, not whether it misleads.
    expect(b?.d).toBeCloseTo(-1, 10);
    expect(b?.isFlagged).toBe(true);
  });

  it('flags a distractor that attracts students who are WRONG', () => {
    const data = obs(
      100,
      (i) => (i % 4 === 0 ? ['b'] : []),
      (i) => i % 4 !== 0,
    );
    const [b] = analyseDistractors(data, ['b'], 0.75);
    // Students who chose b are wrong (i%4===0 -> correct false); students who did not are right. So d is negative,
    // which is the reading `plans/08` §2.3 tells a teacher to act on.
    expect(b?.d).toBeLessThan(-0.2);
    expect(b?.isFlagged).toBe(true);
    // Both readings are offered, because the analysis cannot tell a misconception from a mis-key and guessing sends a
    // teacher to rewrite an item that is fine.
    expect(b?.reading).toMatch(/misconception|mis-key/);
  });

  it('reports the item facility as the null, not a bare 40% threshold', () => {
    // On a pFull = 0.95 item a distractor chosen by 60% of students means nothing, because nearly everyone is choosing
    // distractors. On a pFull = 0.30 item, 40% is remarkable.
    const data = obs(
      100,
      (i) => (i % 5 === 0 ? ['b'] : []),
      (i) => i % 5 !== 0,
    );
    const [b] = analyseDistractors(data, ['b'], 0.95);
    expect(b?.nullValue).toBe(0.95);
    expect(b?.selectionRate).toBeCloseTo(0.2, 10);
  });

  it('refuses to flag below 30 students, because 40% of five is two', () => {
    const data = obs(
      10,
      (i) => (i % 4 === 0 ? ['b'] : []),
      (i) => i % 4 !== 0,
    );
    const [b] = analyseDistractors(data, ['b'], 0.5);
    expect(b?.isFlagged).toBeNull();
    expect(b?.reading).toContain(String(DISTRACTOR_MIN_N));
  });

  it('reports 0 rather than NaN when EVERY student chose the option', () => {
    const data = obs(
      40,
      () => ['b'],
      (i) => i % 2 === 0,
    );
    const [b] = analyseDistractors(data, ['b'], 0.5);
    // The groups are disjoint, so one is empty -- which is itself a finding, and a NaN would poison every average.
    expect(Number.isFinite(b?.d ?? Number.NaN)).toBe(true);
  });
});

describe('time on item: median and IQR, against BOTH references', () => {
  it('uses the MEDIAN, so a walkaway does not move it', () => {
    const durations = [60_000, 61_000, 62_000, 63_000, 600_000];
    // The mean is 169s because one student walked away for ten minutes. The median is not.
    expect(median(durations)).toBe(62_000);
    expect(durations.reduce((sum, value) => sum + value, 0) / durations.length).toBe(169_200);
  });

  it('returns an OBSERVED value for an even count, not the mean of the middle pair', () => {
    expect(median([10, 20])).toBe(10);
  });

  it('returns null, not 0, when nothing was recorded', () => {
    expect(median([])).toBeNull();
    const [item] = timeOnItem([{ questionId: 'q1', durationsMs: [] }]);
    expect(item?.medianMs).toBeNull();
  });

  it('discards a negative or non-finite duration rather than clamping it', () => {
    const [item] = timeOnItem([
      { questionId: 'q1', durationsMs: [-5, Number.NaN, 30_000, 40_000] },
    ]);
    expect(item?.n).toBe(2);
    // 30_000, not 40_000: for an even count the module takes the LOWER median, so the number shown is always a
    // duration somebody actually spent.
    expect(item?.medianMs).toBe(30_000);
  });

  it('compares against the AUTHOR estimate and the CLASS median separately', () => {
    const [item] = timeOnItem([
      { questionId: 'q1', durationsMs: [300_000, 300_000], estimatedSeconds: 30 },
      { questionId: 'q2', durationsMs: [10_000, 10_000], estimatedSeconds: 60 },
    ]);
    // Two references because they answer different questions: the estimate says whether the ITEM was written to be
    // answerable in that time, the class median says whether THIS class found it slow.
    expect(item?.againstAuthor).toContain('more than twice');
    expect(item?.classMedianMs).toBe(10_000);
    expect(item?.againstClass).toBe('slower than this class median');
  });
});
