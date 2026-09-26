# 07 — Assessment, Grading & Release

Question types, the partial-credit taxonomy, the pure grader, the review workspace, and the atomic release that is the product's central promise.

---

## 1. Two modes, one model

| | Quiz | Exam |
|---|---|---|
| Policy | Permissive defaults | Integrity policy (`09-EXAM-INTEGRITY.md`) |
| Timing | Often untimed | Total and per-question limits, availability window, grace |
| Attempts | Configurable, often unlimited | Usually 1 |
| Navigation | Free | Sequential with lock, or palette + flag |
| Practice | Optional ungraded practice attempt | **`RN-04`**: an ungraded practice run before the real thing is standard practice in Canvas deployments and it prevents exam-day technical failures |
| Release | `MANUAL` (default) or `AUTO_RELEASE` | `MANUAL` only (`D6`) |

Same data model, same question types, same grader. The mode only selects a default policy. One code path means one set of bugs to find.

---

## 2. Question types

A Zod discriminated union in `@orrery/contracts`. Adding a type fails compilation in the public projection, the grader, the authoring UI and the response renderer (exhaustive `switch` with a `never` check).

| Type | Answer shape | Grading | Notes |
|---|---|---|---|
| `single_choice` | `{ choiceId }` | AUTO | one correct; per-option feedback |
| `multi_select` | `{ choiceIds[] }` | AUTO | **five named partial-credit methods — see §3** |
| `true_false` | `{ value: boolean }` | AUTO | distinct for authoring clarity |
| `numeric` | `{ value, unit? }` | AUTO | absolute/relative tolerance, significant-figures policy, unit table, `acceptExpression` |
| `short_text` | `{ text }` | AUTO or MANUAL | `EXACT`, `NORMALISED`, `REGEX_SET`, `FUZZY` (token overlap), `NUMERIC_TOLERANCE` on extracted numbers |
| `ordering` | `{ itemIds[] }` | AUTO | partial credit on adjacent pairs |
| `free_response` | `{ text }` | MANUAL | rubric bands; an optional auto keyword/concept layer that only *suggests* |
| `file_submission` | `{ assetIds[] }` | MANUAL | presigned upload, allowlist, scan status, inline preview |
| `simulation` | `{ simState, answer }` | AUTO or MANUAL | the sim's **pure Node grader** runs server-side (`INV-SIM-2`) |
| `worked_solution` | `{ steps[] }` | MANUAL | multi-part, per-step credit; the closest thing we have to a proof |

Each question also carries `points`, `gradingMode`, `timeLimitSec?`, `shuffleOptions`, `estimatedSeconds`, `cognitiveDemand`, tags, and an optional teacher-only `modelAnswer`.

### 2.1 Projections
- `publicQuestionSpec()` — the student payload. Strips keys, model answers, rubrics, rationales, and (for free response) any authoring notes. **Exhaustively typed**, so a new type cannot ship without a projection.
- `teacherQuestionSpec()` — the key, rubric, rationale, plus a live `testGrader` harness.

### INV-Q-1
> No client payload, HTML, log, trace, error, Sentry breadcrumb or analytics event may contain `spec` key material. Enforced by `audit:seals` and `audit:payloads` in CI, and by the full route audit in P10.

---

## 3. Partial credit: a named taxonomy, not a boolean

`RN-05` is unambiguous that multi-select partial credit is a genuine measurement problem with several established methods and different validity properties. "All or nothing vs proportional" is not enough, and the choice is consequential enough that it should be a deliberate, named decision by the author. Implemented methods:

| Method | Rule | Properties | Use when |
|---|---|---|---|
| **NC** (no credit) | all correct → full, else 0 | Highest face validity, lowest reliability, rewards guessing at 1/c | High-stakes gates; small stakes |
| **NG** (no guessing / negative) | correct − incorrect | Suppresses guessing; measurably improves reliability over NC (`RN-05`) | The default for multi-select in exams |
| **SU** (subset) | score only if the response is a subset of the key; then proportional | Lenient — irrelevant selections are forgiven | When distractors are genuinely attractive rather than wrong |
| **RI** (Ripkey) | +1 per correct selected, −1 per incorrect selected, but only if the response is no larger than the key | More lenient than SU; rewards partial knowledge | Low-stakes practice |
| **PM** (plus/minus) | +1 correct, −1 incorrect, regardless of set size | Strongest IRT fit in comparative studies (`RN-05`) | When you will later run IRT |

