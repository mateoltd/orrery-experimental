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
 * `logging-hygiene.test.ts` seeds canary values in **every position a value can occupy** and
 * asserts they never reach the log output. If a future field needs to be logged, it goes
 * through `redact()` and is categorised — there is no path that logs an arbitrary object.
 *
 * ## AND `msg` IS A POSITION, NOT AN EXEMPTION
 *
 * `TM-19`: `msg` used to be copied straight onto the record while `fields` went through
 * `redact()`, so `log.info(\`failed for ${email}\`)` was one interpolation from a breach and the
 * canary test could not see it — every canary it planted was in a **field**, and the test's own
 * title said "whatever the field is called", which is a claim about NAMES. A value that arrives in
 * an unvarying position is invisible to a test that varies a different one.
 *
 * So `msg` is scrubbed by `scrubMessage()` on the way out, and the canary test varies position
 * rather than name. **`scrubMessage` catches values by SHAPE and that limit is stated in the report
 * and asserted by the test's own title** — an email address, a bearer token, a JWT and a long
 * high-entropy run are recognisable; an answer key that happens to be `purple` is not
 * recognisable from the outside, and no amount of regex makes it so. What catches THAT is the rule
 * this module already enforces by construction: a dynamic value belongs in a field, where the key
 * decides whether it survives, not in a sentence.
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
 *
 * ## AND IT IS NOT THE CONTROL FOR THIS MODULE EITHER (`TM-15`)
 *
 * `audit:seals` audits **student payloads** built from `packages/contracts` — question projections,
 * sealed grades, the release view. It never sees a log line, and a script that cannot see the thing
 * it is cited as controlling is not a control for it. **The controls on THIS path are `redact()` for
 * keyed fields, `scrubMessage()` for the message, and `logging-hygiene.test.ts` for both.** The
 * sentence above used to name `audit:seals` as "the control" and was wrong about its own module.
 */
const SENSITIVE_KEY =
  /(pass(word)?|secret|token|auth|cookie|session|key|signature|dsn|email|phone|address|ip|user_?agent|question|answer|rubric|feedback|body|spec)/i;

/**
 * VALUE SHAPES THAT ARE A SECRET WHENEVER THEY APPEAR, INCLUDING INSIDE A SENTENCE.
 *
 * **KEY-REDACTION CANNOT REACH THIS POSITION.** `SENSITIVE_KEY` decides on the key; a message has no
 * key, and `${email}` inside `` `failed for ${email}` `` is already a finished string by the time any
 * scrubber sees it. So this is a shape list, and each entry is a shape that means one thing.
 *
 * Deliberately absent: anything that would also match ordinary prose. `TM-19`'s residual is exactly
 * that gap and it is not closable here — an answer key reading `purple` has no shape, so a value-shaped
 * guard that claimed to catch it would be claiming something false. What this list does catch is the
 * class of value that is a credential *because of what it is*: an address, a bearer credential, a JWT.
 *
 *  · EMAIL        — `student@school.example`, including the `+tag` and dotted local forms.
 *  · BEARER       — an `Authorization` header value, with or without the scheme.
 *  · JWT          — three base64url segments, which is what an attacker pastes and what we issue.
 *  · HIGH_ENTROPY — 32+ unbroken alphanumerics with no separator: a session id, a signature, a key.
 *
 * The last entry is the one that could have caused false positives, so it demands a LENGTH and an alphabet rather than
 * matching any long token: prose words are lowercase with spaces, a hex digest is not.
 *
 * **`/` IS DELIBERATELY NOT IN THE HIGH-ENTROPY CLASS, AND THE CANARY TEST IS WHY.** With `/` in it, the rule ate the
 * stack's own frame — `at /home/day/lab/orrery-[redacted]-hygiene.test.ts:200:48` — because a filesystem path is a long
 * run of the allowed alphabet once the separator is in the class. **A scrubber that redacts the line number of the
 * failing test is worse than no scrubber: it removes the one thing the line was for.** A path is broken by `/`, `-` and
 * `.`, so excluding `/` is sufficient, and it costs only a base64 secret that happens to hide a slash in its first 32
 * characters — not a shape worth optimising for.
 */
/** Values that are safe to log but noisy; collapsed to a shape summary. One token for BOTH scrubbers, so one grep finds every redaction. */
const REDACTED = '[redacted]';

const SENSITIVE_VALUE =
  /(?:[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)|(?:bearer\s+[A-Za-z0-9._~+/=-]+)|(?:eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,})|(?:[A-Za-z0-9+]{32,}={0,2})/giu;

/**
 * THE MESSAGE LENGTH CEILING.
 *
 * A cap rather than a truncation: `redact()` truncates arrays because a partial array is honest, and
 * a partial SENTENCE is not — half a message with a canary in the half that survived is worse than no
 * message, because it reads like a complete record. So an over-long message is refused outright and the
 * refusal is visible in the log line.
 */
const MAX_MESSAGE_CHARS = 2_000;

/**
 * SCRUB A MESSAGE, AND STATE WHAT IT CANNOT DO.
 *
 * Replaces every `SENSITIVE_VALUE` match, then refuses a message over `MAX_MESSAGE_CHARS`.
 *
 * **This catches credentials and contact details, and it does not catch content.** No value-shape rule
 * can: an answer key, a student's sentence, a marker comment and a password are all strings, and
 * distinguishing them requires knowing which is which — which is what the field NAME gives you and what a
 * sentence does not. The control for content is therefore not this function; it is that a dynamic value
 * goes into `fields`, where `SENSITIVE_KEY` decides it. What this buys is that the mistake which costs
 * most, pasting a credential or an address into a sentence, is caught rather than merely discouraged.
 */
