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
vi.mock('../../../packages/db/dist/release-worker.js', () => ({ runReleaseTick: stub.release }));
vi.mock('../../../packages/db/dist/student-digest.js', () => ({
  runStudentDigestTick: stub.digest,
}));

import { JOBS } from './index.js';

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
});
