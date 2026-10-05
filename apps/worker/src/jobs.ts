/**
 * The job registry: what work exists, and WHERE each job's tick comes from.  (P0-T7)
 *
 * ## WHY `queue` IS A FIELD AND NOT A CONVENTION
 *
 * The deadline sweep must not be scheduled on the queue — `RN`/`C3`, and the reason is
 * `INV-LATE-1`: two schedulers for one sweep means two auto-submissions at a deadline, and a
 * double-submit at a deadline is exactly the race the invariant exists to prevent. For this session
 * that was a *silence* — the sweep was absent from `JOBS` on the general queue, with a comment
 * explaining why it was absent, which is the weakest possible form of a rule: correct until the next
 * person adds a job.
 *
 * So every job now declares where its tick comes from, and the scheduler builds functions only from
 * the jobs that say `inngest`. The sweep cannot drift onto the queue because there is no way to
 * express that it is on the queue, and the second line of defence is mechanical: its 10-second
 * interval has no cron expression at all (`cron.ts`), so even a hand-edited `queue` would fail at
 * boot rather than quietly run every minute.
 *
 * ## WHY `pending` IS A FIELD TOO
 *
 * Three handlers throw `not implemented`, and there are three wrong ways to leave them:
 * registered and throwing (an alert every tick for a job nobody has written), unregistered and
 * silent (a runbook that names a job that does not exist), or left in a list nobody reads. The
 * choice here is: **not scheduled, named loudly once at boot, with the ticket recorded in the
 * registry**, and the handler still throwing so that removing `pending` without implementing anything
 * fails on the first tick rather than becoming a no-op that looks like success.
 */

import { systemClock } from '@orrery/clock';
import { loadEnv } from '@orrery/config/env';
import { createLogger } from '@orrery/config/logging';
import { getPrisma } from '@orrery/db';
import { runReleaseTick } from '@orrery/db/release-worker';
import { runStudentDigestTick } from '@orrery/db/student-digest';
import { runDeadlineSweep } from '@orrery/db/sweep';

const db = getPrisma();

const log = createLogger('job', { service: 'worker' });

/**
 * Advisory-lock-guarded job runner. PostgreSQL advisory locks are the right primitive for the sweep
 * rather than a Redis lock: the lock and the data it protects are in the same database, so they
 * cannot disagree.
 */
/** Re-exported so `apps/worker` and the tests exercise the SAME lock, not two implementations of it. */
export { runExclusive } from '@orrery/db/run-exclusive';

export interface Job {
  name: string;
  /** Minimum interval between runs. The sweep's is 10 s; everything else is minutes. */
  everySeconds: number;
  /**
   * The reason a job exists, quoted into its runbook. A job whose purpose cannot be stated
   * in one sentence is a job nobody will dare to disable at 3 a.m.
   */
  purpose: string;
  /**
   * WHERE THE TICK COMES FROM. `pg_cron` means this process must never schedule it, however long the
   * interval looks.
   */
  queue: 'inngest' | 'pg_cron';
  /**
   * The ticket for a handler that has not landed. Set means: do not schedule, say so at boot, and
   * keep the throwing body so that un-setting it without implementing produces a loud first tick.
   */
  pending?: string;
  run: () => Promise<void>;
}

