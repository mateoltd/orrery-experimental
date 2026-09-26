# Assessment, Grading & Release

How questions are authored, graded, reviewed and — critically — withheld until a human says so.

---

## 1. Two modes, one model

| | Quiz | Exam |
|---|---|---|
| Runtime | Permissive defaults, one question or all at once | Integrity policy (§ `05-EXAM-INTEGRITY.md`) |
| Attempts | Configurable, often unlimited | Usually 1, occasionally 2 |
| Timing | Often untimed | Total and per-question limits, availability window |
| Auto-grades | Sealed until release (`reviewMode: MANUAL`) or auto-released (`AUTO_RELEASE`, quizzes only) | Always sealed (`reviewMode: MANUAL`) |
| Nav | Free | Palette + flag-for-review |

Same data model, same question types, same grader. The mode only selects a default policy. This is deliberate: one code path means one set of bugs to find.

---

## 2. Question types

Every type is a Zod discriminated union member in `@orrery/contracts`. Adding a type forces an update to the public projection, the grader, the authoring UI and the response renderer — enforced by an exhaustive `switch` with a `never` check that fails compilation.

| Type | Answer shape | Grading | Notes |
|---|---|---|---|
| `single_choice` | `{ choiceId }` | AUTO | one correct option; optional per-option feedback |
| `multi_select` | `{ choiceIds: string[] }` | AUTO | partial credit: `allOrNothing` or `proportional`; configurable min/max |
| `true_false` | `{ value: boolean }` | AUTO | trivial variant of single choice; distinct for authoring clarity |
| `numeric` | `{ value: number, unit?: string }` | AUTO | tolerance: absolute and/or relative; significant-figures policy; unit conversion table; `acceptExpression` for simple algebra |
| `short_text` | `{ text: string }` | AUTO or MANUAL | matching: `EXACT`, `NORMALISED` (case/punctuation/whitespace), `REGEX_SET`, `FUZZY` (token overlap with a threshold), or `NUMERIC_TOLERANCE` on extracted numbers |
| `free_response` | `{ text: string }` | MANUAL | rubric-based, with an optional auto-checked keyword/concept layer that only *suggests* to the grader |
| `file_submission` | `{ assetIds: string[] }` | MANUAL | presigned uploads, type/size allowlist, virus scan, inline preview |
| `simulation` | `{ simState, answer }` | AUTO or MANUAL | the sim's pure grader runs server-side; teacher can override with a reason and replay the state |
| `ordering` | `{ itemIds: string[] }` | AUTO | partial credit on adjacent pairs (Kendall-tau style) |

Each question also carries: `points`, `gradingMode`, `timeLimitSec?`, `shuffle?`, per-option feedback, an optional model answer, and `estimatedSeconds` (used for pacing hints and for item analysis).

### 2.1 `@orrery/grading` — the pure core
```ts
type GradeInput  = { spec: QuestionSpec; response: ResponseAnswer; variant: QuestionVariant }
type GradeOutput = { points: number; maxPoints: number; correct: boolean; rationale: Rationale }
grade(input: GradeInput): GradeOutput     // pure, total, deterministic
```
Rules that make this trustworthy:
- **Pure.** No clock, no I/O, no randomness, no network. It is a function of its arguments.
- **Total.** Every (spec, response) pair returns a `GradeOutput`, including malformed and missing responses. No throws escape.
- **Versioned.** The grader version is stored on each auto-graded response, so re-grading with new logic is an explicit, auditable act rather than a silent change.
- **Fixture-tested.** Every type has hand-computed fixtures, plus property-based tests over randomised specs and responses (monotonicity, bounds, idempotence, symmetry where expected).
- **Branch coverage target: 100%.** This package decides people's grades.

