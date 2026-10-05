/**
 * The evidence pipeline: the closed event schema, strike classification, and batch signing.  (P8-T7)
 *
 * ## WHY THE EVENT TABLE IS CODE AND NOT A DATABASE LOOKUP
 *
 * `plans/09` §7.1 gives every event a severity and says whether it counts as a strike. Four entries in that table are
 * not about the student at all, and each of them can be turned into an accusation by accident:
 *
 *  · `FULLSCREEN_DENIED` — "a capability failure, not misconduct". A locked-down school device denies fullscreen.
 *  · `DEVTOOLS_SIZE_ANOMALY` — "advisory evidence only, never punitive". Window size is not evidence of anything.
 *  · `SIM_LOAD_FAILED` — "**never penalises the student for our bug**".
 *  · `ACCOMMODATION_RELAXED` — never, under INV-ACC-1.
 *
 * Those four are the reason the table lives here as data with the strike decision made in one function. A severity
 * looked up per call site is a severity somebody eventually gets wrong, and the consequence is a strike against a
 * student for a browser policy.
 *
 * ## AND WHY `VIOLATION_THRESHOLD_REACHED` CANNOT BE EMITTED FROM HERE
 *
 * §7.1 marks it "emitted by the **server**". A client that emitted it would be announcing its own escalation, on
 * evidence it holds and a teacher has not seen, and the ladder would act on the client's count. So it is in the schema
 * as a known type and is REJECTED by the writer, because the type has to exist for the server's rows to be readable.
 */

import type { Millis } from '@orrery/clock';

/** Every event type in `plans/09` §7.1, plus the ones the server emits. */
export type EvidenceType =
  | 'EXAM_STARTED'
  | 'FULLSCREEN_ENTERED'
  | 'FULLSCREEN_EXITED'
  | 'FULLSCREEN_DENIED'
  | 'POINTERLOCK_ENTERED'
  | 'POINTERLOCK_LOST'
  | 'WINDOW_BLURRED'
  | 'WINDOW_FOCUSED'
  | 'TAB_HIDDEN'
  | 'TAB_VISIBLE'
  | 'MULTI_TAB_DETECTED'
  | 'COPY_ATTEMPT'
  | 'PASTE_ATTEMPT'
  | 'CONTEXT_MENU'
  | 'PRINT_ATTEMPT'
  | 'SAVE_ATTEMPT'
  | 'DEVTOOLS_SIZE_ANOMALY'
  | 'SAVE_REJECTED_LATE'
  | 'QUESTION_WINDOW_CLOSED'
  | 'CLOCK_SKEW_DETECTED'
  | 'NETWORK_LOST'
  | 'NETWORK_RESTORED'
  | 'AUTOSAVE_QUEUED'
  | 'SIM_LOAD_FAILED'
  | 'ACCOMMODATION_RELAXED'
  | 'VIOLATION_THRESHOLD_REACHED'
  | 'ATTEMPT_TERMINATED'
  | 'ATTEMPT_SUBMITTED';

export type Severity = 'INFO' | 'WARN' | 'VIOLATION';

/**
 * HOW EACH EVENT IS TREATED, and the four that are not about the student.
 *
 * `strike: 'never'` is a stronger statement than `strike: 'no'`, and the distinction is deliberate:
 *
 *  · `'no'` -- this event does not increment a counter. It can still be shown.
 *  · `'never'` -- this event must NEVER affect a student's outcome under any policy. It is evidence about the
 *    software, the browser or an accommodation, and `plans/09` says so in as many words for three of them.
 */
export interface EventRule {
  readonly severity: Severity;
  readonly strike: 'never' | 'when_fullscreen_required' | 'when_policy_says' | 'always';
  readonly why: string;
}

/**
 * THE CLOSED TABLE.
 *
 * `as const` so a missing row is a type error rather than an `undefined` that reads as "no strike".
 *
 * It is declared as `RULES` and exported under the wide type below, because `POLICY_SWITCHES` needs each row's LITERAL
 * `strike` to know which types owe it a switch, and every other reader wants `Record<EvidenceType, EventRule>`.
 */
