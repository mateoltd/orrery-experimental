/**
 * GATE VERIFICATION for the job registry.
 *
 * Two properties that are easy to state and easy to lose:
 *
 *   1. **The deadline sweep is on the 10 s clock and is NOT on the general queue.** `C3`
 *      found that Inngest cannot schedule sub-minute cron, so a 30 s sweep was never
 *      schedulable. The sweep runs on `pg_cron` behind an advisory lock. If it ever also
 *      appears in the queue, every attempt is auto-submitted twice at its deadline — the
 *      exact race `INV-LATE-1` exists to prevent.
 *
 *   2. **Every job can state its purpose in one sentence.** A job whose reason cannot be
 *      written is a job nobody will dare to disable at 3 a.m., and disabling the wrong one
 *      during an incident is worse than the bug.
 */

import { describe, expect, it } from 'vitest';
import { JOBS } from './index.js';

describe('job registry', () => {
  it('registers the deadline sweep at 10 s — not 30, and not 60', () => {
    // RN-04/Moodle uses 60 s; C3 established the sweep must be faster than the grace
    // window plus a cron interval, or a student waits minutes for a grade they earned.
    const sweep = JOBS.find((j) => j.name === 'exam.deadlineSweep');
    expect(sweep, 'the deadline sweep must exist').toBeDefined();
    expect(sweep?.everySeconds).toBeLessThanOrEqual(10);
  });

  it('does not also schedule the sweep on the general queue', () => {
    // One source of truth for the tick. A double-submit at a deadline is the race
    // INV-LATE-1 exists to prevent.
    const queueNames = JOBS.filter((j) => j.everySeconds > 30).map((j) => j.name);
    expect(queueNames).not.toContain('exam.deadlineSweep');
  });

  it('every job states a purpose a stranger could read at 3 a.m.', () => {
    for (const job of JOBS) {
      expect(job.purpose.length, `${job.name} has no purpose`).toBeGreaterThan(40);
      expect(job.everySeconds, `${job.name} has no interval`).toBeGreaterThan(0);
    }
  });

  it('job names are unique', () => {
    const names = JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('namespaced by domain, so a runbook can find them', () => {
    for (const job of JOBS) expect(job.name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
  });
});
