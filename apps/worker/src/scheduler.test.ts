/**
 * THE SCHEDULER'S PROPERTIES, NOT ITS WIRING.  (P0-T7)
 *
 * Four things can go wrong with a job runner, and all four are invisible in production until a backlog,
 * an alert nobody can attribute, or a double-submission at a deadline:
 *
 *   1. **A job overlaps itself.** A tick that starts while the previous one is still going is how one
 *      backlog becomes two, and a 5,000-attempt release or a retention sweep is measured in minutes.
 *   2. **One failure stops everything.** A release that throws must not silence the digest, and the
 *      failure must name the job it came from or nobody can attribute it.
 *   3. **The sweep drifts onto this queue.** Two schedulers for one sweep is a double auto-submit at a
 *      deadline: `INV-LATE-1`.
 *   4. **Shutdown kills a transaction that was 200 ms from committing.** Which is why the drain is a
 *      sequence — stop accepting, then wait, then abandon loudly.
 *
 * None of these need an Inngest server to test, which is the point: the durable layer's *retries* and
 * *queueing* are its own contract, and what this file pins is the behaviour that has to hold even when
 * that layer is misconfigured or absent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@orrery/config/logging';
import { Inngest } from 'inngest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cronFor } from './cron.js';
import { JOBS, type Job, PENDING_JOBS, SCHEDULED_JOBS, SWEEP_JOB_NAME } from './jobs.js';
import {
  createFunctions,
  createJobRunner,
  createWorkerServer,
  DRAINING_STATUS,
  installSignalHandlers,
  JOB_RETRIES,
  type JobRunner,
  jobHandler,
  SHUTDOWN_SIGNALS,
  type SignalRegistrar,
  shutdownWorker,
  startWorker,
} from './scheduler.js';

/** The registry imports Prisma and the app env; neither belongs in a scheduler test. */
vi.mock('@orrery/db', () => ({ getPrisma: () => ({}) }));
vi.mock('@orrery/config/env', () => ({
  loadEnv: () => ({ APP_URL: 'https://configured.example' }),
}));

/** A logger that keeps its records and writes nothing, so assertions can read the log itself. */
function recordingLogger() {
  return createLogger('job', {}, { write: () => {}, retain: 500 });
}

