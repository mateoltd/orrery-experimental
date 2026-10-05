/**
 * THE CLOSED `detail` SCHEMA AS IT ARRIVES, AND WHY IT IS A TYPE PLUS A CHECK RATHER THAN EITHER ALONE.
 *  (P14-T14, TM-20, TM-10, `INV-TELEMETRY-2`)
 *
 * ## THE ONE THING THIS FILE EXISTS TO PREVENT
 *
 * A student's answer, or an identifier, reaching a row that is retained for 400 days. `detail` is the only field in an
 * evidence event where either could arrive: everything else is a type from a closed union, a sequence number, or an
 * instant. `evidence.ts` calls it *"read by a human"* and forbids an answer and a score in prose, and that prose was
 * the only thing standing between the two.
 *
 * ## THE VOCABULARY IS THE EVIDENCE ONE, BY REFERENCE, AND THERE IS NO SECOND LIST
 *
 * `TELEMETRY_DETAIL_KEYS` below IS `EVIDENCE_DETAIL_KEYS` — the same array, not a copy of it. `scripts/audit-payloads.mjs`
 * already allows twenty-two specific names, walks every one of them through the real writer, and independently checks
 * the exported tuple against its own copy of the forbidden list. A list written here would be a twenty-third place for
 * that gate to have to be taught about, and the gate's own header says why a gate which asks the module under audit
 * whether its own key is allowed is a gate that agrees with whatever the module says.
 *
 * So the twenty-two names, their value types, and the `Exclude`-based compile-time prohibition on a PII name are
 * **imported, not re-derived**. What this file adds is the half that had no home: the boundary.
 *
 * ## A TYPE CANNOT SEE A PAYLOAD THAT ARRIVED ALREADY TYPED, AND THE PROBE THAT PROVES IT
 *
 * `EvidenceDetail` stops a fresh object literal, and `evidence-detail.assert.types.ts` asserts the hole that remains on
 * purpose: `const viaSpread: EvidenceDetail = { ...WIDE }` **compiles**, because a spread of a `Record<string, unknown>`
 * produces an index signature and the const it lands in is not fresh, so excess-property checking does not apply. A
 * telemetry payload arrives from `JSON.parse`, which is precisely that shape. `EvidenceBatcher.record()` re-checks at
 * runtime for the same reason and says so in its own comment: **that check is the only thing standing between
 * `{ studentEmail }` and a row retained for 400 days.**
 *
 * So this module has both halves and says which is which. The type is the control for the twenty-two places in this
 * repository that build a detail. The runtime check is the control for the one place that receives one.
 *
 * ## WHAT THE RUNTIME CHECK CANNOT DO, STATED HERE RATHER THAN DISCOVERED
 *
 * **It constrains the NAME, not the VALUE.** `{ detail: { awayForMs: 'ada@example.school' } }` has a reviewed key and a
 * reviewed primitive, and passes. No key list prevents that and no value-shape rule can either: an answer key reading
 * `purple` has no shape. The honest statement, which `evidence.ts` also makes, is that the type narrows the surface
 * from "any key" to "twenty-two reviewed keys" — not to zero — and that what narrows the remainder is the caller,
 * which for a value arriving from a browser is the machine-word rule below.
 */

import { scrubMessage } from '@orrery/config/logging';
import {
  EVIDENCE_DETAIL_KEYS,
  type EvidenceDetail,
  type EvidenceDetailKey,
  type EvidenceDetailValue,
  isEvidenceDetailKey,
  isEvidenceDetailValue,
} from '@orrery/exam-engine/evidence';

/**
 * THE SAME TUPLE, BY REFERENCE.
 *
 * Exported so a reader can see there is one list rather than two that agree today, and so `telemetry-schema.test.ts`
 * can assert identity — `TELEMETRY_DETAIL_KEYS === EVIDENCE_DETAIL_KEYS` — which is the assertion that fails the day
 * somebody writes a second one. A copy would be indistinguishable from this at every call site and would pass every
 * test except that one.
 */
export const TELEMETRY_DETAIL_KEYS = EVIDENCE_DETAIL_KEYS;

export type TelemetryDetailKey = EvidenceDetailKey;
export type TelemetryDetail = EvidenceDetail;
export type TelemetryDetailValue = EvidenceDetailValue;

