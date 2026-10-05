/**
 * The scheduler: what actually runs a job, and what happens when one of them is still running.  (P0-T7)
 *
 * ## WHY THIS IS INNGEST AND NOT A `setInterval`
 *
 * `plans/03` §2 names the worker an "Inngest consumer, cron, background jobs" and `ADR-0012` chose it
 * for one reason: durable retries and step history. A hand-rolled interval loop gives neither, and it
 * fails in the specific way that hurts here — a tick that overlaps the previous one, where the second
 * run of a release tick waits on rows the first is still holding and the backlog becomes two
 * backlogs. The loop is also invisible: nothing records that a tick ran, so "the release job is
 * broken" and "the release job never ran" produce the same silence.
 *
 * So the durable layer does the scheduling, and this module is the part Inngest calls into.
 *
 * ## THE DEADLINE SWEEP IS NOT SCHEDULED HERE, AND CANNOT BE
 *
 * `RN`/`C3`: a five-field cron has no sub-minute field, so the 10-second sweep is a `pg_cron` job
 * behind a Postgres advisory lock. Registering it on both schedulers would auto-submit every attempt
 * twice at its deadline — the exact race `INV-LATE-1` exists to prevent. Two independent guards
 * enforce the exclusion: `jobs.ts` marks the sweep `queue: 'pg_cron'` and the scheduler builds
 * functions only from jobs that say `inngest`, and `cronFor(10)` refuses a ten-second interval
 * outright, so even a hand-edited field fails at boot instead of quietly running every minute.
 *
 * ## NON-OVERLAP IS ENFORCED TWICE, DELIBERATELY
 *
 * 1. **Durably, by the queue.** Every function declares `concurrency: { limit: 1 }` with no key, which
 *    applies to the function across every replica — so two workers cannot run two releases at once
 *    either. A cron firing while a run is in flight is queued, not dropped.
 * 2. **In-process, by `createJobRunner`.** The guard is what survives a misconfigured or dev-mode
 *    queue, and it is the layer that can be tested without a server. A tick that arrives while the
 *    previous run is still going is *skipped* rather than queued, because a release tick that resumes
 *    every `RELEASING` batch has nothing to do 40 ms after the previous one finished.
 *
 * ## A FAILING JOB IS AN OUTCOME, NOT AN EXCEPTION
 *
 * `runAll` never rejects: one broken handler must not stop the digest or the next release. But a
 * swallowed failure is also a silent one, so the split is deliberate — the runner records the failure
 * WITH THE JOB NAME and returns it, and `jobHandler` re-throws it so the durable layer schedules the
 * retry. Two consumers, one outcome; neither of them loses the other requirement.
 *
 * ## SHUTDOWN IS DELIBERATE RATHER THAN GRACEFUL-BY-DEFAULT
 *
 * `SIGTERM` stops the listener and refuses new work, waits up to the grace period for what is running,
 * and then abandons it — with a `fatal` line naming every job still in flight, and a non-zero exit so
 * the platform sees a container that did not drain. Abandoning is safe *because* the work is durable:
 * the queue retries the run on another attempt. Exiting zero with a half-finished release would not.
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Clock, systemClock } from '@orrery/clock';
import { createLogger, type Logger } from '@orrery/config/logging';
import { Inngest, type InngestFunction } from 'inngest';
import { serve } from 'inngest/node';
import { cronFor } from './cron.js';
import { isScheduled, type Job } from './jobs.js';

/**
 * THE APP ID IS A CONSTANT, AND CHANGING IT IS NOT A RENAME.
 *
 * The Inngest dashboard keys run history, retry budgets and replay by app id. A second app id is a
 * second empty dashboard and a second set of cron schedules, so the two processes would each believe
 * they owned the schedule and neither would show the other's history.
 */
export const INNGEST_APP_ID = 'orrery';

/**
 * Retries are per-run, not per-tick, and three is chosen rather than tuned: the handlers are
 * idempotent (a release tick resumes what is still `RELEASING`, a digest re-checks its content hash),
 * so a retry costs a repeat of work that already happened and a crash costs a batch that never runs.
 */