const RULES = {
  EXAM_STARTED: { severity: 'INFO', strike: 'never', why: 'carries the preflight record' },
  FULLSCREEN_ENTERED: { severity: 'INFO', strike: 'never', why: 'the deterrent working' },
  FULLSCREEN_EXITED: {
    severity: 'VIOLATION',
    strike: 'when_fullscreen_required',
    why: 'counts only when the policy required fullscreen',
  },
  // "A capability failure, not misconduct" -- `plans/09` §7.1. A locked-down device denies fullscreen.
  FULLSCREEN_DENIED: {
    severity: 'WARN',
    strike: 'never',
    why: 'a capability failure, not misconduct: the browser refused and the student is not at fault',
  },
  POINTERLOCK_ENTERED: { severity: 'INFO', strike: 'never', why: 'the deterrent working' },
  // "only past grace, and only if policy says so" -- and `Escape` always causes this, which is why the grace exists.
  POINTERLOCK_LOST: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'past grace only, and Escape always causes it, so it is a deterrent and not a lock',
  },
  WINDOW_BLURRED: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'thresholded, not per-event: one click on another window is not an offence, so only the count matters',
  },
  WINDOW_FOCUSED: {
    severity: 'WARN',
    strike: 'never',
    why: 'the student came back, which is the wanted outcome',
  },
  TAB_HIDDEN: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'thresholded, and correlated with blur so one alt-tab costs one count rather than two',
  },
  TAB_VISIBLE: { severity: 'WARN', strike: 'never', why: 'the student came back' },
  // A second LIVE session. `tabGuard` only emits this for a tab that answered, never for one that went quiet.
  MULTI_TAB_DETECTED: {
    severity: 'VIOLATION',
    strike: 'always',
    why: 'a second live attempt session',
  },
  COPY_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential, and only because copying is the easiest way to share it',
  },
  PASTE_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential; pasting is the easiest way to bring an answer in',
  },
  CONTEXT_MENU: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'the menu is how Save As is reached, so it counts with the print/save block rather than on its own',
  },
  PRINT_ATTEMPT: {
    severity: 'WARN',
    strike: 'when_policy_says',
    why: 'only when the paper declares its content confidential; print and Save As are the same disclosure',
  },
  SAVE_ATTEMPT: { severity: 'INFO', strike: 'never', why: 'advisory only' },
  // "advisory evidence only, never punitive" -- window size is not evidence of anything.
  DEVTOOLS_SIZE_ANOMALY: {
    severity: 'INFO',
    strike: 'never',
    why: 'advisory evidence only: a window size anomaly is not evidence of anything',
  },
  SAVE_REJECTED_LATE: {
    severity: 'INFO',
    strike: 'never',
    why: 'the server rejected the write; the client is reporting, not confessing',
  },
  QUESTION_WINDOW_CLOSED: {
    severity: 'INFO',
    strike: 'never',
    why: 'a consequence of a per-question timeout, which the policy chose',
  },
  CLOCK_SKEW_DETECTED: {
    severity: 'WARN',
    strike: 'never',
    why: 'advisory; the server enforces time',
  },
  NETWORK_LOST: { severity: 'INFO', strike: 'never', why: 'the network, not the student' },
  NETWORK_RESTORED: { severity: 'INFO', strike: 'never', why: 'the network, not the student' },
  AUTOSAVE_QUEUED: {
    severity: 'INFO',
    strike: 'never',
    why: 'explains a later gap in the timeline',
  },
  // "never penalises the student for our bug" -- `plans/09` §7.1.
  SIM_LOAD_FAILED: {
    severity: 'INFO',
    strike: 'never',
    why: "our bug, never the student's",
  },
  // INV-ACC-1.
  ACCOMMODATION_RELAXED: {
    severity: 'INFO',
    strike: 'never',
    why: 'INV-ACC-1: a relaxation is a right, never an offence',
  },
  // Server-emitted. Present so the server's rows are readable; the writer refuses to emit it.
  VIOLATION_THRESHOLD_REACHED: {
    severity: 'VIOLATION',
    strike: 'never',
    why: 'emitted by the SERVER, on evidence a human has not yet seen',
  },
  ATTEMPT_TERMINATED: { severity: 'INFO', strike: 'never', why: 'an outcome, not an offence' },
  ATTEMPT_SUBMITTED: { severity: 'INFO', strike: 'never', why: 'an outcome, not an offence' },
} as const satisfies Record<EvidenceType, EventRule>;

export const EVIDENCE_RULES: Readonly<Record<EvidenceType, EventRule>> = Object.freeze(RULES);

/**
 * THE ROW FOR A TYPE, OR A THROW. Every read of the table by a name that arrived at runtime goes through here.
 *
 * ## `EVIDENCE_RULES[type] === undefined` WAS NOT A MISSING-ROW CHECK  (`ADV-E1`)
 *
 * The table is an object literal, so a bare property read also finds everything on `Object.prototype`:
 * `constructor`, `toString`, `__proto__`, `valueOf`. Each of those is not `undefined`, so the guard passed, `strike` on
 * a function is `undefined`, and the switch fell to `default: return false` -- the lenient default the guard's own
 * comment said must never happen. It is the read `answerStore.ts` already fixed with `Object.hasOwn`, in a second
 * place.
 *
 * A missing rule is a BUG, not a lenient default. Answering `false` would silently un-strike a violation the moment
 * someone added an event type without a row, or a route misspelt one.
 */
export const evidenceRuleFor = (type: EvidenceType): EventRule => {
  if (!Object.hasOwn(EVIDENCE_RULES, type)) throw new Error(`no evidence rule for ${String(type)}`);
  return EVIDENCE_RULES[type];
};

/** The types the client must never emit. See the note at the top of this file. */
export const SERVER_ONLY_EVENTS: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'VIOLATION_THRESHOLD_REACHED',
]);

/** What the client knows about the policy, which is all the strike decision needs. */
export interface StrikePolicyView {
  readonly requireFullscreen: string;
  readonly requirePointerLock: string;
  readonly multiTabPolicy: string;
  readonly blockCopyPaste: boolean;
  readonly blockPrintSave: boolean;
}

/**
 * IS A REQUIREMENT SWITCHED ON? One spelling, because there were two and one of them was wrong.
 *
 * `ExamPolicy.requireFullscreen` and `requirePointerLock` are `OFF | WARN | REQUIRE` (`@orrery/contracts`). The
 * fullscreen arm tested `=== 'WARN' || === 'BLOCK'` and the pointer-lock arm tested `!== 'OFF'`, so under `REQUIRE` --
 * the strictest value the schema has -- **a fullscreen exit was never a strike**, while a pointer-lock loss was. Nothing
 * caught it because every test here spells the strict value `BLOCK`, which is the hardening switches' word for it and
 * not the policy's. `BLOCK` stays accepted for that reason.
 *
 * An allow-list rather than `!== 'OFF'`: this view arrives as plain strings, and a value nobody recognises should not
 * switch a counter ON.
 */
const REQUIREMENT_IN_FORCE: ReadonlySet<string> = new Set(['WARN', 'REQUIRE', 'BLOCK']);
const requirementInForce = (value: string): boolean => REQUIREMENT_IN_FORCE.has(value);

/** The types whose row says `when_policy_says`, read off the table so this list cannot disagree with it. */
type PolicyDecidedType = {
  [K in EvidenceType]: (typeof RULES)[K]['strike'] extends 'when_policy_says' ? K : never;
}[EvidenceType];

/**
 * WHICH SWITCH EACH `when_policy_says` EVENT ANSWERS TO.
 *
 * A `Record` over `PolicyDecidedType`, so a row that says `when_policy_says` and has no entry here is a compile error.
 * It was a chain of `if`s ending in a bare `return true`, which made "counts, always" the answer for any such type
 * nobody had listed: the accusing default, reached by forgetting a line.
 *
 * Each is policed only when ITS switch is on, so a copy-paste block cannot enable the print counter.
 */
const POLICY_SWITCHES: Readonly<Record<PolicyDecidedType, (policy: StrikePolicyView) => boolean>> =
  Object.freeze({
    POINTERLOCK_LOST: (policy) => requirementInForce(policy.requirePointerLock),
    // `WINDOW_BLURRED` and `TAB_HIDDEN` are thresholded rather than switched, and the threshold lives in `thresholds`;
    // whether the count has passed it is the ladder's decision, not this one's.
    WINDOW_BLURRED: () => true,
    TAB_HIDDEN: () => true,
    COPY_ATTEMPT: (policy) => policy.blockCopyPaste,
    PASTE_ATTEMPT: (policy) => policy.blockCopyPaste,
    CONTEXT_MENU: (policy) => policy.blockCopyPaste,
    PRINT_ATTEMPT: (policy) => policy.blockPrintSave,
  });