export const JOBS: Job[] = [
  {
    name: 'exam.deadlineSweep',
    everySeconds: 10,
    queue: 'pg_cron',
    purpose:
      'Auto-submit attempts past their deadline + grace, close per-question windows, and shed ' +
      'writes inside the final seconds. Runs on pg_cron behind an advisory lock, NOT on the ' +
      'general queue, because an unsubmitted attempt is a student waiting for a grade.',
    run: async () => {
      // P8-T9. Three steps, per 03 §3.4, in `packages/db/src/sweep.ts`:
      //   1. IN_PROGRESS with deadlineAt + grace < now  -> auto-submit from SERVER state
      //   2. per-question windows past deadline          -> close per policy
      //
      // Step 3 of §3.4 ("answer writes get 409 WINDOW_CLOSING inside the final 10 s") is the PRE-B10 text and is NOT
      // implemented here, deliberately: `B10` records that shedding answer writes inside the grace window DISCARDED
      // answers the plan had promised to keep. Only telemetry sheds (`P8-T9b`). §3.4 needs amending, and until it does
      // this comment is the correction.
      //
      // **THE TRANSACTION LIVES IN `packages/db`, NOT HERE.** `plans/03` §5: only `packages/db` imports Prisma, and
      // multi-table writes go through a service function that owns the transaction and the audit events. A cron that
      // opened its own transaction here would be the second writer of the same rows and would not be covered by the
      // tests that now exist for the sweep.
      //
      // **NOTHING IN THIS PROCESS CALLS THIS BODY, AND `queue: 'pg_cron'` IS WHY.** The scheduler builds functions only
      // from jobs that say `inngest`, and `cronFor(10)` refuses a 10-second interval outright, so the exclusion is
      // mechanical as well as declared. What is missing is the other half, which no job registry can supply: nothing
      // registers this sweep in Postgres. See the P0-T7 report — the sweep has no tick on EITHER scheduler.
      const result = await runDeadlineSweep(db, systemClock.now());
      if (result.autoSubmitted > 0 || result.windowsClosed > 0) {
        log.info('swept', result);
      }
    },
  },
  {
    name: 'grade.auto',
    everySeconds: 30,
    queue: 'inngest',
    // Not scheduled: there is no handler, and a registered job that throws every 30 seconds is an alert storm that
    // trains everyone to ignore the alerting. The interval is also not schedulable as declared (see `cron.ts`), which
    // is the next thing P7-T9 has to decide: 60 seconds, or an event per submission as 03 §6 describes.
    pending: 'P7-T9',
    purpose:
      'Run the pure grader over AUTO responses and write SEALED scores. Sealed until a ' +
      'ReleaseBatch reaches RELEASED (INV-RELEASE-1).',
    run: async () => {
      throw new Error('not implemented — P7-T9');
    },
  },
  {
    name: 'release.batch',
    // 60s, not the 30s this job used to declare: a cron expression resolves to one minute, and declaring an interval
    // the scheduler cannot honour is a declaration that means nothing. Release latency is bounded by the batch, not by
    // the tick — 5,000 attempts measured at 379 ms (P10-T2) — and a queued tick is retried rather than dropped.
    everySeconds: 60,
    queue: 'inngest',
    purpose:
      'Resume RELEASING batches: lock and verify every member, then commit all scores and the ' +
      'batch visibility gate in one transaction; retry notification delivery after commit.',
    run: async () => {
      const origin = loadEnv().APP_URL;
      const results = await runReleaseTick(db, systemClock, origin);
      for (const result of results) {
        if (result.error) log.error('release failed; next tick retries', { ...result });
        // Students are waiting on a frozen batch that cannot release; silence here is the outage.
        else if (result.refusals) log.warn('release refused; batch stays RELEASING', { ...result });
        else if (result.released || result.notified > 0)
          log.info('release processed', { ...result });
      }
    },
  },
  {
    name: 'student.digest',
    // Each tick reads every active student. A digest five minutes late costs nobody anything.
    everySeconds: 300,
    queue: 'inngest',
    purpose:
      'Queue each student’s instruments-only coursework digest at their preferred interval, only ' +
      'when its content changed, with reversible freeze copy and no rankings.',
    run: async () => {
      const result = await runStudentDigestTick(db, systemClock, loadEnv().APP_URL);
      if (result.queued > 0 || result.failed > 0) log.info('student digests processed', result);
    },
  },
  {
    name: 'retention.sweep',
    everySeconds: 86_400,
    queue: 'inngest',
    // Unscheduled for the same reason as `grade.auto`, and with more at stake: a retention job that throws on a daily
    // cron is also the job a DPO would ask about, so its absence has to be visible rather than inferred.
    pending: 'P14-T6',
    purpose:
      'Delete expired telemetry, sessions, invitations and exports. Dry-run mode reports ' +
      'counts without deleting, and the counts go to the audit stream (14 §7.2).',
    run: async () => {
      throw new Error('not implemented — P14-T6');
    },
  },
  {
    name: 'sim.build',
    everySeconds: 3_600,
    queue: 'inngest',
    // `03` §2 gives `sim-build` its OWN deployable unit; this registry entry is the queue-side description of that
    // unit's tick, and it stays unscheduled until the build pipeline (P6-T4) has something to invoke.
    pending: 'P6-T4',
    purpose:
      'Build, screenshot and register simulations changed since the last run. A merge that ' +
      'fails conformance does not reach the registry (10 §6).',
    run: async () => {
      throw new Error('not implemented — P6-T4');
    },
  },
];

/**
 * THE ONE PREDICATE, so the scheduler and its tests cannot disagree about what runs here.
 *
 * A job is scheduled when its tick comes from the queue AND its handler exists. The two exclusions are
 * different failures and are tested separately: `queue: 'pg_cron'` excludes the sweep because a second
 * tick would double-submit at a deadline, and `pending` excludes the unimplemented handlers because a
 * cron that throws forever is an alert storm rather than a job.
 */
export function isScheduled(job: Job): boolean {
  return job.queue === 'inngest' && job.pending === undefined;
}

export const SCHEDULED_JOBS: Job[] = JOBS.filter(isScheduled);

/** Declared, unscheduled, and why. Logged once at boot so a missing job is not a discovery. */
export const PENDING_JOBS: Job[] = JOBS.filter(
  (job) => job.queue === 'inngest' && !isScheduled(job),
);

/** The sweep, by name, for the assertions that keep it off this queue. */
export const SWEEP_JOB_NAME = 'exam.deadlineSweep';