export const JOB_RETRIES = 3;

/** What a draining worker answers instead of accepting an invocation. */
export const DRAINING_STATUS = 503;

/** What one attempt at one job did. */
export type TickOutcome = 'completed' | 'failed' | 'skipped' | 'refused';

export interface TickResult {
  readonly job: string;
  readonly outcome: TickOutcome;
  /** Elapsed on the injected clock's MONOTONIC reading — a stopwatch, not an instant. */
  readonly durationMs?: number;
  /** Present only when `outcome` is `failed`. Carried so the handler can re-throw what was caught. */
  readonly error?: unknown;
}

export interface DrainReport {
  /** Jobs that were in flight when the drain began and completed. */
  readonly finished: readonly string[];
  /** Jobs still running at the grace deadline. Deliberately abandoned, and logged as fatal. */
  readonly abandoned: readonly string[];
}

export interface JobRunner {
  /** True once `beginDrain` has been called: new work is refused, in-flight work continues. */
  readonly draining: boolean;
  /** Names of the jobs currently running. */
  readonly inFlight: readonly string[];
  run(job: Job): Promise<TickResult>;
  /** Every job, one after another, with each one's failure contained. Never rejects. */
  runAll(): Promise<TickResult[]>;
  beginDrain(reason: string): void;
  /** Resolve when nothing is running, or when the grace expires. Never throws. */
  awaitDrain(graceMs: number): Promise<DrainReport>;
}

export interface JobRunnerOptions {
  readonly jobs: readonly Job[];
  readonly clock?: Clock;
  readonly log?: Logger;
}

/**
 * THE RUNNER OWNS NON-OVERLAP, FAILURE CONTAINMENT AND THE DRAIN STATE — nothing else.
 *
 * It knows nothing about Inngest, opens no connection and starts no timer of its own, so all three
 * properties are testable with three fake jobs and a `FrozenClock`.
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { jobs, clock = systemClock, log = createLogger('job', { service: 'worker' }) } = options;

  /** Job name to the monotonic instant it started. Presence IS the lock. */
  const running = new Map<string, number>();
  /** One settled-promise per in-flight run, so a drain can wait for all of them at once. */
  const inFlight = new Set<Promise<void>>();
  let draining = false;

  const run = async (job: Job): Promise<TickResult> => {
    const name = job.name;

    if (draining) {
      // Refused rather than queued: a tick that starts after SIGTERM is work this process has been told not to accept,
      // and the durable layer will re-run it after the restart, which is where it belongs.
      log.warn('tick refused: this worker is draining and is not starting new work', { job: name });
      return { job: name, outcome: 'refused' };
    }

    const heldSince = running.get(name);
    if (heldSince !== undefined) {
      // THE HAZARD IS ONE BACKLOG BECOMING TWO. A job slower than its interval — a 5,000-attempt release, a
      // retention sweep — would otherwise be re-entered by the next tick while the first still holds its rows.
      log.warn('tick skipped: the previous run of this job has not finished', {
        job: name,
        heldMs: clock.monotonic() - heldSince,
      });
      return { job: name, outcome: 'skipped' };
    }

    const startedAt = clock.monotonic();
    running.set(name, startedAt);
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlight.add(settled);

    try {
      await job.run();
      const durationMs = clock.monotonic() - startedAt;
      log.info('job finished', { job: name, durationMs });
      return { job: name, outcome: 'completed', durationMs };
    } catch (error) {
      const durationMs = clock.monotonic() - startedAt;
      /**
       * THE JOB NAME IS A FIELD, NOT PART OF THE SENTENCE, AND THAT IS THE POINT.
       *
       * `log.error('job failed', { error })` is an outage nobody can attribute: the next person reading the log has six
       * jobs' errors interleaved and no way to tell which one is failing. The name rides on the record, so the record is
       * searchable by job and an alert can be raised per job.
       */
      log.error('job failed; the other jobs are unaffected and this tick will be retried', {
        job: name,
        durationMs,
        error,
      });
      return { job: name, outcome: 'failed', durationMs, error };
    } finally {
      running.delete(name);
      inFlight.delete(settled);
      settle();
    }
  };

  return {
    get draining() {
      return draining;
    },
    get inFlight() {
      return [...running.keys()];
    },
    run,
    runAll: () => Promise.all(jobs.map((job) => run(job))),
    beginDrain: (reason) => {
      if (draining) return;
      draining = true;
      log.info('worker draining: no new ticks will be started', {
        reason,
        inFlight: [...running.keys()],
      });
    },
    awaitDrain: async (graceMs) => {
      const pending = [...running.keys()];
      if (pending.length === 0) return { finished: [], abandoned: [] };

      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'grace-expired'>((resolve) => {
        timer = setTimeout(() => resolve('grace-expired'), graceMs);
        // A drain timer must not be the reason a process stays alive: an unresolved tick is the platform's problem now.
        timer.unref();
      });
      const drained = Promise.all([...inFlight]).then(() => 'drained' as const);
      const outcome = await Promise.race([drained, expired]);
      if (timer) clearTimeout(timer);

      if (outcome === 'drained') return { finished: pending, abandoned: [] };

      // The names are read at the moment of abandonment, not the moment of the drain: a job that finished during the
      // grace period is finished, and naming it as abandoned would page somebody for work that completed.
      const abandoned = [...running.keys()];
      log.fatal('abandoning in-flight jobs at the grace deadline; the queue will run them again', {
        jobs: abandoned,
        graceMs,
      });
      return { finished: pending.filter((name) => !abandoned.includes(name)), abandoned };
    },
  };
}

