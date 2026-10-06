/**
 * The model and the grader, in bare Node.  (P12-T2, card 8 `astronomy.tides`)
 *
 * ## THE FIRST TEST IS THE ONE THAT MAKES THIS A T-C SIMULATION
 *
 * T-C is "relative only", and its named trap is an answer that can legitimately be 0 for a whole parameter
 * range. So the class is only defensible if NO legal parameter set produces a zero, and that is checked by
 * sweeping the ends of every declared range rather than asserted.
 *
 * ## THE SECOND TEST IS THAT THE BEAT IS AN INTERFERENCE
 *
 * There is no rule anywhere in the model that says "spring tides happen at the new moon", so the only way to
 * show the card's focus is to show the beat EMERGING: find the maxima of the summed curve's envelope and
 * check they are one beat apart, and that a spring is several times a neap.
 */

import { gradeStoredState } from '@orrery/sim-sdk/grader';
import { describe, expect, it } from 'vitest';
import sim, {
  AMPLIFICATION_MARKS,
  MAX_POINTS,
  RANGE_MARKS,
  RESONANT_MARKS,
  TOLERANCE,
} from '../src/grader.js';
import {
  A_M2,
  amplification,
  amplificationFor,
  asBoolean,
  beatPeriodDays,
  beatPeriodHours,
  clamp,
  constituentAmplitudes,
  describeTides,
  envelope,
  height,
  MAX_NATURAL,
  MIN_NATURAL,
  Q0,
  RESONANT_AMPLIFICATION,
  resonant,
  semidiurnalPeriod,
  T_M2,
  T_S2,
  type TideParams,
  tidalRange,
} from '../src/model.js';

const PARAMS: TideParams = { natural: T_M2, hours: 168, phase: 0 };

const grade = (answer: unknown, params: TideParams = PARAMS, state: unknown = { probe: true }) =>
  sim.grader.grade(state, params, answer);

const correct = (params: TideParams = PARAMS) => ({
  range: tidalRange(params),
  period: semidiurnalPeriod(),
  amplification: amplification(params.natural),
  resonant: resonant(params.natural),
});