/**
 * DOES THIS EVENT COUNT AS A STRIKE, FOR A STUDENT HOLDING NO RELAXATION?
 *
 * ## THE ONLY READER OF THE `strike` COLUMN, AND THE FUNCTION `accommodations.ts` CALLS  (`ADV-A1`)
 *
 * `routeWatchdogEvent` used to answer this question itself, as `severity === 'VIOLATION'`. Severity and strike are two
 * columns of `plans/09` §7.1 and they disagree on purpose: seven of the nine types that can count are `WARN`. So for a tab
 * hide by a student with no accommodation this said yes and routing said no, and whichever a telemetry route called,
 * one invariant went -- `thresholds.tabHides` dead, or `INV-ACC-1` not applied. That is `perQuestionExpiry` (PF-8)
 * over again: two implementations of one rule, each locally reasonable.
 *
 * So routing now asks HERE and holds no strike rule of its own. What this does not know is the student:
 * **`routeEvidence` in `accommodations.ts` is the whole answer**, and a caller holding a student's relaxations that
 * stops at this function is not applying `INV-ACC-1`.
 *
 * The switch has no `default`. Every `strike` value is decided by a named arm, and a fifth one added to the union is a
 * compile error here rather than a quiet "never".
 */
export const countsAsStrike = (type: EvidenceType, policy: StrikePolicyView): boolean => {
  const rule = evidenceRuleFor(type);

  switch (rule.strike) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'when_fullscreen_required':
      return requirementInForce(policy.requireFullscreen);
    case 'when_policy_says':
      return POLICY_SWITCHES[type as PolicyDecidedType](policy);
  }
};

/**
 * EVERY KEY `detail` MAY CARRY, AND THE LIST IS THE CONTROL (`TM-20`).
 *
 * ## "NEVER AN ANSWER, NEVER A SCORE" WAS A COMMENT, AND A COMMENT IS NOT A SCHEMA
 *
 * The old declaration was `Readonly<Record<string, string | number | boolean | null>>`, described as *"Free-form. Never
 * an answer, never a score: this is read by a human."* The VALUES were constrained and the KEYS were not, so
 * `{ detail: { studentEmail: 'a@b.c' } }` typechecked, compiled, passed every test in this repository and reached a table
 * retained for 400 days. **`INV-TELEMETRY-2` cites `audit:payloads` as its mechanism and that gate did not exist either**,
 * so the property had a name, a registry row, a docstring and no mechanism at all.
 *
 * So the keys are closed, which is a TYPE-level guarantee and therefore one the compiler enforces everywhere at once:
 * an unknown key is an excess-property error at the literal, not a review comment somebody reads past.
 *
 * ## AND THE LIST IS THE *ONLY* KEY LIST, BECAUSE A SECOND ONE IS A LIST THAT WILL DRIFT
 *
 * Each key below names where it is written, so a reader can check the claim rather than trust it. A key that does not
 * name its writer would be a key nobody can find when the thing it describes changes.
 *
 * ## WHAT A CLOSED KEY LIST DOES NOT DO, STATED HERE RATHER THAN DISCOVERED
 *
 * It constrains the NAME, not the VALUE. `{ detail: { reason: someError.message } }` typechecks and can carry a student's
 * email, because `reason` is a legitimate key (`watchdog.ts` writes a browser error name into it) and `lifecycleGuard`
 * writes `error.message` into it. **No key list can prevent that**, and a value-shaped rule on `detail` would have to
 * guess which strings are PII — which is the guess `packages/config`'s `scrubMessage` makes for log lines and the same
 * guess with the same limit. The control for a free-form value under a legitimate key is the *caller*, and the honest
 * statement is that the type narrows the surface from "any key" to "twenty reviewed keys", not to zero.
 */
export const EVIDENCE_DETAIL_KEYS = [
  /** `clockGuard.ts`: advisory only, so a teacher reading the timeline sees nothing was enforced. */
  'advisory',
  /** `focusGuard.ts`: how long the student was away. */
  'awayForMs',
  /** `focusGuard.ts`: which counter this departure consumed. */
  'countsAgainstTabHides',
  /** Read by `packages/db/src/report-integrity.ts` when rebuilding a timeline; a gap count, not a mark. */
  'droppedEventCount',
  /** `clockGuard.ts`: the deadline authority is the server, restated on the event. */
  'enforcedByServer',
  /** `pointerLockGuard.ts`: whether the lock belonged to the simulation frame. */
  'escapeBelongsToSimulation',
  /** `pointerLockGuard.ts`: `null` because the browser will not say, rather than a guess. */
  'escapePossiblyInvolved',
  /** `pointerLockGuard.ts`: the grace the student actually got. */
  'graceMs',
  /** `pointerLockGuard.ts`: when the loss was observed. */
  'lostAt',
  /** `clockGuard.ts`: the measured drift. A duration in milliseconds, never an instant. */
  'offsetMs',
  /** `pointerLockGuard.ts` and `lifecycleGuard.ts`: a machine word from a closed vocabulary, never prose. */
  'outcome',
  /** `tabGuard.ts`: the client-chosen id of the tab that answered. */
  'peerTabId',
  /** `lifecycleGuard.ts`: which lifecycle moment this is. */
  'phase',
  /** `watchdog.ts` and `lifecycleGuard.ts`: a browser error NAME. See the value caveat above. */
  'reason',
  /** `watchdog.ts`: whether fullscreen was asked for, which decides whether the exit counts. */
  'requested',
  /** `clockGuard.ts`: the skew verdict. */
  'status',
  /** `clockGuard.ts`: whether the student was warned. Always false, deliberately — it names no student, which is why the
   * closed list can hold a key containing "student" while forbidding `studentEmail`. */
  'studentWarned',
  /** `focusGuard.ts`: whether the tab was also hidden, so two counters do not merge silently. */
  'tabWasHidden',
  /** Read by `packages/db/src/report-integrity.ts`; which threshold was crossed, as a NUMBER, never a mark. */
  'threshold',
  /** `watchdog.ts`: whether the denial followed a request. */
  'wasRequested',
  /**
   * `SIM_LOAD_FAILED`, and it is THE ONE ALLOWLISTED KEY WHOSE VALUE IS A CLIENT-CHOSEN STRING.
   *
   * Resolved through the sim registry's allowlist rather than free text, which is why it is here and `questionText` is
   * not — but nothing at THIS layer checks that the string names a registered simulation, and the closed key list cannot:
   * it constrains names. The check belongs at ingestion, with the rest of the closed schema (`plans/09` §7).
   */
  'simId',
  /** `SIM_LOAD_FAILED`: a machine code from a closed vocabulary such as `LOAD_TIMEOUT`, never a sentence. */
  'code',
] as const;