/**
 * THE HANDLER INNGEST CALLS, AND THE ONE PLACE A CAUGHT FAILURE IS RE-THROWN.
 *
 * The runner swallows so one job cannot stop the others; the handler re-throws so the durable layer sees a failure and
 * schedules its retry. A version that only swallowed would pass every test in this file and silently turn a retrying
 * queue into a fire-and-forget one, which is the failure this whole module was chosen to avoid.
 */
export function jobHandler(job: Job, runner: JobRunner): () => Promise<TickResult> {
  return async () => {
    const result = await runner.run(job);
    if (result.outcome === 'failed') {
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
    // A skip is not a failure: nothing was attempted, so there is nothing to retry and the next tick is on schedule.
    return result;
  };
}

/**
 * The Inngest functions for the jobs whose tick comes from this queue.
 *
 * `cronFor` is called here, and it THROWS for anything a cron cannot express exactly — so an
 * unschedulable interval is a boot failure with the interval in the message, not a silently coarsened
 * cadence. The sweep never reaches this line.
 */
export function createFunctions(
  client: Inngest,
  jobs: readonly Job[],
  runner: JobRunner,
): InngestFunction.Any[] {
  return jobs.filter(isScheduled).map((job) =>
    client.createFunction(
      {
        id: job.name,
        name: job.name,
        description: job.purpose,
        triggers: [{ cron: cronFor(job.everySeconds) }],
        /**
         * ONE AT A TIME, GLOBALLY, WHICH INCLUDES EVERY REPLICA.
         *
         * A keyless limit applies to the function rather than to one worker, so two `worker` replicas cannot run two
         * release ticks at the same moment — which matters because a release is a transaction over shared rows, and the
         * database would serialise them anyway with lock timeouts instead of with a queue. The tick that arrives while a
         * run is in flight is QUEUED by the durable layer, and the in-process guard in `createJobRunner` is what skips it
         * if the queue is ever running in a mode that does not honour this.
         */
        concurrency: { limit: 1 },
        retries: JOB_RETRIES,
      },
      jobHandler(job, runner),
    ),
  );
}

/** The structural shape of `process.once` for signals, so the wiring is testable without a real signal. */
export interface SignalRegistrar {
  once(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/** Both signals, and `once` — a second SIGTERM during a slow drain must not start a second shutdown. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export function installSignalHandlers(
  registrar: SignalRegistrar,
  onSignal: (signal: NodeJS.Signals) => void,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    registrar.once(signal, (received) => {
      onSignal(received);
    });
  }
}

export interface WorkerServerOptions {
  readonly client: Inngest;
  readonly functions: readonly InngestFunction.Any[];
  readonly runner: JobRunner;
}

/**
 * THE LISTENER, AND THE ONLY HTTP THIS PROCESS SERVES.
 *
 * `03` §2 and `19` §4 both say the worker holds no HTTP handlers, and the honest reading is that it holds no
 * APPLICATION handlers: this endpoint is Inngest calling the functions it was told to run, and it lives here rather than
 * in `web` because `03` §5 keeps the Prisma client out of `web` and the release transaction is the reason there is a
 * worker at all. It is also why this process refusing connections while draining matters: the endpoint is the only way
 * work gets in.
 */
export function createWorkerServer(options: WorkerServerOptions): Server {
  const handler = serve({ client: options.client, functions: options.functions });
  return createServer((req, res) => {
    if (options.runner.draining) {
      /**
       * 503 RATHER THAN A CLOSED SOCKET, BECAUSE A CLOSE IS NOT ENOUGH ON ITS OWN.
       *
       * `server.close()` stops new connections but leaves an established keep-alive connection able to POST another
       * invocation, and the queue will happily send one. Answering 503 makes the refusal explicit to the caller instead of
       * leaving it to infer a dropped request, and the invocation is retried elsewhere rather than run by a process that
       * has been told to stop.
       */
      res.statusCode = DRAINING_STATUS;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'draining', service: 'worker' }));
      return;
    }
    handler(req, res);
  });
}