describe('the model', () => {
  it('NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO, which is what T-C requires', () => {
    for (const natural of [MIN_NATURAL, MAX_NATURAL, T_M2]) {
      for (const hours of [1, 720]) {
        for (const phase of [0, 29.53]) {
          const params = clamp({ natural, hours, phase });
          for (const [name, value] of [
            ['range', tidalRange(params)],
            ['period', semidiurnalPeriod()],
            ['amplification', amplification(params.natural)],
          ] as const) {
            expect(value, `${name} ${JSON.stringify(params)}`).toBeGreaterThan(0);
            expect(Number.isFinite(value), `${name} ${JSON.stringify(params)}`).toBe(true);
          }
          expect(Number.isFinite(height(params))).toBe(true);
        }
      }
    }
    // AND THE PERIOD IS A CONSTANT, so it is never near zero either.
    expect(semidiurnalPeriod()).toBeGreaterThan(0);
  });

  it('the amplification PEAKS AT THE NATURAL PERIOD and is exactly Q0 there', () => {
    expect(amplificationFor(T_M2, T_M2)).toBeCloseTo(Q0, 10);
    expect(amplificationFor(T_M2, T_M2)).toBeGreaterThan(amplificationFor(T_M2, 8));
    expect(amplificationFor(T_M2, T_M2)).toBeGreaterThan(amplificationFor(T_M2, 20));
    // FINITE, NOT A DIVISION BY ZERO -- the reason `resonant` can be a measured threshold.
    expect(Number.isFinite(amplificationFor(T_M2, T_M2))).toBe(true);
  });

  it('resonance is a THRESHOLD on a computed number, not a lookup', () => {
    expect(resonant(T_M2)).toBe(true);
    expect(resonant(6)).toBe(false);
    // AND "NEARLY" IS A BAND: a basin one per cent off the natural period is STILL reported resonant, which
    // is what a threshold means and what `natural === T_M2` would have said no.
    const onePercentOff = clamp({ natural: T_M2 * 1.01 });
    expect(amplificationFor(T_M2, onePercentOff.natural)).toBeGreaterThan(RESONANT_AMPLIFICATION);
    expect(resonant(onePercentOff.natural)).toBe(true);
    // AND A QUARTER OFF IS NOT, so the band has an edge a student can find.
    expect(resonant(clamp({ natural: T_M2 * 1.25 }).natural)).toBe(false);
  });

  it('the SPRING AND NEAP BEAT EMERGES from the sum, one beat apart', () => {
    // THE ENVELOPE'S MAXIMUM IS A SPRING, AND IT IS ONE BEAT APART. No table of which day of the cycle a
    // spring falls on exists anywhere in the model, so this can only be true if the beat is the interference
    // of two nearby constituents -- which is the card's focus.
    //
    // FOUND BY ARGMAX OVER SUCCESSIVE BEAT-LENGTH WINDOWS, and the method is the assertion's own subject.
    // Picking local maxima off a single grid failed first, for a reason worth recording: the envelope is
    // `|m2 cos(w1 t)| + |s2 cos(w2 t)|`, so it carries SECONDARY maxima every half constituent period, and
    // because the alignment drifts by 2 minutes per beat, a grid coarse enough to be cheap misses the true
    // alignment in later windows entirely. A window one beat long contains exactly one alignment to within a
    // minute, so the argmax in each window is the spring and consecutive springs are a beat apart.
    const params: TideParams = { natural: T_M2, hours: 24 * 30, phase: 0 };
    const beat = beatPeriodHours();
    const step = 1 / 60;
    const springs: number[] = [];
    for (let window = 0; window * beat <= params.hours; window += 1) {
      const start = window * beat;
      let best = Number.NEGATIVE_INFINITY;
      let at = start;
      for (let i = 0; i <= beat / step; i += 1) {
        const level = envelope({ ...params, hours: start + i * step });
        if (level > best) {
          best = level;
          at = start + i * step;
        }
      }
      springs.push(at);
    }
    expect(springs.length).toBeGreaterThan(1);
    for (let i = 1; i < springs.length; i += 1) {
      const gap = (springs[i] ?? 0) - (springs[i - 1] ?? 0);
      const beats = Math.round(gap / beat);
      expect(beats, `gap ${String(i)}`).toBeGreaterThanOrEqual(1);
      expect(Math.abs(gap - beats * beat), `gap ${String(i)}`).toBeLessThan(3);
    }
  });

  it('the envelope PEAKS AT ALIGNMENT and TRASHES AT OPPOSITION, which is what interference means', () => {
    // The analytic extremes of `|a cos w1 t| + |b cos w2 t|` are `a + b` and `|a - b|`. Neither is a
    // property of any calendar: they are what two sinusoids do when their arguments agree and disagree.
    const { m2, s2 } = constituentAmplitudes(T_M2);
    const params: TideParams = { natural: T_M2, hours: 24 * 30, phase: 0 };
    const step = 1 / 60;
    let high = 0;
    let low = Infinity;
    for (let hours = 0; hours <= params.hours; hours += step) {
      const level = envelope({ ...params, hours });
      high = Math.max(high, level);
      low = Math.min(low, level);
    }
    expect(high).toBeGreaterThan((m2 + s2) * 0.999);
    expect(low).toBeLessThan(Math.abs(m2 - s2) * 1.001);
  });

  it('a SPRING is at least twice a NEAP, so the SUN constituent is not irrelevant', () => {
    // Misconception (2) is "tides are caused by the Sun alone". Read as "the Sun does not matter", it would
    // mean every range is the same. It is not: the envelope's peak is several times its own trough, and
    // that difference is S2.
    const params: TideParams = { natural: 6, hours: 24 * 30, phase: 0 };
    const step = 1 / 12;
    let best = 0;
    let worst = Infinity;
    for (let hours = 0; hours <= params.hours; hours += step) {
      const level = envelope({ ...params, hours });
      best = Math.max(best, level);
      worst = Math.min(worst, level);
    }
    expect(best).toBeGreaterThan(0);
    expect(best / Math.max(1e-9, worst)).toBeGreaterThan(2);
  });

  it('the envelope PEAK does not depend on the lunar phase, only its POSITION does', () => {
    // Misconception (1) is "spring tides happen at the quarter moons". If the spring were a RULE about the
    // lunar day, changing the phase would change the size of a spring. It does not: it slides the envelope,
    // so a basin can have its biggest tide on any day of the cycle.
    const peakOf = (phase: number): number => {
      const params: TideParams = { natural: T_M2, hours: beatPeriodHours(), phase };
      let best = 0;
      for (let hours = 0; hours <= params.hours; hours += 1 / 12) {
        best = Math.max(best, envelope({ ...params, hours }));
      }
      return best;
    };
    expect(peakOf(0)).toBeGreaterThan(0);
    expect(peakOf(3)).toBeCloseTo(peakOf(0), 6);
  });

  it('the RANGE GROWS with the response, and the constituents keep their declared ratio', () => {
    const quiet = tidalRange({ ...PARAMS, natural: 6 });
    const resonant = tidalRange({ ...PARAMS, natural: T_M2 });
    expect(resonant).toBeGreaterThan(quiet);
    // The declared amplitudes and the declared response, multiplied. Asserted as the identity rather than as
    // a ratio, because the RESPONSE differs between the two constituents and a ratio assertion would be
    // asserting the response twice.
    for (const natural of [1, 6, T_M2, 30]) {
      const { m2, s2 } = constituentAmplitudes(natural);
      expect(m2).toBeCloseTo(A_M2 * amplificationFor(T_M2, natural), 12);
      expect(s2).toBeCloseTo(0.46 * amplificationFor(T_S2, natural), 12);
      expect(m2).toBeGreaterThan(s2);
    }
  });

  it('reports the beat period rather than asking for it, and it is 14.77 DAYS', () => {
    // The card's float hazard: this is a difference of two close reciprocals, so it is poorly conditioned.
    // The card quotes 14.77 days, and a student computing `1/(1/12.42 - 1/12.00)` gets 354.4 -- HOURS. The
    // division by 24 is in the model and the discrepancy is in the spec card.
    expect(beatPeriodHours()).toBeGreaterThan(350);
    expect(beatPeriodHours()).toBeLessThan(360);
    expect(beatPeriodDays()).toBeGreaterThan(14);
    expect(beatPeriodDays()).toBeLessThan(15);
    expect(describeTides(PARAMS)).toContain('beat');
  });

  it('reads a yes/no answer in the three spellings a control produces', () => {
    for (const spoken of ['yes', 'true', '1', 'YES']) expect(asBoolean(spoken), spoken).toBe(true);
    for (const spoken of ['no', 'false', '0']) expect(asBoolean(spoken), spoken).toBe(false);
    expect(asBoolean('resonant-ish')).toBeNull();
  });
});