/** One of the twenty reviewed keys. Nothing else is a legal `detail` key. */
export type EvidenceDetailKey = (typeof EVIDENCE_DETAIL_KEYS)[number];

/**
 * WHAT A `detail` VALUE MAY BE: a primitive, and nothing else.
 *
 * Unchanged by `TM-20` — it was already right — and stated here because the closed key set makes the VALUE type the only
 * remaining freedom, so it should be a decision rather than an accident. A nested object or an array in `detail` is how a
 * whole payload would get smuggled past a key allowlist, so it is refused at the type and at the writer.
 */
export type EvidenceDetailValue = string | number | boolean | null;

/**
 * THE CLOSED `detail`. Every key optional, because "not applicable" is expressible and an empty object is not a lie.
 *
 * `Partial` rather than a union of per-event shapes: pairing each key to the event types that may carry it would be a
 * stronger type, and it would be a **second list** that a new event type has to be added to in two places. The gate
 * `scripts/audit-payloads.mjs` is what keeps the pairing honest, and a gate is the right instrument for it because a
 * gate runs on every commit and a second list does not.
 */
export type EvidenceDetail = Readonly<Partial<Record<EvidenceDetailKey, EvidenceDetailValue>>>;

/**
 * KEYS THAT WOULD NAME CONTENT OR A PERSON, and they are forbidden BY THE TYPE ABOVE RATHER THAN BY REVIEW.
 *
 * The mirror of `SENSITIVE_KEY` in `packages/config`, minus the ambiguous ones. `name` is here for `studentName` and
 * `fileName` as much as for a person's name, which is the right bias for a field retained for 400 days.
 *
 * **EXPORTED, AND THE EXPORT IS LOAD-BEARING.** `Exclude<EvidenceDetailKey, typeof PII_OR_CONTENT_KEYS[number]>` is the
 * whole mechanism, and a module-scope `const` nothing reads is a lint error that gets a `// biome-ignore` by next
 * Tuesday. It is also read by `evidence-detail.test.ts`, which asserts two things about it: that it and the allowlist do
 * not overlap, and that it still CONTAINS the names at risk — because a forbidden list that has been emptied satisfies the
 * first assertion perfectly.
 *
 * THE MECHANISM IS `EVIDENCE_DETAIL_KEYS_NO_CONTENT` BELOW, NOT THIS LIST: the list only becomes a control once
 * something fails to compile when the two overlap.
 */
export const PII_OR_CONTENT_KEYS = [
  'answer',
  'address',
  'comment',
  'content',
  'cookie',
  'deviceId',
  'email',
  'feedback',
  // THE COMPOUNDS ARE LISTED IN FULL, AND THAT IS NOT REDUNDANCY.
  //
  // `Exclude` matches WHOLE NAMES. `student` on its own forbids a key called `student` and does nothing about
  // `studentEmail`, `studentName`, `guardianEmail` or `pupilEmail` — which are the four names anybody actually writes. A
  // substring rule would catch all four and would also forbid `studentWarned`, a legitimate key `clockGuard.ts` writes
  // (a `true`/`false` about whether the student was shown a warning, which names nobody), so a substring rule is not
  // available and the compounds have to be enumerated.
  //
  // **`scripts/audit-payloads.mjs` keeps its own copy of this list on purpose** — a gate that imports the list it is
  // auditing cannot catch the list being widened — and `evidence-detail.test.ts` asserts both that the two do not overlap
  // and that this list still CONTAINS these names.
  'guardianEmail',
  'ip',
  'key',
  'name',
  'password',
  'phone',
  'pupilEmail',
  'response',
  'secret',
  'session',
  'sessionId',
  'student',
  'studentEmail',
  'studentName',
  'submission',
  'text',
  'token',
  'user',
  'userAgent',
] as const;

type PiiOrContentKey = (typeof PII_OR_CONTENT_KEYS)[number];

/**
 * THE SAME TUPLE, TYPED SO THAT ADDING A FORBIDDEN KEY IS A COMPILE ERROR RATHER THAN A REVIEW CATCH.
 *
 * **`Exclude` is the whole mechanism.** `Exclude<EvidenceDetailKey, PiiOrContentKey>` collapses to `never` the moment
 * one key is in both sets, and a `readonly` tuple is not assignable to `readonly never[]` — so the intersection on the
 * left stops accepting `EVIDENCE_DETAIL_KEYS` and the build fails. Proven rather than asserted: with
 * `studentEmail` added to `EVIDENCE_DETAIL_KEYS` the compiler reports
 * `Type 'readonly [...]' is not assignable to type 'readonly never[]'`, and with it absent it is silent.
 *
 * Exported, and that is not tidiness: a module-scope `const` nothing reads is a lint error, and a lint error is a
 * `// biome-ignore` by next Tuesday. The name says what reading it proves.
 */
export const EVIDENCE_DETAIL_KEYS_NO_CONTENT: readonly EvidenceDetailKey[] &
  readonly Exclude<EvidenceDetailKey, PiiOrContentKey>[] = EVIDENCE_DETAIL_KEYS;

/**
 * THE SAME LIST AS A SET, FOR THE RUNTIME CHECK.
 *
 * Derived from the tuple rather than written out again: a second list of twenty keys is a list that will differ from the
 * first one, and the failure mode is the gate passing against a key the type forbids.
 */
const EVIDENCE_DETAIL_KEY_SET: ReadonlySet<string> = new Set<string>(EVIDENCE_DETAIL_KEYS);

