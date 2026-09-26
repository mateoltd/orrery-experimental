# 09 — Exam Runtime & Integrity

**The highest-risk document in this plan. Read it before touching any exam code.**

The exam is the product's trust boundary. A teacher's decision to give a grade must rest on evidence, not on a promise from a student's browser.

---

## 1. What the evidence actually says

We designed this section from the research rather than from intuition, and the research is not what vendors would like you to hear.

| Finding | Source | Consequence here |
|---|---|---|
| Automated proctoring has **high specificity and catastrophically low sensitivity**. In a controlled trial with 6 staged cheaters, automated detection caught **none**; human review caught 1. False positives: 0% automated, 4% human. | `RN-01` | Any system that flags a student as a cheater is mostly right when it says "fine" and mostly wrong when it says "flag". So it must not be allowed to decide. **Evidence only.** |
| Scores fell **10–20%** after proctoring was adopted at one institution, which the authors read as evidence that cheating had previously been common. | `RN-01` | **Corrected after review (`P-19`).** The original plan adopted that reading and called the drop "the intended effect". **That inference is not available, and it is load-bearing.** The same drop is equally consistent with measurement variation, a different item sample, regression to the mean after a selection decision, or the added cognitive load of the controls. See §1.1. |
| Proctored (lockdown-only) students **completed in half the time and scored significantly lower** than unproctored peers on the same exam. | `RN-03` | The controls themselves change performance. Any control that adds cognitive load is a measurement intervention, not free. |
| Meta-analysis, 49 studies, 100k+ test takers: unproctored internet testing favours online ~0.20 SD, and the effect **collapses to near zero** when strict time limits, non-searchable content and lockdown are combined. Deep item pools and adaptive selection stop answer-sharing. | `RN-03` | Item-level design is the real lever. This is why `06-QUESTION-BANK-BLUEPRINT.md` is core scope and not a nice-to-have. |
| Facial detection is documented as **disproportionately false-flagging students of colour, students with accommodation needs, and students on unstable connections**. Universities publish advice to instructors not to enable it. | `RN-02` | **No biometric proctoring in v1 — absent, not "off by default"** (`D11`). If it is ever built it requires its own bias audit, per-institution consent and a human review queue. |
| Students are most comfortable with **lockdown browsers**, least comfortable with browser-history and webcam/screen recording. Installing a browser extension is itself a significant barrier. | `RN-01` | Zero-install is a hard requirement (`D4`). No extensions, ever. |
| Students widely report proctoring increasing anxiety and reducing performance. | `RN-01` | Accommodations mode, an opt-out path, and a published policy students can read in advance. |
| Editors widely note the raising of flags "needs to be overcautious, necessitating a large proportion of false positives", with a danger of **profiling students** based on flagged behaviour. | `RN-01` | No automated punitive action. A named teacher records a verdict with a reason. |

### 1.1 The score drop is a confound, not a success metric
> Corrected after review (`P-19`). The original plan wrote *"the score drop is the intended effect"*. That is wrong, and it gave the product a **target score reduction** — which is not something a measurement instrument should have.

The plan cites Alessio et al. in the same table: lockdown-only proctored students "completed in half the time and **scored significantly lower** on the same exam". That is the direct evidence that **the controls themselves change the score**. So a pre/post comparison cannot separate:

- "less cheating happened", from
- "students performed worse under the cognitive load of the controls"

Both produce a drop. They are indistinguishable after the fact, and they have opposite implications.

**Our position:** a pre/post score delta is an **unexplained change requiring investigation**, measured and disclosed to the teacher, and **never** a target. An organisation watching a "proctoring reduced scores by 15%" metric has an incentive to add controls and observe a fall. We refuse to supply that metric.

### 1.2 The number that actually settles it: base rate
> Added after review (`P-20`). The original led with "high specificity, low sensitivity" — true, and not the quantity that matters. The quantity that matters is the **positive predictive value**: of the students a system flags, how many were actually cheating?

Even a *hypothetical* excellent detector — 99% specificity, 30% sensitivity — applied to a cohort with 10% cheating:

```
PPV = (sens × prevalence) / (sens × prevalence + (1 − spec) × (1 − prevalence))
    = (0.30 × 0.10) / (0.30 × 0.10 + 0.01 × 0.90)
    = 0.03 / 0.039  ≈  0.77   → ~77% of flags would be genuine
```
At 2% prevalence the same detector gives **PPV ≈ 6%**: **roughly 17 of every 18 flags would be an innocent student.** Real systems are far worse than this hypothetical.

