/**
 * The deadline sweep's RULES, with no database and no waiting.  (P8-T9)
 *
 * Every interesting case here is a BOUNDARY case, and the boundary worth testing is the one you would otherwise have to
 * wait ten seconds to observe -- which is the entire argument for keeping the plan pure.
 */

import { describe, expect, it } from 'vitest';

import {
  planDeadlineSweep,
  type SweepAttempt,
  type SweepQuestionWindow,
  WINDOW_CLOSED_DEADLINE,
} from './sweep.js';

const T0 = 1_800_000_000_000;
const SECOND = 1000;

const attempt = (over: Partial<SweepAttempt> = {}): SweepAttempt => ({
  id: 'a1',
  status: 'IN_PROGRESS',
  deadlineAt: T0,
  gracePeriodSec: 60,
  ...over,
});

const window = (over: Partial<SweepQuestionWindow> = {}): SweepQuestionWindow => ({
  responseId: 'r1',
  attemptId: 'a1',
  questionDeadlineAt: T0,
  questionClosedReason: null,
  ...over,
});

describe('step 1: IN_PROGRESS past deadline + grace is auto-submitted', () => {
  it('submits once the grace has passed', () => {
    const plan = planDeadlineSweep({
      attempts: [attempt()],
      windows: [],
      now: T0 + 61 * SECOND,
    });
    expect(plan.autoSubmit.map((a) => a.id)).toEqual(['a1']);
  });

  it('DOES NOT submit one millisecond early', () => {
    // `isPastDeadline` is `now > deadline + grace`, so the boundary is exclusive. A sweep that submitted at exactly
    // the boundary would race the last legitimate write of the grace window.
    const plan = planDeadlineSweep({ attempts: [attempt()], windows: [], now: T0 + 60 * SECOND });
    expect(plan.autoSubmit).toEqual([]);
  });

  it('leaves an attempt alone with NO deadline', () => {
    const plan = planDeadlineSweep({
      attempts: [attempt({ deadlineAt: null })],
      windows: [],
      now: T0 + 10 * 365 * 24 * 3600 * SECOND,
    });
    expect(plan.autoSubmit).toEqual([]);
  });

  it('respects a LARGER grace, because that is what an accommodation means', () => {
    // `RN-04`'s 60s default is per attempt precisely so one student's extension is not everyone's. A sweep with a
    // hardcoded grace would submit a student who was given ten extra minutes.
    const plan = planDeadlineSweep({
      attempts: [attempt({ gracePeriodSec: 600 })],
      windows: [],
      now: T0 + 120 * SECOND,
    });
    expect(plan.autoSubmit).toEqual([]);
  });

  it('ignores an attempt that is not IN_PROGRESS', () => {
    for (const status of ['SUBMITTED', 'FROZEN', 'GRADED', 'RELEASED', 'VOIDED', 'EXPIRED']) {
      const plan = planDeadlineSweep({
        attempts: [attempt({ status })],
        windows: [],
        now: T0 + 999 * SECOND,
      });
      expect(plan.autoSubmit, status).toEqual([]);
    }
  });

  it("does NOT touch FROZEN, because `V-12` made a freeze a TEACHER'S to lift", () => {
    /**
     * This is the `V-12` guarantee expressed as a sweep rule. The old `TERMINATE` ended an attempt on a timer;
     * auto-submitting a FROZEN attempt would do the same thing by a different name, discarding whatever the student
     * had not yet had a chance to write while a teacher was deciding whether to reinstate.
     */
    const plan = planDeadlineSweep({
      attempts: [attempt({ status: 'FROZEN' })],
      windows: [],
      now: T0 + 999 * SECOND,
    });
    expect(plan.autoSubmit).toEqual([]);
  });
});