/** Is this key one of the twenty? The runtime half of `EvidenceDetailKey`. */
export const isEvidenceDetailKey = (key: string): key is EvidenceDetailKey =>
  EVIDENCE_DETAIL_KEY_SET.has(key);

/**
 * IS THIS A VALUE `detail` MAY CARRY? A primitive, and `null` because "not known" has to be expressible.
 *
 * `undefined` is refused deliberately, even though `canonicalJson` drops it. Dropping it here instead would mean an
 * event whose detail reads `{"reason": undefined}` is stored as `{"reason": null}` by one path and as `{}` by another, and
 * a canonical form with two spellings of one event is the `ADV-E2` defect one level up.
 */
export const isEvidenceDetailValue = (value: unknown): value is EvidenceDetailValue =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

export interface EvidenceRecord {
  readonly seq: number;
  readonly type: EvidenceType;
  readonly at: Millis;
  /** Closed: one of `EVIDENCE_DETAIL_KEYS`, or absent. Never an answer, never a score, never a key we have not read. */
  readonly detail?: EvidenceDetail;
}

/**
 * WHAT ARRIVES FROM A PEER — WHICH IS NOT WHAT OUR WRITER PRODUCES, AND THE DISTINCTION IS THE POINT.
 *
 * `EvidenceRecord` is closed because we build it. `canonicalJson`, `canonicalEvent` and `batchSigningInput` are **total
 * functions over hostile bytes** and must stay that way: a canonicaliser that rejected an unrecognised `detail` key
 * would refuse to reproduce the signature of a batch carrying exactly the key an attacker added, and a verifier that
 * cannot canonicalise a forged batch cannot report that it forged one.
 *
 * So the closed schema is enforced where a batch is *accepted* — the ingestion route `plans/09` §7 specifies and
 * `packages/db` will own — and the signing path stays total. `forged-events.test.ts:389` pins this: it canonicalises
 * `{ detail: { a: 1, b: 2 } }`, keys no allowlist would permit, because the property under test is that the canonical
 * form does not depend on the shape it is handed. Closing `EvidenceRecord.detail` and closing the wire shape are two
 * different decisions about two different jobs.
 */
export interface WireEvidenceRecord {
  readonly seq: number;
  /** Deliberately `string` and not `EvidenceType`: an unrecognised type is the verifier's finding, not a compile error. */
  readonly type: string;
  readonly at: number;
  readonly detail?: Record<string, unknown>;
}

/**
 * CANONICAL JSON: keys sorted AT EVERY DEPTH, `undefined` dropped, and nothing else changed.
 *
 * ## IT WALKS THE VALUE BECAUSE SORTING ONE LEVEL IS HOW `ADV-E2` HAPPENED
 *
 * `canonicalEvent` sorted the event's own keys and then handed `detail` to `JSON.stringify` as it found it, so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` signed differently under a comment promising the opposite. Sorting `detail` by
 * name as well would have left the same bug one level further down, which is what a hand-written list of levels does:
 * `freezePolicy` froze `thresholds` by name and left `availabilityWindow` mutable in exactly this way.
 *
 * It bites the moment a server derives the bytes from anything but the raw request body. Postgres `jsonb` does not
 * preserve key order, so an event stored and read back canonicalised differently and a GENUINE batch failed
 * verification -- a timeline flagged as tampered with when nobody touched it.
 *
 * ## AND THE KEYS ARE QUOTED, WHICH THEY WERE NOT
 *
 * The form was `{key:value,...}` with bare keys. `detail` is free-form, so its keys are whatever the sender chose:
 * `{ a: 1, b: 2 }` and `{ 'a:1,b': 2 }` both came out as `a:1,b:2`. Real JSON has no such pair, and it is also the form
 * a verifier in any other language can reproduce without reading this file.
 *
 * Keys compare by UTF-16 code unit, not by locale: a collation that differs between a phone and a server is a
 * signature that differs between them.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    // An array's order is its meaning, so it is kept. A hole is `null`, as `JSON.stringify` has it.
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      // Dropped rather than serialised: `JSON.stringify` drops it anyway, and two implementations that disagree about
      // whether a key exists produce two signatures for one batch.
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`);
    return `{${entries.join(',')}}`;
  }
  // `?? null`, not a bare `stringify`: an explicit `null` is recorded as `null`, which is a different fact from a key
  // that is absent, and `stringify` answers `undefined` for a value JSON cannot hold.
  return JSON.stringify(value ?? null) ?? 'null';
};

/**
 * AN EVENT'S CANONICAL FORM, and it is canonical for a reason a reviewer will ask about.
 *
 * A signature computed on a phone has to match one computed on a server, from the same event however either side
 * happened to build the object. See `canonicalJson` for what that requires and what it used to miss.
 *
 * **`WireEvidenceRecord`, not `EvidenceRecord`, and that is the `TM-20` boundary.** See `WireEvidenceRecord`: this
 * function must canonicalise a batch it did not author, including one carrying a key the closed set forbids, because
 * refusing to canonicalise a forgery is how a forgery gets stored unexamined.
 */
export const canonicalEvent = (event: WireEvidenceRecord): string => canonicalJson(event);

/** What gets signed: the attempt, the sequence range, and every event in order. */
export interface SignedBatch {
  readonly attemptId: string;
  readonly tabId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** The wire shape, because a batch's events are whatever arrived rather than whatever we typed. */
  readonly events: readonly WireEvidenceRecord[];
  /** Hex HMAC over the canonical form, with domain separation. See `signBatch`'s caller for the key. */
  readonly signature: string;
}