This is why the plan reaches "must not be allowed to decide" — and it is arithmetic, not citation, so it survives a teacher who does not trust the literature.

**The honest summary, which we also publish to users:** in a browser, we can reliably enforce *time* and *which items you got*. We cannot reliably detect *whether you cheated*, and any system that tells you otherwise is reporting its false-positive rate as a success rate. Our product copy is written to match.

---

## 2. The design decision

Integrity controls in a browser are **advisory, not authoritative**. Any competent student can disable client-side checks. So the problem is split by what can actually be trusted:

| Layer | What it does | Trustworthy? |
|---|---|---|
| **Server authority** | Deadlines, item selection, variant seeds, grading, release. The client renders server truth. | **Yes.** This is where integrity actually lives. |
| **Item variation** | Per-student draws from pools, option shuffles, parameter seeds — all persisted and logged, so no leaked key is worth anything. | **Yes.** `RN-03` says this is the effective lever. |
| **Deterrence & evidence** | Fullscreen, pointer lock, focus watchdog, copy/paste blocking, tab detection. Produces a timeline a human reads. | **No.** Signals only. Never punitive. |
| **Human judgement** | A teacher reads the evidence, the answers and the similarity data, and decides. | **Yes.** The real answer to cheating. |

### Explicitly rejected approaches
| Rejected | Why |
|---|---|
| `debugger` statement loops / devtools timing traps | Trivially defeated; false-positive rate destroys legitimate students' grades; indefensible on appeal |
| Window-size heuristics used to auto-fail | Extraordinarily noisy — normal window management triggers it |
| Auto-voiding an attempt on N violations | Unfair, unappealable, legally risky. `RN-01` |
| Biometric / webcam / audio monitoring | `RN-02`. Not in v1 at all |
| A required browser extension or custom client | Fails the managed-school-device requirement (`D4`) and the comfort data (`RN-01`) |
| Score drop as a success metric | The score drop is the *point*, but it must be **disclosed to the teacher**, not celebrated silently |

---

## 3. Threat model

| # | Threat | Control | Residual risk |
|---|---|---|---|
| T1 | Change the system clock to beat a deadline | All deadlines computed and validated server-side from `serverNow`. Client clock affects display only | None against a compliant client; a fully custom client is rejected by request validation |
| T2 | Second device or second tab | Single active `AttemptSession`; a second session revokes-or-blocks the first; `MULTI_TAB` event; per-response `revision` detects divergent writes | Detected, not prevented |
| T3 | Reload or crash to reset a per-question timer | `questionOpenedAt` is set server-side on the first **accepted** interaction and is immutable | None |
| T4 | Second monitor | Pointer lock + fullscreen deterrent; `screen` vs `outerWidth` mismatch logged as INFO | Detected, not prevented |
| T5 | Copy the question, search the answer | Per-student variants, shuffles, parameter seeds; copy/paste deterrents; similarity analysis | Raises cost. A determined student with a second device can still do this |
| T6 | Read the key from the network | Keys never leave the server; one exhaustively-typed public projection; route leak audit is a release gate | None while the audit is green |
| T7 | Forge telemetry to frame or self-report | Client timestamps only; server stamps `serverTs`, assigns `seq`, reclassifies severity. Events cannot affect scores | Noise only |
| T8 | Replay a pre-deadline save | `idempotencyKey` uniqueness + monotonic `revision`; stale revisions rejected | None |
| T9 | Never submit | Cron auto-submits at `deadlineAt + grace + 30s` from server state | None |
| T10 | Network loss near the deadline | Acknowledged-save semantics, outbox, honest messaging | Answers written after the hard deadline can be lost — by design, and **disclosed before the exam starts** |
| T11 | Collusion / answer sharing | Per-student draws, option shuffles, parameter seeds; similarity clustering as a signal | Human judgement required |
| T12 | A different person takes the exam | Not solvable in v1. **Stated plainly to teachers.** Optional proctoring is a v2, opt-in, consent-gated module | Open, acknowledged |
| T13 | The controls harm an assistive-technology user | Accommodations mode (§9) — a first-class, teacher-granted, zero-penalty policy variant | Addressed by design |
| T14 | Teacher error or dispute | Immutable `AnswerRevision` chain, verifiable receipt, `AttemptEvent` narrative, full audit | Addressed by design |

