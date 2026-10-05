#!/usr/bin/env node
/**
 * ANSWER-KEY AND TELEMETRY PAYLOAD GATE — `INV-Q-1` and `INV-TELEMETRY-2`.  (P14-T16)
 *
 * > `INV-Q-1`: answer keys never leave the server.  `INV-TELEMETRY-2`: telemetry carries no content and no PII.
 * > (`plans/01` §9, `plans/18` §4.1)
 *
 * ## THIS SCRIPT EXISTED ONLY AS A STRING IN A JSON FILE UNTIL NOW (`TM-15`)
 *
 * `plans/invariants.json:103` and `:167` both named `audit:payloads` as a control. There was no such script, and
 * `scripts/invariant-registry.mjs` checks gate existence only inside its `status === 'active'` branch (`:87-107`), so two
 * STAGED invariants naming a gate that does not exist reported green. **This is the repo's own `D-31`/`D-35` failure mode
 * reproduced inside the mechanism built to prevent it**, and it is the whole reason this file opens by saying what it
 * used to be.
 *
 * ## AND IT IS NOT `audit:seals`, WHICH IS THE GATE NEXT TO IT IN THE SAME CI JOB
 *
 * `audit-seals.mjs` audits `SCORE_BEARING_KEYS` — twenty-three NAMES — in sealed GRADE payloads. `INV-RELEASE-2` is about
 * a mark being *inferable* before release. Neither of the two invariants above is about that, and the overlap is one
 * name: `answerKey`, `correctAnswer` and `modelAnswer` appear in both lists.
 *
 * **So what is checked here that is not checked there, stated concretely because "broader audit" is not a scope:**
 *
 *  · THE KEY IS CALLED `key`. Every keyed question type in `packages/contracts/src/question/index.ts` spells it `key` —
 *    `{ key: { choiceId: 'a' } }`, `{ key: { text: 'answer' } }`, `steps[].key`. `SCORE_BEARING_KEYS` does **not** contain
 *    `key`, so a projection that accidentally spread the whole spec would carry the answer key in a field
 *    `findScoreBearingKeys` reports as clean. `audit:seals` returns no violation for it. This script fails.
 *  · The `rubric` of a `free_response` and its `conceptHints`: the marking scheme and which concepts the answer must
 *    contain. `SCORE_BEARING_KEYS` has `rubricScore`, not `rubric`.
 *  · Telemetry at all. `audit:seals` never opens an evidence record.
 *
 * ## THE CORPUS IS THE OUTPUT OF THE REAL PROJECTIONS, BUILT FROM SPECS CARRYING CANARIES
 *
 * Following `audit-seals.mjs`'s rule — the corpus is the OUTPUT of the functions that produce payloads, never a JSON
 * fixture, because a gate that cannot find its subject has lost it and passes for ever. The addition here is that the
 * specs are built with **key material that is a recognisable canary**, so the audit is not restricted to key NAMES:
 *
 *  · `KEY_NAME_HIT` walks the projection for a forbidden field name.
 *  · `KEY_VALUE_HIT` walks it for the canary VALUE, at any depth, including as a substring of a longer string — because a
 *    key inlined into a sentence is still the key, and a name-only walk cannot see that.
 *
 * **AND THE TEACHER PROJECTION IS AUDITED AS A POSITIVE CONTROL, which is the part that stops the gate being vacuous.**
 * If `teacherQuestionSpec` did not carry the canary, then "the public projection does not carry it" would be true of a
 * spec that had no key material to leak, and this gate would be auditing nothing while reporting success. The first
 * version of this script did exactly that and the self-check is what caught it — which is `audit-seals.mjs`'s own note
 * about a projection that THREW rather than being quietly skipped, applied to a projection that was silently empty.
 *
 * ## A FLOOR, BECAUSE A GATE THAT AUDITS NOTHING MUST NOT BE ABLE TO PASS
 *
 * `audited === 0` prints that it has no subject and fails. The floor is `QUESTION_TYPES.length + 4` — one public
 * projection per type, plus one teacher positive control per type, plus a sealed grade and a release view — so a question
 * type added without a representative spec, or a student-facing payload added without joining this corpus, is a failure
 * here rather than a silent omission.
 */