/** A clock the test advances by hand, so a duration is a number the test chose rather than one it waited for. */
function testClock() {
  let elapsed = 0;
  return {
    now: () => 1_700_000_000_000,
    monotonic: () => elapsed,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

function fakeJob(overrides: Partial<Job> & Pick<Job, 'name' | 'run'>): Job {
  return {
    everySeconds: 60,
    queue: 'inngest',
    purpose: `A test job called ${overrides.name} whose stated purpose is long enough to read at 3 a.m.`,
    ...overrides,
  };
}

/** A promise plus its resolver, for holding a job open across an await. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A client pointed at an unroutable address, so no test can reach the network through Inngest. */
function offlineClient() {
  return new Inngest({
    id: 'orrery-test',
    signingKey: 'test-signing-key-not-a-secret',
    baseUrl: 'http://127.0.0.1:9',
  });
}

async function listen(server: ReturnType<typeof createWorkerServer>): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return (server.address() as { port: number }).port;
}

describe('what the queue is allowed to schedule', () => {
  const runner = createJobRunner({ jobs: JOBS, clock: testClock(), log: recordingLogger() });
  const functions = createFunctions(offlineClient(), JOBS, runner);

  it('DOES NOT SCHEDULE THE DEADLINE SWEEP', () => {
    // The one registration that would double-submit every attempt at its deadline: `INV-LATE-1`.
    expect(SCHEDULED_JOBS.map((job) => job.name)).not.toContain(SWEEP_JOB_NAME);
    expect(functions.map((fn) => fn.opts.id)).not.toContain(SWEEP_JOB_NAME);
  });

  it('cannot schedule the sweep even if its queue field were edited to lie', () => {
    // The second guard, and the reason the exclusion is mechanical rather than conventional: a
    // ten-second interval has no cron expression, so `cronFor` refuses it and the boot fails.
    const sweep = JOBS.find((job) => job.name === SWEEP_JOB_NAME);
    expect(sweep?.everySeconds).toBe(10);
    expect(() => cronFor(sweep?.everySeconds ?? 0)).toThrow(/below the one-minute floor/);
    const lying: Job = { ...(sweep as Job), queue: 'inngest' };
    expect(() => createFunctions(offlineClient(), [lying], runner)).toThrow(
      /below the one-minute floor/,
    );
  });

  it('creates exactly one function per scheduled job, and no others', () => {
    expect(functions.map((fn) => fn.opts.id).sort()).toEqual(
      SCHEDULED_JOBS.map((job) => job.name).sort(),
    );
  });

  it('gives every function a cron that IS the interval the job declares', () => {
    // No silent rounding: if a cadence cannot be expressed exactly, the job must not be scheduled at all.
    for (const job of SCHEDULED_JOBS) {
      const fn = functions.find((candidate) => candidate.opts.id === job.name);
      expect(fn, `${job.name} has no function`).toBeDefined();
      expect(fn?.opts.triggers).toEqual([{ cron: cronFor(job.everySeconds) }]);
    }
  });

  it('allows ONE run at a time for every function, which is what stops a release overlapping itself', () => {
    // Keyless: the limit applies to the function across every replica, not to one worker process.
    for (const fn of functions) {
      expect(fn.opts.concurrency, `${fn.opts.id} has no concurrency limit`).toEqual({ limit: 1 });
    }
  });

  it('gives every function retries, because a swallowed failure is a lost release', () => {
    for (const fn of functions) {
      expect(fn.opts.retries, `${fn.opts.id} has no retries`).toBe(JOB_RETRIES);
    }
  });

  it('leaves the three unimplemented handlers OFF the queue, with their tickets on the record', () => {
    // A registered job that throws every tick is an alert storm; an unregistered one is invisible. The
    // compromise is declared-but-unscheduled, and the warning is asserted in the boot-log test below.
    expect(PENDING_JOBS.map((job) => job.name).sort()).toEqual([
      'grade.auto',
      'retention.sweep',
      'sim.build',
    ]);
    for (const job of PENDING_JOBS) {
      expect(job.pending, `${job.name} has no ticket`).toMatch(/^P\d+-T\d+$/);
      expect(functions.map((fn) => fn.opts.id)).not.toContain(job.name);
    }
  });
});

describe('a job must never overlap itself', () => {
  it('SKIPS a tick that arrives while the previous run is still going', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    const slow = fakeJob({
      name: 'slow.job',
      run: async () => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 40);
        });
        active -= 1;
      },
    });
    const runner = createJobRunner({ jobs: [slow], clock: testClock(), log: recordingLogger() });

    // Three ticks, closer together than one run takes. The first holds the lock; the other two must not enter.
    const results = await Promise.all([runner.run(slow), runner.run(slow), runner.run(slow)]);

    expect(peak, 'two runs of one job were in flight at once').toBe(1);
    expect(started, 'the skipped ticks still ran the job body').toBe(1);
    expect(results.map((result) => result.outcome)).toEqual(['completed', 'skipped', 'skipped']);
    expect(runner.inFlight).toEqual([]);
  });

  it('names the job it skipped and how long the previous run has held it', async () => {
    const log = recordingLogger();
    const gate = deferred();
    const slow = fakeJob({ name: 'slow.job', run: () => gate.promise });
    const runner = createJobRunner({ jobs: [slow], clock: testClock(), log });

    void runner.run(slow);
    const skipped = await runner.run(slow);
    gate.resolve();
    await runner.awaitDrain(1000);

    expect(skipped.outcome).toBe('skipped');
    const record = log.sink().find((entry) => entry.msg.startsWith('tick skipped'));
    expect(record?.job).toBe('slow.job');
    expect(record?.level).toBe('warn');
  });

  it('lets the NEXT tick run once the previous one has finished', async () => {
    let runs = 0;
    const quick = fakeJob({
      name: 'quick.job',
      run: async () => {
        runs += 1;
        await Promise.resolve();
      },
    });
    const runner = createJobRunner({ jobs: [quick], clock: testClock(), log: recordingLogger() });

    await runner.run(quick);
    await runner.run(quick);

    // A guard that never released would make the job run exactly once, forever, which is a quieter bug than an overlap.
    expect(runs).toBe(2);
  });

  it('measures duration with the INJECTED clock, so a job timing is a number a test chooses', async () => {
    const clock = testClock();
    const job = fakeJob({
      name: 'timed.job',
      run: async () => {
        clock.advance(250);
      },
    });
    const runner = createJobRunner({ jobs: [job], clock, log: recordingLogger() });

    const result = await runner.run(job);

    // `Date.now()` here would report a duration near zero and the assertion below would be meaningless.
    expect(result.durationMs).toBe(250);
  });
});