---

## 4. Policy model

Plain JSON, versioned, Zod-validated, deep-frozen, stored on the attempt at first start (`INV-POLICY-1`). Resolved once: `resolve(assignment.policyOverride, version.assessmentPolicy, studentOverride, accommodation)`.

```ts
type ExamPolicy = {
  version: 1

  // timing
  totalTimeLimitSec: number | null            // null = untimed
  perQuestionTimeLimitSec: number | null
  perQuestionExpiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT'
  availabilityWindow: { from: string | null; until: string | null } | null
  gracePeriodSec: number                      // default 60 (RN-04: Moodle's default)

  // environment
  requireFullscreen: 'OFF' | 'WARN' | 'REQUIRE'
  requirePointerLock: 'OFF' | 'WARN' | 'REQUIRE'
  focusWatchdog: 'OFF' | 'WARN' | 'REQUIRE'
  multiTabPolicy: 'WARN' | 'BLOCK'
  blockCopyPaste: boolean
  blockContextMenu: boolean
  blockPrintSave: boolean

  // thresholds → escalation
  thresholds: {
    fullscreenExits: number
    focusLosses: number
    tabHides: number
    pointerLockLosses: number
    copyAttempts: number
  }
  escalation: ('WARN' | 'BLOCK_UNTIL_RELOCK' | 'REQUIRE_RELOCK' | 'TERMINATE')[]

  // attempts & presentation
  maxAttempts: number
  allowPracticeAttempt: boolean                // RN-04
  navigation: 'ONE_AT_A_TIME' | 'ALL_AT_ONCE'
  lockQuestionAfterAnswer: boolean            // RN-04 (Canvas "Lock Questions")
  showQuestionNumbers: boolean
  showCorrectAnswersAfterRelease: boolean
  reviewMode: 'MANUAL'
}
```

### 4.1 Policy rules
1. **Permissive defaults, strict `EXAM` profile.** A strict global default would break ordinary quizzes. But a resource marked `EXAM` gets a stricter profile so "exam" always means something.

> **Corrected after review (`V-13`).** The original named `WARN` for fullscreen and focus but **never specified the thresholds**, so whether `WARN` was inert or brutal was undefined and the entire "default to WARN" position was unimplementable. Given `RN-03`'s finding that controls which add cognitive load change the score, the defaults are deliberately high:

```ts
EXAM_PROFILE_DEFAULTS = {
  requireFullscreen: 'WARN',   requirePointerLock: 'WARN',   focusWatchdog: 'WARN',
  thresholds: { fullscreenExits: 8, focusLosses: 25, tabHides: 12, pointerLockLosses: Infinity, copyAttempts: 20 },
  escalation: ['WARN', 'BLOCK_UNTIL_RELOCK'],   // never TERMINATE automatically — see V-12
}
QUIZ_PROFILE_DEFAULTS = { requireFullscreen: 'OFF', focusWatchdog: 'OFF', thresholds: { /* all Infinity */ } }
```
`pointerLockLosses: Infinity` is deliberate and principled: `Escape` releases pointer lock and browsers deliberately prevent interception, so counting it would penalise a documented browser behaviour (§6.1).
2. **Consistency validated at authoring time** (`INV-POLICY-2`): window start before end; window length not shorter than the total limit; `perQuestionExpiry ≠ SOFT` with no per-question limit is an error. Field-level errors in the authoring UI, never at exam start.
3. **Frozen on first start.** Later changes go through audited `DEADLINE_EXTENDED` / `POLICY_OVERRIDDEN` attempt events.
4. **Full disclosure before start.** The student sees the entire effective policy in plain language, including exactly what is recorded, what it is used for, and what is **never** collected. No mid-exam surprises.
5. **Grace period default 60 s.** `RN-04`: absorbs network jitter honestly without extending the exam. Also the precedent for a small, bounded, server-enforced window.

---

## 5. Server-authoritative time

```
attempt.startedAt  = serverNow at first accepted start
attempt.deadlineAt = totalTimeLimitSec ? startedAt + limit : null

per question, on the first ACCEPTED interaction:
  response.questionOpenedAt   = serverNow
  response.questionDeadlineAt = timeLimitSec ? questionOpenedAt + timeLimitSec : null
```

