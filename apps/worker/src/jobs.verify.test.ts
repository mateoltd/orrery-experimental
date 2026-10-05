/**
 * GATE VERIFICATION for the job registry.
 *
 * Three properties that are easy to state and easy to lose:
 *
 *   1. **The deadline sweep is on the 10 s clock and is NOT on the general queue.** `C3`
 *      found that Inngest cannot schedule sub-minute cron, so a 30 s sweep was never
 *      schedulable. The sweep runs on `pg_cron` behind an advisory lock. If it ever also
 *      appears in the queue, every attempt is auto-submitted twice at its deadline — the
 *      exact race `INV-LATE-1` exists to prevent.
 *   2. **Every job can state its purpose in one sentence.** A job whose reason cannot be
 *      written is a job nobody will dare to disable at 3 a.m., and disabling the wrong one
 *      during an incident is worse than the bug.
 *   3. **Every job says where its tick comes from.** The exclusion above used to be a
 *      comment and an absence; it is a field now, and a job that does not declare one cannot
 *      be registered at all.
 */

import { describe, expect, it } from 'vitest';
import { isScheduled, JOBS, PENDING_JOBS, SCHEDULED_JOBS, SWEEP_JOB_NAME } from './index.js';

describe('job registry', () => {
  it('registers the deadline sweep at 10 s — not 30, and not 60', () => {
    // RN-04/Moodle uses 60 s; C3 established the sweep must be faster than the grace
    // window plus a cron interval, or a student waits minutes for a grade they earned.
    const sweep = JOBS.find((j) => j.name === SWEEP_JOB_NAME);
    expect(sweep, 'the deadline sweep must exist').toBeDefined();
    expect(sweep?.everySeconds).toBeLessThanOrEqual(10);
  });

  it('does not also schedule the sweep on the general queue', () => {
    // One source of truth for the tick. A double-submit at a deadline is the race
    // INV-LATE-1 exists to prevent.
    expect(SCHEDULED_JOBS.map((j) => j.name)).not.toContain(SWEEP_JOB_NAME);
    expect(JOBS.find((j) => j.name === SWEEP_JOB_NAME)?.queue).toBe('pg_cron');
  });

  it('every job declares where its tick comes from', () => {
    // A job that omits `queue` is a job whose scheduling is a matter of convention, which is how the
    // sweep was one careless edit away from the queue in the first place.
    for (const job of JOBS) {
      expect(['inngest', 'pg_cron'], `${job.name} has no queue`).toContain(job.queue);
    }
  });

  it('a pg_cron job is never scheduled here, whatever its interval', () => {
    for (const job of JOBS.filter((candidate) => candidate.queue === 'pg_cron')) {
      expect(isScheduled(job), `${job.name} is on the queue`).toBe(false);
    }
  });

  it('every unscheduled job names the ticket that will schedule it', () => {
    // Silence is the failure mode this guards: a declared job with no handler and no ticket is
    // invisible to whoever goes looking for it during an incident.
    for (const job of PENDING_JOBS) {
      expect(job.pending, `${job.name} is unscheduled with no ticket`).toMatch(/^P\d+-T\d+$/);
    }
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
