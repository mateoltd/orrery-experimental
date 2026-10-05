/**
 * The worker process.  (P0-T7, P0-T13)
 *
 * ## What lives here
 *
 * The jobs in `plans/03` §6: the deadline sweep, auto-grading, atomic release, exports,
 * retention, and the simulation build. It is a separate process from `web` for two reasons
 * that are both about exams:
 *
 *   1. **A slow job must never delay an autosave.** The exam path is the most
 *      latency-sensitive thing we serve, and it must not queue behind a 5,000-attempt
 *      release.
 *   2. **A deploy must not interrupt an exam.** `web` and `worker` roll independently, and
 *      the release order is `migrate → worker → web`, with the previous release still
 *      deployable throughout.
 *
 * ## The one thing that is not negotiable
 *
 * The deadline sweep MUST NOT run on the same scheduler as everything else.
 *
 * `RN`/`C3`: Inngest does not support sub-minute cron, so a 30-second sweep was never
 * schedulable as originally specified. The sweep therefore runs on **Postgres `pg_cron`
 * behind an advisory lock**, at 10 s. A missed sweep is an alert, and two consecutive
 * misses page a human — because an unsubmitted attempt is a student waiting for a grade
 * they already earned.
 *
 * The advisory lock is what makes it safe to run on several workers at once: exactly one
 * sweep executes per tick, and the others return immediately.
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
 * Advisory-lock-guarded job runner. PostgreSQL advisory locks are the right primitive here
 * rather than a Redis lock: the lock and the data it protects are in the same database, so
 * they cannot disagree.
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
  run: () => Promise<void>;
}

export const JOBS: Job[] = [
  {
    name: 'exam.deadlineSweep',
    everySeconds: 10,
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
      const result = await runDeadlineSweep(db, systemClock.now());
      if (result.autoSubmitted > 0 || result.windowsClosed > 0) {
        log.info('swept', result);
      }
    },
  },
  {
    name: 'grade.auto',
    everySeconds: 30,
    purpose:
      'Run the pure grader over AUTO responses and write SEALED scores. Sealed until a ' +
      'ReleaseBatch reaches RELEASED (INV-RELEASE-1).',
    run: async () => {
      throw new Error('not implemented — P7-T9');
    },
  },
  {
    name: 'release.batch',
    everySeconds: 30,
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
    purpose:
      'Build, screenshot and register simulations changed since the last run. A merge that ' +
      'fails conformance does not reach the registry (10 §6).',
    run: async () => {
      throw new Error('not implemented — P6-T4');
    },
  },
];

export async function main(): Promise<void> {
  log.info('worker starting', { jobs: JOBS.map((j) => j.name) });
  for (const job of JOBS)
    log.info('job registered', { job: job.name, everySeconds: job.everySeconds });

  // The sweep's own tick lives in Postgres, not here. This process consumes the queue and
  // runs everything else. Registering the sweep in both places would double-submit, and a
  // double-submit at a deadline is exactly the race INV-LATE-1 exists to prevent.
  log.warn('job execution not wired — P0-T7 wiring, handlers land per phase');
}

// Do not start on import: the tests import this module to assert on JOBS.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  void main();
}
