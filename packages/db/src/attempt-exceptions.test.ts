import { describe, expect, it } from 'vitest';
import {
  type AttemptException,
  decideAttemptException,
  EXCEPTION_VERB,
  gradebookIncluded,
} from './attempt-exceptions.js';

const base = {
  status: 'NOT_STARTED',
  reason: 'Teacher recorded a reason',
  windowClosesAt: 1000,
  deadlineAt: 1000,
  now: 1001,
  releaseStarted: false,
};
const statuses = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'FROZEN',
  'SUBMITTED',
  'EXPIRED',
  'PENDING_REVIEW',
  'GRADED',
  'RELEASED',
  'EXCUSED',
  'MISSING',
  'VOIDED',
];

describe('exception state decisions', () => {
  it.each(statuses)('EXCUSED only from NOT_STARTED: %s', (status) => {
    expect(decideAttemptException({ ...base, status, action: { kind: 'EXCUSE' } }).ok).toBe(
      status === 'NOT_STARTED',
    );
  });
  it.each(statuses)('MISSING only from NOT_STARTED: %s', (status) => {
    expect(decideAttemptException({ ...base, status, action: { kind: 'MARK_MISSING' } }).ok).toBe(
      status === 'NOT_STARTED',
    );
  });
  it.each(statuses)('extensions require a live attempt: %s', (status) => {
    expect(
      decideAttemptException({ ...base, status, action: { kind: 'EXTEND_DEADLINE', addedSec: 60 } })
        .ok,
    ).toBe(status === 'IN_PROGRESS');
  });
  it.each(statuses)('lateness is a submitted fact: %s', (status) => {
    expect(
      decideAttemptException({ ...base, status, action: { kind: 'MARK_LATE', isLate: true } }).ok,
    ).toBe(['SUBMITTED', 'EXPIRED', 'PENDING_REVIEW', 'GRADED'].includes(status));
  });
  it.each([-1, 0, 0.5, Infinity, NaN, 2147483648])('rejects unusable extension %j', (addedSec) => {
    expect(
      decideAttemptException({
        ...base,
        status: 'IN_PROGRESS',
        action: { kind: 'EXTEND_DEADLINE', addedSec },
      }),
    ).toEqual({ ok: false, reason: 'INVALID_EXTENSION' });
  });
  it.each([null, 1000, 1002])('missing cannot be marked before closure %j', (windowClosesAt) => {
    expect(
      decideAttemptException({
        ...base,
        now: 1000,
        windowClosesAt,
        action: { kind: 'MARK_MISSING' },
      }),
    ).toEqual({ ok: false, reason: 'WINDOW_OPEN' });
  });
  it.each([
    { kind: 'EXCUSE' },
    { kind: 'MARK_MISSING' },
    { kind: 'EXTEND_DEADLINE', addedSec: 10 },
    { kind: 'MARK_LATE', isLate: true },
  ] as AttemptException[])(
    'every action requires a reason and refuses after release starts: %j',
    (action) => {
      expect(decideAttemptException({ ...base, reason: ' ', action })).toEqual({
        ok: false,
        reason: 'NO_REASON',
      });
      expect(decideAttemptException({ ...base, releaseStarted: true, action })).toEqual({
        ok: false,
        reason: 'RELEASE_STARTED',
      });
    },
  );
  it('no base deadline cannot produce an effective deadline', () => {
    expect(
      decideAttemptException({
        ...base,
        status: 'IN_PROGRESS',
        deadlineAt: null,
        action: { kind: 'EXTEND_DEADLINE', addedSec: 60 },
      }),
    ).toEqual({ ok: false, reason: 'NO_DEADLINE' });
  });
  it('gradebook exclusion separates missing policy from excusal', () => {
    expect(gradebookIncluded('EXCUSED', false)).toBe(false);
    expect(gradebookIncluded('VOIDED', false)).toBe(false);
    expect(gradebookIncluded('MISSING', true)).toBe(false);
    expect(gradebookIncluded('MISSING', false)).toBe(true);
    expect(gradebookIncluded('GRADED', true)).toBe(true);
  });
  it('excusal and absence ask the kernel for `excuse`, never the broader `update`', () => {
    // Folding these into `update` would let any rule that grants editing also grant excusal.
    expect(EXCEPTION_VERB.EXCUSE).toBe('excuse');
    expect(EXCEPTION_VERB.MARK_MISSING).toBe('excuse');
    expect(EXCEPTION_VERB.EXTEND_DEADLINE).toBe('update');
    expect(EXCEPTION_VERB.MARK_LATE).toBe('grade');
  });
});