Write acceptance, evaluated entirely server-side:
```
accept iff  attempt.status == IN_PROGRESS
       and  (questionDeadlineAt == null or now <= questionDeadlineAt + grace)
       and  (deadlineAt        == null or now <= deadlineAt        + grace)
       and  response.revision == expectedRevision                  (else 409 with server copy)
       and  idempotencyKey is new                                  (else idempotent success)
```

> **INV-LATE-1.** Writes after the window are **rejected and the last accepted value retained.** Not silently accepted, not silently zeroed. This is directly the precedent of Moodle's "no marks are awarded for any answers entered after the time ran out" (`RN-04`), and it is the entire reason the server clock is worth anything.

At `questionDeadlineAt` the policy chooses `SOFT` (log only), `LOCK` (freeze), or `AUTO_SUBMIT` (freeze and mark final). A cron auto-submits at `deadlineAt + grace + 30s` from whatever the server holds.

### 5.1 Client clock sync
`GET /session/:id/sync` returns `{ serverNow, deadlineAt, questionDeadlines, ... }`. The client computes `offset = serverNow + rtt/2 − t0`, re-syncing every 60 s and after any pause > 30 s. **A client whose clock is three days wrong behaves identically to a correct one.** If sync is unavailable the exam still runs, with a visible "time check unavailable" banner; the server remains the sole enforcer.

### 5.2 Property tests
Over randomised `(start, limit, grace, elapsed, action)` tuples:
- no write is accepted after its window closes;
- a reload never moves `questionOpenedAt`;
- the total deadline dominates the per-question deadline when both apply;
- grace extends the window by exactly `gracePeriodSec`, not one tick more;
- the cron auto-submit selects `SUBMITTED` (not `EXPIRED`) exactly when a client submit landed inside grace.

---

## 6. Client watchdog

Six watchdogs in `apps/web/src/features/exam/watchdogs/`. Each takes an injected clock and an injected sink, so each is unit-testable without a browser.

| Watchdog | Listens to | Emits | Escalation |
|---|---|---|---|
| `fullscreenGuard` | `fullscreenchange`, `blur` | `FULLSCREEN_ENTERED/EXITED/DENIED` | per policy |
| `pointerLockGuard` | `pointerlockchange`, `pointerlockerror`, `keydown(Escape)` | `POINTERLOCK_ENTERED/LOST` | per policy, 3 s grace before counting a loss |
| `focusGuard` | `blur`, `focus`, `visibilitychange` | `WINDOW_BLURRED/FOCUSED`, `TAB_HIDDEN/VISIBLE` | thresholded |
| `lifecycleGuard` | `pagehide`, `beforeunload`, `freeze`/`resume` | `NETWORK_LOST/RESTORED`, final flush attempt | none |
| `tabGuard` | `BroadcastChannel` ping | `MULTI_TAB_DETECTED` | per policy |
| `clockGuard` | periodic sync | `CLOCK_SKEW_DETECTED` | none (advisory) |

### 6.1 The Escape-key honesty problem
`Escape` releases pointer lock and browsers deliberately do not allow it to be intercepted. Any product claiming otherwise is lying. Our position:
- Pointer lock is a **deterrent and a tripwire**, not a lock. UI copy says so.
- A `POINTERLOCK_LOST` is `WARN`, not `VIOLATION`, and is excluded from the escalation ladder in the default profile.
- The `Escape` keypress is not counted; only the resulting lock loss is, and only after a grace period.

### 6.2 Degradation ladder — a student is never dead-ended
Before start, a **preflight** probes capability and states precisely what will happen:

```
checks: viewport ≥ 1024×640 · fullscreen API · pointer lock API · storage available ·
        IndexedDB available · network reachable · clock sync reachable · visibility detectable ·
        BroadcastChannel available · reduced-motion / forced-colors detected
result: OK | DEGRADED (with the exact list of relaxations) | BLOCKED (with a real reason)
```
`DEGRADED` shows the student which controls will be relaxed and why. `BLOCKED` appears only for genuine blockers: already running elsewhere, outside the availability window, viewport genuinely too small. **A capability a modern browser lacks never produces `BLOCKED` — it produces `DEGRADED`.** Locked-down school devices are a normal case, not an error.