### 2.2 Grading examples worth writing down
- **Multi-select, proportional:** `selected ∩ correct` / `correct.length` × points, but zero if the student selected anything outside `correct` when the question is marked `noDistractors`. Rationale explains exactly which options were wrong, and is teacher-visible before release.
- **Numeric significant figures:** correct only if the student's value is within tolerance *and* stated to at least the required significant figures. Teaches precision, which is the point.
- **Short text fuzzy:** token-overlap ≥ threshold, stopwords removed, stems stripped (`"the cell's membrane"` ≡ `"cell membrane"`). Threshold is author-set; the rationale shows the token diff so a teacher can sanity-check the machine.
- **Ordering partial credit:** score = points × (fraction of correctly-ordered adjacent pairs). A student who gets 3 of 4 items in the right relative order gets most of the credit — pedagogically right.
- **Simulation:** `grader(simState, params, answer)` from `@orrery/sim-sdk`. If the state fails its schema, the question is routed to a human rather than scored zero. **A student is never auto-zeroed because our code choked.**

---

## 3. The withholding rule

> Multiple-choice and other automatically gradable items are graded automatically at submission, but students see those results **only when the rest of the exam feedback and grades are released as well.**

Implementation, in three layers:

**Layer 1 — storage.** `ExamAttempt.autoScore`, `manualScore`, `finalScore`, `percentage` and each response's `autoScore`/`autoCorrect` are written at submission. They are simply not in any student-facing projection. `releasedAt IS NULL` means sealed.

**Layer 2 — DTO construction.** Student-facing DTO builders take `{ attempt, released }` and have exactly two branches. There is no code path that returns a score field when `released` is false — not a `null`, not a rounded approximation, not a "you did well" hint. The pre-release payload is a fixed, score-free shape.

**Layer 3 — verification.** `P10-T8` enumerates every student-facing route (tRPC procedures, REST endpoints, Next.js server actions, RSC loaders, error payloads, meta tags, `robots`-adjacent metadata, Sentry breadcrumbs, analytics events) and asserts no score-bearing field is reachable while `releasedAt IS NULL`. The test is machine-checked and runs in CI on every PR and in the release checklist. It also asserts that the pre-release and post-release payloads differ in *status* only where documented, so no timing or size oracle leaks a score.

This is the product's promise to students: **no partial credit visibility, ever**. It is enforced structurally rather than by discipline, because a single leaky `?count=8` query parameter would break a promise that teachers rely on.

---

## 4. Attempt lifecycle and the review pipeline

```
student submits
   │
   ├─ server auto-grades everything AUTO            → sealed
   ├─ counts MANUAL questions
   │
   ├─ manual count > 0  → status PENDING_REVIEW, ReviewTask created (priority by age)
   │                          │
   │                          ├─ teacher claims (optimistic lock, presence shown)
   │                          ├─ grades each MANUAL question (score, feedback, rubric)
   │                          ├─ optional: review sealed auto-grades, flag a bad key
   │                          ├─ all resolved → status GRADED, final computed (still sealed)
   │                          └─ cannot resolve (student vanished) → teacher excuses it
   │
   └─ manual count == 0 → status GRADED immediately (still sealed)
                          │
                          └─ teacher builds a ReleaseBatch and releases it
                                 → transaction unseals everything in the batch at once
```

### 4.1 The grading workspace
One submission, one screen, built for volume:
- Question-by-question with the prompt, the student's answer, and the sim replay side by side.
- Keyboard-first: `J`/`K` next/previous, `1`–`9` quick-score, `Enter` save and advance, `E` excuse, `F` flag. A teacher can clear 200 free responses without touching the mouse.
- Rubric editor with banded descriptors; applying a rubric band sets the score and prefills feedback that the teacher edits.
- Saved drafts so a half-graded submission survives a closed tab.
- Sealed auto-grades visible but **not** editable inline — a teacher who believes a key is wrong flags it, which triggers a regrade review across all affected attempts (audited) rather than a quiet local override.
- Simulation answers: "replay" re-runs the sim's Node grader against the stored state and shows the trace. Override requires a reason.