describe('the grader', () => {
  it('awards full marks for the range, the period, the amplification and the verdict', () => {
    const graded = grade(correct());
    expect(graded.points).toBe(MAX_POINTS);
    expect(graded.code).toBe('CORRECT');
  });

  it('declares NO absolute bound, because T-C means relative only', () => {
    expect('abs' in TOLERANCE).toBe(false);
    expect(TOLERANCE.rel).toBe(0.05);
  });

  it('a basin that is not resonant loses exactly the resonance mark for saying it IS', () => {
    const quiet: TideParams = { ...PARAMS, natural: 6 };
    expect(grade(correct(quiet), quiet).points).toBe(MAX_POINTS);
    const wrongVerdict = grade({ ...correct(quiet), resonant: true }, quiet);
    expect(wrongVerdict.points).toBe(MAX_POINTS - RESONANT_MARKS);
    expect(wrongVerdict.feedback).toMatch(/near resonance/u);
  });

  it('reads a "yes"/"no" answer and does not confuse it with an unreadable one', () => {
    expect(grade({ ...correct(), resonant: 'yes' }).points).toBe(MAX_POINTS);
    expect(grade({ ...correct(), resonant: 'no' }).points).toBe(MAX_POINTS - RESONANT_MARKS);
    expect(grade({ ...correct(), resonant: 'no' }).code).toBe('PARTIAL');
    const unread = grade({ ...correct(), resonant: 'sometimes' });
    expect(unread.points).toBe(MAX_POINTS - RESONANT_MARKS);
    expect(unread.feedback).toMatch(/neither yes nor no/u);
  });

  it('accepts a range computed from two-decimal constituents, which is what the 5% is for', () => {
    // The card: a student computing the beat from 2-dp inputs disagrees by about a day. The same generosity
    // is applied to a range read off a curve to the nearest tenth, which is a legitimate reading of a plot.
    const onPlot = grade({ ...correct(), range: correct().range * 1.04 });
    expect(onPlot.points).toBe(MAX_POINTS);
    const careless = grade({ ...correct(), range: correct().range * 1.2 });
    expect(careless.points).toBeLessThan(MAX_POINTS);
    expect(careless.points).toBeLessThanOrEqual(MAX_POINTS - RANGE_MARKS);
  });

  it('marks the amplification wrong when it is read off as the constituent amplitude', () => {
    const unfactored = grade({ ...correct(), amplification: A_M2 });
    expect(unfactored.points).toBeLessThan(MAX_POINTS);
    expect(unfactored.points).toBeLessThanOrEqual(MAX_POINTS - AMPLIFICATION_MARKS);
  });

  it('awards nothing for a blank answer, and says UNPARSEABLE when nothing could be read', () => {
    expect(grade(null).code).toBe('UNPARSEABLE');
    expect(grade({}).code).toBe('UNPARSEABLE');
    expect(grade({}).points).toBe(0);
  });

  it('is DETERMINISTIC: three runs, identical output', () => {
    const runs = [0, 1, 2].map(() => JSON.stringify(grade(correct())));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it('tolerates the determinism probe state and every legal parameter set', () => {
    expect(() => grade(correct(), PARAMS, { probe: true })).not.toThrow();
    for (const natural of [1, 6, 12, T_M2, 30]) {
      for (const hours of [1, 168, 720]) {
        const params: TideParams = { natural, hours, phase: 0 };
        expect(() => grade(correct(params), params), JSON.stringify(params)).not.toThrow();
      }
    }
  });

  it('REPLAYS: re-grading the stored state reproduces the stored mark', () => {
    const state = { ...PARAMS };
    const once = sim.grader.grade(state, state, correct());
    const twice = gradeStoredState(sim.grader, { state, params: state, answer: correct() });
    expect(twice.points).toBe(once.points);
    expect(twice.code).toBe(once.code);
  });

  it('`gradeStoredState` is what REFUSES a bad state', () => {
    const validator = sim.grader.validateState;
    if (validator === undefined) throw new Error('this simulation declares no validateState');
    expect(validator(PARAMS)).toBeNull();
    expect(validator({ natural: Number.NaN })).toMatch(/natural/u);
    expect(validator('not an object')).toMatch(/not an object/u);
    expect(() =>
      gradeStoredState(sim.grader, {
        state: { natural: 'twelve' },
        params: PARAMS,
        answer: correct(),
      }),
    ).toThrow(/STATE_INVALID/u);
  });
});