/**
 * WHY A NEW NAME AT ALL, WHEN THE TYPE COULD SIMPLY BE RE-EXPORTED.
 *
 * Because the ingestion path has to say what it will and will not accept, and `EvidenceDetail` is a name that means
 * "what our writer may build". What arrives is the same vocabulary read by a server that did not build it, and the two
 * differ in exactly one place — `evidence.ts` states it for itself: the signing path must stay total, the ACCEPTANCE
 * path must be closed. `TelemetryDetail` is that name, so the distinction is in the type a reader reaches for rather
 * than in a comment above it.
 */

/**
 * THE CEILING ON A `detail` VALUE, and it is a refusal rather than a truncation.
 *
 * `scrubMessage` makes the same argument for log lines: half a message with a canary in the half that survived is worse
 * than no message, because it reads like a complete record. Truncating here would store `student@school.exam…` in a
 * field whose key said the value was a duration.
 */
export const MAX_TELEMETRY_DETAIL_VALUE_CHARS = 128;

/**
 * THE KEYS WHOSE VALUE IS A MACHINE WORD FROM A CLOSED VOCABULARY, and the rule for them.
 *
 * **`reason` IS IN HERE, AND THAT IS THE POINT OF THIS FILE.** `evidence.ts` records, against `reason` itself, that
 * `watchdog.ts` writes a browser error NAME into it and `lifecycleGuard` writes `error.message` into it — so `reason` is
 * the one allowlisted key whose value is free-form prose in the code that writes it, and `14` §7.5's promise not to read
 * students' written answers at scale rests on nothing at all beneath it. A student's answer is a string, and a string
 * under a reviewed key is exactly the shape `INV-TELEMETRY-2` cannot see.
 *
 * So the five keys whose value `evidence.ts` describes as a machine word are REQUIRED to hold one: a single identifier
 * token, no spaces, no punctuation. `AbortError` and `LOAD_TIMEOUT` and `STOP` pass, because those are what the
 * watchdog writes. `"the mitochondria is the powerhouse of the cell"` does not, because that is a sentence, and the
 * question at ingestion is not "is this value sensitive" — no shape answers that — it is "is this value what the key
 * says it is", which is answerable.
 *
 * The keys deliberately NOT here are the ones whose value is genuinely structured rather than symbolic: `simId` names a
 * registered simulation and contains dots, `peerTabId` is chosen by the client, and `outcome` on `MULTI_TAB_DETECTED` is
 * the watchdog's own machine word — so all three are still covered, and adding a key to this list is a decision someone
 * has to make rather than a consequence.
 */
export const MACHINE_WORD_DETAIL_KEYS = ['outcome', 'phase', 'status', 'code', 'reason'] as const;
export type MachineWordDetailKey = (typeof MACHINE_WORD_DETAIL_KEYS)[number];

const MACHINE_WORD_SET: ReadonlySet<string> = new Set<string>(MACHINE_WORD_DETAIL_KEYS);

/**
 * A single identifier token: letters, digits, underscore and hyphen, starting with a letter, and short.
 *
 * **THE UNDERSCORE IS NOT OPTIONAL**, and its absence was found by the test that exercises every key's documented
 * value: `evidence.ts` describes `code` as "a machine code from a closed vocabulary such as `LOAD_TIMEOUT`", and a
 * character class without `_` refuses exactly the example the source gives. A rule that rejects the documented value of
 * a key is a rule whose first response is to be widened until the value fits, and at that point it is a comment.
 */
const MACHINE_WORD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * WHY A REGEX AND NOT A CLOSED SET OF ALLOWED WORDS.
 *
 * A closed set of words would be a second vocabulary — every watchdog outcome, every phase, every error name — and it
 * would need a code change in a server to notice that a client had learned a new one, which is the opposite of what a
 * closed schema is for. The shape is the stable part: `evidence.ts` describes these as machine words and a machine word
 * is a token, not a sentence. What this deliberately does NOT claim is that the token is one anybody recognises — a
 * client may send `NOT_A_REAL_OUTCOME` and it is stored — because the escalation ladder reads a severity and a strike
 * decision from the table, never from the word.
 */
export const isMachineWord = (value: string): boolean => MACHINE_WORD.test(value);