describe('one failure must not stop the others, and must be attributable', () => {
  let log: ReturnType<typeof recordingLogger>;
  let ran: string[];

  beforeEach(() => {
    log = recordingLogger();
    ran = [];
  });

  const boom = fakeJob({
    name: 'boom.job',
    run: async () => {
      ran.push('boom.job');
      throw new Error('release could not be verified');
    },
  });
  const quiet = fakeJob({
    name: 'quiet.job',
    run: async () => {
      ran.push('quiet.job');
    },
  });

  it('runs every job in the tick even though one of them throws', async () => {
    const runner = createJobRunner({ jobs: [boom, quiet], clock: testClock(), log });

    const results = await runner.runAll();

    expect(ran.sort()).toEqual(['boom.job', 'quiet.job']);
    expect(results.map((result) => result.outcome).sort()).toEqual(['completed', 'failed']);
  });

  it('never rejects, because a rejected runAll would stop the tick that had not started yet', async () => {
    const runner = createJobRunner({ jobs: [boom, quiet], clock: testClock(), log });
    await expect(runner.runAll()).resolves.toHaveLength(2);
  });

  it('logs the failure WITH THE JOB NAME as a field, so an outage can be attributed', async () => {
    const runner = createJobRunner({ jobs: [boom], clock: testClock(), log });

    await runner.run(boom);

    const record = log.sink().find((entry) => entry.level === 'error');
    expect(record).toBeDefined();
    expect(record?.job).toBe('boom.job');
    expect(record?.channel).toBe('job');
    expect((record?.error as { message?: string } | undefined)?.message).toContain(
      'release could not be verified',
    );
    // The name is a FIELD and not part of the sentence: a message with the job interpolated into it is one
    // rename away from being unsearchable, and `TM-19` is the finding that made `msg` a scrubbed position.
    expect(record?.msg).not.toContain('boom.job');
  });

  it('RE-THROWS to the queue so the durable retry happens, while the runner keeps swallowing', async () => {
    // Two consumers of one outcome: the runner must not let a sibling job die, and the handler must not
    // turn a retrying queue into a fire-and-forget one.
    const runner = createJobRunner({ jobs: [boom], clock: testClock(), log });

    await expect(jobHandler(boom, runner)()).rejects.toThrow('release could not be verified');
    await expect(runner.run(boom)).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('does not re-throw a skip, because nothing was attempted and there is nothing to retry', async () => {
    const gate = deferred();
    const slow = fakeJob({ name: 'slow.job', run: () => gate.promise });
    const runner = createJobRunner({ jobs: [slow], clock: testClock(), log });

    const inProgress = jobHandler(slow, runner)();
    const skipped = await jobHandler(slow, runner)();

    expect(skipped.outcome).toBe('skipped');
    gate.resolve();
    await expect(inProgress).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('wraps a thrown non-Error, because re-throwing a string would leave the queue with no message', async () => {
    const rude = fakeJob({
      name: 'rude.job',
      run: () => Promise.reject('a bare string'),
    });
    const runner = createJobRunner({ jobs: [rude], clock: testClock(), log });

    await expect(jobHandler(rude, runner)()).rejects.toThrow('a bare string');
  });
});

describe('shutdown stops accepting work, then waits, then abandons loudly', () => {
  it('refuses a new tick while draining instead of running it', async () => {
    let ran = false;
    const job = fakeJob({
      name: 'after.drain',
      run: async () => {
        ran = true;
      },
    });
    const log = recordingLogger();
    const runner = createJobRunner({ jobs: [job], clock: testClock(), log });

    runner.beginDrain('SIGTERM');
    const result = await runner.run(job);

    expect(result.outcome).toBe('refused');
    expect(ran, 'a draining worker started new work').toBe(false);
    expect(runner.draining).toBe(true);
    expect(log.sink().some((entry) => entry.msg.startsWith('tick refused'))).toBe(true);
  });

  it('WAITS for an in-flight job to finish, rather than reporting an empty drain', async () => {
    const order: string[] = [];
    const gate = deferred();
    const job = fakeJob({
      name: 'finishing.job',
      run: async () => {
        order.push('started');
        await gate.promise;
        order.push('finished');
      },
    });
    const runner = createJobRunner({ jobs: [job], clock: testClock(), log: recordingLogger() });

    void runner.run(job);
    runner.beginDrain('SIGTERM');
    setTimeout(() => gate.resolve(), 10);
    const report = await runner.awaitDrain(5_000);
    order.push('drained');

    // The ordering IS the assertion: a drain that returned before the job did would push 'drained' first.
    expect(order).toEqual(['started', 'finished', 'drained']);
    expect(report).toEqual({ finished: ['finishing.job'], abandoned: [] });
  });

  it('ABANDONS a job that outlives the grace, names it, and reports a non-zero exit', async () => {
    const log = recordingLogger();
    const stuck = fakeJob({ name: 'stuck.job', run: () => new Promise<void>(() => undefined) });
    const runner = createJobRunner({ jobs: [stuck], clock: testClock(), log });

    void runner.run(stuck);
    runner.beginDrain('SIGTERM');
    const report = await runner.awaitDrain(20);

    expect(report.abandoned).toEqual(['stuck.job']);
    expect(report.finished).toEqual([]);
    const fatal = log.sink().find((entry) => entry.level === 'fatal');
    expect(fatal?.jobs).toEqual(['stuck.job']);
    expect(fatal?.msg).toMatch(/abandoning/);
  });

  it('closes the listener, so nothing new arrives while the drain runs', async () => {
    const log = recordingLogger();
    const runner = createJobRunner({ jobs: [], clock: testClock(), log });
    const server = createWorkerServer({
      client: offlineClient(),
      functions: [],
      runner,
    });
    await listen(server);

    const outcome = await shutdownWorker({ runner, server, graceMs: 50, log }, 'SIGTERM');

    expect(server.listening).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.signal).toBe('SIGTERM');
  });

  it('answers 503 to an invocation that arrives while draining', async () => {
    const log = recordingLogger();
    const runner = createJobRunner({ jobs: [], clock: testClock(), log });
    const server = createWorkerServer({ client: offlineClient(), functions: [], runner });
    const port = await listen(server);
    const url = `http://127.0.0.1:${String(port)}/api/inngest`;

    try {
      // Before the drain the request reaches Inngest's own handler, whatever it decides about our request's
      // signature — what matters is that the 503 below comes from the drain guard and not from Inngest.
      const before = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      expect(before.status).not.toBe(DRAINING_STATUS);

      runner.beginDrain('SIGTERM');
      const after = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      expect(after.status).toBe(DRAINING_STATUS);
      expect(await after.json()).toMatchObject({ error: 'draining' });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('registers BOTH signals, once each, so a second SIGTERM cannot start a second drain', () => {
    const registered = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>();
    const registrar: SignalRegistrar = {
      once: (event, listener) => registered.set(event, listener),
    };
    const seen: NodeJS.Signals[] = [];

    installSignalHandlers(registrar, (signal) => seen.push(signal));
    for (const signal of SHUTDOWN_SIGNALS) registered.get(signal)?.(signal);

    expect([...registered.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    expect(seen).toEqual(['SIGTERM', 'SIGINT']);
  });
});

describe('startWorker wires the endpoint, and shuts down on a signal', () => {
  it('serves, logs the schedule, and reports pending handlers exactly once at boot', async () => {
    const log = recordingLogger();
    const exits: number[] = [];
    const registered = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>();
    const handle = await startWorker({
      jobs: JOBS,
      port: 0,
      shutdownGraceMs: 100,
      clock: testClock(),
      log,
      host: '127.0.0.1',
      registrar: { once: (event, listener) => registered.set(event, listener) },
      exit: (code) => exits.push(code),
    });

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.functions.map((fn) => fn.opts.id)).not.toContain(SWEEP_JOB_NAME);

      const scheduled = log.sink().filter((entry) => entry.msg === 'job scheduled');
      expect(scheduled.map((entry) => entry.job).sort()).toEqual(
        SCHEDULED_JOBS.map((job) => job.name).sort(),
      );
      for (const entry of scheduled) {
        expect(entry.cron).toBe(
          cronFor(JOBS.find((job) => job.name === entry.job)?.everySeconds ?? 0),
        );
      }

      const pendingWarnings = log
        .sink()
        .filter(
          (entry) => entry.msg === 'job is declared but not scheduled: its handler has not landed',
        );
      // Once per boot, not once per tick: the alert channel has to stay clean or people stop reading it.
      expect(pendingWarnings).toHaveLength(PENDING_JOBS.length);
      expect(pendingWarnings.map((entry) => entry.ticket).sort()).toEqual(
        PENDING_JOBS.map((job) => job.pending).sort(),
      );

      expect(
        log
          .sink()
          .some((entry) => entry.msg === 'job is not scheduled here: its tick comes from pg_cron'),
      ).toBe(true);
    } finally {
      await handle.shutdown('test');
    }
  });

  it('a SIGTERM drains the running worker and exits with the drain outcome', async () => {
    const log = recordingLogger();
    const exits: number[] = [];
    const registered = new Map<NodeJS.Signals, (signal: NodeJS.Signals) => void>();
    const done = deferred();
    const handle = await startWorker({
      jobs: JOBS,
      port: 0,
      shutdownGraceMs: 100,
      clock: testClock(),
      log,
      host: '127.0.0.1',
      registrar: { once: (event, listener) => registered.set(event, listener) },
      exit: (code) => {
        exits.push(code);
        done.resolve();
      },
    });

    try {
      expect(handle.server.listening).toBe(true);
      registered.get('SIGTERM')?.('SIGTERM');
      await done.promise;

      expect(exits).toEqual([0]);
      expect(handle.server.listening).toBe(false);
      expect(handle.runner.draining).toBe(true);
    } finally {
      await handle.shutdown('test');
    }
  });

  it('is idempotent: a second signal joins the drain already running', async () => {
    const handle = await startWorker({
      jobs: [],
      port: 0,
      shutdownGraceMs: 100,
      clock: testClock(),
      log: recordingLogger(),
      host: '127.0.0.1',
      registrar: { once: () => undefined },
      exit: () => undefined,
    });

    const first = handle.shutdown('first');
    const second = handle.shutdown('second');
    expect(await second).toBe(await first);
    expect(second).toBe(first);
  });

  /**
   * THE DEFAULT EXIT IS `process.exit`, AND THIS TEST IS WHY IT IS NOT AN OPTIONAL CALL.
   *
   * The first version wrote `options.exit?.(outcome.exitCode)`: with no `exit` passed — which is how the worker runs in
   * production — that line did nothing at all. The end-to-end run found it: the worker drained, abandoned a job at the
   * grace deadline, logged `fatal`, and then sat there until something killed it, because `process.exit` was never called
   * and Node cannot reach an idle state while the Prisma pool is an open handle.
   */
  it('exits the PROCESS by default after a clean drain', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const handle = await startWorker({
        jobs: [],
        port: 0,
        shutdownGraceMs: 50,
        clock: testClock(),
        log: recordingLogger(),
        host: '127.0.0.1',
        registrar: { once: () => undefined },
      });

      await handle.shutdown('SIGTERM');

      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('exits NON-ZERO by default when a job was abandoned', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const stuck = fakeJob({ name: 'stuck.job', run: () => new Promise<void>(() => undefined) });
      const handle = await startWorker({
        jobs: [stuck],
        port: 0,
        shutdownGraceMs: 20,
        clock: testClock(),
        log: recordingLogger(),
        host: '127.0.0.1',
        registrar: { once: () => undefined },
      });
      void handle.runner.run(stuck);

      await handle.shutdown('SIGTERM');

      // A container that abandoned a release and exited zero is a lie the platform cannot question.
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});

/**
 * INV-TIME-1, ASSERTED AGAINST THE SOURCE rather than trusted to a lint rule.
 *
 * The tick path decides when work happens, so a second clock there is a deadline model that behaves
 * differently depending on who asks. ESLint already bans `Date.now()` and a bare `new Date()`
 * repository-wide (`packages/config/src/lint-rules.verify.test.ts` proves those rules fire); this is the
 * second, independent check, and it is the one that would still hold if the tick path were exempted from
 * the rule block by accident.
 */
describe('the tick path reads time only through the injected clock', () => {
  /** The files that decide when a job runs. */
  const TICK_PATH = ['scheduler.ts', 'jobs.ts', 'index.ts'];

  /**
   * STRIP COMMENTS BEFORE MATCHING, OR THIS TEST MEASURES PROSE.
   *
   * These files explain the rule in their headers, and a rule that fires on its own explanation is a rule somebody
   * deletes to make the build green. This is a stripper and not a parser: `//` inside a string literal would truncate
   * the rest of that line, which is a limitation of the check rather than a claim that there is none.
   */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const forbidden = [
    {
      pattern: /new\s+Date\s*\(\s*\)/,
      what: 'the bare Date constructor, which reads the host clock',
    },
    { pattern: /Date\s*\.\s*now\s*\(/, what: 'Date.now()' },
    { pattern: /performance\s*\.\s*now\s*\(/, what: 'a second monotonic clock' },
    { pattern: /\bsetInterval\b/, what: 'a hand-rolled scheduler loop' },
  ];

  for (const file of TICK_PATH) {
    it(`${file} contains no host clock and no interval loop`, () => {
      const source = code(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));
      for (const { pattern, what } of forbidden) {
        expect(source, `${file} uses ${what}`).not.toMatch(pattern);
      }
    });
  }

  it('the matcher itself can fail, so a green run means something', () => {
    // A negative-only assertion is satisfied by a regex that matches nothing. These four samples are the proof it does not.
    const planted = [
      'const at = new Date();',
      'const ms = Date.now();',
      'const t = performance.now();',
      'setInterval(tick, 1000);',
    ];
    for (const sample of planted) {
      expect(
        planted.filter((candidate) => forbidden.some((rule) => rule.pattern.test(candidate))),
      ).toContain(sample);
    }
  });

  it('reads elapsed time from the clock it was given', () => {
    // The behavioural half: a job that advances the injected clock by 250 ms reports 250 ms, whatever the host
    // clock said. Asserted above as `durationMs`; this names the property so the reason is not lost.
    const clock = testClock();
    expect(clock.monotonic()).toBe(0);
    clock.advance(250);
    expect(clock.monotonic()).toBe(250);
    expect(clock.now(), 'the stub answers the injected instant it was given').toBe(
      1_700_000_000_000,
    );
  });
});

/** A job list with nothing in it still has to produce a worker. */
describe('degenerate inputs', () => {
  it('an empty registry produces no functions and no crash', async () => {
    const runner: JobRunner = createJobRunner({
      jobs: [],
      clock: testClock(),
      log: recordingLogger(),
    });
    expect(createFunctions(offlineClient(), [], runner)).toEqual([]);
    expect(await runner.runAll()).toEqual([]);
  });
});
