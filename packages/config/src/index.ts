/**
 * `@orrery/config` — toolchain configuration, environment validation, and logging.
 *
 * Deliberately NOT a dumping ground. Two things live here because they must be
 * unreachable from application code:
 *
 *   · `env` — the only module permitted to read `process.env` (ESLint-enforced), and it
 *     fails at boot rather than yielding `undefined` three layers into a request.
 *   · `logging` — `redact()` is the only way to build a log object, so "logs carry no PII"
 *     is a type-level constraint rather than a sentence in a document.
 */
export { type Env, type EnvInput, type EnvResult, envShape, loadEnv, parseEnv } from './env.js';
export {
  type Channel,
  createLogger,
  examLogger,
  httpLogger,
  type LogFields,
  type Logger,
  type LogRecord,
  redact,
  type Severity,
} from './logging.js';