export interface ShutdownPlan {
  readonly runner: JobRunner;
  readonly server: Server;
  readonly graceMs: number;
  readonly log: Logger;
}

export interface ShutdownOutcome {
  readonly signal: string;
  readonly finished: readonly string[];
  readonly abandoned: readonly string[];
  /** 0 when everything finished, 1 when a job was abandoned. A draining worker that abandoned work must not look clean. */
  readonly exitCode: number;
}

/**
 * STOP ACCEPTING, THEN WAIT, THEN ABANDON — IN THAT ORDER, AND THE ORDER IS THE PROPERTY.
 *
 * Closing the listener first means no new invocation can arrive while the drain is in progress; waiting second means a
 * release transaction that is 200 ms from committing is not killed for being 200 ms from committing; abandoning last,
 * loudly and non-zero, means the platform learns that this container did not drain instead of inferring health from an
 * exit code it cannot question.
 */
export async function shutdownWorker(plan: ShutdownPlan, signal: string): Promise<ShutdownOutcome> {
  plan.runner.beginDrain(signal);
  await new Promise<void>((resolve) => {
    plan.server.close(() => {
      resolve();
    });
    // Nothing has been listened on (a test, or a bind failure that never reached `listen`), and `close()` then never
    // calls back — so a drain must not be able to hang on a server that was never open.
    if (!plan.server.listening) resolve();
  });
  const report = await plan.runner.awaitDrain(plan.graceMs);
  const outcome: ShutdownOutcome = {
    signal,
    finished: report.finished,
    abandoned: report.abandoned,
    exitCode: report.abandoned.length > 0 ? 1 : 0,
  };
  if (outcome.exitCode === 0) {
    plan.log.info('worker stopped cleanly', { signal, finished: report.finished });
  }
  return outcome;
}

export interface StartWorkerOptions {
  readonly jobs: readonly Job[];
  readonly port: number;
  readonly shutdownGraceMs: number;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly host?: string;
  /** Defaults to `process`. Injectable so the signal wiring is testable without signalling the test runner. */
  readonly registrar?: SignalRegistrar;
  /** Defaults to `exitWithCode`. Injectable so a test can observe the exit code instead of dying. */
  readonly exit?: (code: number) => void | Promise<void>;
}

