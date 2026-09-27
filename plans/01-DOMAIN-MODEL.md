# 01 — Domain Model

Entities, state machines, invariants, and the permission matrix. The Prisma schema in `02-DATA-MODEL.prisma` is the machine-readable form of this document; they are changed together.

---

## 1. Entity map

```
                          ┌──────────┐
                          │   User   │
                          └────┬─────┘
        ┌──────────────┬────────┼───────────┬──────────────┐
        │              │        │           │              │
   ┌────▼─────┐  ┌─────▼────┐ ┌─▼────────┐ ┌▼───────────┐  │
   │ Resource │  │Classroom │ │Submission│ │ SimDraft   │  │
   └────┬─────┘  └────┬─────┘ └──────────┘ └────────────┘  │
        │             │                                      │
   ┌────▼──────────┐  │  ┌──────────────┐  ┌──────────────┐ │
   │ResourceVersion│◀─┘  │  Assignment  │  │ClassroomInvit│ │
   │  (write-once) │     │ pins version │  └──────────────┘ │
   └────┬──────────┘     └──────┬───────┘                   │
        │                       │                    ┌───────▼──────┐
        │                  ┌────▼─────┐              │  Enrollment  │
        │                  │ Question │              └──────────────┘
        │                  │  (bank)  │
        │                  └────┬─────┘
        │                       │
   ┌────▼──────────┐     ┌──────▼──────────┐   ┌──────────────┐
   │   Question    │     │  QuestionPool   │   │  Blueprint   │
   │ (the item)    │◀────┤ draw N of M     │◀──┤ coverage map │
   └────┬──────────┘     └─────────────────┘   └──────┬───────┘
        │                                            │
        └──────────────┬─────────────────────────────┘
                       │ version-pinned
                  ┌────▼──────────┐
                  │ ExamAttempt   │──► QuestionResponse (answer + grades, SEALED)
                  └────┬────┬────┘
                       │    └──► IntegrityEvent (evidence, never verdict)
                       └───────► ReleaseBatch (atomic unseal)
```

---

## 2. Identity

- `User.status ∈ {ACTIVE, SUSPENDED, DELETING, DELETED}`. Suspension revokes all session rows **in the same transaction**, so it takes effect on the next request.
- `locale`, `timezone` (IANA). Used for date rendering and for telling a student a deadline in *their* zone.
- `anonymisedAt` marks a completed deletion. Auth rows are removed. Content referenced by a graded submission is anonymised to a tombstone rather than deleted, so historical grades stay coherent.
- `isMinor` and `guardianEmail` support the minors posture in `15-A11Y-I18N.md` / `14-SECURITY-PRIVACY.md`.

### INV-AUTH-1
> Sessions are revocable. Every mutating request re-reads authorisation. No JWT-only sessions, anywhere.

---

## 3. Content

### 3.1 `Resource`
`kind ∈ {LESSON, QUIZ, EXAM}`. Quiz and exam are the same object with different runtime policy; the distinction selects defaults and UI, not the data shape. One code path means one set of bugs.

- `currentVersionId` → the working draft head.
- `visibility ∈ {PRIVATE, UNLISTED, PUBLIC}`; `status ∈ {DRAFT, PUBLISHED, ARCHIVED, WITHDRAWN}`.

`WITHDRAWN` is an addition made by P2-T8, which asked for "DRAFT → PUBLISHED → ARCHIVED plus
WITHDRAWN" while this list held only the first three. `WITHDRAWN` is also an `Assignment` status
in §3.x, so the packet was conflating two lifecycles. The state is nonetheless needed and
`ARCHIVED` does not cover it: `ARCHIVED` means *no longer current*, whereas `WITHDRAWN` means
*was published, has been found wrong, and must stop being visible to students immediately* —
while every grade and submission referencing it stays valid, because a student's mark cannot be
invalidated by an author fixing a typo afterwards. Folding it into `ARCHIVED` means a correction
either stays visible to students or is hidden by archiving, which also breaks the version chain.
`WITHDRAWN` is not restorable to `PUBLISHED` directly; it returns to `DRAFT`, so the author has
looked at it again.

### INV-VISIBILITY-1
> A resource the viewer may not see is **404**, not 403, and **never enters a shared cache**. The
> read decision is re-made on every read; a denied read is indistinguishable from absence; and
> only `PUBLIC` published content gets a cacheable response, whose key includes the visibility
> tier, owner and version.