### 4.2 Review queue
Filters: assignment, classroom, reviewer (mine/unclaimed/all), age, question type, flagged, has-sim-answers. Bulk claim. Age and count indicators so nothing rots. Every attempt in the queue is visible to every teacher in the classroom, but claiming takes a soft lock with presence so two people do not silently overwrite.

---

## 5. Release

```ts
await releaseBatch(batchId, actorId, { overrideReason? })
// 1. load batch, require status ∈ {READY}
// 2. freeze membership: snapshot the attempt ids
// 3. TRANSACTION:
//      for each attempt:
//        assert status == GRADED  (or collect blockers for the override path)
//        compute finalScore from responses (pure grader, re-run)
//        set finalScore, percentage, latePenaltyApplied, releaseBatchId, releasedAt
//      set batch.status = RELEASED, releasedById, releasedAt
// 4. enqueue notifications (outside the transaction)
// 5. write audit events
```
- **Atomic.** All of a batch, or none. There is no window in which half a classroom can see grades.
- **Idempotent and resumable.** A crash mid-job leaves nothing released; the retry completes it. Re-running a released batch is a no-op.
- **Pre-release gate.** If any attempt in the batch is not `GRADED`, release is blocked and the blockers are listed. A teacher may override with a reason, which is stored on the batch and in the audit log.
- **Bulk scale.** A 5,000-attempt release is a background job with progress, chunked inside one transaction per chunk only if the whole batch can be verified first — the atomicity guarantee is preserved by verifying *all* attempts are releasable *before* opening the write transaction, then writing in a single transaction (Postgres handles 5,000 row updates comfortably).

### 5.1 What the student sees
**Before release:** "Submitted. Your teacher is reviewing responses. You'll be notified when results are released." Plus the submission time, the receipt hash, and their own answers. No score, no partial signal.

**After release:** per-question outcome, the correct answer (if the author allowed it), the feedback, the score breakdown, the receipt hash, a regrade notice if applicable, and their accommodations marker if they chose to show it.

---

## 6. Regrade

Triggers: a flagged wrong auto-key, a rubric change, a teacher bulk correction, a changed late-penalty policy.

```
regradeAssignment(assignmentId, { questionIds?, reason, dryRun })
  → dry run returns: affected attempts, score deltas, count of already-released attempts
  → confirm
  → background job: recompute per attempt, append GradeChange + AttemptEvent(REGRADED)
  → if attempt.releasedAt != null → set regradeNoticePendingAt
  → invalidate analytics rollups
  → notify affected students (batch, not per attempt)
```
An already-released attempt is never silently changed: the student gets a visible "your results were updated" notice with the reason. Regrades are append-only in the audit trail, with before/after values.

---

## 7. Late, missing, excused

| State | Meaning | Effect on grade |
|---|---|---|
| `onTime` | submitted before `deadlineAt` | none |
| `late` | submitted within `gracePeriodSec` | `latePenaltyPercent` applied at computation, so the penalty is adjustable and auditable |
| `lateUnaccepted` | submitted after the grace window | treated as the server's last-held state; flagged for the teacher |
| `missing` | no attempt, window closed | excluded from the gradebook denominator per the assignment's policy |
| `excused` | teacher-marked | removed from both numerator and denominator |
| `voided` | integrity failure upheld | scores discarded, attempt retained in the audit trail |

Every transition writes an `AttemptEvent`. `extendDeadline` is an audited per-attempt action, available to teachers during an exam, with a reason. It is the correct answer to "the wifi died in my classroom" and it must be easy, or teachers will not use it and will instead not enforce deadlines at all.

---

## 8. Item analysis (used to improve teaching, not to rank students)

Per question, per assignment: p-value (difficulty), point-biserial discrimination, top-27% / bottom-27% split, distractor selection frequencies, time-on-item percentiles, and the count of free-text responses flagged by similarity clustering. Presented to teachers as *"this question is too hard / this distractor is attracting 60% of students / everyone spent 4× the median here"* — actionable, and it is how the catalogue gets better.
