/**
 * GATE VERIFICATION: logs cannot leak.
 *
 * This is the test that makes `14` §4.1 a checkable requirement rather than a sentence.
 * It seeds canary values that look exactly like the things we must never log — an answer
 * key, a student's email, a bearer token, a password — and asserts none of them appear in
 * the serialised output.
 *
 * A canary test is the right shape for this: the failure mode is a field name nobody
 * thought about, added in a hurry under an exam deadline. No amount of reading the redaction
 * regex catches that. Seeding a value and looking for it afterwards does.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import { createLogger, examLogger, redact } from './logging.js';

const CANARIES = {
  answerKey: 'CANARY-ANSWER-KEY-7f3a9c',
  modelAnswer: 'CANARY-MODEL-ANSWER-2b8e1d',
  studentEmail: 'CANARY-EMAIL-student@school.invalid',
  guardianEmail: 'CANARY-EMAIL-guardian@school.invalid',
  password: 'CANARY-PASSWORD-hunter2',
  authSecret: 'CANARY-SECRET-0a1b2c3d4e5f',
  sessionToken: 'CANARY-TOKEN-xyz789',
  cookie: 'CANARY-COOKIE-session=abc123',
  answerKeyField: 'CANARY-IN-ANSWER-FIELD-4d7e0a',
};

const capture = (fn: (log: ReturnType<typeof createLogger>) => void) => {
  const written: string[] = [];
  const log = createLogger('exam', {}, { write: (r) => written.push(JSON.stringify(r)) });
  fn(log);
  return written.join('\n');
};

describe('redact', () => {
  it('removes every canary by key', () => {
    const out = JSON.stringify(
      redact({
        answerKey: CANARIES.answerKey,
        correctAnswer: CANARIES.answerKey,
        studentEmail: CANARIES.studentEmail,
        password: CANARIES.password,
        authSecret: CANARIES.authSecret,
        sessionToken: CANARIES.sessionToken,
        cookie: CANARIES.cookie,
      }),
    );
    for (const [name, value] of Object.entries(CANARIES)) {
      expect(out, `canary "${name}" survived redaction`).not.toContain(value);
    }
  });

  it('matches key patterns case-insensitively and in snake_case', () => {
    const out = JSON.stringify(
      redact({
        STUDENT_EMAIL: CANARIES.studentEmail,
        student_email: CANARIES.studentEmail,
        userPassword: CANARIES.password,
        Authorization: CANARIES.sessionToken,
      }),
    );
    expect(out).not.toContain(CANARIES.studentEmail);
    expect(out).not.toContain(CANARIES.password);
    expect(out).not.toContain(CANARIES.sessionToken);
  });

  it('recurses into nested objects', () => {
    const out = JSON.stringify(
      redact({ meta: { attempt: { feedback: CANARIES.answerKey, score: 4 } } }),
    );
    expect(out).not.toContain(CANARIES.answerKey);
    // Non-sensitive siblings survive, or the log becomes useless.
    expect(out).toContain('"score":4');
  });

  it('bounds recursion depth rather than overflowing the stack', () => {
    // A log call must never be the thing that takes a process down. Nested deep enough
    // that a MISSING bound reliably overflows — an earlier version of this test nested
    // only 50 deep, so raising the bound to 1000 still passed and the check was vacuous.
    let deep: Record<string, unknown> = { answerKey: CANARIES.answerKey };
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    expect(() => redact(deep as LogFields)).not.toThrow();
    expect(JSON.stringify(redact(deep as LogFields))).not.toContain(CANARIES.answerKey);
  });

  it('replaces a too-deep value with a shape summary, not a truncation', () => {
    // Truncating a deep object would silently produce a partial log line, which is worse
    // than saying "there was an object here".
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(JSON.stringify(redact(deep as LogFields))).toContain('[object]');
  });

  it('truncates long arrays rather than logging 50,000 entries', () => {
    const out = JSON.stringify(redact({ ids: Array.from({ length: 5000 }, (_, i) => `id_${i}`) }));
    expect(out.length).toBeLessThan(5000);
  });
});

describe('Error serialisation', () => {
  it('extracts name, message, stack and digest', () => {
    // A serialised Error is `{}` in most runtimes, which turns every error log in the
    // platform into {"error":{}}. That failure is invisible and total.
    const err = Object.assign(new Error('boom'), { digest: 'abc123' });
    const out = JSON.stringify(redact({ err }));
    expect(out).toContain('boom');
    expect(out).toContain('abc123');
    expect(out).not.toContain('{}');
  });
});

describe('the logger end to end', () => {
  it('never emits a canary, whatever the field is called', () => {
    const out = capture((log) => {
      log.info('attempt started', {
        attemptId: 'att_123',
        answerKey: CANARIES.answerKey,
        studentEmail: CANARIES.studentEmail,
        sessionToken: CANARIES.sessionToken,
        durationMs: 120,
      });
      log.error('grade failed', {
        questionId: 'q_1',
        answer: CANARIES.answerKeyField,
        error: new Error('grader threw'),
      });
      log.warn('evidence dropped', { payload: { studentEmail: CANARIES.guardianEmail } });
    });
    for (const value of Object.values(CANARIES)) {
      expect(out, `canary survived: ${value}`).not.toContain(value);
    }
    // And the useful parts are still there, or we have fixed a leak by deleting all logs.
    expect(out).toContain('att_123');
    expect(out).toContain('120');
    expect(out).toContain('grader threw');
  });

  it('carries the attemptId spine on every line', () => {
    const log = examLogger('att_attempt_42', { write: () => {} });
    log.info('a');
    log.info('b');
    for (const r of log.sink()) expect(r.attemptId).toBe('att_attempt_42');
  });

  it('inherits child bindings', () => {
    const log = examLogger('att_1', { write: () => {} }).child({ requestId: 'req_9' });
    log.info('x');
    const [r] = log.sink();
    expect(r?.attemptId).toBe('att_1');
    expect(r?.requestId).toBe('req_9');
  });

  it('respects the minimum level', () => {
    const log = createLogger('http', {}, { minLevel: 'warn', write: () => {} });
    log.debug('noisy');
    log.info('also noisy');
    log.warn('kept');
    expect(log.sink()).toHaveLength(1);
    expect(log.sink()[0]?.level).toBe('warn');
  });

  it('uses the injected clock, so a log timestamp is testable', () => {
    // A static import, not `require`: require() resolves through Node and bypasses the
    // vitest alias, so it would look for an unbuilt dist/ and fail. Found the hard way.
    const log = createLogger('http', {}, { clock: new FrozenClock(0), write: () => {} });
    log.info('x');
    expect(log.sink()[0]?.ts).toBe('1970-01-01T00:00:00.000Z');
  });
});

// `LogFields` is only referenced in a cast above; declaring it here keeps that honest.
type LogFields = Record<string, unknown>;