/**
 * THE SIGNATURE INPUT.
 *
 * Returned separately from the signing so it can be tested on its own: the exact bytes that were signed are the thing a
 * dispute is about, and "the signature verified" is not evidence that the right thing was signed.
 *
 * `attemptId` and the sequence range are INSIDE the signed material, not merely alongside it. Without them a valid
 * signature could be replayed onto a different attempt or extended to cover events the signer never saw, and the whole
 * point of signing is that the server can tell a client's account from a client's invention.
 *
 * The `v1` tag is DOMAIN SEPARATION. The HMACs elsewhere in this repository all use `orrery.<purpose>.v1` with NUL
 * separators, and reusing a key across purposes without a tag lets a signature obtained for one thing be presented as a
 * signature for another.
 *
 * The separators are written as the ESCAPE `\u0000`, never as a literal byte: PF-4 records that a literal NUL in
 * source is a defect, because it is invisible in every diff and every editor.
 *
 * ## THE TWO IDS ARE JSON STRINGS, BECAUSE A SEPARATOR INSIDE A FIELD MOVES THE FIELD  (`ADV-E3`)
 *
 * They were joined raw. Attempt `a` with tab `b<NUL>c` then signed the same bytes as attempt `a<NUL>b` with tab `c`,
 * so a signature for one pair was a signature for the other. The attempt id is server-issued and will not contain a
 * NUL; **the tab id is chosen by the client and nothing constrains it.**
 *
 * `JSON.stringify` escapes every control character, so neither id can contain the separator once encoded. The two seq
 * fields are digits and the body is last, so the first five separators are always the real ones and the input decodes
 * to exactly one `(attemptId, tabId, first, last, body)`. Length prefixes would do the same and were not used only
 * because the range is read back out of fields 3 and 4 by position (`forged-events.test.ts`).
 *
 * This changes the signed bytes for EVERY batch (each id gains quotes), not only the hostile ones, and the tag is
 * still `v1`. That was safe while nothing in this repository verified an evidence signature, so there was no stored
 * signature and no deployed verifier to disagree with.
 *
 * ## AND NOW A VERIFIER EXISTS, SO THE `v1` TAG IS PINNED FOR A DIFFERENT REASON (`TM-17`)
 *
 * `verifyEvidenceBatch` above calls THIS function, so the two cannot drift — which was the instruction the old comment
 * gave ("the first verifier must be written against this function, not against a description of it"), and it has been
 * followed. **What has changed is that the bytes are now load-bearing in two directions:** any stored batch signed under
 * the pre-`ADV-E3` form (raw ids, no quotes) will now verify as `SIGNATURE_MISMATCH`, and a stored signature under the
 * current form will not verify against a signer built before `ADV-E3`. That is the correct outcome — a batch signed over a
 * format where a NUL inside a client-chosen tab id moved the field boundary is a batch whose signature can be forged by
 * moving a boundary — but it means **a deployment that stored evidence signed under the old form must re-sign or
 * discard it, and the tag does not say which form was in force.** Keeping `v1` was the right call for the reason above
 * (no stored signature existed, so nothing was invalidated); had the tag been bumped to `v2` there would be no way to tell
 * a `v2` batch from a `v1` one, because the tag is inside the signed material and is not stored beside it.
 */
export const batchSigningInput = (input: {
  readonly attemptId: string;
  readonly tabId: string;
  readonly events: readonly WireEvidenceRecord[];
}): string => {
  const first = input.events[0]?.seq ?? 0;
  const last = input.events[input.events.length - 1]?.seq ?? 0;
  const body = input.events.map(canonicalEvent).join('\n');
  return [
    'orrery.evidence.v1',
    JSON.stringify(input.attemptId),
    JSON.stringify(input.tabId),
    String(first),
    String(last),
    body,
  ].join('\u0000');
};

/**
 * WHY A SIGNATURE IS HERE AT ALL, IN ONE PARAGRAPH, AND IT IS NOT "TO TRUST THE EVIDENCE".
 *
 * The key is the STUDENT'S. `EvidenceBatcher` is constructed with a `sign` function the client supplies, so a valid
 * signature says *"these exact bytes were produced by somebody holding this session's key"* — which is a statement about
 * ISSUANCE, and it is what lets a server tell a client's **account** from a client's **invention**. It says nothing about
 * whether the events are true: a student can sign a perfectly valid batch of complete fabrications, and no verifier can
 * do better, because the thing a verifier would need to know — what actually happened on the student's screen — is not in
 * the payload. **`evidence-verify.test.ts` asserts this by verifying a batch of invented evidence and expecting
 * `ok: true`**, because a limit asserted only in a comment is a limit that gets lost.
 *
 * `ADR-0017` is why that is the right limit rather than a disappointing one: telemetry is evidence for a human, and
 * `plans/09` refuses to claim a false-positive rate as accuracy. A verifier that also judged plausibility would have to
 * invent a threshold nobody agreed to, and would be the first thing in the repository to report its own accuracy.
 */

/**
 * WHY A STORED BATCH IS NOT ACCEPTABLE. Named, for the reason `SignatureVerdict` in
 * `packages/contracts/src/grading/receipt.ts` is named: "does not match" is the answer that sends a teacher through a whole
 * paper, and a verdict that collapses every failure to one reason is a verdict nobody can act on.
 */
export type EvidenceSignatureVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: /** No key was available, so nothing was checked. A REFUSAL, never a pass — see `verifyReceiptSignature`. */
        | 'NO_KEY'
        /** No signature arrived at all. */
        | 'NOT_SIGNED'
        /** A signature arrived that is not a hex SHA-256 digest, so it cannot be compared to one. */
        | 'MALFORMED_SIGNATURE'
        /** The recomputed signature differs. The forgery case. */
        | 'SIGNATURE_MISMATCH'
        /**
         * `fromSeq`/`toSeq` contradict the events they claim to cover.
         *
         * NOT a fifth flavour of mismatch, and it is checked BEFORE the signature for that reason. Both fields are inside
         * the signed material, so a contradicted range fails the signature check too — the separate reason is not extra
         * strictness, it is a distinct FAULT: `report-integrity.ts` rebuilds a timeline out of `fromSeq`/`toSeq`, so a
         * batch that describes a range it does not cover is a coverage claim nothing else in the system would catch.
         */
        | 'RANGE_MISMATCH';
    };

/** What a caller supplies: the batch as it ARRIVED, and a function producing the hex HMAC. `null` means "no key". */
export interface VerifyEvidenceInput {
  readonly attemptId: string;
  readonly tabId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly events: readonly WireEvidenceRecord[];
  readonly signature: string;
}