export type TelemetryDetailRefusal =
  /** `detail` was present and was not a plain object. */
  | 'DETAIL_NOT_AN_OBJECT'
  /** A key outside `EVIDENCE_DETAIL_KEYS`. The `TM-20` leak, arriving over the wire. */
  | 'DETAIL_KEY_NOT_ALLOWED'
  /** A value that is not a primitive, which is how a whole payload gets past a key allowlist. */
  | 'DETAIL_VALUE_NOT_PRIMITIVE'
  /** Over the ceiling. Refused rather than truncated — see `MAX_TELEMETRY_DETAIL_VALUE_CHARS`. */
  | 'DETAIL_VALUE_TOO_LONG'
  /**
   * A string whose SHAPE is a credential, an address, a bearer token or a JWT.
   *
   * Decided by `scrubMessage` from `@orrery/config`, which is the repository's existing answer to this question and has
   * its own limits written on it — it catches what a value *is*, and it cannot catch content. Reusing it is the point:
   * a second value-shape list in a second package is a list that disagrees with the first one within a release.
   */
  | 'DETAIL_VALUE_LOOKS_LIKE_A_CREDENTIAL'
  /** A key documented as a machine word holding prose. The §7.5 answer. */
  | 'DETAIL_VALUE_IS_PROSE';

export type TelemetryDetailVerdict =
  | { readonly ok: true; readonly detail: TelemetryDetail }
  | { readonly ok: false; readonly reason: TelemetryDetailRefusal; readonly key: string | null };

/**
 * Is this a legal stored `detail`? Narrowed, not validated-and-carried.
 *
 * **`key` IS RETURNED ON REFUSAL AND IT IS A NAME, NEVER A VALUE.** A log line needs to say which key was refused, and
 * echoing the value back into a log is how the refusal becomes the leak.
 *
 * **KEYS FIRST, THEN VALUES, AND THE ORDER IS THE DIAGNOSTIC.** `Object.entries` iterates in insertion order, so a
 * single pass would let a bad value beside a PII key be reported as the value problem — the payload is refused either
 * way, but a stable reason is what makes a counter mean something across a class of thirty students.
 */
export const narrowTelemetryDetail = (raw: unknown): TelemetryDetailVerdict => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'DETAIL_NOT_AN_OBJECT', key: null };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  /** Narrowed to a reviewed key, so nothing below needs a cast to build a closed detail. */
  const allowed: { key: TelemetryDetailKey; value: unknown }[] = [];
  for (const [key, value] of entries) {
    if (!isEvidenceDetailKey(key)) return { ok: false, reason: 'DETAIL_KEY_NOT_ALLOWED', key };
    allowed.push({ key, value });
  }

  const accepted: Partial<Record<TelemetryDetailKey, TelemetryDetailValue>> = {};
  for (const { key, value } of allowed) {
    if (!isEvidenceDetailValue(value)) {
      return { ok: false, reason: 'DETAIL_VALUE_NOT_PRIMITIVE', key };
    }
    if (typeof value === 'string') {
      const refusal = classifyDetailString(key, value);
      if (refusal !== null) return { ok: false, reason: refusal, key };
    }
    accepted[key] = value;
  }
  return { ok: true, detail: accepted };
};

/** WHY THIS IS SEPARATE FROM THE LOOP: it is the part with a decision in it, and a decision wants its own tests. */
const classifyDetailString = (
  key: TelemetryDetailKey,
  value: string,
): TelemetryDetailRefusal | null => {
  if (value.length > MAX_TELEMETRY_DETAIL_VALUE_CHARS) return 'DETAIL_VALUE_TOO_LONG';
  if (scrubMessage(value) !== value) return 'DETAIL_VALUE_LOOKS_LIKE_A_CREDENTIAL';
  if (MACHINE_WORD_SET.has(key) && !isMachineWord(value)) return 'DETAIL_VALUE_IS_PROSE';
  return null;
};

/**
 * THE WHOLE SCHEMA AS ONE VALUE, for a caller that wants to validate a detail it already holds in the closed type.
 *
 * Exported rather than kept private because a module-scope `const` nothing reads is a lint error and a lint error is a
 * `// biome-ignore` by next Tuesday. The test reads it, which is what makes it load-bearing rather than decorative.
 */
export const TELEMETRY_SCHEMA = Object.freeze({
  detailKeys: TELEMETRY_DETAIL_KEYS,
  machineWordKeys: MACHINE_WORD_DETAIL_KEYS,
  maxValueChars: MAX_TELEMETRY_DETAIL_VALUE_CHARS,
  isDetailKey: isEvidenceDetailKey,
  isDetailValue: isEvidenceDetailValue,
  narrow: narrowTelemetryDetail,
});
