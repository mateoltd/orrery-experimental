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
 *
 * ## AND IT VARIES POSITION, NOT ONLY NAME (`TM-19`)
 *
 * The first version of this file varied the **field name** and its own title said so — *"never emits a
 * canary, whatever the field is called"*. That is a real property and it left the larger one untested:
 * `msg` is not a field, so a canary interpolated into the message was invisible to every assertion here.
 * `log.info(\`failed for ${email}\`)` compiles, runs, and was logged in full.
 *
 * So `POSITIONS` below plants every credential-shaped canary in each position a value can occupy on a
 * record: a sensitive-named field, a benign-named field, a nested field, the **message**, an `Error`'s
 * **message**, and a field **named `msg`**. A test that varies one axis cannot catch a leak on another,
 * which is the whole finding.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it } from 'vitest';
import { createLogger, examLogger, redact, scrubMessage } from './logging.js';

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

/**
 * `TM-19`: A CANARY IN EVERY POSITION, NOT ONLY IN EVERY FIELD.
 *
 * The six positions below are the six ways a value reaches a `LogRecord`. Four are fields, and fields are what the
 * first version of this file tested — twice, under two names, which is one axis. The other two are the ones that
 * leaked:
 *
 *  1. a sensitive-named field   · 2. a benign-named field   · 3. a nested field
 *  4. **the message**            · 5. **an `Error`'s message**   · 6. **a field literally named `msg`**
 *
 * Only credential-SHAPED canaries are planted in positions 4–6, and that is the finding's own limit rather than a
 * convenience: `scrubMessage` recognises an address, a bearer credential, a JWT and a long high-entropy run, and it
 * cannot recognise an answer key, because an answer key has no shape. Positions 1–3 carry the full set, since
 * `SENSITIVE_KEY` decides on the key and the key is what a content canary is judged by.
 */
const CREDENTIAL_CANARIES = {
  email: 'CANARY-EMAIL-student@school.invalid',
  bearer: 'bearer CANARY-BEARER-7d2f4a6b8c1e',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.CANARY-JWT-payload.CANARY-JWT-signature',
  highEntropy: 'CANARYHIGHDENSITYRUN0123456789abcdefZ',
} as const;

/** Every way a value can get onto a record. Each returns the serialised line(s). */
const POSITIONS: readonly {
  readonly name: string;
  readonly log: (log: ReturnType<typeof createLogger>, canary: string) => void;
}[] = [
  { name: 'a sensitive-named field', log: (l, c) => l.info('started', { studentEmail: c }) },
  { name: 'a benign-named field', log: (l, c) => l.info('started', { note: c }) },
  { name: 'a nested field', log: (l, c) => l.info('started', { meta: { deep: { note: c } } }) },
  { name: 'the message', log: (l, c) => l.info(`failed for ${c}`) },
  {
    name: "an Error's message",
    log: (l, c) => l.error('boom', { error: new Error(`no row for ${c}`) }),
  },
  {
    name: 'a field named `msg`',
    log: (l, c) => l.info('attempt failed', { msg: `failed for ${c}` }),
  },
];

describe('TM-19: a canary in every POSITION on the record, not only in every field', () => {
  for (const position of POSITIONS) {
    it(`never emits a canary placed in ${position.name}`, () => {
      const written: string[] = [];
      const log = createLogger('exam', {}, { write: (r) => written.push(JSON.stringify(r)) });
      for (const canary of Object.values(CREDENTIAL_CANARIES)) position.log(log, canary);
      const out = written.join('\n');
      for (const canary of Object.values(CREDENTIAL_CANARIES)) {
        expect(out, `canary survived in ${position.name}: ${canary}`).not.toContain(canary);
      }
    });
  }

  it('keeps the message it was given, so the scrubber is not deleting every log', () => {
    // A leak test satisfied by emitting nothing is satisfied by a broken logger. The useful sentence has to survive
    // alongside the redacted one, or "we scrub everything" and "we log nothing" are indistinguishable.
    const written: string[] = [];
    const log = createLogger('exam', {}, { write: (r) => written.push(JSON.stringify(r)) });
    log.info(`failed for ${CREDENTIAL_CANARIES.email}`, { attemptId: 'att_9', durationMs: 120 });
    const out = written.join('\n');
    expect(out).toContain('failed for [redacted]');
    expect(out).toContain('att_9');
    expect(out).toContain('120');
  });

  it('refuses an over-long message rather than truncating half of one', () => {
    // Truncation is right for an array (a partial array is honest) and wrong for a sentence: half a message with a
    // canary in the surviving half reads like a complete record.
    const written: string[] = [];
    const log = createLogger('exam', {}, { write: (r) => written.push(JSON.stringify(r)) });
    log.info(`failed for ${CREDENTIAL_CANARIES.email} ${'x'.repeat(2_100)}`);
    const out = written.join('\n');
    expect(out).toContain('message refused');
    expect(out).not.toContain('x'.repeat(100));
  });

  it("scrubs an Error's STACK, whose first line is the message it had just redacted", () => {
    // Pinned separately because it is a distinct property from "the message is scrubbed", and because the received value
    // when it was missing is the clearest possible statement of the defect: `[redacted]` on the line above the canary.
    const out = JSON.stringify(
      redact({ error: new Error(`no row for ${CREDENTIAL_CANARIES.email}`) }),
    );
    expect(out).not.toContain(CREDENTIAL_CANARIES.email);
    // And the stack is still a stack: refusing it would delete the only diagnostic an incident has.
    expect(out).toContain('logging-hygiene.test');
  });

  it('names the limit: a content canary in a field is caught by its KEY, and nothing catches one in a sentence', () => {
    // This is the honest boundary of `scrubMessage`, asserted rather than left in a comment. `answerKey` is on
    // `SENSITIVE_KEY`, so the field form is redacted; a bare answer key in prose is indistinguishable from any other
    // sentence, and a guard claiming otherwise would be claiming something false.
    const out = JSON.stringify(redact({ answerKey: CANARIES.answerKey }));
    expect(out).not.toContain(CANARIES.answerKey);
    expect(scrubMessage(`the answer is ${CANARIES.answerKey}`)).toContain(CANARIES.answerKey);
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