**Default: NG**, because `RN-05` finds negative crediting materially improves reliability over both NC and NG-free scoring, and because it is the least gameable: a student cannot gain by selecting everything.

Exposed to authors as a labelled choice with a one-paragraph explanation of the trade-off, plus a live `testGrader` demonstration showing the score for four sample student responses. We are not asking a teacher to pick a scoring function blind.

### 3.1 Other graders worth specifying
- **Numeric significant figures**: correct only if within tolerance *and* stated to at least the required significant figures. This teaches precision, which is usually the point.
- **Short text fuzzy**: stopwords removed, stems stripped, token-overlap ≥ author threshold. The rationale shows a **token diff** so a teacher can sanity-check the machine's judgement. A teacher must never be asked to trust an opaque score.
- **Ordering**: credit = fraction of correctly-ordered adjacent pairs. A student with 3 of 4 in correct relative order earns most of the credit — which is pedagogically right.
- **Simulation**: `grader(simState, params, answer)` from the sim's Node bundle. If the state fails `stateSchema`, the response is flagged `needsHuman` and routed to review. **A student is never auto-zeroed because our code failed** (`INV-SIM-2`).

---

## 4. `@orrery/grading` — the pure core

```ts
type GradeInput  = { spec: QuestionSpec; response: ResponseAnswer; variant: QuestionVariant; graderVersion: string }
type GradeOutput = { points: number; maxPoints: number; correct: boolean; rationale: Rationale; flags: GradeFlag[] }
grade(input: GradeInput): GradeOutput
computeAttemptTotals(attempt, responses): Totals
hashAnswerChain(attempt, responses): string   // the tamper-evident receipt
```

Properties that make this trustworthy:
- **Pure.** No clock, no I/O, no randomness, no network. A function of its arguments.
- **Total.** Every `(spec, response)` pair returns a `GradeOutput`, including malformed, missing, and hostile responses. No throw escapes. A grader that can crash is a grader that can be made to skip a student's grade.
- **Versioned.** `graderVersion` is stored per response, so a logic change is an explicit, auditable regrade rather than a silent rewrite of history.
- **Bounded.** `0 ≤ points ≤ maxPoints` always, including on malformed input. Property-tested.
- **Idempotent.** Same input → byte-identical output. Re-running never drifts.
- **Coverage**: **100% branch**, enforced by a dedicated coverage threshold that cannot be lowered.
- **Fixtures**: hand-computed expected grades for every type × every method, **reviewed by a second person**. These are the numbers that decide students' grades.

### 4.1 The auto-grader test harness
`bank.testGrader` runs the production grader against a sample answer and shows points plus the rationale. During authoring this is the highest-leverage trust feature we ship: a teacher can see the key working before a student does, and can catch a mis-keyed item while it is still cheap to fix.

---

## 5. The review pipeline

```
submit
 ├─ pure grader over every AUTO question → SEALED
 ├─ count MANUAL questions
 │
 ├─ manual > 0 → PENDING_REVIEW, ReviewTask created (priority by age)
 │                teacher claims (optimistic lock + presence)
 │                grades each MANUAL question (score, feedback, rubric)
 │                optionally reviews sealed auto-grades and flags a bad key
 │                all resolved → GRADED, totals computed, still SEALED
 │                unresolvable (student vanished) → teacher excuses
 │
 └─ manual = 0 → GRADED immediately, still SEALED
                      │
                      teacher builds a ReleaseBatch and releases it
                      → one transaction unseals everything in the batch
```

### 5.1 The grading workspace
Built for volume, because a teacher with 200 free responses is a customer we can lose:
- Prompt, student answer and **sim replay** side by side.
- Keyboard-first: `J`/`K` navigate, `1`–`9` quick-score, `Enter` save and advance, `E` excuse, `F` flag, `R` open feedback. A teacher can clear 200 free responses without a mouse.
- Rubric editor with banded descriptors; applying a band sets the score and prefills editable feedback.
- Saved drafts; a half-graded submission survives a closed tab.
- Sealed auto-grades **visible but not editable inline** — a teacher who believes a key is wrong flags it, which triggers a reviewed regrade across all affected attempts rather than a quiet local override.
- Simulation answers: **replay** re-runs the Node grader against stored state and shows the trace; an override requires a reason and is audited.
- Concurrency: optimistic lock per response with presence indicators, so two teachers never silently overwrite each other.

