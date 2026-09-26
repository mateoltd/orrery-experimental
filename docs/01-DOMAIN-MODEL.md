# Domain Model

Authoritative entity, state-machine and invariant specification. The Prisma schema in `DATA-MODEL.prisma` is the machine-readable expression of this document; where they disagree, the Prisma schema plus this document must be updated together.

---

## 1. Entity map

```
                    ┌──────────┐
                    │   User   │──── owns ────┬──────────────┐
                    └────┬─────┘               │              │
                         │                 ┌────▼─────┐   ┌────▼────────┐
                    Account/Session     │ Resource  │   │ Classroom   │
                                           │           │   │             │
                                           └────┬──────┘   └────┬────────┘
                                                │                 │
                              ┌─────────────────┼────────────┐    │
                              ▼                 ▼            ▼    ▼
                      ResourceVersion    ┌──────────────┐  Enrollment   Assignment
                      (immutable)        │  Question    │       │         │ pins
                                          └──────┬───────┘       │         ▼
                                                 │               │   ResourceVersion
                                                 ▼               │
                                         ┌───────────────┐       │
                                         │ ExamAttempt   │◄──────┘
                                         └───┬───────┬───┘
                          ┌──────────────────┘       └──────────────┐
                          ▼                                         ▼
                ┌──────────────────┐                     ┌──────────────────┐
                │ QuestionResponse │                     │ IntegrityEvent   │
                │  (answer+grade)  │                     │   (telemetry)    │
                └────────┬─────────┘                     └──────────────────┘
                         │
                         ▼
                ┌──────────────────┐        ┌───────────────────┐
                │  AnswerRevision  │        │   ReleaseBatch    │
                │  (audit chain)   │        │ (atomic unseal)   │
                └──────────────────┘        └───────────────────┘
```

---

## 2. Identity

### 2.1 `User`
Fields of consequence beyond identity data:
- `status`: `ACTIVE | SUSPENDED | DELETING | DELETED`. Suspension blocks login immediately (session rows revoked in the same transaction).
- `locale`, `timezone` (IANA). Used for date rendering and for reminding a student that a deadline is in *their* zone.
- `anonymisedAt`: set on deletion. Auth rows are removed; authored content is either deleted or, if referenced by a graded submission, anonymised to a tombstone user so historical grades stay attributable-but-not-identifiable.

### 2.2 Invariant: sessions are revocable
Session revocation is a hard requirement of the exam model — a teacher suspending a student mid-exam, or a student being removed from a classroom, must take effect on the next request. Therefore sessions live in Postgres (not JWT-only), and every mutating request re-reads authorisation.

---

## 3. Content

### 3.1 `Resource`
The authoring container. `kind ∈ {LESSON, QUIZ, EXAM}`. A quiz and an exam are the same object with different runtime policy; the distinction drives UI, defaults and integrity policy, not the data shape.

- `currentVersionId` points at the working draft head.
- `visibility ∈ {PRIVATE, UNLISTED, PUBLIC}`.
- `status ∈ {DRAFT, PUBLISHED, ARCHIVED}`.

### 3.2 `ResourceVersion` — immutability invariant
> **INV-CONTENT-1.** A `ResourceVersion` row is never updated after creation. `blocks`, `blocksChecksum` and `meta` are frozen. Corrections are new versions.

This is what makes `Assignment` pinning meaningful. It is enforced in application code (`packages/db` exposes only `createVersion`, never `updateVersionContent`) and asserted by a test that attempts an update and expects failure.

Version numbering is per-resource and monotonic (`version Int`), with a unique constraint on `(resourceId, version)`.

### 3.3 Block content
`blocks` is a JSON array of a discriminated union (see `04-ASSESSMENT.md` §2 for the full list). Invariants:
- Every block has a stable `id` (uuid) so that diffs and analytics can reference blocks across versions.
- Simulation embeds store `simId` + `simVersion` + `params` + `seedPolicy`. The registry must contain that exact `id@version` or the resource fails to publish.
- `practiceCheck` blocks reference a `Question` by id; the question is copied into the version snapshot (`questionsSnapshot`) so that editing the question later does not rewrite history. Actually — see the deliberate decision: assessment questions are versioned **with the resource**, so `practiceCheck` blocks embed a full question snapshot rather than a live reference. This is a deliberate trade: authoring a practice check inline is more valuable than live-updating it, and history integrity matters more here.