import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A REAL hex HMAC-SHA256, because `verifyEvidenceBatch` refuses anything that is not one. See the block below. */
const payloadHmac = (input) =>
  createHmac('sha256', 'audit-payloads-corpus-key').update(input).digest('hex');

const load = async (relative) => import(pathToFileURL(join(root, relative)).href);

const contracts = await load('packages/contracts/dist/question/index.js');
const { QUESTION_TYPES, publicQuestionSpec, teacherQuestionSpec } = contracts;
const interop = await load('packages/interop/dist/boundary.js');
const { buildStudentGrade, findScoreBearingKeys } = interop;
const evidence = await load('packages/exam-engine/dist/evidence.js');
const { EVIDENCE_DETAIL_KEYS, EvidenceBatcher, isEvidenceDetailKey, verifyEvidenceBatch } =
  evidence;

const failures = [];
const fail = (m) => failures.push(m);

/**
 * THE FORBIDDEN KEY NAMES, and why each is here rather than being left to `SCORE_BEARING_KEYS`.
 *
 * `key` is the important one and the reason this script is not a duplicate of `audit:seals`: it is the field name every
 * keyed question type in this repository uses, and `SCORE_BEARING_KEYS` does not contain it.
 */
const KEY_NAME_HIT = new Set([
  'key',
  'answerKey',
  'correctAnswer',
  'modelAnswer',
  'rubric',
  'conceptHints',
  'solution',
  'rationale',
  'explanation',
]);

/** Walk a projection for a forbidden key NAME, at any depth. */
const findForbiddenKeys = (value, path = '$', out = []) => {
  if (Array.isArray(value)) {
    // A BLOCK body, not a concise arrow returning the recursive call: `boundary.ts:158-160` records this as the shape
    // that makes a reader wonder whether the walk is short-circuiting, and `useIterableCallbackReturn` agrees.
    value.forEach((element, i) => {
      findForbiddenKeys(element, `${path}[${String(i)}]`, out);
    });
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (KEY_NAME_HIT.has(key)) out.push(`${here} (${key})`);
    findForbiddenKeys(child, here, out);
  }
  return out;
};

/**
 * Walk a projection for a canary VALUE, at any depth, as an exact match OR as a substring of a longer string.
 *
 * The substring half is not defensive. An answer key that reaches a payload inside a sentence — `"the answer is purple"`,
 * a rationale, a step prompt — is the leak, and a name-based walk reports it clean because every key in it is innocuous.
 * Numbers are compared by `String()`, so a numeric key cannot hide either.
 */