export function scrubMessage(msg: string): string {
  if (msg.length > MAX_MESSAGE_CHARS) {
    return `[message refused: ${String(msg.length)} characters, over the ${String(MAX_MESSAGE_CHARS)}-character ceiling]`;
  }
  return msg.replace(SENSITIVE_VALUE, REDACTED);
}

/**
 * SCRUB A MULTI-LINE STRING WITHOUT PUTTING A CEILING ON IT.
 *
 * A stack is the case this exists for: `redact()` used to scrub an `Error`'s `message` and copy its `stack` verbatim,
 * and a stack's first line is `"<name>: <message>"` — so the value it had just redacted reappeared one line down, and
 * the only test that could see it was one planting a canary in that position.
 *
 * No ceiling, deliberately: `MAX_MESSAGE_CHARS` is right for a sentence and wrong for a stack, and a refused stack is
 * the loss of the one diagnostic a production incident has.
 */
function scrubLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(SENSITIVE_VALUE, REDACTED))
    .join('\n');
}

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
 * - **Every surviving string value is run through `scrubMessage` as well**, because a key list is a guess about
 *   names and a name is not the only thing that makes a value sensitive.
 * - `Error` objects become `{ name, message, stack, digest }` because a serialised Error
 *   is `{}` in most runtimes — a bug that has silently turned every error log into
 *   `{"error":{}}` in a hundred projects.
 * - Nesting is bounded to depth 3, because an unbounded recursive walk is a stack
 *   overflow triggered by a log call, which is a genuinely bad afternoon.
 *
 * ## AND `SENSITIVE_KEY` ALONE WAS NOT ENOUGH — WHICH IS WHAT THE CANARY TEST FOUND
 *
 * `log.warn('evidence dropped', { payload: { studentEmail: canary } })` is caught, because `studentEmail` is a name on
 * the list. **`log.warn('evidence dropped', { note: canary })` was not, and neither was `{ meta: { deep: { note: canary } } }`.**
 * Both were red when `TM-19`'s position-varying canaries were run against the pre-fix module, which is the second half of
 * the finding and the half the original test could not have found: that test planted canaries under *sensitive* names
 * only, so a leak that depended on the name being INNOCUOUS was invisible to it. A key blocklist is a control against
 * naming a secret after itself.
 *
 * ## THE COST, STATED RATHER THAN DISCOVERED
 *
 * Value-shape scrubbing redacts a 32+ character opaque run wherever it appears, so a hex digest logged as an innocuously
 * named field now reads `[redacted]`. That is the intended trade: in a log line a 64-character hex run is a session id or a
 * signature far more often than it is something a human needs to read, and `receiptHash` was already redacted by
 * `SENSITIVE_KEY` regardless. A UUID survives, because the rule requires a 32+ run with no separators.
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
        /**
         * `scrubMessage`, and this is the SECOND position a credential arrives in unaided.
         *
         * `redact()` reaches an `Error` and then copies `message` verbatim, because `SENSITIVE_KEY` has nothing to
         * match — the key is `error`, and `error` is not on the list. So `throw new Error(\`no row for ${email}\`)` was a
         * second interpolation path into the log line, and it is the more likely one: an error message is written by
         * whoever was nearest the failure, which is exactly where somebody pastes the value they were debugging with.
         */
        message: scrubMessage(value.message),
        /**
         * SCRUBBED PER LINE, AND THIS WAS FOUND BY THE CANARY TEST RATHER THAN BY READING.
         *
         * A stack's first line IS the message — `Error: no row for a@b.c` — so redacting `message` and copying `stack`
         * verbatim re-emits the identical value two lines lower. That is not a subtle leak: the canary test's
         * "an `Error`'s message" position was the only one still red after `message` was scrubbed, and the received value
         * showed the canary sitting in `stack` with `[redacted]` sitting directly above it.
         *
         * Per LINE rather than per stack: the message ceiling is wrong here (a stack is legitimately thousands of
         * characters and refusing one would delete the only diagnostic a production incident has) and the pattern is
         * anchored at a shape, so running it inside each line cannot merge across the newlines that give a stack its
         * shape.
         */
        stack: value.stack === undefined ? undefined : scrubLines(value.stack),
        ...(typeof (value as Error & { digest?: string }).digest === 'string'
          ? { digest: (value as Error & { digest?: string }).digest }
          : {}),
      };
      continue;
    }
    if (typeof value === 'string') {
      // The KEY was innocent and the VALUE was not. Reached here before the object branch so it cannot be skipped by a
      // nesting quirk, and after the key branch so a sensitive key is not scrubbed twice for no reason.
      out[key] = scrubMessage(value);
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
      ...base,
      ...(fields ? redact(fields) : {}),
      /**
       * `msg` LAST, and it used to be first.
       *
       * A field named `msg` — or a `child()` binding called `msg` — overwrote the message, because the spread was
       * the other way round. That was not hypothetical: it meant the scrubbed message was replaceable by an
       * **unscrubbed** one, so a caller could bypass `scrubMessage` without knowing the function existed, by
       * passing `{ msg: \`failed for ${email}\` }` as a field. The field's value still went through `redact()`,
       * which has no rule for the key `msg`, so the credential went out verbatim.
       *
       * Last wins the tie because the message is the one thing on the line that is not caller-supplied data.
       */
      msg: scrubMessage(msg),
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