---

## 4. Taxonomy

- `Subject`: self-referencing tree, cycle-safe moves (a move that would create a cycle is rejected with a precise error).
- `Tag`: flat, with merge (retargets all resources) and rename.
- A resource has one primary `subjectId` and zero or more `tagIds`. A simulation has a `subjects String[]` because one sim legitimately spans subjects (e.g. a projectile sim is both maths and physics).
- `ResourceSubject` join table exists for secondary subjects.

---

## 5. Classroom

### 5.1 Entities
- `Classroom`: `name`, `slug` (unique per owner), `status ∈ {ACTIVE, ARCHIVED}`, `ownerId`. Exactly one owner; ownership is transferable, and the transfer is audited.
- `Enrollment`: `(classroomId, userId)` unique. `role ∈ {OWNER, TEACHER, STUDENT}`. `status ∈ {ACTIVE, REMOVED, LEFT}`. Retains a row after removal so history (attempts, grades) is preserved.
- `ClassroomInvitation`: `email?`, `codeHash?`, `role`, `status ∈ {PENDING, ACCEPTED, REVOKED, EXPIRED}`, `expiresAt`, `acceptedById?`, `resendCount`, `lastSentAt`.
  - Exactly one of `email`/`codeHash` is set.
  - Codes: 6 characters from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`), stored hashed, regenerable (regeneration revokes the old code), rate-limited by IP and by classroom.
- `RosterImport`: records each CSV import with its dry-run diff and error report, so a re-import is idempotent and auditable.

### 5.2 INV-CLASSROOM-1
> A user's effective role in a classroom is the maximum of their active enrollments. A user with both a `STUDENT` and a `TEACHER` enrollment is a teacher for all purposes (grading, publishing). Removing the student enrollment does not reduce their ability to see the classroom as a teacher.

### 5.3 INV-CLASSROOM-2
> A removed or departed student loses *read* access to classroom-scoped content on the next request, but retains permanent read access to their own submissions, grades and released feedback — those are their records, not the classroom's.

---

## 6. Assignment

- `Assignment`: `classroomId`, `resourceId`, `resourceVersionId` (**pinned**), `mode ∈ {ASSIGNMENT, EXAM}`, `titleOverride?`, `instructions?`, `availableFrom`, `availableUntil`, `weight Decimal`, `policy Json?` (per-assignment override of the resource's assessment policy), `maxAttempts Int`.
- `status ∈ {DRAFT, PUBLISHED, WITHDRAWN}`.

### 6.1 INV-ASSIGN-1 (the pinning invariant)
> A student's assessment surface is derived **only** from `Assignment.resourceVersionId` and the attempt's `policySnapshot`. No code path may read `Resource.currentVersionId` when rendering an assessment. Enforced by a lint rule on the assessment router plus a test that mutates the resource post-assignment and asserts identical output.

### 6.2 INV-ASSIGN-2 (withdrawal)
> Withdrawing an assignment stops new attempts from starting. In-flight attempts continue to their own deadline and remain submittable. Withdrawal is audited and visible to students as a message, not a silent 404.

### 6.3 Policy resolution
```
effectivePolicy = attempt.policySnapshot          // frozen at first start
effectivePolicy = resolve(assignment.policy, resourceVersion.assessment.policy)   // at publish time, stored
```
Policy is resolved **once**, at publish, and copied onto every attempt at start. Later edits to the resource or assignment never affect in-flight attempts. Teachers who need to change conditions for a live exam must use the auditable `extendDeadline` / `policyOverride` actions on the attempt, which create an exception record.

---

## 7. Assessment questions

- `Question`: `assessmentId` (the resource version's assessment), `position`, `type`, `spec Json` (contains keys — server-only), `points Decimal`, `gradingMode ∈ {AUTO, MANUAL, HYBRID}`, `timeLimitSec?`, `simId?`, `simVersion?`, `simConfig Json?`.
- Two projections:
  - `publicQuestionSpec` — what the student client receives. Strips every key, and for free-response strips model answers. Generated by a single exhaustive function in `@orrery/contracts` with a compile-time guarantee that adding a question type forces updating it.
  - `teacherQuestionSpec` — adds the key, the rubric and the auto-grade rationale.
- **INV-Q-1.** No client-facing response, HTML payload, log line, analytics event or error message may contain the `spec` key material. Enforced by P10-T8's route leak audit and a payload scanner in CI.

Question type catalogue and grading semantics live in `04-ASSESSMENT.md`.

---

## 8. Exam attempt

### 8.1 State machine

```
                          ┌──────────────┐
                          │  NOT_STARTED │
                          └──────┬───────┘
                                 │ first start (validates window, policy, attempts)
                                 ▼
        ┌────────────────────────────────────────────┐
        │              IN_PROGRESS                   │◀──┐
        │  answers autosaved; deadline ticking;      │───┘ resume (same attempt)
        │  violations may accumulate                 │
        └───┬──────────────┬──────────────┬──────────┘
            │              │              │
   submit   │   deadline   │  teacher    │  policy
   (client  │   passes     │  terminates │  threshold
    or cron)│              │              │
            ▼              ▼              ▼
      ┌──────────┐  ┌──────────┐   ┌────────────┐
      │SUBMITTED │  │ EXPIRED  │   │ TERMINATED │
      └────┬─────┘  └────┬─────┘   └────────────┘
           │             │              (no grade; teacher may void or reinstate)
           │ auto-grade computed, SEALED
           ▼
      ┌──────────────────┐
      │  PENDING_REVIEW  │  manual questions unresolved
      └────────┬─────────┘
               │ all manual questions graded
               ▼
      ┌──────────────────┐
      │    GRADED        │  final score computed, still SEALED
      └────────┬─────────┘
               │ teacher releases the batch
               ▼
      ┌──────────────────┐
      │   RELEASED       │  student may see results
      └──────────────────┘