/** A hex SHA-256 digest. Anything else is `MALFORMED_SIGNATURE` rather than a mismatch somebody has to explain. */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * IS THIS BATCH THE ONE THAT WAS SIGNED?  (`TM-17`; the verifier used to be three lines in a test file)
 *
 * ## WHAT IT ESTABLISHES
 *
 * **These bytes are unaltered since they were signed by the holder of this key.** Edit, trim, reorder, extend, replay onto
 * another attempt, replay onto another tab, edit a `detail` value — each changes the canonical form, each changes the HMAC,
 * each is refused. `evidence-verify.test.ts` pins all six.
 *
 * ## WHAT IT DOES NOT ESTABLISH
 *
 * **That the evidence is true.** The key is the student's, so a student can sign a perfectly valid batch of complete
 * fabrications, and no verifier can do better — see the paragraph above `EvidenceSignatureVerdict`.
 *
 * It also does not establish that the event types are legal or that the `detail` keys are on the allowlist. Those are the
 * ingestion route's closed-schema check (`plans/09` §7), they need a different response from whoever is on call, and
 * folding them in here would report a schema error as `SIGNATURE_MISMATCH`.
 *
 * ## THE MAC IS INJECTED AND `node:crypto` IS DELIBERATELY NOT IMPORTED
 *
 * This module is loaded by `apps/web` — the batcher runs in a browser — and a module-scope `import 'node:crypto'` would
 * break that bundle for a check only a server ever performs. The signature arrives as `(input: string) => string`, exactly
 * as `EvidenceBatcher` receives its `sign` and exactly as `verifyReceiptSignature` in
 * `packages/contracts/src/grading/receipt.ts` receives its `Mac`.
 *
 * ## AND THE RANGE IS CHECKED BEFORE THE SIGNATURE IS COMPARED
 *
 * `batchSigningInput` re-derives the range from the events and never reads `fromSeq`/`toSeq`, so the signature check alone
 * would catch a contradicted range as a generic mismatch. It is checked first and named separately so the caller can tell
 * "this transport is describing its batches wrongly" from "this batch was forged", which are different incidents.
 */
export const verifyEvidenceBatch = (
  presented: VerifyEvidenceInput,
  sign: ((input: string) => string) | null,
): EvidenceSignatureVerdict => {
  if (sign === null) return { ok: false, reason: 'NO_KEY' };
  if (presented.signature.length === 0) return { ok: false, reason: 'NOT_SIGNED' };
  // BEFORE `sign` is called, so a transport sending garbage cannot make the key do work on its behalf.
  if (!HEX_SHA256.test(presented.signature)) return { ok: false, reason: 'MALFORMED_SIGNATURE' };

  const first = presented.events[0]?.seq ?? 0;
  const last = presented.events[presented.events.length - 1]?.seq ?? 0;
  if (presented.fromSeq !== first || presented.toSeq !== last) {
    return { ok: false, reason: 'RANGE_MISMATCH' };
  }

  const expected = sign(batchSigningInput(presented));
  // A length mismatch is not secret — a digest's length is not a secret — so it is an ordinary mismatch.
  if (expected.length !== presented.signature.length)
    return { ok: false, reason: 'SIGNATURE_MISMATCH' };

  /**
   * CONSTANT-TIME COMPARISON, COPIED FROM `verifyReceiptSignature` RATHER THAN INVENTED HERE.
   *
   * A byte-by-byte `===` on a MAC returns at the first difference, so a forger learns the length of the matching prefix and
   * improves a forgery one byte at a time. This accumulates a difference over EVERY position and branches once at the end,
   * so the time taken does not depend on where the first mismatch falls. Two hand-written copies is two chances to write
   * the `===` version by accident, which is why this one names its original.
   *
   * `charCodeAt` rather than `Buffer`, because `Buffer` is a Node global and this module is browser-loaded. Both sides are
   * lowercase hex, so the comparison is over ASCII code units and the encoding question does not arise.
   */
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= presented.signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: 'SIGNATURE_MISMATCH' };
};

/**
 * HOW EVENTS ARE DELIVERED. Injected: this module does not own transport, and P7's outbox owns answer saves, which are a
 * DIFFERENT pipeline with different loss guarantees.
 *
 * ## IT TAKES THE WHOLE `SignedBatch`, AND IT USED TO BE FORBIDDEN FROM SEEING THE SIGNATURE  (`ADV-E4`)
 *
 * This was `Omit<SignedBatch, 'signature'>`. `flushOnce` signed the batch and then passed every field EXCEPT the
 * signature, and `flushOnUnload` did not sign at all. The type is what made that invisible: a transport could not have
 * forwarded the signature if it had wanted to.
 *
 * **That half is fixed and the verifier exists — `verifyEvidenceBatch`, above — and this paragraph used to describe the
 * bug as though it were still present**, which is how a fixed bug gets "re-fixed". `TM-17` recorded both this comment and
 * `adversarial/forged-events.test.ts:408-411` as stale; the second is still stale and is listed in the task report,
 * because that file is outside the lane that fixed this one. `forged-events.test.ts:420` already asserts the signature
 * IS handed over, so the code and its own test disagreed with this comment for longer than the comment claimed.
 *
 * A transport written against the old type still fits -- a function that ignores a field accepts a value that has it.
 * That is deliberate, because it keeps every existing transport compiling, and it is also the limit: **this hands the
 * signature over and cannot make a transport send it.** A `verifyEvidenceBatch` that is never called verifies nothing,
 * and where it is called from is `P14-T14`'s ingestion route, which does not exist yet.
 */
export type BatchTransport = (batch: SignedBatch) => Promise<boolean>;

export interface BatcherOptions {
  /** Events per signature. Small enough that a lost batch loses little. */
  readonly batchSize: number;
  /**
   * The queue ceiling, and what happens at it is the important part.
   *
   * `plans/09` §7: "`sendBeacon` is fire-and-forget and may be lost: **telemetry may be incomplete, and that is
   * acceptable.**" So an overflowing queue DROPS the oldest telemetry and counts the loss, rather than growing without
   * bound during a three-hour exam or blocking the exam to preserve it.
   *
   * Answer SAVES are not in this queue and are never dropped here -- they are the outbox's job, and dropping a save
   * because telemetry filled up would be a catastrophic misplacement of priorities.
   */
  readonly maxQueued: number;
  readonly transport: BatchTransport;
}

export interface BatcherStats {
  readonly queued: number;
  readonly sent: number;
  /** Events dropped because the queue was full. Reported, never hidden: a timeline with holes should say so. */
  readonly dropped: number;
  readonly batchesFailed: number;
}

export class EvidenceBatcher {
  #queue: EvidenceRecord[] = [];
  #seq = 0;
  #dropped = 0;
  #sent = 0;
  #failed = 0;

