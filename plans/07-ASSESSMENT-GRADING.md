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

> **Corrected after review (`23-REVIEW-ACTIONS.md` P-1…P-5).** The original version of this section defaulted to **NG** and justified it with a citation that had been **edited to support the opposite of what its source says**: `RN-05` records the METRON finding as *"all partial-credit functions improve reliability over no-credit (NC) and no-guessing (NG)"*, and NG **is** negative crediting. "NG-free scoring" was not a defined term. `RN-05` has been restored and the default replaced. Do not re-derive the old default from the old text.

`RN-05` supports exactly one conclusion here: **some** form of partial credit improves reliability over dichotomous scoring, and functions that penalise incorrect selections improve it further. It does **not** support a specific default. The default below is chosen on different grounds, stated openly.

| Method | Rule | Gameable by select-all? | Properties | Use when |
|---|---|---|---|---|
| **NC** (no credit) | all correct → full, else 0 | No | Highest face validity, lowest reliability, rewards guessing at `1/c` | High-stakes gates; tiny stakes |
| **1PM** (partial all-or-nothing) | +1 per correct option selected, 0 for incorrect, **0 overall if more options are selected than there are correct ones** | **No** | Bounded below, never negative, no guessing incentive, and the most widely used method in the literature | **Default** |
| **NG** (negative) | `correct − incorrect` | **Yes, when `C > M/2`** | Suppresses guessing *a priori*; produces **negative raw scores** | Only when the publish-time guard below passes |
| **SU** (subset) | score only if the response is a **subset of the key**; then proportional | No | Lenient about **omissions**, **absolute about commission**. Selecting any incorrect option scores **zero** | Distractors are genuinely attractive rather than wrong |
| **RI** (Ripkey) | +1 correct, −1 incorrect, only if the response is no larger than the key | No (the size clause saves it) | Forgives irrelevant selections when the set is small | Low-stakes practice |
| **PM** (plus/minus) | +1 correct, −1 incorrect, regardless of set size | **Yes** | Best IRT fit in comparative studies (`RN-05`) | Only with a size guard, or when IRT follows |
| **PROP** (proportional) | `correct / total` | No | Simple, transparent, no penalty | Low-stakes; youngest students |

### 3.1 Why 1PM is the default
Not because the cited literature says so — it does not — but on three grounds we can defend:
1. **It is naturally bounded.** `0 ≤ points ≤ maxPoints` holds without a floor, so it coexists with the invariant in §4 that is property-tested. `NG` and `PM` do not (§3.2).
2. **It cannot be gamed by select-all**, because the size clause zeroes the response (§3.3).
3. It is the field's most-used method, so a teacher's prior intuitions transfer.

### 3.2 NG and the bounded-points invariant
`NG` produces negative raw scores **by design**. Clamping at zero in the item is a **nonlinear** transform: it silently converts NG into "no penalty" for every student who guessed — destroying the guessing suppression NG exists to provide — while keeping the penalty for students who did not guess. It also changes the item's relationship to the total score, which invalidates the discrimination statistics in `08-ITEM-ANALYSIS.md`.

**Rule if `NG` or `PM` is used:**
- `QuestionResponse.autoRawScore` stores the **raw, possibly negative** value; item statistics are computed on that raw scale.
- The zero floor is applied **in the attempt total only** (`01-DOMAIN-MODEL.md` §10.1).
- The `08` report states that the item's statistics are on the raw scale.

### 3.3 Publish-time gameability guard
The `testGrader` harness displays the **select-all score** for every method on the item, and a publish check refuses a configuration that is gameable:

```
selectAllScore = f(M options, C correct keys)
publish refuses NG or PM when selectAllScore > 0
i.e. refuse when 2C − M > 0
```
Concretely: 5 options with a 3-option key pays a third of the marks for selecting everything under NG, and 6 options with a 4-option key pays two thirds. Where a teacher genuinely wants a negative-credit item, the authoring UI offers to **cap the number of selectable options** or switch to 1PM, and says why in one line.

### 3.4 Other graders worth specifying
- **Numeric significant figures**: correct only if within tolerance *and* stated to at least the required significant figures. This teaches precision, which is usually the point.
- **Short text fuzzy**: stopwords removed, stems stripped, token-overlap ≥ author threshold. The rationale shows a **token diff** so a teacher can sanity-check the machine's judgement. A teacher must never be asked to trust an opaque score.
- **Ordering**: credit = fraction of correctly-ordered adjacent pairs. A student with 3 of 4 in correct relative order earns most of the credit — which is pedagogically right.
- **Simulation**: `grader(simState, params, answer)` from the sim's Node bundle, run in an isolated worker thread (`14-SECURITY-PRIVACY.md` §5). If the state fails `stateSchema`, the response is flagged `needsHuman` and routed to review. **A student is never auto-zeroed because our code failed** (`INV-SIM-2`).
  - A simulation usable as a question must declare `scoringSurface` (`10-SIMULATIONS.md` §3). `ENDPOINT_ONLY` reads only the final answer. `PATH_SENSITIVE` reads a bounded interaction trace. Without this field the item measures parameter-space search, and its facility will look **excellent** while measuring nothing (`V-11`).