### 5.2 Review queue
Filters: assignment, classroom, reviewer (mine / unclaimed / all), age, question type, flagged, has-sim-answers, `needsHuman`. Bulk claim. Age and count indicators so nothing rots. Every teacher in the classroom can see the queue; claiming takes a soft lock.

---

## 6. Release

```ts
await releaseBatch(batchId, actorId, { overrideReason? })
// 0. require status ∈ { READY }
// 1. freeze membership: snapshot the attempt ids
// 2. verify EVERY attempt is GRADED  (collect blockers otherwise)
// 3. TRANSACTION:
//      for each attempt:
//        recompute totals with the pure grader (never trust stored partial state)
//        set finalScore, percentage, latePenaltyApplied, releaseBatchId, releasedAt
//      set batch RELEASED, releasedById, releasedAt
// 4. outside the transaction: notifications, rollup invalidation, xAPI, audit
```

- **Atomic** — all of a batch or none. No window in which half a classroom can see grades (`INV-RELEASE-1`).
- **Idempotent and resumable** — a crash releases nothing; the retry completes it; re-running a released batch is a no-op.
- **Pre-release gate** — any attempt not `GRADED` blocks release and the blockers are listed. A teacher may override with a reason, stored on the batch and in the audit log.
- **Scale** — a 5,000-attempt release verifies all, then writes in a single transaction. Postgres handles 5,000 row updates comfortably; the atomicity guarantee is preserved by verifying *everything* before opening the write transaction.

### 6.1 INV-RELEASE-2 — no score is inferable
No score field, no count of correct answers, no toast, no difference in status code, no difference in payload size, no cache-header variance, no analytics event. The pre-release payload is a fixed, score-free DTO. A machine-checked audit enumerates every student-facing route and asserts it. **This is a release gate, not a test.**

### 6.2 What students see
**Before release:** "Submitted. Your teacher is reviewing responses. You'll be notified when results are released." Plus submission time, receipt hash, and their own answers.
**After release:** per-question outcome, correct answers where the author allowed, feedback, score breakdown, receipt hash, a regrade notice if applicable, and their accommodations marker if they chose to show it.

---

## 7. Regrade

```
regrade(assignmentId, { questionIds?, reason, dryRun })
  → dry run: affected attempts, score deltas, count of already-released attempts
  → confirm
  → background job: recompute per attempt, append GradeChange + AttemptEvent(REGRADED)
  → if releasedAt != null → regradeNoticePendingAt (the student is told, with the reason)
  → invalidate analytics rollups · batch-notify affected students
```
An already-released attempt is never silently changed. Regrades are append-only with before/after values.

---

## 8. Late, missing, excused, void

| State | Meaning | Effect |
|---|---|---|
| `onTime` | submitted before `deadlineAt` | none |
| `late` | within `gracePeriodSec` | `latePenaltyPercent`, applied at computation so it stays adjustable |
| `lateRejected` | after the grace window | the server's last-held state stands; flagged for the teacher |
| `missing` | no attempt, window closed | excluded from the gradebook denominator per assignment policy |
| `excused` | teacher-marked | removed from numerator and denominator |
| `voided` | integrity concern upheld by a human | scores discarded; audit retained |

Every transition writes an `AttemptEvent`. **`extendDeadline` is an audited per-attempt action available during a live exam, and it must be easy** — because if a teacher's only options are "rigid policy" or "no deadlines at all", they will choose the latter, and the whole integrity model collapses. Making the honest exception cheap is a correctness feature.

---

## 9. What we deliberately do not build

| Not building | Why |
|---|---|
| Automated misconduct detection that punishes | `RN-01`: sensitivity is catastrophic. `ADR-0017` |
| Partial release of auto-graded items | Contradicts the product's central requirement |
| Student-facing "you got 8/10 right" nudges pre-release | Would break the promise teachers depend on |
| A grader that guesses intent on free response | An opaque score a teacher must trust is worse than a queue item |
| Streaming "live" grading scores | Same reason as above |