Enforced in code: the decision is `Resource.read` in the `packages/auth` matrix, so it is
re-evaluated at each call rather than trusted from a write. The `notVisible` deny code maps to
404 and every other deny maps to 403, so the distinction is carried by the code rather than by a
boolean a rule author can set wrongly. `cacheKey(resource, cacheable)` in
`packages/contracts` takes **no viewer** and returns `null` unless the decision said cacheable,
so the key is structurally incapable of disagreeing with the permission decision. A denied read
and an absent read are asserted to be equal. `UNLISTED` collapses only in `visibleInSearch`,
which is the single place that knows about listings.

### 3.2 `ResourceVersion`

### INV-CONTENT-1
> A `ResourceVersion` is **write-once**. `blocks`, `blocksChecksum`, `meta`, `assessmentPolicy` and the `Question` rows keyed to it are never updated. Corrections are new versions.

Enforced in code: `packages/db` exposes `createResourceVersion` and **no** `updateResourceVersionContent`. A test asserts the update path does not exist.

This extends to questions: a practice check inside v1 refers to v1's question forever.

### 3.3 Block content
`blocks` is a JSON array of a closed discriminated union (16 types, `05-CONTENT-AUTHORING.md` §2). Every block has a stable `id` so diffs and analytics survive versions. Simulation embeds pin `simId@simVersion`. Publishing validates that every referenced sim version is in the registry — a registry problem can never publish a broken resource, and an already-published resource degrades to a static fallback rather than breaking.

---

## 4. Taxonomy
- `Subject`: self-referencing tree. Moves are **cycle-checked** (a move that would create a cycle is rejected with a precise error).
- `Tag`: flat, with merge (retargets every resource) and rename.
- A `Resource` has one primary `subjectId` plus `ResourceSubject` for secondary subjects. A `Simulation` has a `subjects String[]`, because one simulation legitimately spans several (`maths.projectile-motion` is both maths and physics).

---

## 5. Classroom

- `Classroom`: exactly one `ownerId` (transferable, audited), `name`, unique-per-owner `slug`, `status ∈ {ACTIVE, ARCHIVED}`.
- `Enrollment`: unique `(classroomId, userId)`; `role ∈ {OWNER, TEACHER, STUDENT}`; `status ∈ {ACTIVE, REMOVED, LEFT}`. Rows are **retained** after removal so attempt and grade history survives.
- `ClassroomInvitation`: exactly one of `email` / `codeHash`. Codes are 6 characters from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), stored hashed, regenerable (regeneration revokes the old code), expiring, with `resendCount` and `lastSentAt` cooldowns. `codeHint` stores the last two characters so a teacher can read a code off a printed sheet without the platform being able to reproduce it.
- `RosterImport` records each CSV import with its dry-run diff, error report and applied timestamp, so a re-import is idempotent and auditable.
- `displayNameOverride` lets a teacher set the name a student appears under in that classroom only — used for real-name policies without forcing legal-name disclosure.

### INV-CLASSROOM-1
> A user's effective role is the **maximum** of their active enrollments. A user who is both STUDENT and TEACHER is a teacher for every purpose (grading, publishing, roster). Removing the student enrollment does not reduce their teacher access.

### INV-CLASSROOM-2
> Departure revokes *classroom* access on the next request, but permanently preserves the student's own access to their submissions, grades and released feedback. Those are their records, not the classroom's.

---

## 6. Assignment, pinning and policy

- `Assignment` pins `resourceVersionId`, has `mode ∈ {ASSIGNMENT, EXAM}`, `status ∈ {DRAFT, PUBLISHED, WITHDRAWN}`, `availableFrom/Until`, `maxAttempts`, `weight`, `latePenaltyPercent`, and an optional `policyOverride`.
- `AssignmentStudentOverride` carries per-student exceptions: a different window, extra attempts, a longer time limit, an accommodation reference. This is the escape hatch that stops a teacher from choosing between "rigid policy" and "my student has a rough home internet connection".

### INV-ASSIGN-1
> A student's assessment surface derives **only** from `Assignment.resourceVersionId` and the attempt's `policySnapshot`. No code path may read `Resource.currentVersionId` when rendering an assessment. Enforced by a lint rule on the assessment routers plus a test that mutates the resource post-assignment and asserts byte-identical output.