/**
 * FLUSH, THEN EXIT — AND THE FLUSH IS THE POINT.
 *
 * **A DRAINED CONTAINER THAT DOESN'T EXIT IS AN INCIDENT, NOT A CLEAN SHUTDOWN.** This function was `options.exit?.(code)`
 * — an optional call with no default — and the end-to-end run caught it immediately: the worker drained, abandoned a job
 * at the grace deadline, logged `fatal`, and then sat there. `process.exit` was never called, and Node cannot reach an
 * idle state on its own because the Prisma client's pool is still an open handle.
 *
 * **AND `process.exit` ON ITS OWN LOSES THE ONE LINE THAT MATTERS.** stdout is asynchronous when it is a pipe, which under
 * Docker it is, so exiting immediately after the `fatal` record can truncate it — the record explaining that a release was
 * abandoned is exactly the record that must survive. An empty write's callback fires once the queue ahead of it has
 * drained, which is the cheapest honest way to know the bytes are gone.
 */
export async function exitWithCode(code: number): Promise<void> {
  if (!process.stdout.destroyed && process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => {
      process.stdout.write('', () => {
        resolve();
      });
    });
  }
  process.exit(code);
}

export interface WorkerHandle {
  readonly port: number;
  readonly functions: readonly InngestFunction.Any[];
  readonly runner: JobRunner;
  readonly server: Server;
  /** Idempotent: the signal path and a direct call are the same shutdown. */
  shutdown(signal?: string): Promise<ShutdownOutcome>;
}

/**
 * START THE CONSUMER: the queue's functions, the guarded runner behind them, and the listener Inngest calls.
 *
 * The boot log states the whole schedule — what runs here, on what cron, and what is deliberately not running — because
 * "which jobs does this process own" is the first question of every incident and it should be answerable from one line
 * of startup output rather than by reading a registry.
 */
export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger('job', { service: 'worker' });
  const client = new Inngest({ id: INNGEST_APP_ID });
  const runner = createJobRunner({ jobs: options.jobs, clock, log });
  const functions = createFunctions(client, options.jobs, runner);
  const server = createWorkerServer({ client, functions, runner });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;

  const scheduled = options.jobs.filter(isScheduled);
  log.info('worker starting', { jobs: scheduled.map((job) => job.name) });
  for (const job of scheduled) {
    log.info('job scheduled', {
      job: job.name,
      everySeconds: job.everySeconds,
      cron: cronFor(job.everySeconds),
    });
  }
  for (const job of options.jobs) {
    if (job.queue === 'pg_cron') {
      log.info('job is not scheduled here: its tick comes from pg_cron', {
        job: job.name,
        everySeconds: job.everySeconds,
      });
    }
  }
  for (const job of options.jobs) {
    if (job.queue === 'inngest' && job.pending !== undefined) {
      /**
       * SAID ONCE, AT BOOT, AND NOT ON EVERY TICK.
       *
       * A handler that throws on a 30-second cron is an alert storm that teaches everyone to ignore the alerting; an
       * unregistered handler is a job nobody knows exists. One warning per boot is the difference: the runbook shows the
       * gap, the alert channel stays clean, and the ticket is on the record.
       */
      log.warn('job is declared but not scheduled: its handler has not landed', {
        job: job.name,
        ticket: job.pending,
      });
    }
  }
  log.info('worker ready', { port, functions: functions.length, jobs: scheduled.length });

  let shuttingDown: Promise<ShutdownOutcome> | undefined;
  const exit = options.exit ?? exitWithCode;
  const shutdown = (signal = 'manual'): Promise<ShutdownOutcome> => {
    // Two signals during one drain must not open two drains; the second joins the first.
    shuttingDown ??= shutdownWorker(
      { runner, server, graceMs: options.shutdownGraceMs, log },
      signal,
    ).then(async (outcome) => {
      await exit(outcome.exitCode);
      return outcome;
    });
    return shuttingDown;
  };

  installSignalHandlers(options.registrar ?? process, (signal) => {
    void shutdown(signal);
  });

  return { port, functions, runner, server, shutdown };
}