### 3.5 Moderated sampling — the promise is atomicity, not 100% individual marking
> Corrected after review (`T-1`). The plan conflated two different things.

The product's promise is that a student never sees a **partial** result. That requires that whatever the teacher has **decided** be released together. It does **not** require every free response to be individually marked by a human. Real examination systems mark a moderated *sample*.

| Mode | Behaviour |
|---|---|
| `FULL_MANUAL` (default for small cohorts) | Every free response individually graded. The original behaviour. |
| `MODERATED_SAMPLE` | A random sample is double-marked, the cohort's marks are estimated, and every attempt is still released **atomically**. Sample size and moderation rule are assignment configuration (`Assignment.moderationSampleSize`, `moderationPercent`). |

At 300 students this is the difference between an assessment costing a teacher 8 hours and one costing 40 minutes. The atomicity guarantee is untouched.

### 3.6 Marking rate and inter-rater reliability
> Added after review (`T-2`, `T-3`). The psychometrics in `08` applied to the *auto-grader*; the product's actual work is human marking, and it had no reliability apparatus at all.

- **Quick-scored responses are recorded as such** (`QuestionResponse.wasQuickScored`) and sampled for moderation. A teacher marking at 10 s/script and one at 90 s/script produce visibly different confidence, not the same number.
- **10–20% of every release batch is double-marked** (`ReviewAssignment.isSecondMarker`).
- **Raw agreement and linearly-weighted κ are reported per rubric.** A rubric whose bands disagree between two teachers is a **defect in the rubric**, and is surfaced in authoring rather than averaged away.
- Marking rate is instrumented and shown to the teacher, not used to rank them.

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

## 6. Release — redesigned after review
> **This section was substantially wrong and has been replaced** (`23-REVIEW-ACTIONS.md` B16). The original released a batch by recomputing 5,000 attempts × 30 responses = **150,000 pure-grader invocations inside one database transaction**, then writing ~155,000 rows that all had to be WAL-fsynced before commit. Against its own SLO of `p95 < 60 s` that is 75–300 s while holding 155,000 row locks. Worse, "verify everything, then open the transaction" is a **TOCTOU window**: a teacher can grade an attempt between the verify and the commit, and the batch then releases a stale `finalScore`. The plan's most important correctness claim did not hold at the scale it claimed.

### 6.1 The mechanism: a single-row gate

There is exactly one visibility rule, and it reads one indexed table:

```sql
released = EXISTS (
  SELECT 1 FROM "ReleaseBatchMember" m
  JOIN "ReleaseBatch" b ON b.id = m."batchId"
  WHERE m."attemptId" = $1 AND b.status = 'RELEASED'
)
```

"Release" is therefore **one statement**:

```sql
UPDATE "ReleaseBatch" SET status='RELEASED', "releasedAt"=now(), "releasedById"=$2
WHERE id = $1 AND status IN ('READY','RELEASING');
```

| Property | How it is obtained |
|---|---|
| **Atomic** (`INV-RELEASE-1`) | One row, one statement. Trivially true rather than expensively true. |
| **All-or-nothing across a batch** | Structural: the batch status is the only gate, so a partial state is not representable. |
| **Idempotent** | `status IN ('READY','RELEASING')` makes a repeat a no-op. |
| **Resumable** | There is nothing to resume. A crash either flipped the row or did not. |
| **O(1) in batch size** | 5,000 attempts and 5 cost the same. |
| **Instant** | No recomputation inside the transaction. |

`ReleaseBatch.membership Json` — a 190 KB TOASTed array that had to be read to enumerate candidates — **is gone**, replaced by real `ReleaseBatchMember` rows. The pre-release gate becomes a normal indexed query.

### 6.2 Where the arithmetic moved
Grade totals are computed **before** the batch reaches `READY`, by `grade.recompute`, not during release. `autoScore`/`manualScore` are already persisted per response at grade time, so the release path does no arithmetic at all.

This is also more correct: grades are settled at grading time, and release only decides *visibility*. The two concerns were conflated because the original transaction did both.

### 6.3 Pre-release gate
Release is blocked while any member attempt is not `GRADED`, and the blockers are listed. A teacher may override with a reason, stored on the batch and in the audit log. `C1` fixed a related trap: `EXPIRED` attempts previously had **no path to `GRADED`**, so any class containing one student who never pressed Submit required a permanent override. The sweep now runs `IN_PROGRESS → EXPIRED → grade.auto → GRADED`, and `EXPIRED` is non-terminal in the gate.

`minHoldUntil` implements the minimum pre-release review window that the research notes had claimed and nothing had implemented (`K-4`).

### 6.4 Durability
`synchronous_commit` on, with a synchronous standby, for the tables carrying submissions and receipts. **RPO restated honestly:** 0 for submissions, answers and receipts; 15 minutes for evidence telemetry and analytics rollups. The original 15-minute RPO could lose an *acknowledged release*, which is not compatible with a "zero data loss" completion criterion.

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