const findCanaryValues = (value, canaries, path = '$', out = []) => {
  if (typeof value === 'string') {
    for (const canary of canaries) {
      if (value.includes(canary)) out.push(`${path} carries the canary ${JSON.stringify(canary)}`);
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const asText = String(value);
    for (const canary of canaries) {
      if (canary !== 'true' && canary !== 'false' && asText === canary) {
        out.push(`${path} carries the canary ${JSON.stringify(canary)}`);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((element, i) => {
      findCanaryValues(element, canaries, `${path}[${String(i)}]`, out);
    });
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      findCanaryValues(child, canaries, `${path}.${key}`, out);
  }
  return out;
};

/**
 * ONE SPEC PER TYPE, WITH ITS KEY MATERIAL REPLACED BY A CANARY.
 *
 * The canary values are deliberately nonsense — `CANARY-KEY-single_choice` rather than `a` — because a spec whose key is
 * `a` is indistinguishable from a choice id that legitimately appears in the payload. A gate that cannot tell the key
 * from the options cannot report a key that leaked.
 */
const CANARY = (type) => `CANARY-KEY-${type}-7f3a9c`;
const specFor = (type) => {
  const common = {
    id: `audit-${type}`,
    points: 4,
    gradingMode: 'AUTO',
    shuffleOptions: false,
    estimatedSeconds: 60,
    cognitiveDemand: 'APPLY',
    tags: [],
    // The model answer is teacher-only and is a canary too: `QuestionCommon.modelAnswer` is stripped by the public
    // projection, and a gate that did not check it would not notice if that stopped being true.
    modelAnswer: `CANARY-MODEL-ANSWER-${type}-2b8e1d`,
  };
  switch (type) {
    case 'single_choice':
      return {
        ...common,
        type,
        choices: [{ id: 'a', text: 'A' }],
        key: { choiceId: CANARY(type) },
      };
    case 'multi_select':
      return {
        ...common,
        type,
        choices: [{ id: 'a', text: 'A' }],
        key: { choiceIds: [CANARY(type)] },
        partialCredit: 'NC',
      };
    case 'true_false':
      // `true_false`'s key IS a boolean, so it cannot carry a string canary. The forbidden-NAME walk covers this type —
      // a `key` field present at all is the finding — and `numeric` below covers the numeric case.
      return { ...common, type, key: { value: true } };
    case 'numeric':
      return {
        ...common,
        type,
        key: { value: 987654321 },
        tolerance: { absolute: 0.1 },
        acceptExpression: true,
      };
    case 'short_text':
      return { ...common, type, key: { text: CANARY(type) }, matcher: 'EXACT' };
    case 'ordering':
      return {
        ...common,
        type,
        items: [{ id: 'i1', text: 'one' }],
        key: { itemIds: [CANARY(type)] },
      };
    case 'free_response':
      return {
        ...common,
        type,
        rubric: [{ points: 4, descriptor: `CANARY-RUBRIC-${type}-4d7e0a` }],
        conceptHints: [`CANARY-HINT-${type}-5c1b8f`],
      };
    case 'file_submission':
      return { ...common, type, allow: ['application/pdf'], maxBytes: 1_000_000, maxFiles: 3 };
    case 'simulation':
      return {
        ...common,
        type,
        simId: 'mechanics.newtons-cradle',
        simVersion: '1.0.0',
        params: { g: 9.81 },
        scoringSurface: 'ENDPOINT_ONLY',
      };
    case 'worked_solution':
      /**
       * THE PROMPT IS AN ORDINARY STRING, AND THAT IS A CORRECTION THIS GATE MADE TO ITSELF.
       *
       * The first version planted a canary in `steps[0].prompt` and this gate failed on it — correctly. `prompt` is the
       * question the student is shown; only `steps[].key` is teacher-only (`publicQuestionSpec` rebuilds each step
       * rather than spreading it, `packages/contracts/src/question/index.ts:458-462`). A gate that failed here would be
       * a gate that pushes somebody to strip the questions, so the corpus was wrong rather than the projection.
       *
       * Worth recording that the first version was not wrong by accident: it assumed every string in a keyed spec is key
       * material, which is the same mistake in miniature as trusting a docstring.
       */
      return {
        ...common,
        type,
        steps: [
          { id: 's1', prompt: 'Show the first step', points: 4, key: { text: CANARY(type) } },
        ],
      };
    default:
      throw new Error(`audit-payloads: no representative spec for type ${type}`);
  }
};

/** Every canary a type's key material is made of, in the forms a walker should compare. */
const canariesFor = (type) => [
  CANARY(type),
  `CANARY-MODEL-ANSWER-${type}-2b8e1d`,
  `CANARY-RUBRIC-${type}-4d7e0a`,
  `CANARY-HINT-${type}-5c1b8f`,
  // `numeric`'s key is a NUMBER, and a numeric canary is the only way the by-VALUE walk can see that type at all — the
  // forbidden-NAME walk would catch a leaked `key` field, but not a key whose value was promoted to, say, `answer: 987654321`.
  '987654321',
];

let audited = 0;
let positiveControls = 0;

// ── INV-Q-1: the student projection of every question type ──────────────────────────────────
for (const type of QUESTION_TYPES) {
  let spec;
  try {
    spec = specFor(type);
  } catch (error) {
    fail(`specFor(${type}) threw: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  /**
   * THE POSITIVE CONTROL, RUN FIRST AND BEFORE THE PROJECTION IS AUDITED.
   *
   * If `teacherQuestionSpec` does not carry the canaries then this spec has no key material, every assertion below is
   * vacuously true, and the gate would report a clean corpus it never examined. A self-check that runs after the audit
   * reports the same thing with more confidence.
   */
  const teacher = teacherQuestionSpec(spec);
  const teacherCanaries = findCanaryValues(teacher, canariesFor(type));
  const canaryPresent = teacherCanaries.length > 0 || JSON.stringify(teacher).includes('key');
  if (!canaryPresent) {
    fail(
      `teacherQuestionSpec(${type}) carries no key material — the canary spec has no canary in it, so auditing ` +
        'its projection would report success on a corpus that cannot leak and never could',
    );
    continue;
  }
  positiveControls += 1;
  audited += 1;

  let projected;
  try {
    projected = publicQuestionSpec(spec);
  } catch (error) {
    fail(
      `publicQuestionSpec(${type}) threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }

  for (const hit of findForbiddenKeys(projected)) {
    fail(`publicQuestionSpec(${type}): key material by NAME at ${hit}`);
  }
  for (const hit of findCanaryValues(projected, canariesFor(type))) {
    fail(`publicQuestionSpec(${type}): key material by VALUE — ${hit}`);
  }
  // `audit:seals` runs this same walk; repeating it here is deliberate rather than redundant, because a gate that checks
  // its own invariant and shares a bug with the gate beside it is the situation `D-35` is about.
  for (const violation of findScoreBearingKeys(projected)) {
    fail(`publicQuestionSpec(${type}): score-bearing key "${violation.key}" at ${violation.path}`);
  }
}

// ── INV-Q-1: the sealed grade and the release view ──────────────────────────────────────────
const gradeInput = {
  attemptId: 'at-audit',
  assignmentId: 'as-audit',
  submittedAt: '2026-03-01T09:00:00.000Z',
  // A student's OWN answers, which are legitimately in their receipt, and a canary key that is not.
  answers: [
    { questionId: 'q1', answer: CANARY('short_text'), submittedAt: '2026-03-01T09:00:00.000Z' },
  ],
};
audited += 1;
for (const released of [false, true]) {
  const grade = buildStudentGrade({
    ...gradeInput,
    released,
    score: { rawTotal: 1, maxTotal: 1, earnedPoints: 1, possiblePoints: 1 },
    releasedAt: released ? '2026-03-02T09:00:00.000Z' : null,
    regradeNotice: null,
  });
  for (const violation of findScoreBearingKeys(grade)) {
    if (!released) fail(`buildStudentGrade(sealed): "${violation.key}" at ${violation.path}`);
  }
  if (!released) {
    // A sealed grade carrying a `key` field would be a key leaving the server, whatever it is called.
    for (const hit of findForbiddenKeys(grade))
      fail(`buildStudentGrade(sealed): key material by NAME at ${hit}`);
  }
}

const { studentReleaseState } = await load('packages/db/dist/release-batch.js');
audited += 1;
for (const hit of findForbiddenKeys(studentReleaseState(null))) {
  fail(`studentReleaseState(null): key material by NAME at ${hit}`);
}

// ── INV-TELEMETRY-2: telemetry carries no content and no PII ─────────────────────────────────
/**
 * THE TELEMETRY CORPUS IS BUILT BY THE REAL WRITER, not hand-written records.
 *
 * `EvidenceBatcher.record()` is the only place an event is constructed, so a corpus of hand-written `EvidenceRecord`s
 * would audit a shape no production code produces — which is how `audit-seals.mjs`'s first version audited nothing and
 * passed. Every key on the allowlist is exercised once, so **adding a key to `EVIDENCE_DETAIL_KEYS` is a visible event in
 * this corpus**, and the key-set check below then decides whether that key was allowed to be added.
 */
/** The batcher this gate records through, exposed so the signature block can reuse the same construction. */
const batcherForPayloads = (sign) =>
  new EvidenceBatcher(
    { batchSize: 1_000, maxQueued: 10_000, transport: async () => true },
    { now: () => 1_800_000_000_000 },
    'at-audit',
    'tab-audit',
    sign,
  );

const transportSeen = [];
const batcher = new EvidenceBatcher(
  {
    batchSize: 1_000,
    maxQueued: 10_000,
    transport: async (batch) => {
      transportSeen.push(batch);
      return true;
    },
  },
  { now: () => 1_800_000_000_000 },
  'at-audit',
  'tab-audit',
  payloadHmac,
);

for (const key of EVIDENCE_DETAIL_KEYS) {
  batcher.record('TAB_HIDDEN', { [key]: `CANARY-DETAIL-${key}` });
}
await batcher.flushOnce();
audited += 1;

const telemetryBatch = transportSeen[0];
if (telemetryBatch === undefined) {
  fail(
    'the telemetry corpus reached no transport — the batcher queued nothing, so this gate audited nothing',
  );
} else {
  // Every event must carry a detail, or the loop above silently exercised nothing.
  const withDetail = telemetryBatch.events.filter((event) => event.detail !== undefined).length;
  if (withDetail !== EVIDENCE_DETAIL_KEYS.length) {
    fail(
      `the telemetry corpus recorded ${String(withDetail)} event(s) with a detail, expected ` +
        `${String(EVIDENCE_DETAIL_KEYS.length)} — one per allowlisted key`,
    );
  }
  for (const event of telemetryBatch.events) {
    for (const [key, value] of Object.entries(event.detail ?? {})) {
      if (!isEvidenceDetailKey(key)) {
        fail(`a queued event carries \`detail.${key}\`, which is not in EVIDENCE_DETAIL_KEYS`);
      }
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) continue;
      fail(
        `a queued event carries \`detail.${key}\` of type ${typeof value}, which is not a primitive`,
      );
    }
  }
}

/**
 * THE HOSTILE TELEMETRY CORPUS: THE WRITER MUST REFUSE WHAT THE TYPE CANNOT SEE.
 *
 * `{ studentEmail }` cannot be written as a literal against `EvidenceDetail`, and a spread of a wider object CAN — see
 * `evidence-detail.assert.types.ts`, which asserts that hole exists precisely so nobody closes it by accident. So the
 * gate checks the other half: that `record()` refuses it anyway, and that the refusal queues nothing.
 *
 * **WITHOUT THIS, `audit:payloads` IS A GATE ABOUT A TYPE**, and a type is not a control a runtime gate can observe.
 *
 * ## TWO SEPARATE HOSTILE DETAILS, AND THE FIRST VERSION HAD ONE
 *
 * It sent `{ studentEmail: '…', nested: { answer: 'purple' } }`. Deleting the KEY check from `record()` still refused it,
 * because the `nested` value is an object and the VALUE check caught it — so this gate passed with half the mechanism
 * removed, which is precisely the shape of the defect this whole task is about. The corpus is now split so that each check
 * is load-bearing on its own:
 *
 *  · `{ studentEmail: '…' }`   — an illegal KEY holding a primitive. Only `isEvidenceDetailKey` can refuse it.
 *  · `{ reason: { … } }`       — a legal KEY holding an object.     Only `isEvidenceDetailValue` can refuse it.
 */
{
  const hostile = new EvidenceBatcher(
    { batchSize: 10, maxQueued: 10, transport: async () => true },
    { now: () => 1_800_000_000_000 },
    'at-audit',
    'tab-audit',
    () => 'sig',
  );
  const illegalKey = { studentEmail: 'student@school.invalid' };
  const illegalValue = { reason: { answer: 'purple' } };
  audited += 2;
  if (hostile.record('TAB_HIDDEN', { ...illegalKey })) {
    fail(
      'EvidenceBatcher.record accepted a `detail` carrying `studentEmail`. The closed type cannot see this — a spread ' +
        'of a wider object satisfies it, which `evidence-detail.assert.types.ts` asserts is true — so the writer is the ' +
        'only control between a PII field and a row retained for 400 days.',
    );
  }
  if (hostile.record('TAB_HIDDEN', { ...illegalValue })) {
    fail(
      'EvidenceBatcher.record accepted a `detail` value that is an object rather than a primitive',
    );
  }
  if (hostile.stats.queued !== 0) fail('a refused detail was queued anyway');
}

/**
 * AND THE BATCH THIS GATE BUILT MUST VERIFY, so the corpus is a signed one rather than a pile of records.
 *
 * `TM-17` was that a signature was computed, transmitted, and never verified — and the reason a gate is the right place to
 * notice is that nothing else in the repository does. A telemetry corpus built through the real writer and then never
 * checked is the corpus `P14-T14`'s ingestion route will eventually be handed, so this gate hands it to
 * `verifyEvidenceBatch` first and fails if a genuine batch does not verify.
 *
 * **It also checks the negative in the same place, because a verifier nothing ever fails is how `TM-17` happened.** One
 * event is edited, and the edited batch must not verify.
 *
 * ## A REAL HMAC, BECAUSE THE FIRST VERSION OF THIS BLOCK USED A FAKE ONE AND WAS REFUSED
 *
 * The signer here was `(input) => \`hmac:${String(input.length)}\``, carried over from the corpus batcher above. With a
 * real verifier wired in, the gate failed on its own batch:
 *
 *     verifyEvidenceBatch refused a batch this gate produced itself: MALFORMED_SIGNATURE
 *
 * which is `verifyEvidenceBatch` working: it refuses a signature that is not a hex SHA-256 rather than comparing it and
 * reporting a mismatch. **A gate that had been checking only key names would have shipped that signer happily** — the
 * corpus was exercising the writer and never the bytes.
 */
{
  const sign = payloadHmac;
  const signed = batcherForPayloads(sign);
  for (const key of EVIDENCE_DETAIL_KEYS)
    signed.record('TAB_HIDDEN', { [key]: `CANARY-DETAIL-${key}` });
  const batch = signed.signBatch(signed.takeBatch());

  const verdict = verifyEvidenceBatch(batch, sign);
  audited += 1;
  if (!verdict.ok) {
    fail(
      `verifyEvidenceBatch refused a batch this gate produced itself: ${verdict.reason}. A genuine batch failing ` +
        'verification means the signer and the verifier disagree about the signed bytes, which is the `v1`-tag hazard ' +
        '`evidence.ts` records — and no stored batch signed before that change could be read back.',
    );
  }

  const tampered = {
    ...batch,
    events: batch.events.map((event, index) =>
      index === 0 ? { ...event, detail: { ...event.detail, awayForMs: 999 } } : event,
    ),
  };
  audited += 1;
  if (verifyEvidenceBatch(tampered, sign).ok) {
    fail(
      'verifyEvidenceBatch accepted a batch whose `detail` was edited. An unverified signature on integrity evidence ' +
        "means the evidence is only as trustworthy as the database storing it, which is `TM-17`'s whole finding.",
    );
  }
  // The same refusal with NO KEY, which is the case `receipt.ts` is explicit about: a verifier that cannot check must
  // refuse, because `ok: true` from a keyless verifier is a deployment believing in a check it never performed.
  audited += 1;
  if (verifyEvidenceBatch(batch, null).ok) {
    fail('verifyEvidenceBatch reported a valid signature with NO KEY rather than refusing');
  }
}
process.stdout.write('ANSWER-KEY AND TELEMETRY PAYLOAD GATE (INV-Q-1, INV-TELEMETRY-2)\n');
process.stdout.write(`  question types projected: ${String(QUESTION_TYPES.length)}\n`);
process.stdout.write(`  payloads audited: ${String(audited)}\n`);
process.stdout.write(`  positive controls (a spec that COULD leak): ${String(positiveControls)}\n`);
process.stdout.write(`  forbidden key names watched: ${String(KEY_NAME_HIT.size)}\n`);
process.stdout.write(`  telemetry detail keys allowed: ${String(EVIDENCE_DETAIL_KEYS.length)}\n`);

/**
 * A CORPUS TOO SMALL IS A FAILURE, and so is a KEY LIST THAT NAMES A PERSON OR THE CONTENT OF AN ANSWER.
 *
 * `floor` is `QUESTION_TYPES.length + 4` — one public projection per type, one teacher positive control per type, a
 * sealed grade and the release view — so a question type added without a representative spec fails here rather than
 * being quietly skipped, and so does a student-facing payload added without joining this corpus.
 *
 * `DETAIL_KEY_NAME_HIT` is the SAME list as `evidence.ts`'s `PII_OR_CONTENT_KEYS`, **written out again on purpose**, and
 * the first version of this gate imported `isEvidenceDetailKey` instead and was wrong in a way only a deliberate violation
 * found:
 *
 *     # with 'studentEmail' forced into packages/exam-engine/dist/evidence.js's key tuple
 *     $ node scripts/audit-payloads.mjs
 *       telemetry detail keys allowed: 23
 *       ANSWER-KEY AND TELEMETRY PAYLOAD GATE PASSED
 *
 * A gate that asks the module under audit whether its own key is allowed is a gate that agrees with whatever the module
 * says. **The type-level `Exclude` check in `evidence.ts` is what caught that edit — `tsc` failed with two unused
 * `@ts-expect-error` directives before this script ever ran** — which is the right division of labour and also the reason
 * the gate must not be the only instrument: a build that emits despite type errors, or a `--noEmitOnError false`, gets
 * past it. So the two mechanisms share no reference data on purpose, and if they ever disagree this script is the one
 * that is independent.
 */
const DETAIL_KEY_NAME_HIT = new Set([
  'answer',
  'address',
  'comment',
  'content',
  'cookie',
  'deviceId',
  'email',
  'feedback',
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
  'studentEmail',
  'studentName',
  'submission',
  'student',
  'text',
  'token',
  'user',
  'userAgent',
]);

const floor = QUESTION_TYPES.length + 4;
if (audited < floor) {
  fail(
    `the corpus is too small: expected at least ${String(floor)} payloads, audited ${String(audited)}`,
  );
}

/**
 * AND THE SAME LIST IS CHECKED AGAINST WHAT THE MODULE EXPORTS, which is the check the first version could not do.
 *
 * It needs no corpus at all: `EVIDENCE_DETAIL_KEYS` is the tuple, so a widened list is visible without running anything.
 * The corpus walk above then confirms the writer really accepts it, so the report names a behaviour rather than a name.
 */
for (const key of EVIDENCE_DETAIL_KEYS) {
  if (DETAIL_KEY_NAME_HIT.has(key)) {
    fail(
      `EVIDENCE_DETAIL_KEYS contains "${key}", which names content or a person. A key on the telemetry allowlist is a ` +
        'decision to retain that field for 400 days, and this is where the decision gets argued rather than made by ' +
        'whoever needed the field that day.',
    );
  }
}

if (failures.length > 0) {
  process.stdout.write(`\nFAILED — ${String(failures.length)} payload violation(s):\n`);
  for (const f of failures.slice(0, 25)) process.stdout.write(`  • ${f}\n`);
  if (failures.length > 25) process.stdout.write(`  … and ${String(failures.length - 25)} more\n`);
  process.exit(1);
}

process.stdout.write('\nANSWER-KEY AND TELEMETRY PAYLOAD GATE PASSED\n');