`RN-04` also gives us the **practice attempt**: an ungraded run under the same conditions, unlimited attempts, so a student can shake out their device before the real thing. This is the single cheapest reduction in exam-day technical failure we can offer.

### 6.3 Copy/paste hardening
Applied to the exam surface only when `blockCopyPaste` is on: intercept `copy`/`cut`/`paste`/`contextmenu`/`beforeprint` with a non-blocking toast, `user-select: none` on question text, and a print stylesheet that prints a "this exam is not printable" notice.

Honest limitation, stated in the preflight text: this stops accidents and casual copying, not a student with OS-level tools. Accommodations mode disables it entirely, because blocking paste can break screen readers and switch-access users.

---

## 7. Evidence pipeline

```
watchdog → bounded in-memory ring buffer (500 events)
         → flush every 5 s, or when 25 events accumulate
         → navigator.sendBeacon on pagehide; fetch(keepalive) for critical events
         → POST /api/exam/v1/telemetry
              verify session token
              validate each event against a CLOSED Zod schema; strip unknown keys
              clamp clientTs to ±5 min of serverTs (record the clamp)
              assign serverTs, seq = max(existing)+1, reclassify severity from policy
              route accommodation-relaxed events away from strike counters   (INV-ACC-1)
              update strike counters, evaluate the escalation ladder
              drop events arriving > 2 h after attempt end; retain 400 days
```
`sendBeacon` is fire-and-forget and may be lost: **telemetry may be incomplete, and that is acceptable.** Saves are not — they use `fetch` with retry and the outbox, and only a `2xx` counts as acknowledged.

### 7.1 Event table

| Type | Severity | Counts as strike | Notes |
|---|---|---|---|
| `EXAM_STARTED` | INFO | no | carries the preflight record |
| `FULLSCREEN_ENTERED` | INFO | no | |
| `FULLSCREEN_EXITED` | VIOLATION | when `requireFullscreen` | |
| `FULLSCREEN_DENIED` | WARN | no | A capability failure, not misconduct |
| `POINTERLOCK_ENTERED` | INFO | no | |
| `POINTERLOCK_LOST` | WARN | only past grace, and only if policy says so | `Escape` always causes this |
| `WINDOW_BLURRED` / `WINDOW_FOCUSED` | WARN | past threshold | |
| `TAB_HIDDEN` / `TAB_VISIBLE` | WARN | past threshold | |
| `MULTI_TAB_DETECTED` | VIOLATION | yes | second live attempt session |
| `COPY_ATTEMPT` / `PASTE_ATTEMPT` / `CONTEXT_MENU` / `PRINT_ATTEMPT` | WARN | per policy | |
| `SAVE_ATTEMPT` | INFO | no | advisory only |
| `DEVTOOLS_SIZE_ANOMALY` | INFO | no | **advisory evidence only, never punitive** |
| `SAVE_REJECTED_LATE` | INFO | no | server-side: the client tried to write past a deadline |
| `QUESTION_WINDOW_CLOSED` | INFO | no | consequence of a per-question timeout |
| `CLOCK_SKEW_DETECTED` | WARN | no | |
| `NETWORK_LOST` / `NETWORK_RESTORED` | INFO | no | |
| `AUTOSAVE_QUEUED` | INFO | no | outbox grew; explains later gaps |
| `SIM_LOAD_FAILED` | INFO | no | **never penalises the student for our bug** |
| `ACCOMMODATION_RELAXED` | INFO | never | `INV-ACC-1` |
| `VIOLATION_THRESHOLD_REACHED` | VIOLATION | — | emitted by the **server** |
| `ATTEMPT_TERMINATED` / `ATTEMPT_SUBMITTED` | INFO | no | |

### 7.2 Escalation ladder
```
a thresholded event increments a strike
  → strikes >= thresholds.X
      → apply escalation[i] for the highest threshold crossed
          WARN               : toast the student, log, continue
          BLOCK_UNTIL_RELOCK: overlay; re-satisfy fullscreen/pointer lock to continue
          REQUIRE_RELOCK    : re-lock required before the next question
          TERMINATE         : attempt → FROZEN, **everything already written submitted**,
                              teacher notified. It does NOT discard unwritten answers.
```
Every step appends an `AttemptEvent`. The student always sees what happened and why. A `TERMINATE` is **never final**: the teacher can reinstate or void with a recorded reason.