### INV-ASSIGN-2
> Withdrawing an assignment stops **new** attempts. In-flight attempts run to their own deadline and remain submittable. Withdrawal is audited and shown to students as a message, never a silent 404.

### Policy resolution and freezing
```
resolvedAtPublish = resolve(assignment.policyOverride, resourceVersion.assessmentPolicy, studentOverride)
attempt.policySnapshot = deepFreeze(resolvedAtPublish)   // written once, at first start
```
> **INV-POLICY-1.** Once an attempt exists, its `policySnapshot` never changes. Mid-exam changes go through audited `DEADLINE_EXTENDED` / `POLICY_OVERRIDDEN` attempt events, never a silent rewrite.

### INV-POLICY-2
> A policy must be internally consistent or it is rejected at authoring time with field-level errors: window start before end; window length not shorter than the total time limit; per-question limits summing beyond the total limit produce a warning, not an error; `perQuestionExpiry ≠ SOFT` with no per-question limit is an error.

---

## 7. Question banks, pools and blueprints

These are the objects that make per-student variation real. Full design in `06-QUESTION-BANK-BLUEPRINT.md`.

- `QuestionBank`: a named, owned, shareable collection of `Question` items. This is the unit a teacher builds up over a course year.
- `QuestionPool`: a *selection rule* over a bank (or a filter), with `drawCount` (N) and `availableCount` (M), a draw strategy, and per-item capability requirements.
- `Blueprint`: a coverage map — topics × cognitive demand × points — used to check coverage before an assessment is published.
- `AssessmentSpec` (inside the resource version's `assessmentPolicy`): a list of *slots*, each either `FIXED(questionId)` or `POOLED(poolId, drawCount)`. Resolved per student into a `variantMap` at attempt start.

### INV-BANK-1
> A pool must satisfy `M ≥ N` and must contain at least `minDistinctAcrossCohort` distinct items for the strategy in use, or the assessment is **not publishable**. A teacher cannot ship a pool they cannot draw from.

### INV-BANK-2
> The resolved `variantMap` is written once at attempt start and stored on the attempt. Every subsequent read of "what did this student get" comes from `variantMap`, never from re-running the draw. A draw is therefore reproducible and auditable forever.

### INV-BANK-3
> Question *content* is snapshotted into the version at publish time (`variantSource = VERSION`). A question edited later affects future versions only. The alternative (`variantSource = BANK`) is permitted only for formative quizzes where the teacher explicitly accepts that a mid-flight edit changes live attempts, and it is recorded per assessment.

---

## 8. Questions

- `Question`: `type`, `spec Json` (**contains the key — server-only**), `points`, `gradingMode ∈ {AUTO, MANUAL, HYBRID}`, `timeLimitSec?`, `shuffle?`, `simId?/simVersion?/simConfig?`, `tags`, `estimatedSeconds`, and optional `modelAnswer` (teacher-only).
- Two projections, both exhaustive-typed so a new type fails compilation until handled:
  - `publicQuestionSpec()` — the student payload. Strips keys and model answers.
  - `teacherQuestionSpec()` — adds key, rubric, auto-grade rationale, live "test the grader" harness.

### INV-Q-1
> No client-facing response, HTML payload, log line, trace, analytics event, error message or Sentry breadcrumb may contain `spec` key material. Enforced by `audit:seals` and `audit:payloads` in CI and by the full route audit in P10.

---

## 9. Attempt lifecycle

```
                     ┌──────────────┐
                     │  NOT_STARTED │   (created on assignment publish, or lazily)
                     └──────┬───────┘
                            │ start: validate window, attempts, enrolment, policy
                            ▼
        ┌───────────────────────────────────────────────┐
        │                 IN_PROGRESS                   │◀──┐ resume (same attempt,
        │  answers autosaved · deadlines ticking ·       │───┘  same server clock)
        │  evidence events accumulating                 │
        └──┬────────────┬──────────────┬────────────────┘
           │            │              │
    submit │  deadline  │  teacher     │ policy threshold
  (client  │   passes   │  terminates  │ reached
   or cron)│            │              │
           ▼            ▼              ▼
     ┌──────────┐  ┌──────────┐   ┌────────────┐
     │SUBMITTED │  │ EXPIRED  │   │ TERMINATED │
     └────┬─────┘  └────┬─────┘   └────────────┘
          │             │             teacher may reinstate or void
          │ auto-grade computed ── SEALED ──┐
          ▼                                 │
   ┌──────────────────┐                     │
   │  PENDING_REVIEW  │  manual questions   │
   └────────┬─────────┘  unresolved         │
            │ all resolved                  │
            ▼                               │
      ┌───────────┐                        │
      │  GRADED   │────────────────────────┤
      └─────┬─────┘                        │
            │ teacher releases the batch   │
            ▼                               ▼
      ┌─────────────────────────────────────────┐
      │               RELEASED                  │
      └─────────────────────────────────────────┘
```
Other terminal states: `EXCUSED` (teacher-marked, from `NOT_STARTED`), `VOIDED` (integrity concern upheld by a human; scores discarded, audit retained).

### INV-ATTEMPT-1
> An attempt's score is computed **only** by `@orrery/grading` from stored `QuestionResponse.answer` values, using the stored `variantMap` and the attempt's `policySnapshot`. No client-supplied score is ever read. Re-running the grader over an unchanged attempt is idempotent.

### INV-ATTEMPT-2
> For every student-facing endpoint, `autoScore`, `manualScore`, `finalScore`, `percentage`, per-question `autoScore`/`autoCorrect` and all key material are excluded while `releasedAt IS NULL`. Enforced **structurally**: student-facing DTO builders take `{ attempt, released }` and contain no branch that returns a score field when `released` is false. Not `null`, not rounded, not a hint.

### 9.1 Deadline model
```
attempt.startedAt  = serverNow at first accepted start
attempt.deadlineAt = totalTimeLimitSec ? startedAt + limit : null

per question, on the first ACCEPTED interaction:
  response.questionOpenedAt   = serverNow                (immutable once set)
  response.questionDeadlineAt = timeLimitSec ? openedAt + timeLimitSec : null
```

Write acceptance, evaluated entirely server-side:
```
accept iff  attempt.status == IN_PROGRESS
       and  (questionDeadlineAt == null or now <= questionDeadlineAt + grace)
       and  (deadlineAt        == null or now <= deadlineAt        + grace)
       and  response.revision == expectedRevision      (else 409 with the server copy)
       and  idempotencyKey is new                      (else idempotent success)
```
> **INV-LATE-1.** Answers written after their window are **rejected and the last accepted value retained** — they are not silently accepted and not silently zeroed. This is the direct precedent of Moodle's "no marks are awarded for any answers entered after the time ran out" (`RN-04`), and it is what makes the server clock meaningful. A late submission *within* grace is stored with `isLate = true`.

At `questionDeadlineAt` the policy decides: `SOFT` (log only, editable until the overall deadline), `LOCK` (freeze the answer), `AUTO_SUBMIT` (freeze and mark final). A cron auto-submits at `deadlineAt + grace + 30s` from whatever the server holds (`submittedBy: CRON`).

### 9.2 Clock
`@orrery/clock` is the only time source. The client receives `serverNow` and computes an offset from the RTT midpoint, re-syncing every 60 s and after any pause > 30 s. A client whose system clock is three days wrong behaves identically to a correct one. If sync is unavailable the exam still runs and says so; the server remains the sole enforcer.

### 9.3 Autosave durability
Acknowledged means the server returned `2xx`. An IndexedDB outbox holds unsent writes and flushes in `seq` order on reconnect. If the hard deadline passes with writes still queued, the queue is abandoned and the student is told plainly that unacknowledged answers may not have been recorded. Nothing is silently lost and nothing is silently kept.

Every save carries `idempotencyKey` (client uuid) and `revision`. A duplicate key is an idempotent success; a stale revision is a `409` that surfaces "keep mine / keep theirs" — which is also how a second device is detected.

### 9.4 Answer audit chain and receipt
Each accepted write appends `AnswerRevision(previousHash, answerHash, source, serverTs)`. The submission receipt folds them in question order:
```
H₀ = sha256(attemptId ‖ assignmentId ‖ sha256(canonicalJson(policySnapshot)))
Hᵢ = sha256(Hᵢ₋₁ ‖ questionId ‖ sha256(canonicalJson(answer)) ‖ serverTs)
```
The student sees `Hₙ`. A teacher can recompute it from the revision chain with `pnpm --filter @orrery/grading verify-receipt <attemptId>`, which reports the first divergence. That is what makes "I didn't change my answer" checkable rather than deniable.

---

## 10. Grading, review and release

- `QuestionResponse`: `answer`, `simState`, `revision`, `isExcused`, `flagged`, per-question timing, and the grades: `autoScore`/`autoCorrect`/`autoGradedAt`/`autoRationale`/`autoGraderVersion` (sealed) plus `manualScore`/`manualFeedback`/`rubricScores`/`graderId`/`gradedAt`.
- `ReviewTask`: one per attempt needing human grading; `status ∈ {PENDING, CLAIMED, DONE}`; soft claim lock with presence.
- `ReleaseBatch`: `(assignmentId, classroomId)`; `status ∈ {DRAFT, READY, RELEASING, RELEASED, CANCELED}`. Membership is **frozen** on entering `RELEASING`.
- `GradeChange`: append-only before/after for every score change, with a reason.
- `IntegrityVerdict`: the teacher's recorded conclusion on an attempt's evidence — `NO_CONCERN | NOTED | REVIEW | VOIDED`, with a reason, a verdict author and a timestamp. The machine may recommend; only a human disposes.

### INV-RELEASE-1
> Release is **one database transaction** across the whole batch: verify every attempt is `GRADED` (or an override reason is recorded), compute and persist `finalScore`/`percentage`, set `releaseBatchId` and `releasedAt`, mark the batch `RELEASED`. There is no intermediate state in which some attempts in a batch are visible. A failure releases nothing and the job retries idempotently.

### INV-RELEASE-2
> No score may be *inferable* before release. Therefore: no score field in any endpoint, no count of correct answers, no toast, no difference in status code, no difference in payload size, no cache-header variance, no analytics event. The pre-release student payload is a fixed, score-free DTO. A machine-checked audit enumerates every student-facing route and asserts it (`P10-T8`).

### 10.1 Score computation
```
rawTotal   = Σ (isExcused ? 0 : finalScore(response))
maxTotal   = Σ points over non-excused questions in the resolved variant
percentage = maxTotal > 0 ? rawTotal / maxTotal : null
lateFactor = isLate ? (1 - latePenaltyPercent/100) : 1
final      = round(percentage × 100 × lateFactor, 2)
```
Weights and letter grades are **derived views**, never stored as truth. The late penalty is applied at computation time, not submission time, so it stays adjustable and auditable.

### 10.2 Regrade
Changing an auto-grade configuration, a manual score or a penalty triggers a recompute and appends `GradeChange` + an `AttemptEvent(REGRADED)`. If the attempt was already released, `regradeNoticePendingAt` is set so the student sees a "results were updated" notice with the reason. Assignment-wide regrade is a background job with a dry run that reports affected attempts and score deltas *before* anything changes.

---

## 11. Accommodations

`Accommodation` is a first-class, auditable object — not a flag on a policy.

```
Accommodation {
  id, classroomId, studentId, assignmentId?, grantedById, grantedAt, expiresAt?,
  relaxations: Relaxation[],        // see 09-EXAM-INTEGRITY.md §8
  reason: string,                    // never shown to other students
  status: ACTIVE | REVOKED
}
```

### INV-ACC-1
> A relaxation granted to a student produces **zero** violation events for the affected watchdogs. They route to `accommodation-relaxed`. A student is never penalised for using an accommodation, and accommodations are auditable because institutions need the record.

---

## 12. Evidence (integrity telemetry)

`IntegrityEvent`: `attemptId`, `seq` (monotonic per attempt, unique), `type`, `severity ∈ {INFO, WARN, VIOLATION}`, `clientTs`, `serverTs`, `payload Json` (closed schema), `receivedBy`.

The full event table with severities and strike eligibility is in `09-EXAM-INTEGRITY.md` §7.

### INV-TELEMETRY-1
> Client events are **evidence, never truth**. The server stamps `serverTs`, assigns `seq`, and reclassifies severity from policy. A forged or replayed event can at worst add noise to a human's decision. It can never change a score, and it can never by itself void an attempt.

### INV-TELEMETRY-2
> Telemetry carries no answer content, no keystrokes, no DOM text, no clipboard, no camera, no PII. Payload schemas are closed Zod objects with a per-type allowlist; unknown keys are stripped at ingest and the strip is counted.

---

## 13. Simulation registry
- `Simulation`: natural key `(id, version)`. `manifest Json`, `bundlePath`, `bundleSha256`, `byteSize`, `graderEntry`, `capturesPath`, `licence`, `provenance ∈ {ORIGINAL, INSPIRED_BY:<ref>, PORTED}`, `authors`, `replacedById`, `status ∈ {REGISTERED, DEPRECATED, DISABLED}`.
- Registry rows are created by the CI build pipeline, never by an end user.
- A deprecated version keeps working for resources pinned to it.

### INV-SIM-1
> A simulation is untrusted code: an iframe **without** `allow-same-origin`, on an isolated origin, under a strict CSP, communicating only over nonce-verified `postMessage`, with no network, storage, cookie or clipboard access. It cannot affect the host beyond the frames defined by `sim-host@1`.

### INV-SIM-2
> Every simulation usable as a question exposes a pure `grader(state, params, answer) → grade` that runs in **Node** against stored state. Auto-grading never requires a browser, and the same code grades the live session and the reviewer's replay. If a stored state fails its schema, the question is routed to a human — **never auto-zeroed**.

---

## 14. Invariant index

| ID | Invariant | Enforced by |
|---|---|---|
| INV-AUTH-1 | Sessions are revocable; re-read authorisation every request | `packages/auth`, no JWT |
| INV-CONTENT-1 | `ResourceVersion` is write-once | `packages/db` API shape + test |
| INV-CLASSROOM-1 | Effective role = max of active enrollments | `can()` + tests |
| INV-CLASSROOM-2 | Departure revokes classroom access, not personal records | query scoping + tests |
| INV-ASSIGN-1 | Assessment reads the pinned version and the policy snapshot only | lint rule + test |
| INV-ASSIGN-2 | Withdrawal stops new starts, not in-flight attempts | state machine + test |
| INV-POLICY-1 | `policySnapshot` is frozen at first start | write-path absence + test |
| INV-POLICY-2 | Policies are consistency-checked at authoring time | `resolvePolicy()` + test |
| INV-BANK-1 | A pool must be drawable or the assessment cannot publish | `validateForPublish` + test |
| INV-BANK-2 | `variantMap` is written once and read forever | write-path + test |
| INV-BANK-3 | Question content is version-snapshotted (unless explicitly opted out) | publish transaction |
| INV-Q-1 | Answer keys never leave the server | `audit:seals`, `audit:payloads` |
| INV-ATTEMPT-1 | Scores come only from the pure grader over stored answers | architecture + test |
| INV-ATTEMPT-2 | No partial result visibility, structurally | DTO shape + route audit |
| INV-LATE-1 | Late writes are rejected, last accepted value retained | server write path + test |
| INV-RELEASE-1 | Release is one transaction | worker + concurrency test |
| INV-RELEASE-2 | No score is inferable pre-release | route audit |
| INV-ACC-1 | Accommodations produce zero violations | watchdog routing + test |
| INV-TELEMETRY-1 | Telemetry is evidence, never truth | ingest re-stamping + test |
| INV-TELEMETRY-2 | Telemetry carries no content and no PII | closed schemas + canary test |
| INV-SIM-1 | Simulations are untrusted and isolated | sandbox + escape test |
| INV-SIM-2 | Sim grading is pure and runs in Node | dual-target build + CI |
| INV-TIME-1 | All time flows through `@orrery/clock`; the server is authoritative | ESLint + `FrozenClock` |
| INV-RNG-1 | All randomness flows through seeded `@orrery/rng`; the seed is stored | ESLint + tests |
| INV-ABUSE-1 | Aggregate abuse limits are keyed on the **actor**, never the container | `P4-T3` + test |
| INV-QUOTA-1 | Every write path storing user-controlled bytes has a quota enforced in the storing transaction | `P2-T6` + test |
| INV-MIGRATE-1 | No stored block requires a human to fix it; every readable version migrates forward or publishing is refused | `P2-T1b`, `P2-T10` |
| INV-VISIBILITY-1 | A resource the viewer may not see is 404 and never shared-cached; the read decision is re-made on every read | `P2-T8` |
| INV-SLOT-1 | An `AssessmentSlot` list and the `Question` rows it references agree, verified at publish | `P5-T12` + test |

These four were added by the P0-T9 risk review (`24-P0-RISK-REVIEW.md` MISSED-1/2/3 and
MISSED-6). Each closes a gap that survived three independent reviews because each sat
between their lenses rather than inside one.