```

Additional terminal states: `EXCUSED` (teacher-marked, from `NOT_STARTED`), `VOIDED` (integrity failure upheld by a teacher; scores discarded but audit retained).

### 8.2 INV-ATTEMPT-1 (single source of truth)
> An attempt's score is computed only by `@orrery/grading` from the stored `QuestionResponse.answer` values. No client-supplied score is ever read. Re-running the grader over an unchanged attempt is idempotent and byte-identical.

### 8.3 INV-ATTEMPT-2 (no partial visibility)
> For every student-facing endpoint, the attempt's `autoScore`, `manualScore`, `finalScore`, per-question `autoCorrect`, and all key material are excluded until `attempt.releasedAt IS NOT NULL`. Enforced structurally: student-facing DTO builders take a `released: boolean` and have no branch that returns scores when `released` is false.

### 8.4 Deadline model

```
attempt.startedAt        = serverNow at first start
attempt.deadlineAt       = startedAt + totalTimeLimitSec          (if set)
per question:
  response.questionOpenedAt    = serverNow at first interaction with that question
  response.questionDeadlineAt  = questionOpenedAt + question.timeLimitSec
  grace                       = policy.gracePeriodSec (default 0)
```

Rules:
- `questionOpenedAt` is set **server-side on the first accepted interaction**, never by the client, so a student cannot reset a per-question timer by reloading.
- Once `questionOpenedAt` is set it is immutable for that response.
- Saves are accepted while `serverNow <= questionDeadlineAt + grace`. Beyond that: rejected with `409 QUESTION_WINDOW_CLOSED`, and the answer retains its last accepted value.
- At `questionDeadlineAt` the policy decides: `LOCK` (freeze the answer, log the event), `AUTO_SUBMIT` (freeze and record as final), or `SOFT` (log only, allow the answer to be edited until the overall deadline).
- The overall `deadlineAt` is absolute. A cron job auto-submits at `deadlineAt + grace + 30s` using whatever the server holds.
- Late-but-in-grace submissions are stored with `isLate = true`; a teacher-set `latePenaltyPercent` is applied at grade computation, not at submission, so the penalty is always auditable and adjustable.

### 8.5 Clock
`@orrery/clock` is the only time source. On attempt start the client receives `serverNow` and computes a `clockOffset` using the RTT midpoint of the start handshake, re-syncing every 60 s and immediately after any long pause. The countdown renders from `serverNow + offset`; if the offset cannot be established, the client shows a degraded banner and still relies on the server rejecting late writes. A client whose clock is 3 days wrong behaves identically to a correct one.

### 8.6 Autosave durability
Acknowledged semantics: the UI shows `saved` only after the server has acknowledged. Internally, an IndexedDB outbox holds unsent writes; on reconnect they are flushed in `seq` order. If the hard deadline passes while writes are queued, the queue is abandoned and the student is told plainly that unacknowledged answers after the deadline may not have been recorded. Nothing is silently lost and nothing is silently kept.

Every save carries `idemKey` (client-generated uuid) and `revision` (monotonic per response). Duplicate `idemKey` is a no-op success. A stale `revision` returns `409` with the server copy so the UI can offer "keep mine / keep theirs" — this is both a UX feature and the mechanism that detects two devices.

### 8.7 Answer audit chain
Each accepted write appends an `AnswerRevision` (previous value hash, new value hash, actor, server time, source `CLIENT|TEACHER|GRADE|SYSTEM`). The submission receipt is `H = sha256(H₍ₙ₋₁₎ ‖ questionId ‖ answerHash ‖ serverTs)` folded in question order. The student sees the final `H`; a teacher can recompute it from the revision chain to prove no answer changed after submission.

---

## 9. Integrity telemetry

`IntegrityEvent`: `attemptId`, `seq` (monotonic per attempt), `type`, `severity ∈ {INFO, WARN, VIOLATION}`, `clientTs`, `serverTs`, `payload Json`, `sessionId`, `receivedBy ∈ {BEACON, KEEPALIVE, POLL}`.

Event types and whether they count toward a strike:

| Type | Severity | Counts | Notes |
|---|---|---|---|
| `EXAM_STARTED` | INFO | no | carries the preflight record |
| `FULLSCREEN_ENTERED` / `FULLSCREEN_EXITED` | INFO / VIOLATION | exit only | exit is a strike when `requireFullscreen` |
| `FULLSCREEN_DENIED` | WARN | no | capability/permission failure — a problem, not cheating |
| `POINTERLOCK_ENTERED` / `POINTERLOCK_LOST` | INFO / WARN | only past grace | `Escape` always releases it; treated as WARN, not VIOLATION |
| `WINDOW_BLURRED` / `WINDOW_FOCUSED` | WARN | past threshold | threshold policy-controlled |
| `TAB_HIDDEN` / `TAB_VISIBLE` | WARN | past threshold | |
| `MULTI_TAB_DETECTED` | VIOLATION | yes | second live attempt session |
| `COPY_ATTEMPT` / `PASTE_ATTEMPT` / `CONTEXT_MENU` / `PRINT_ATTEMPT` | WARN | policy | |
| `SAVE_ATTEMPT` / `DEVTOOLS_SIZE_ANOMALY` | INFO | no | advisory evidence only, never punitive |
| `SAVE_REJECTED_LATE` | INFO | no | server-side; means the client tried to write past a deadline |
| `QUESTION_WINDOW_CLOSED` | INFO | no | consequence of a per-question timeout |
| `CLOCK_SKEW_DETECTED` | WARN | no | client clock vs server offset beyond threshold |
| `NETWORK_LOST` / `NETWORK_RESTORED` | INFO | no | |
| `AUTOSAVE_QUEUED` | INFO | no | outbox grew; explains later gaps |
| `SIM_LOAD_FAILED` | INFO | no | never penalises the student |
| `VIOLATION_THRESHOLD_REACHED` | VIOLATION | — | emitted by the server, not the client |
| `ATTEMPT_TERMINATED` / `ATTEMPT_SUBMITTED` | INFO | no | |

### 9.1 INV-TELEMETRY-1
> Client-supplied events are **evidence, never truth**. The server stamps `serverTs`, assigns `seq`, and can reclassify severity. A forged or replayed event can at worst add noise to a human's decision; it can never change a score, and it can never by itself void an attempt.

### 9.2 INV-TELEMETRY-2
> Telemetry carries no answer content, no keystrokes, no DOM text and no PII. Payload schemas are closed Zod objects with an explicit allowlist per event type; unknown keys are stripped at ingest.

---

## 10. Grading and release

- `QuestionResponse`: `autoScore?`, `autoGradedAt?`, `autoGradeRationale?` (teacher-only), `manualScore?`, `manualFeedback?`, `rubricScores Json?`, `graderId?`, `gradedAt?`, `isExcused`, `flagged`.
- `ReviewTask`: `(attemptId, graderId?)` with `status ∈ {PENDING, CLAIMED, DONE, RELEASED}`, `claimedAt?`, `priority`.
- `ReleaseBatch`: `(assignmentId, classroomId?)`, `status ∈ {DRAFT, READY, RELEASING, RELEASED, CANCELED}`. Membership is frozen when it enters `RELEASING`. `releasedAt`, `releasedById`.
- `ExamAttempt.releaseBatchId?` and `releasedAt?`.

### 10.1 INV-RELEASE-1 (atomic unseal)
> Release is performed by a single worker step that, in one database transaction: verifies every attempt in the batch is `GRADED` (or an override reason is recorded), sets `finalScore`, sets `releaseBatchId`, sets `releasedAt`, and marks the batch `RELEASED`. There is no intermediate state in which some attempts in a batch are visible. If the transaction fails, nothing is released and the job retries idempotently.

### 10.2 INV-RELEASE-2 (no partial signal)
> A student must not be able to infer a score before release. Therefore: no score appears in any endpoint, no count of correct answers leaks, no "you got 8/10 right" toast, no difference in response time or status code, no cache header variance. The pre-release student response is a fixed, score-free DTO.

### 10.3 Score computation
```
rawTotal   = Σ (response.isExcused ? 0 : response.finalScore ?? 0)
maxTotal   = Σ (question.points for questions not excused)
percentage = rawTotal / maxTotal
lateFactor = attempt.isLate ? (1 - assignment.latePenaltyPercent/100) : 1
final      = round(percentage * 100 * lateFactor, 2)
```
Weights and letter grades are derived views, never stored as truth.

### 10.4 Regrade
Changing an auto-grade configuration or a manual score appends a `GradeChange` audit record, recomputes the attempt, and — if the attempt was already released — sets `regradeNoticePendingAt` so the student sees a "results were updated" notice. Regrade of a whole assignment is a background job with progress and a dry-run preview of affected attempts.

---

## 11. Simulation registry

- `Simulation`: `id` (reverse-DNS-ish slug, e.g. `maths.projectile-motion`) is the natural key; `version` follows. Unique `(id, version)`. `status ∈ {REGISTERED, DEPRECATED, DISABLED}`. `manifest Json` holds the full `sim.manifest.json`. `bundlePath`, `bundleSha256`, `byteSize`. `graderEntry` (path to the Node-side grader module). `licence`, `provenance`, `authors`.
- Registry rows are created by the build pipeline, never by end users. A deprecated version keeps working for resources pinned to it; `replacedById` guides migration.

### 11.1 INV-SIM-1
> A simulation is untrusted code. It runs in an iframe without `allow-same-origin`, on an isolated origin, under a strict CSP, communicates only over nonce-verified `postMessage`, and has no network, storage or cookie access. It cannot affect the host beyond the frames defined in `sim-host@1`.

### 11.2 INV-SIM-2 (gradeability without a browser)
> Every simulation that can be an exam question exposes a pure `grader(state) → grade` function that runs in Node against the stored serialised state. Auto-grading a simulation question therefore never requires a browser, and the same code grades the student's live session and the reviewer's replay.

---

## 12. Cross-cutting invariants summary

| ID | Invariant |
|---|---|
| INV-CONTENT-1 | `ResourceVersion` is immutable |
| INV-ASSIGN-1 | Assessment surfaces derive only from the pinned version and the policy snapshot |
| INV-CLASSROOM-1 | Effective role is the max of active enrollments |
| INV-CLASSROOM-2 | Departure revokes classroom access, not personal records |
| INV-Q-1 | Answer keys never leave the server |
| INV-ATTEMPT-1 | Scores come only from the pure grader over stored answers |
| INV-ATTEMPT-2 | No partial result visibility, structurally enforced |
| INV-TELEMETRY-1 | Telemetry is evidence, never truth |
| INV-TELEMETRY-2 | Telemetry carries no content and no PII |
| INV-RELEASE-1 | Release is one transaction; no intermediate state |
| INV-RELEASE-2 | No score is inferable before release |
| INV-SIM-1 | Simulations are untrusted and isolated |
| INV-SIM-2 | Sim grading is pure and runs in Node |
| INV-TIME-1 | All time flows through `@orrery/clock`; the server is authoritative |
| INV-RNG-1 | All randomness flows through seeded `@orrery/rng`; the seed is stored with the attempt |