> **Corrected after review (`V-12`).** The original `TERMINATE` set the attempt to `TERMINATED`, submitted "held answers", and so **irreversibly discarded every unwritten item** — reducing the grade with no human present. That is an automated punitive action, which directly contradicts `ADR-0017` and `INV-TELEMETRY-1`, both of which state that client events "can never change a score". The plan contradicted itself inside one document.
>
> The automatic escalation ladder now stops at **freeze and notify**. `TERMINATE` is renamed `FREEZE_AND_SUBMIT`: it submits all written answers, leaves the attempt `FROZEN`, and requires a human `IntegrityVerdict` before any score is affected. A forged or looped telemetry event can inconvenience a student and alert a teacher; it cannot cost them a grade.
>
> **B11:** strikes are per-kind (`AttemptStrikeCounter { attemptId, kind }`, incremented atomically), not a single `Int`. A single counter could not represent five independent thresholds, so a student who left fullscreen 12 times would trip the `tabHides: 3` threshold and be terminated for something they did not do.
>
> **U-2:** threshold-crossing and above-threshold events are **never dropped**, even under telemetry shedding, and `ExamAttempt.droppedEventCount` records what was lost so a teacher can see the escalation was under-counted.

### 7.3 What the teacher sees
A per-attempt evidence timeline: chronological events, severity, threshold crossings, the preflight record, force-exit reports, similarity cluster membership, and the teacher's recorded verdict.

Copy requirements, enforced in review:
- A banner stating this is **evidence, not a determination**.
- Event-describing language, never intent: "left fullscreen 3 times", never "attempted to cheat".
- A required verdict with a reason before any void.
- The `RN-01` finding quoted in the help text, because a teacher who believes this is a lie detector will use it as one.

---

## 8. Accommodations mode

First-class, auditable, teacher-granted. Not a workaround — `RN-02` makes it an obligation.

```ts
type Relaxation =
  | 'DISABLE_FULLSCREEN'      // ADDED after review (U-3). Was missing entirely, so a
                              // screen-reader user in a virtual-buffer configuration
                              // could be forced into fullscreen — while the plan exempted
                              // Escape for pointer lock and then forgot the equivalent.
  | 'HIDE_COUNTDOWN'          // ADDED after review (U-3): a visible countdown is a
                              // significant cognitive-load cost under time pressure
  | 'DISABLE_POINTER_LOCK'
  | 'ALLOW_TAB_SWITCH'        // screen readers, magnifiers, translation tools
  | 'ALLOW_COPY_PASTE'
  | 'ALLOW_FOCUS_LOSS'
  | 'EXTRA_TIME_PERCENT'      // e.g. 50
  | 'BREAKS_ALLOWED'          // server-approved pauses
```

Rules:
- Relaxed events produce **zero** violation events. The watchdog still runs but routes to `accommodation-relaxed` and never touches strike counters (`INV-ACC-1`).
- `EXTRA_TIME_PERCENT` is an **additive** `AttemptDeadlineExtension` row, not a rewrite. > Corrected after review (`C14`): the original *rewrote* `deadlineAt`, which broke `INV-POLICY-1` and made `verify-receipt` report divergence on a legitimate action. `effectiveDeadlineAt = deadlineAt + Σ addedSec + pausedAccumSec`, and `deadlineAt` is never updated.
- `BREAKS_ALLOWED` requires `ExamAttempt.pausedAccumSec` and an audited `PAUSED` / `RESUMED_FROM_PAUSE` transition. > Corrected after review (`C15`): the original offered breaks with no policy field, no column, and no pause term in the deadline, so granting one silently did nothing.
- The marker is shown on the released result at the student's choice, and never to other students.
- Accommodations are auditable and reportable, because an institution needs the record.
- Granting one is a two-click action, available **during** a live exam, precisely because `RN-01`/`RN-03` show the controls themselves cost students performance.

---

## 9. Autosave and durability

Per-response state machine: `UNSAVED → QUEUED → SENDING → SAVED | FAILED`.

