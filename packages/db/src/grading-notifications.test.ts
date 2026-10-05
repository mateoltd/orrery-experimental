import { policyFor } from '@orrery/contracts/notifications';
import { describe, expect, it } from 'vitest';
import { decideGradingNotice } from './grading-notifications.js';

const queue = { newestTaskId: 'task-9', newestTaskAt: 500 };

describe('grading-needed notice', () => {
  it('sends nothing when no work is waiting, whatever was sent before', () => {
    for (const latest of [null, { read: true, watermark: 1 }, { read: false, watermark: 1 }])
      expect(decideGradingNotice('a', null, latest)).toBeNull();
  });
  it('sends the first notice for an assignment', () => {
    expect(decideGradingNotice('a', queue, null)).toBe('a:task-9');
  });
  it('never stacks a second notice on an unread one, however much work arrived since', () => {
    expect(decideGradingNotice('a', queue, { read: false, watermark: 1 })).toBeNull();
  });
  it.each([500, 501])(
    'a read notice sent for work at %s is not repeated for the same work',
    (watermark) => {
      expect(decideGradingNotice('a', queue, { read: true, watermark })).toBeNull();
    },
  );
  it('a read notice is followed by a new one when work arrived after it', () => {
    expect(decideGradingNotice('a', queue, { read: true, watermark: 499 })).toBe('a:task-9');
  });
  it('a read notice with no readable watermark does not silence waiting work', () => {
    expect(decideGradingNotice('a', queue, { read: true, watermark: null })).toBe('a:task-9');
  });
  it('is in-app only: `notify` reads this policy, so an email channel here is an email to every teacher', () => {
    expect(policyFor('GRADING_NEEDED').channels).toEqual(['IN_APP']);
  });
});
