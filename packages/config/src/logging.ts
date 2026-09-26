/**
 * Structured logging, with scrubbing that is enforced rather than remembered.
 *
 * ## The problem
 *
 * `plans/18` §4 says logs carry no answer content, no PII and no credentials. That is a
 * *requirement*, and a requirement nobody checks is a wish — the same defect class as the
 * pre-ticked sandbox checklist (`D-31`) and the vacuous bundle gate.
 *
 * So: `redact()` is the ONLY way to build a log object in application code, and
 * `logging-hygiene.test.ts` seeds canary values and asserts they never reach the log
 * output. If a future field needs to be logged, it goes through `redact()` and is
 * categorised — there is no path that logs an arbitrary object.
 */

import { type Clock, isoNow, systemClock } from '@orrery/clock';

/** What a log line is about. Also the index for dashboards and alerts. */
export type Channel =
  | 'http' // request lifecycle
  | 'exam' // anything on the exam path
  | 'grading' // auto-grade, manual grade, release
  | 'sim' // simulation load and grading
  | 'auth' // sign-in, session, MFA, impersonation
  | 'job' // worker and cron
  | 'db' // query and migration
  | 'audit'; // consequential actions — retained, never sampled

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Field names whose VALUES are dropped. Matched case-insensitively against the key, so
 * `studentEmail`, `STUDENT_EMAIL` and `email` are all caught.
 *
 * `INV-TELEMETRY-2` and 14 §4.1. Note what is NOT here: there is no key for "answer",
 * because no log line is permitted to contain one in the first place — the answer-key leak
 * audit (`pnpm audit:seals`) is the control for that, and a redaction list is not a
 * substitute for not logging it.
 */
const SENSITIVE_KEY =
  /(pass(word)?|secret|token|auth|cookie|session|key|signature|dsn|email|phone|address|ip|user_?agent|question|answer|rubric|feedback|body|spec)/i;

/** Values that are safe to log but noisy; collapsed to a shape summary. */
const REDACTED = '[redacted]';

export interface LogFields {
  [key: string]: unknown;
}

export interface LogRecord {
  ts: string;
  level: Severity;
  channel: Channel;
  msg: string;
  [key: string]: unknown;
}

/**
 * Build a log-safe field object. This is the only sanctioned way to assemble log fields.
 *
 * - Sensitive keys are replaced, never truncated, so a partial secret cannot leak.
 * - `Error` objects become `{ name, message, stack, digest }` because a serialised Error
 *   is `{}` in most runtimes — a bug that has silently turned every error log into
 *   `{"error":{}}` in a hundred projects.
 * - Nesting is bounded to depth 3, because an unbounded recursive walk is a stack
 *   overflow triggered by a log call, which is a genuinely bad afternoon.
 */
export function redact(fields: LogFields, depth = 0): LogFields {
  const out: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (value instanceof Error) {
      out[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(typeof (value as Error & { digest?: string }).digest === 'string'
          ? { digest: (value as Error & { digest?: string }).digest }
          : {}),
      };
      continue;
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    if (depth >= 3) {
      out[key] = Array.isArray(value) ? `[array ${value.length}]` : '[object]';
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((v) => redact({ v } as LogFields, depth + 1).v);
      continue;
    }
    out[key] = redact(value as LogFields, depth + 1);
  }

  return out;
}

export interface Logger {
  child(bindings: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** A human-readable, secret-free dump. Used by the tests and by `envShape`. */
  sink(): LogRecord[];
}

const LEVEL_ORDER: Record<Severity, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface LoggerOptions {
  minLevel?: Severity;
  clock?: Clock;
  /** Replace the sink. Production writes JSON to stdout; tests inspect the array. */
  write?: (record: LogRecord) => void;
  /** Cap on retained records for the in-memory sink. 0 disables retention. */
  retain?: number;
}

/**
 * A logger that buffers into `sink` so tests can assert on it, and can be pointed at a
 * real writer in production.
 *
 * Sampling note (`18` §9): head-based sampling is fine, with `attemptId` **always**
 * retained — an exam trace is never the one you wish you had dropped.
 */
export function createLogger(
  channel: Channel,
  bindings: LogFields = {},
  options: LoggerOptions = {},
): Logger {
  const {
    minLevel = (process.env.LOG_LEVEL as Severity) ?? 'info',
    clock = systemClock,
    write = (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    retain = 1000,
  } = options;

  const records: LogRecord[] = [];
  const base = redact(bindings);

  const emit = (level: Severity, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record: LogRecord = {
      ts: isoNow(clock),
      level,
      channel,
      msg,
      ...base,
      ...(fields ? redact(fields) : {}),
    };
    if (retain > 0) {
      records.push(record);
      if (records.length > retain) records.shift();
    }
    write(record);
  };

  return {
    child: (more) => createLogger(channel, { ...bindings, ...more }, options),
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    fatal: (m, f) => emit('fatal', m, f),
    sink: () => records.slice(),
  };
}

/**
 * The `attemptId` spine (`18` §4.2).
 *
 * One grep reconstructs a student's entire exam: start, every save, every evidence event,
 * every release. This is the single most valuable debugging affordance we will build, and
 * it is why the client sends `attemptId` on every request — including the ones that fail.
 *
 * `examLogger` exists so that no call site can forget it. If you are logging on the exam
 * path, you are using this, not `createLogger('exam', …)` directly.
 */
export function examLogger(attemptId: string, options: LoggerOptions = {}): Logger {
  return createLogger('exam', { attemptId }, options);
}

/** `requestId` for the non-exam surface, same reasoning. */
export function httpLogger(requestId: string, options: LoggerOptions = {}): Logger {
  return createLogger('http', { requestId }, options);
}
