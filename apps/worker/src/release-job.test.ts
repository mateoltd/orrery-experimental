import { describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
  db: {},
  release: vi.fn().mockResolvedValue([]),
  digest: vi.fn().mockResolvedValue({ queued: 0, failed: 0 }),
}));
vi.mock('@orrery/db', () => ({ getPrisma: () => stub.db }));
vi.mock('@orrery/config/env', () => ({
  loadEnv: () => ({ APP_URL: 'https://configured.example' }),
}));
vi.mock('@orrery/db/release-worker', () => ({ runReleaseTick: stub.release }));
vi.mock('@orrery/db/student-digest', () => ({
  runStudentDigestTick: stub.digest,
}));

import { JOBS, PENDING_JOBS, SCHEDULED_JOBS } from './index.js';

describe('registered release and digest handlers', () => {
  it('release body invokes the real service boundary with configured origin and injected clock', async () => {
    await JOBS.find((j) => j.name === 'release.batch')?.run();
    expect(stub.release).toHaveBeenCalledWith(
      stub.db,
      expect.objectContaining({ now: expect.any(Function) }),
      'https://configured.example',
    );
  });
  it('digest body invokes the digest service independently of release', async () => {
    await JOBS.find((j) => j.name === 'student.digest')?.run();
    expect(stub.digest).toHaveBeenCalledWith(
      stub.db,
      expect.objectContaining({ now: expect.any(Function) }),
      'https://configured.example',
    );
  });

  /**
   * THE `pending` MARKERS ARE ONLY HONEST IF EVERY SCHEDULED JOB ACTUALLY RUNS.
   *
   * The three unimplemented handlers are kept out of the queue with a `pending` ticket, and their bodies still throw. So
   * clearing a ticket without writing a handler — the obvious way to "turn the job on" — puts a throwing body on a cron,
   * and this is the test that says so at the moment it happens rather than in an alert channel an hour later.
   */
  it('every scheduled job completes its first invocation', async () => {
    for (const job of SCHEDULED_JOBS) {
      await expect(
        job.run(),
        `${job.name} is scheduled but its handler throws`,
      ).resolves.toBeUndefined();
    }
  });

  it('schedules exactly the handlers that exist, and holds the rest with a ticket each', async () => {
    expect(SCHEDULED_JOBS.map((job) => job.name).sort()).toEqual([
      'release.batch',
      'student.digest',
    ]);
    expect(PENDING_JOBS.map((job) => job.name).sort()).toEqual([
      'grade.auto',
      'retention.sweep',
      'sim.build',
    ]);
  });
});
