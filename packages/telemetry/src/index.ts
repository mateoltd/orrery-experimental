/**
 * `@orrery/telemetry` — the server side of the evidence pipeline.  (P14-T14, `plans/09` §7)
 *
 * ## ONE EXPORT SURFACE PER DECISION, AND NO BARREL FILES  (ADR-0016)
 *
 * `schema`, `ingest` and `retention` are subpath exports rather than one index, for the same reason
 * `packages/auth` has fifteen: a caller that needs the retention constant should not load the request handler, and a
 * module whose only job is to be imported cannot be reviewed as a unit.
 *
 * ## WHAT IS IN HERE AND WHAT IS NOT
 *
 * In: the closed `detail` schema as it arrives over the wire (`schema`), the endpoint's decisions (`ingest`), and where
 * telemetry is kept and who may read it (`retention`).
 *
 * Not in here, and named in each file: persistence in Postgres (`packages/db`), the strike counters and the escalation
 * ladder (`plans/09` §7 steps 6-7), the retention sweep that acts on `retentionDecision` (`P14-T6`), and the Next.js
 * mount. **Four things this pipeline needs and this package does not contain is a worse position than one where the
 * list is written down**, because the list is the work.
 */

export type {
  IncomingTelemetryBody,
  StoredTelemetryEvent,
  TelemetryIngestDependencies,
  TelemetryIngestRefusal,
  TelemetryIngestReport,
  TelemetryIngestResult,
  TelemetryRejection,
  TelemetrySession,
  TelemetrySessionLookup,
  TelemetrySink,
} from './ingest.js';
export { ingestTelemetry, TELEMETRY_ENDPOINT } from './ingest.js';
export type { TelemetryReadRequest, TelemetryRetentionDecision } from './retention.js';
export {
  mayReadAttemptTelemetry,
  mayReadTelemetry,
  retentionDecision,
  TELEMETRY_CLOCK_SKEW_WINDOW,
  TELEMETRY_LATE_ARRIVAL_WINDOW,
  TELEMETRY_RETENTION_DAYS,
  TELEMETRY_RETENTION_MS,
} from './retention.js';
export {
  MACHINE_WORD_DETAIL_KEYS,
  MAX_TELEMETRY_DETAIL_VALUE_CHARS,
  type MachineWordDetailKey,
  narrowTelemetryDetail,
  TELEMETRY_DETAIL_KEYS,
  TELEMETRY_SCHEMA,
  type TelemetryDetail,
  type TelemetryDetailKey,
  type TelemetryDetailRefusal,
  type TelemetryDetailValue,
  type TelemetryDetailVerdict,
} from './schema.js';
