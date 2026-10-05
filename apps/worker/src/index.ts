/**
 * The worker process: the Inngest consumer that runs the jobs.  (P0-T7, P0-T13)
 *
 * ## What lives here
 *
 * The entrypoint, and the job registry in `jobs.ts`, which is where the jobs in `plans/03` §6 are
 * declared: auto-grading, atomic release, exports, retention, and the simulation build. It is a
 * separate process from `web` for two reasons that are both about exams:
 *
 *   1. **A slow job must never delay an autosave.** The exam path is the most latency-sensitive
 *      thing we serve, and it must not queue behind a 5,000-attempt release.
 *   2. **A deploy must not interrupt an exam.** `web` and `worker` roll independently, and the
 *      release order is `migrate → worker → web`, with the previous release still deployable
 *      throughout.
 *
 * ## The one thing that is not negotiable
 *
 * The deadline sweep MUST NOT run on the same scheduler as everything else.
 *
 * `RN`/`C3`: Inngest does not support sub-minute cron, so a 30-second sweep was never schedulable as
 * originally specified. The sweep therefore runs on **Postgres `pg_cron` behind an advisory lock**, at
 * 10 s. A missed sweep is an alert, and two consecutive misses page a human — because an unsubmitted
 * attempt is a student waiting for a grade they already earned.
 *
 * The advisory lock is what makes it safe to run on several workers at once: exactly one sweep
 * executes per tick, and the others return immediately.
 *
 * That exclusion is a FIELD now (`queue: 'pg_cron'` in `jobs.ts`) rather than a comment, and it is
 * enforced twice: the scheduler builds functions only from jobs that say `inngest`, and `cronFor(10)`
 * refuses a ten-second interval outright. Registering the sweep in both places would double-submit at
 * a deadline, which is exactly the race `INV-LATE-1` exists to prevent.
 *
 * ## What runs, and what does not
 *
 * Two jobs run on this queue — `release.batch` and `student.digest`. Three more are declared with
 * handlers that throw `not implemented` (`grade.auto`, `retention.sweep`, `sim.build`) and are
 * **deliberately not scheduled**: a registered job that throws every tick is an alert storm, and an
 * unregistered job is invisible. They are named once in the boot log with the ticket that will land
 * them, and their handlers still throw so that clearing `pending` without implementing produces a
 * loud first tick instead of a silent no-op.
 *
 * ⚠️ **AND THE SWEEP STILL HAS NO TICK ON EITHER SCHEDULER.** `runDeadlineSweep` exists and is
 * tested; `pg_cron` registration is a migration, and no migration in the corpus schedules it. That
 * gap is outside what a job registry can close, and it is recorded here rather than papered over:
 * until a migration registers the sweep, an attempt past its deadline is not auto-submitted by
 * anything.
 */

import { systemClock } from '@orrery/clock';
import { loadEnv } from '@orrery/config/env';
import { createLogger } from '@orrery/config/logging';
import { JOBS } from './jobs.js';
import { exitWithCode, startWorker } from './scheduler.js';

/** Re-exported so `apps/worker` and the tests exercise the SAME lock and the SAME registry, not copies. */
export {
  isScheduled,
  JOBS,
  type Job,
  PENDING_JOBS,
  runExclusive,
  SCHEDULED_JOBS,
  SWEEP_JOB_NAME,
} from './jobs.js';
export {
  createFunctions,
  createJobRunner,
  createWorkerServer,
  DRAINING_STATUS,
  INNGEST_APP_ID,
  installSignalHandlers,
  JOB_RETRIES,
  type JobRunner,
  jobHandler,
  SHUTDOWN_SIGNALS,
  type ShutdownOutcome,
  type StartWorkerOptions,
  shutdownWorker,
  startWorker,
  type TickOutcome,
  type TickResult,
  type WorkerHandle,
} from './scheduler.js';

/** Same channel and bindings as the jobs' own logging, so one grep finds every worker line. */
const log = createLogger('job', { service: 'worker' });

/**
 * BOOT: validate the environment, then hand the jobs to the queue.
 *
 * `loadEnv()` first is deliberate — `03` §7 requires a malformed variable to fail at boot rather than
 * three layers into a tick, and a port that cannot bind is not a useful way to learn the deployment
 * is missing `INNGEST_*`.
 */
export async function main(): Promise<void> {
  const env = loadEnv();

  const worker = await startWorker({
    jobs: JOBS,
    port: env.WORKER_INNGEST_PORT,
    shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
    clock: systemClock,
    log,
  });

  /**
   * THE INNGEST ENDPOINT IS NOT REACHABLE UNLESS SOMETHING IS TOLD ITS ADDRESS, SO SAY IT.
   *
   * `npx inngest-cli dev -u http://localhost:<port>/api/inngest` in development, and the same URL in the
   * platform's app configuration in production. Logging the port at boot means the wiring is checkable
   * from startup output rather than by reading a deployment manifest.
   */
  log.info('inngest endpoint ready; point the Inngest server at it', { port: worker.port });
}

// Do not start on import: the tests import this module to assert on JOBS.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  /**
   * A BOOT FAILURE HAS TO END THE PROCESS, OR IT IS NOT A BOOT FAILURE.
   *
   * `loadEnv()` throwing is the documented way a missing variable stops this process (`03` §7), and a `void main()` would
   * leave the rejection unhandled: Node prints the stack and exits non-zero, which happens to be right, but nothing logs
   * it in the worker's own channel and nothing makes the exit deliberate. `exitWithCode` is the same path a drain takes,
   * so a refused start and a finished drain are reported the same way.
   */
  void main().catch(async (error: unknown) => {
    log.fatal('worker refused to start', { error });
    await exitWithCode(1);
  });
}
