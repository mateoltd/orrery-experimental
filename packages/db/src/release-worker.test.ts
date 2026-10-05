import { assertNoScoreLeak } from '@orrery/interop';
import { describe, expect, it } from 'vitest';
import { releaseNotice } from './release-delivery.js';
import { releaseWork } from './release-worker.js';
import { buildStudentDigest, digestPeriod } from './student-digest.js';

describe('release work discovery', () => {
  it.each(['DRAFT', 'READY', 'CANCELED'])('%s is never started by a worker', (status) => {
    expect(releaseWork(status, false)).toBe('NONE');
  });
  it('retries interrupted release and interrupted notifications separately', () => {
    expect(releaseWork('RELEASING', false)).toBe('RELEASE');
    expect(releaseWork('RELEASED', false)).toBe('NOTIFY');
    expect(releaseWork('RELEASED', true)).toBe('NONE');
  });
});

describe('score-free notices and instruments-only digest', () => {
  it('does not include mark changes, comparisons or reasons in release notices', () => {
    expect(() => assertNoScoreLeak(releaseNotice('attempt'))).not.toThrow();
    expect(releaseNotice('attempt').body).not.toMatch(/changed|rank|classmate|lower|higher/);
  });
  it('grading progress cannot alter digest bytes and frozen is reversible', () => {
    const item = { attemptId: 'a', title: 'Mechanics', released: false };
    expect(buildStudentDigest([{ ...item, status: 'GRADED' }])).toEqual(
      buildStudentDigest([{ ...item, status: 'PENDING_REVIEW' }]),
    );
    const frozen = buildStudentDigest([{ ...item, status: 'FROZEN' }]);
    expect(frozen.items[0]?.notice).toContain('can reinstate');
    expect(() => assertNoScoreLeak(frozen)).not.toThrow();
  });
  it('only the instrument being released changes its notice', () => {
    const digest = buildStudentDigest([
      { attemptId: 'released', title: 'Released', status: 'GRADED', released: true },
      { attemptId: 'sibling', title: 'Sealed', status: 'GRADED', released: false },
    ]);
    expect(digest.items[0]?.notice).toBe('Results are available.');
    expect(digest.items[1]?.notice).toContain('with your teacher');
  });
});

it('digest periods honour the preference and remain stable across worker restarts', () => {
  expect(digestPeriod(3_599_999, 60)).toBe('60:0');
  expect(digestPeriod(3_600_000, 60)).toBe('60:1');
  expect(digestPeriod(3_600_000, 30)).toBe('30:2');
  expect(() => digestPeriod(3_600_000, 0)).toThrow('INVALID_DIGEST_INTERVAL');
});