describe('step 2: a question window closes, and closing it is idempotent', () => {
  it('closes a window past its deadline', () => {
    const plan = planDeadlineSweep({ attempts: [], windows: [window()], now: T0 + SECOND });
    expect(plan.closeWindow.map((w) => w.responseId)).toEqual(['r1']);
  });

  it('does NOT close one millisecond early', () => {
    const plan = planDeadlineSweep({ attempts: [], windows: [window()], now: T0 });
    expect(plan.closeWindow).toEqual([]);
  });

  it('SKIPS AN ALREADY-CLOSED WINDOW, so a ten-second cron does not write an event per tick', () => {
    /**
     * The failure this prevents is an event amplifier: a window left closed stays in the query, so a sweep that
     * filtered only on the deadline would emit a `QUESTION_WINDOW_CLOSED` event every ten seconds for every finished
     * question, for as long as the row exists. At cohort scale that is the write spike `plans/03` §3.4 exists to avoid.
     */
    const plan = planDeadlineSweep({
      attempts: [],
      windows: [window({ questionClosedReason: WINDOW_CLOSED_DEADLINE })],
      now: T0 + 10 * SECOND,
    });
    expect(plan.closeWindow).toEqual([]);
  });

  it('leaves a window with NO per-question deadline open, because the attempt deadline governs it', () => {
    const plan = planDeadlineSweep({
      attempts: [],
      windows: [window({ questionDeadlineAt: null })],
      now: T0 + 999 * SECOND,
    });
    expect(plan.closeWindow).toEqual([]);
  });
});

describe('THE SWEEP AND THE WRITE PATH MUST AGREE, AND THEY AGREE BY CONSTRUCTION', () => {
  it('closes a window at the SAME instant `decideWrite` stops accepting', () => {
    /**
     * The sweep uses `isPastDeadline(deadline, now, 0)` for a per-question window, and so does `decideWrite` -- which
     * is why the planner imports it instead of re-deriving `now > deadline + grace`.
     *
     * If the two ever disagreed, a save inside the boundary would SUCCEED against a question the sweep had already
     * marked closed: the answer is stored, the interface says the window is shut, and nothing reports the conflict.
     */
    // `isPastDeadline` is `now > deadline`, so the boundary is EXCLUSIVE and one millisecond wide. My first version of
    // this test stepped by a whole second and asserted the wrong side of it, which is the sort of near-miss that makes a
    // boundary test look like it passed for the right reason.
    const exactlyAt = planDeadlineSweep({ attempts: [], windows: [window()], now: T0 });
    const oneMillisecondLater = planDeadlineSweep({
      attempts: [],
      windows: [window()],
      now: T0 + 1,
    });

    expect(exactlyAt.closeWindow).toEqual([]);
    expect(oneMillisecondLater.closeWindow).toHaveLength(1);
  });
});

describe('running the sweep twice is indistinguishable from running it once', () => {
  it('produces an empty plan once the writes are visible', () => {
    // The property that makes this usable as a CRON: tick N does the work, tick N+1 sees it and does nothing. Anything
    // that re-derives "what is due" from its own bookkeeping instead of from the database fails exactly here, and only
    // in production, where ticks are ten seconds apart.
    const first = planDeadlineSweep({
      attempts: [attempt()],
      windows: [window()],
      now: T0 + 61 * SECOND,
    });
    expect(first.autoSubmit).toHaveLength(1);
    expect(first.closeWindow).toHaveLength(1);

    const second = planDeadlineSweep({
      attempts: [],
      windows: [window({ questionClosedReason: WINDOW_CLOSED_DEADLINE })],
      now: T0 + 71 * SECOND,
    });
    expect(second.autoSubmit).toEqual([]);
    expect(second.closeWindow).toEqual([]);
  });

  it('NEVER DECIDES TO DELETE ANYTHING', () => {
    /**
     * `B10` in the form this module could have got wrong. An auto-submitted attempt keeps every response row it has,
     * including empty ones: an unanswered question contributes zero to the score, and deleting its row would only
     * destroy the evidence that it was unanswered. So the plan has no delete-shaped decision in it at all.
     */
    const plan = planDeadlineSweep({
      attempts: [attempt()],
      windows: [window()],
      now: T0 + 61 * SECOND,
    });
    expect(Object.keys(plan).sort()).toEqual(['autoSubmit', 'closeWindow']);
    expect(JSON.stringify(plan)).not.toMatch(/delete|discard|drop/i);
  });
});