  constructor(
    private readonly options: BatcherOptions,
    private readonly clock: { now(): number },
    private readonly attemptId: string,
    private readonly tabId: string,
    /** Injected so a test can sign deterministically; production passes an HMAC over `batchSigningInput`. */
    private readonly sign: (input: string) => string,
  ) {}

  /**
   * RECORD AN EVENT, OR REFUSE IT.
   *
   * Returns whether it was accepted. **Two refusals are possible and both are unconditional**: a server-only type, and a
   * `detail` outside the closed key set.
   */
  record(type: EvidenceType, detail?: EvidenceRecord['detail']): boolean {
    if (SERVER_ONLY_EVENTS.has(type)) {
      // A client that emitted its own escalation would be announcing a threshold breach on evidence a teacher has not
      // seen, and the ladder would act on the client's count.
      return false;
    }

    /**
     * THE RUNTIME HALF OF THE CLOSED KEY SET, and the type cannot be the whole answer.
     *
     * `EvidenceDetail` stops a fresh object LITERAL. It stops nothing that arrives already typed as
     * `Record<string, unknown>` — a spread of a wider object, a `JSON.parse`, a value from a `zod`-parsed body whose
     * schema is `passthrough()`. Every one of those is a normal thing for a telemetry writer to be handed, and every one
     * of them is a way to put `studentEmail` into a row retained for 400 days while the compiler watches.
     *
     * **REFUSED, NOT THROWN, and the reason is the exam.** `record()` is called from browser event handlers and from a
     * `pagehide` flush, where a throw costs a student their sitting. Telemetry is explicitly allowed to be incomplete
     * (`plans/09` §7), so an unrepresentable `detail` is dropped and the caller learns it was dropped from the `false`.
     * The loud place for this failure is the compiler, which is where it is: adding an illegal key is a build break,
     * and a build break is a thing somebody cannot ship past.
     */
    if (detail !== undefined) {
      for (const [key, value] of Object.entries(detail)) {
        if (!isEvidenceDetailKey(key) || !isEvidenceDetailValue(value)) return false;
      }
    }

    const event: EvidenceRecord = {
      seq: this.#seq,
      type,
      at: this.clock.now(),
      ...(detail === undefined ? {} : { detail }),
    };
    this.#seq += 1;

    if (this.#queue.length >= this.options.maxQueued) {
      // Drop the OLDEST, not the newest: a queue that sheds recent events loses the ones a teacher is currently looking
      // at, and the oldest are least likely to matter to the incident being reviewed.
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(event);
    return true;
  }

  /** Take up to `batchSize` events, leaving the rest queued. Returns an empty array when there is nothing to send. */
  takeBatch(): EvidenceRecord[] {
    return this.#queue.splice(0, this.options.batchSize);
  }

  /** Sign a batch without sending it, which is what the unload path needs. */
  signBatch(events: readonly EvidenceRecord[]): SignedBatch {
    const unsigned = {
      attemptId: this.attemptId,
      tabId: this.tabId,
      fromSeq: events[0]?.seq ?? 0,
      toSeq: events[events.length - 1]?.seq ?? 0,
      events,
    };
    return { ...unsigned, signature: this.sign(batchSigningInput(unsigned)) };
  }

  /**
   * SEND ONE BATCH. Returns whether it was accepted, and counts a failure rather than throwing.
   *
   * Telemetry is allowed to be lost, so a failed send is not an error the exam should surface. It is counted, and the
   * caller can surface the count in a diagnostic without interrupting a student.
   *
   * The SIGNING is inside the `try` as well. It sat above it, so a signer that threw -- a key that failed to import --
   * rejected out of a function whose one promise is that it does not.
   */
  async flushOnce(): Promise<boolean> {
    const events = this.takeBatch();
    if (events.length === 0) return true;
    try {
      const ok = await this.options.transport(this.signBatch(events));
      if (ok) this.#sent += events.length;
      else this.#failed += 1;
      return ok;
    } catch {
      this.#failed += 1;
      return false;
    }
  }

  /**
   * THE UNLOAD PATH, and it does NOT await.
   *
   * A `pagehide` handler that awaits has already lost the race: the document is going away. `plans/09` §7's position is
   * that telemetry may be lost, so this fires and returns.
   *
   * ## AND IT DOES NOT THROW, WHICH IT DID  (`ADV-N1`)
   *
   * `flushOnce` wrapped the transport in `try/catch` and this called it bare. A transport that throws synchronously --
   * `sendBeacon` on a detached document, a serialiser choking on a payload -- threw out of the `pagehide` handler.
   * `pagehide` is where the ANSWER outbox gets its last flush too (`lifecycleGuard`), so a handler that flushes
   * telemetry first and answers second lost the answer flush to a telemetry failure: the one priority inversion
   * `shedding.ts` exists to forbid.
   *
   * A transport that REJECTS is the same hazard one tick later, as an unhandled rejection, so the promise is caught
   * too. `Promise.resolve` because a `sendBeacon` wrapper returns a bare boolean whatever its type says, and calling
   * `.catch` on `true` would be this method throwing after all.
   *
   * ## WHAT IS COUNTED HERE, AND WHAT STILL CANNOT BE
   *
   * A throw or a rejection is a failure this path KNOWS about, so it is counted like any other failed batch. A beacon
   * that was accepted for sending and never arrived is not knowable from here, and neither is a transport that resolves
   * `false` after the page has gone -- so a resolved promise counts nothing, sent or failed, exactly as before. `seq`
   * holes, not these counters, are still what `droppedEventCount` has to be computed from.
   *
   * It signs, which it did not (`ADV-E4`): the last batch of a sitting is the one most likely to hold the event a
   * teacher is asked about, and it was the one batch no server could have verified.
   */
  flushOnUnload(): void {
    const events = this.takeBatch();
    if (events.length === 0) return;
    try {
      void Promise.resolve(this.options.transport(this.signBatch(events))).catch(() => {
        this.#failed += 1;
      });
    } catch {
      this.#failed += 1;
    }
  }

  get stats(): BatcherStats {
    return {
      queued: this.#queue.length,
      sent: this.#sent,
      dropped: this.#dropped,
      batchesFailed: this.#failed,
    };
  }
}