- Debounced 1.2 s after the last keystroke; immediate on blur, question change, `visibilitychange`, and every 20 s while dirty.
- `PUT` carries `{ answer, revision, idempotencyKey, clientTs }`.
- **`SAVED` only on `2xx`.** Anything else → `QUEUED` in IndexedDB with backoff (1, 2, 4, 8, 15, 30 s cap) and an honest indicator.
- On `online`, flush in `seq` order, oldest first. A `409` revision conflict stops the flush for that response and surfaces "keep mine / keep theirs" — which is also how a second device is detected.
- Near the deadline the client switches to aggressive saving (no debounce) and fires a final submit at `deadlineAt − 2 s`. After `deadlineAt + grace`, the outbox is abandoned and the student is told plainly: *"Answers not saved before the deadline may not have been recorded."*
- Simulation state uses a separate, lower-frequency debounce (3 s); the last known good state is always kept.

---

## 10. Submission and the tamper-evident receipt

`POST /attempts/:a/submit` (idempotent):
1. Assert submittable (`IN_PROGRESS`, and `now ≤ deadlineAt + grace` for a client submit; cron may submit later and marks `submittedBy: CRON`).
2. Close all open per-question windows.
3. Fold the answer hash chain in **resolved variant order**:
   `H₀ = sha256(attemptId ‖ assignmentId ‖ sha256(canonicalJson(policySnapshot)))`
   `Hᵢ = sha256(Hᵢ₋₁ ‖ questionId ‖ sha256(canonicalJson(answer)) ‖ serverTs)`
4. Persist `submissionReceipt = Hₙ` and `submittedAt`.
5. Run `@orrery/grading` → **sealed** auto-grades; write the `AttemptEvent` trail.
6. `SUBMITTED` → `PENDING_REVIEW` if manual questions exist, else `GRADED`. Both still sealed.

The student sees `Hₙ` on confirmation and again on their released result. A teacher runs `pnpm --filter @orrery/grading verify-receipt <attemptId>`, which recomputes the chain from `AnswerRevision` rows and reports the first divergence. That is what makes "I didn't change my answer" checkable rather than deniable.

---

## 11. What the student is told, and when

Pre-exam screen, in this order, in plain language:

1. What the exam is: length, question count, whether it can be paused, whether a practice attempt exists.
2. **Every enforced condition, itemised**, and what happens if it is broken.
3. **Exactly what is recorded**: window focus changes, fullscreen exits, tab switches, copy attempts — and that a human reads them.
4. **What is never recorded**: keystrokes, screen contents, camera, microphone, clipboard, and that we do not and cannot detect whether you cheated with a second device.
5. That the exam affects your score, and the availability window in **the student's own timezone**.
6. Accommodations: that they exist, how to request one, and that requesting one costs nothing.
7. What happens to their answers: they go to the teacher; automatically graded items are not shown until the teacher releases the whole set.
8. The durability rule: answers not saved before the deadline may not have been recorded.

Mid-exam: the countdown, the per-question timer, the durability indicator and the policy state are always visible. No surprise modals, no unannounced rule changes.

---

## 12. Failure modes we designed for

| Failure | Behaviour |
|---|---|
| Fullscreen denied by device policy | Preflight says `DEGRADED`; the exam runs without it and says so |
| Pointer lock unavailable | Same; default profile counts losses as `WARN` only |
| Tab closed mid-exam | Attempt stays `IN_PROGRESS`; resume allowed; elapsed time preserved; closing is logged |
| Student removed from the classroom mid-exam | Next request 403; attempt frozen; the teacher decides. Recorded, not deleted |
| Network drops for 90 s | Answers queue; the timer keeps running server-side; restore and flush; the UI is honest throughout |
| Network never returns | Server state is authoritative; unsent answers are lost, and this was disclosed in advance |
| Submitted twice | Second call is an idempotent success returning the same receipt |
| Client bundle tampered with | Server recomputes every grade from stored answers; the client is never trusted for scoring |
| A simulation crashes mid-question | The embed fails closed to a static fallback; the existing answer is preserved; `SIM_LOAD_FAILED`; the student is never penalised for our bug |
| System clock wrong by days | Irrelevant |
| Two teachers grade the same submission | Optimistic locking per response; the second save gets a conflict, never a silent overwrite |
| Student uses a screen reader | Accommodations mode; tab switching, copy/paste and pointer lock relaxed; focus order and ARIA first-class |
| Deadline sweep misses a cycle | Catch-up sweep on the next tick; a second consecutive miss pages a human. Answers are unaffected because the server still rejects late writes |
