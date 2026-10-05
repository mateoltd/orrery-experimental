/**
 * The compiler assertions behind `INV-TELEMETRY-2` at the ingestion boundary.  (P14-T14, TM-20)
 *
 * ## SAME RULES AS `packages/exam-engine/src/evidence-detail.assert.types.ts`, AND THE SAME FILENAME REASON
 *
 * `packages/exam-engine/tsconfig.json:7` excludes `*.test.ts` from the program, so a file of `@ts-expect-error`
 * directives named `…test.ts` is a comment with import statements. The `.assert.types.ts` suffix is what keeps these
 * probes inside `pnpm run typecheck`, which is the only thing that runs this file.
 *
 * Each probe sits inside a never-called function and hands its value to a declared sink, because `no-unused-expressions`
 * refuses a bare expression and a file of bare expressions is a file nobody can review.
 */

import type { StoredTelemetryEvent } from './ingest.js';
import type { TelemetryDetail } from './schema.js';

declare const anyRow: StoredTelemetryEvent;

/** A sink, so each probe is a statement with an effect rather than a stray token. */
declare function _use(value: unknown): void;

/** A local alias, purely so the row probes fit inside Biome's 100-column `lineWidth`. */
type Row = StoredTelemetryEvent;

/**
 * `Record<string, unknown>`: what a codec, a `JSON.parse` or a merged config hands you — and precisely what
 * `request.json()` produces in `ingest.ts`. Used to assert the hole, which is the whole point of this file.
 */
const WIDE: Record<string, unknown> = { studentEmail: 'student@school.invalid' };

/**
 * THE VOCABULARIES ARE ONE LIST, AND `Exactly` IS WHAT MAKES A REDEFINITION AN ERROR.
 *
 * `TelemetryDetail` is an alias today, so `Exactly` is trivially satisfied — which is exactly why the assertion has
 * teeth: the day somebody redefines `TelemetryDetail` as its own `Partial<Record<string, …>>`, or widens the evidence
 * tuple and aliases the old name at it, the two directions stop agreeing, `Exactly` collapses to `never`, and
 * `= true` fails to compile. **The assertion is not a description of today; it is the thing that stops a second
 * vocabulary existing.**
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export function theDetailVocabularyIsTheEvidenceOne(): void {
  const one: Exactly<TelemetryDetail, import('@orrery/exam-engine/evidence').EvidenceDetail> = true;
  _use(one);
}

/** THE HEADLINE PROBE: the leak `TM-20` names, written on the STORED ROW rather than on a standalone alias. */
export function unknownDetailKeyIsAnErrorOnTheStoredRow(): void {
  const leak: Row = {
    attemptId: 'at-1',
    sessionId: 'se-1',
    clientSeq: 0,
    seq: 0,
    type: 'TAB_HIDDEN',
    severity: 'WARN',
    receivedAt: 0,
    clientTs: null,
    clampedByMs: 0,
    accommodationRelaxed: false,
    countsAsStrike: false,
    protected: false,
    rejectedBecause: null,
    // @ts-expect-error `studentEmail` is not one of the twenty-two, and this is the row it would reach.
    payload: { studentEmail: 'student@school.invalid' },
  };

  // A legal row, so the probe above is not passing because nothing is accepted.
  const fine: Row = {
    attemptId: 'at-1',
    sessionId: 'se-1',
    clientSeq: 0,
    seq: 0,
    type: 'TAB_HIDDEN',
    severity: 'WARN',
    receivedAt: 0,
    clientTs: null,
    clampedByMs: 0,
    payload: { awayForMs: 12 },
    accommodationRelaxed: false,
    countsAsStrike: false,
    protected: false,
    rejectedBecause: null,
  };
  _use([leak, fine, anyRow.payload]);
}

/** An answer key is the exact thing the original docstring forbade in prose. */
export function answerMaterialIsAnError(): void {
  // @ts-expect-error The keyed question types all spell it `key`, and `audit-payloads.mjs:85-95` watches for it.
  const key: TelemetryDetail = { key: { choiceId: 'a' } };

  // @ts-expect-error The compound form. `Exclude` matches whole names, so `PII_OR_CONTENT_KEYS` spells it out.
  const named: TelemetryDetail = { studentName: 'Alex' };

  // @ts-expect-error A value that is not a primitive is how a whole payload gets past a key allowlist.
  const nested: TelemetryDetail = { reason: { answer: 'purple' } };

  _use([key, named, nested]);
}

/**
 * THE ONE PLACE THE CLOSED TYPE DOES NOT REACH, ASSERTED AS COMPILING RATHER THAN AS AN ERROR.
 *
 * **A `@ts-expect-error` here would be WRONG**, and writing one would have been a probe passing for the wrong reason.
 * So this is a call with no directive: it compiles, and if it stops compiling this file goes red. That inverts the usual
 * direction deliberately, because the property under test is the EXISTENCE of a hole — and it is exactly the hole
 * `narrowTelemetryDetail` exists to close at the wire, since `request.json()` produces this shape and nothing else.
 */
export function theClosedTypeDoesNotSeeARequestBody(): void {
  const viaConst: TelemetryDetail = WIDE;
  _use(viaConst);

  const viaSpread: TelemetryDetail = { ...WIDE };
  _use(viaSpread);
}

/**
 * `protected` is a LITERAL `false`, so the endpoint cannot be edited to write a protected row.
 *
 * The type is the mechanism rather than a value somebody passes: `IntegrityEvent.protected` marks the server's own
 * threshold-crossing row, and `SERVER_ONLY_EVENTS` refuses `VIOLATION_THRESHOLD_REACHED` at the writer, so a row arriving
 * here is by definition not that row. A boolean would compile and could be set to `true` by a later change.
 */
export function theProtectedRowCannotBeClaimedFromAClientBatch(): void {
  // @ts-expect-error `true` is not assignable to the literal `false` the stored row carries.
  const claimed: Row['protected'] = true;
  _use([claimed, false as const]);
}
