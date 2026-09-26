# Exam Runtime & Integrity

**The one document to read before touching P8.** The exam is the product's trust boundary: a teacher's decision to give a grade must rest on evidence, not on a promise from the student's browser.

---

## 1. The central design decision

Integrity controls in a browser are **advisory, not authoritative**. Any competent student can disable JavaScript-side checks, and no browser API can prevent a determined violation. Therefore Orrery splits the problem:

| Layer | What it does | Can it be trusted? |
|---|---|---|
| **Server authority** | Deadlines, question selection, variant seeds, grading, release. The client is a renderer of server truth. | **Yes.** This is where real integrity lives. |
| **Variation** | Per-student question variants, option shuffles and parameter seeds, persisted and logged, so no single answer key can be shared. | **Yes.** Raises the cost of collusion; makes memorisation of leaked keys worthless. |
| **Deterrence & evidence** | Fullscreen, pointer lock, focus watchdog, copy/paste blocking, tab detection. Produces a timeline a human reads. | **No.** Signals only. Never auto-punitive. |
| **Human judgement** | A teacher reads the evidence, the answers, and the similarity data, and decides. | **Yes.** The product's real answer to cheating. |

**Anti-pattern we explicitly reject:** a `debugger` statement loop, obfuscated timing traps, or any "detect devtools" heuristic used to auto-fail a student. These produce false positives that destroy legitimate students' grades, they are trivially defeated, and they are indefensible when a student appeals. We log a passive size-anomaly hint and stop there.

**Anti-pattern we explicitly reject:** auto-voiding an attempt on N violations. Violations escalate to *teacher attention*; only a human voids an attempt, with a recorded reason.

---

## 2. Threat model

| # | Threat | Control | Residual risk |
|---|---|---|---|
| T1 | Change the system clock to beat a deadline | All deadlines computed and validated server-side from `serverNow`; client clock only affects display | None if the client honours the server; a fully custom client is rejected by API validation |
| T2 | Second device or second tab during a timed exam | Single active `AttemptSession`; a second session revokes-or-blocks the first; `MULTI_TAB_DETECTED` event; per-response `revision` detects divergent writes | Detected, not prevented |
| T3 | Reload / crash to reset a per-question timer | `questionOpenedAt` is set server-side on first accepted interaction and is immutable | None |
| T4 | Use a second monitor | Pointer lock + fullscreen deterrent; `screen` vs `outerWidth` mismatch recorded as INFO | Detected, not prevented |
| T5 | Copy the question or search the answer | Per-student variants, option shuffles, parameter seeds; copy/paste/context-menu deterrents; answer-similarity analysis | Raises cost; a determined student with a second device can still do this |
| T6 | Read the answer key from the network | Keys never leave the server; public projection is a separate, exhaustively-typed function; route leak audit is a release gate | None, given P10-T8 stays green |
| T7 | Forge telemetry to frame or to self-report | Events carry client timestamps only; the server stamps `serverTs`, assigns `seq`, reclassifies severity; events cannot affect scores | Noise only |
| T8 | Replay a save from before the deadline | `idemKey` uniqueness + monotonic `revision`; stale revisions rejected with 409 | None |
| T9 | Never submit | Cron auto-submits at `deadlineAt + grace + 30s` using server-held answers; client also auto-submits | None |
| T10 | Network loss near the deadline | Acknowledged-save semantics, IndexedDB outbox, honest "may not have been recorded" messaging | Answers written after the hard deadline can be lost — by design, and disclosed up front |
| T11 | Collude / share answers | Per-student variants and seeds; similarity clustering surfaced as a signal | Human judgement required |
| T12 | A different person takes the exam | Optional proctoring is a v2, opt-in, consent-gated feature | **Not solvable in v1. Documented honestly to teachers.** |
| T13 | Student is harmed by the controls (assistive tech) | Accommodations mode (§8) is a first-class, teacher-granted policy variant that relaxes controls without penalty | Addressed by design |
| T14 | Teacher error / dispute | Immutable `AnswerRevision` chain, verifiable submission receipt, `AttemptEvent` narrative, full audit log | Addressed by design |

---

## 3. Policy model

A policy is a plain JSON object, versioned, validated by Zod, deep-frozen, and stored on the attempt at first start. It is resolved once: `resolve(assignment.policyOverride, resourceVersion.assessmentPolicy)`.

```ts
type ExamPolicy = {
  version: 1

  // ── timing
  totalTimeLimitSec: number | null      // null = untimed
  perQuestionTimeLimitSec: number | null
  perQuestionExpiry: 'SOFT' | 'LOCK' | 'AUTO_SUBMIT'
  availabilityWindow: { from: string | null; until: string | null } | null
  gracePeriodSec: number                // default 0; accepts late writes/submits

  // ── environment
  requireFullscreen: 'OFF' | 'WARN' | 'REQUIRE'
  requirePointerLock: 'OFF' | 'WARN' | 'REQUIRE'
  focusWatchdog: 'OFF' | 'WARN' | 'REQUIRE'
  multiTabPolicy: 'WARN' | 'BLOCK'
  blockCopyPaste: boolean
  blockContextMenu: boolean
  blockPrintSave: boolean

  // ── thresholds → escalation
  thresholds: {
    fullscreenExits: number            // before escalation kicks in
    focusLosses: number
    tabHides: number
    pointerLockLosses: number
    copyAttempts: number
  }
  escalation: ('WARN' | 'BLOCK_UNTIL_RELOCK' | 'REQUIRE_RELOCK' | 'TERMINATE')[]

  // ── attempts & display
  maxAttempts: number
  navigation: 'ONE_AT_A_TIME' | 'ALL_AT_ONCE'
  showQuestionNumbers: boolean
  shuffleQuestions: boolean
  shuffleOptions: boolean
  showCorrectAnswersAfterRelease: boolean
  reviewMode: 'MANUAL'                  // v1: every attempt is reviewed by a human
}
```

**Default quiz policy** is the same shape with everything permissive and `reviewMode: 'MANUAL' | 'AUTO_RELEASE'`.

### 3.1 Policy rules
1. **Default deny is wrong here.** A strict default would break ordinary quizzes. Defaults are permissive; exam strictness is opt-in per resource/assignment. But a resource marked `EXAM` gets a *stricter* default profile (`requireFullscreen: 'WARN'`, `focusWatchdog: 'WARN'`) so "exam" always means something.
2. **Validation.** `totalTimeLimitSec` and `availabilityWindow` must be internally consistent (window start before end; window length not shorter than the total limit). Invalid combos are rejected with field-level errors in the authoring UI, not at exam start.
3. **Snapshot immutability.** Once an attempt exists, its `policySnapshot` never changes. Teacher-side changes go through audited `DEADLINE_EXTENDED` / `POLICY_OVERRIDDEN` attempt events.
4. **Disclosure.** The student sees the full effective policy on the preflight screen, in plain language, including exactly what will be recorded and what it will *not* be used for. No surprises mid-exam.

---

## 4. Server-authoritative time

```
attempt.startedAt  = clock.now()                     // first accepted start
attempt.deadlineAt = totalTimeLimitSec ? startedAt + limit : null

// per question, on the first ACCEPTED interaction:
response.questionOpenedAt   = clock.now()
response.questionDeadlineAt = timeLimitSec ? questionOpenedAt + timeLimitSec : null
```

Write acceptance rule, evaluated entirely on the server:

```
accept iff  attempt.status == IN_PROGRESS
       and  (questionDeadlineAt == null or now <= questionDeadlineAt + gracePeriodSec)
       and  (deadlineAt == null or now <= deadlineAt + gracePeriodSec)
       and  response.revision matches the expected revision   (else 409)
       and  idemKey is new                                  (else idempotent success)
```

### 4.1 Client clock sync
`GET /api/exam/v1/session/{id}/sync` returns `{ serverNow, deadlineAt, questionDeadlines, attemptId }`. The client computes `offset = serverNow + rtt/2 − performance.now() − t0`, re-syncs every 60 s and after any pause > 30 s. The countdown renders from the corrected clock. **If sync fails, the exam still works**: the client shows a "time check unavailable" banner and the server remains the sole enforcer.

### 4.2 Property tests (P8-T2)
Property-based tests assert, over randomised (start, limit, grace, elapsed, attempt-action) tuples:
- no write is accepted after its window closes;
- a reload never moves `questionOpenedAt`;
- total-deadline beats per-question-deadline when both are set;
- grace extends the window by exactly `gracePeriodSec` and not by one tick more;
- cron auto-submit selects `SUBMITTED` (not `EXPIRED`) exactly when a client submit landed in grace.

---

## 5. Attempt lifecycle, server side

```
POST   /api/exam/v1/attempts/{attemptId}/start
       · validates window, maxAttempts, enrolment, assignment status
       · freezes policySnapshot, generates rngSeed + variantMap
       · sets startedAt/deadlineAt
       · issues AttemptSession (single active)
       · records EXAM_STARTED with the preflight record

GET    /api/exam/v1/session/{id}/sync          time handshake
PUT    /api/exam/v1/attempts/{a}/responses/{q}  answer save (idempotent, revisioned)
POST   /api/exam/v1/attempts/{a}/sim-state/{q} sim state capture (batched, debounced)
POST   /api/exam/v1/attempts/{a}/submit        idempotent submit
POST   /api/exam/v1/telemetry                  batched integrity events
POST   /api/exam/v1/heartbeat                  liveness + session keepalive
```

### 5.1 Session single-activity rule
`start` revokes any other live session for that attempt, unless the request presents the existing session token (a reload) — in which case it is treated as a resume. A *different* browser presenting a different token to an in-progress attempt with `multiTabPolicy: 'BLOCK'` is refused with `409 MULTI_TAB`, and the original session's owner sees an advisory event. With `'WARN'`, both sessions are permitted and every write from the second is revisioned, so conflicts surface as explicit `409`s rather than silent overwrites.

### 5.2 Deadline cron
A worker job runs every 30 s:
1. Find `IN_PROGRESS` attempts with `deadlineAt + grace < now` → auto-submit from server state (`submittedBy: CRON`), event `AUTO_SUBMITTED`.
2. Close per-question windows past their deadline per `perQuestionExpiry` → set `questionClosedReason`, event `QUESTION_WINDOW_CLOSED`.
3. Shed load: reject new answer writes for attempts inside the final 5 s (409) so the stampede hits the cron instead.

**Shedding policy at scale:** during the final 10 s before a cohort deadline, answer writes are answered with `409 WINDOW_CLOSING` after the answer has been durably recorded *or* discarded per policy. The design goal is that the database sees a flat ~200 writes/s, not a 5,000-request spike. Load-tested at P8-T15.

---

## 6. Client watchdog

The exam client (`apps/web/src/features/exam`) owns six watchdogs. Each is a pure-ish module with an injected clock and an injected sink, so every one is unit-testable without a browser.

| Watchdog | Listens to | Emits | Escalation |
|---|---|---|---|
| `fullscreenGuard` | `fullscreenchange`, `blur` | `FULLSCENTERED/EXITED/DENIED` | per policy |
| `pointerLockGuard` | `pointerlockchange`, `pointerlockerror`, `keydown(Escape)` | `POINTERLOCK_ENTERED/LOST` | per policy, with a 3 s grace before counting a loss |
| `focusGuard` | `blur`, `focus`, `visibilitychange` | `WINDOW_BLURRED/FOCUSED`, `TAB_HIDDEN/VISIBLE` | thresholded |
| `lifecycleGuard` | `pagehide`, `beforeunload`, `freeze`/`resume` (Page Lifecycle) | `NETWORK_LOST/RESTORED`, final flush attempt | none |
| `tabGuard` | BroadcastChannel ping | `MULTI_TAB_DETECTED` | per policy |
| `clockGuard` | periodic sync | `CLOCK_SKEW_DETECTED` | none (advisory) |

### 6.1 The Escape-key honesty problem
`Escape` releases pointer lock and browsers deliberately do not allow it to be intercepted. Any product claiming otherwise is lying. Our position:

- Pointer lock is a **deterrent and a tripwire**, not a lock. UI copy says so.
- A `POINTERLOCK_LOST` is `WARN`, not `VIOLATION`, and is excluded from the escalation ladder in the default profile.
- The `Escape` key is *not* counted as a violation; only the resulting lock loss is, and only after grace.

### 6.2 Degradation ladder
The exam must never dead-end a student. Before start, a **preflight** probes capability and reports precisely what will happen:

```
checks: viewport ≥ 1024×640 · fullscreen API · pointer lock API · storage available ·
        IndexedDB available · network reachable · clock sync reachable · tab visibility detectable
result: OK | DEGRADED (list of relaxations that will be applied) | BLOCKED (reason)
```
`DEGRADED` shows the student exactly which controls will be relaxed. `BLOCKED` never appears for a capability a modern browser lacks; it appears for real blockers (exam already in progress elsewhere, window outside the availability window).

### 6.3 Copy/paste hardening
Applied to the exam surface only, and only when `blockCopyPaste` is on: `copy`/`cut`/`paste`/`contextmenu`/`beforeprint` intercepted with a non-blocking toast, `user-select: none` on question text, print stylesheet that prints a "this exam is not printable" notice. Honest limitation: this stops accidents and casual copying, not a determined student with OS-level tools. Accommodations mode disables it entirely, because blocking paste can break screen readers and switch-access users.

---

## 7. Telemetry pipeline

```
watchdog → in-memory ring buffer (bounded 500 events)
         → flush every 5 s (batched) or when 25 events accumulate
         → navigator.sendBeacon on pagehide, fetch(keepalive: true) on critical events
         → POST /api/exam/v1/telemetry
              · verify session token
              · validate each event against a closed Zod schema, strip unknown keys
              · clamp clientTs to ±5 min of serverTs (record the clamp)
              · assign serverTs, seq = max(existing)+1, reclassify severity from policy
              · update strike counters, evaluate escalation ladder
              · drop events arriving > 2 h after attempt end (retention: 400 days)
```

`sendBeacon` is fire-and-forget and may be lost; telemetry is explicitly allowed to be incomplete. **Saves are not** — they use `fetch` with retry and the IndexedDB outbox, and only a `2xx` counts as acknowledged.

### 7.1 Escalation ladder
```
count a strike for a thresholded event
  → strikes >= thresholds.X
      → apply escalation[i] for the highest threshold crossed
          WARN              : toast the student, log, continue
          BLOCK_UNTIL_RELOCK: overlay; student must re-satisfy fullscreen/pointer lock
          REQUIRE_RELOCK   : overlay; re-lock required before the next question
          TERMINATE         : attempt → TERMINATED, submission of held answers, teacher notified
```
Every step appends an `AttemptEvent`. The student always sees what happened and why. A `TERMINATE` is never final: the teacher can reinstate or void with a reason.

### 7.2 What the teacher sees
A per-attempt integrity timeline: chronological events, severity, threshold crossings, the preflight record, force-exit reports, and the similarity cluster. Framed as **evidence**, with an explicit "this is not a determination" banner and a required teacher verdict (`NO_CONCERN` / `NOTED` / `REVIEW` / `VOIDED` with reason) that is itself audited.

---

## 8. Accommodations mode

A first-class requirement, not a workaround. An accommodation is a **recorded, teacher-granted policy variant** applied to a specific student for a specific assignment:

```ts
type Accommodations = {
  grantedById: string
  grantedAt: string
  reason: string            // free text; never shown to other students
  relaxations: Array<
    | 'DISABLE_POINTER_LOCK'
    | 'ALLOW_TAB_SWITCH'     // screen readers, magnifiers, translation tools
    | 'ALLOW_COPY_PASTE'
    | 'EXTRA_TIME_PERCENT'   // e.g. 50
    | 'BREAKS_ALLOWED'       // pauses the clock in server-approved windows
  >
}
```

Rules:
- Relaxed events are **not recorded as violations**. The watchdog runs but routes to `accommodation-relaxed` rather than `strikes`.
- `EXTRA_TIME_PERCENT` extends `deadlineAt` and every `questionDeadlineAt`, recorded as a `DEADLINE_EXTENDED` attempt event with the accommodation reference.
- The accommodations marker is shown on the student's released result (their choice) and never to other students.
- Accommodations are auditable and reportable, because a school will need that record.

---

## 9. Autosave and durability

```
state machine per response:  UNSAVED → QUEUED → SENDING → SAVED | FAILED
```

- Debounced 1.2 s after the last keystroke; immediate on blur, on question change, on `visibilitychange`, and every 20 s while dirty.
- `PUT` carries `{ answer, revision, idemKey, clientTs }`.
- **Acknowledged** (`SAVED`) only on `2xx`. Anything else → `QUEUED` in IndexedDB with backoff (1 s, 2 s, 4 s, 8 s, 15 s, 30 s cap) and an honest UI indicator.
- On `online`, flush in `seq` order, oldest first. On a `409` revision conflict, stop flushing for that response and surface "keep mine / keep theirs" — this is also how a second device is detected.
- Near the deadline the client switches to *aggressive* saving (no debounce) and, at `deadlineAt − 2 s`, fires a final submit. After `deadlineAt + grace`, the outbox is abandoned and the student is told plainly: *"Answers not saved before the deadline may not have been recorded."*
- Sim state is captured with a separate, lower-frequency debounce (3 s) because sim state can be large; the last known good state is always kept.

---

## 10. Submission and the tamper-evident receipt

`POST /attempts/{a}/submit` (idempotent via `IdempotencyKey`):

1. Assert the attempt is in a submittable state (`IN_PROGRESS`, and `now <= deadlineAt + grace` for a client submit; cron may submit later and marks `submittedBy: CRON`).
2. Close all open per-question windows.
3. Compute the answer hash chain in `position` order:
   `H₀ = sha256(attemptId ‖ assignmentId ‖ policySnapshotChecksum)`
   `Hᵢ = sha256(Hᵢ₋₁ ‖ questionId ‖ canonicalJson(answer) ‖ serverTs)`
4. Persist `submissionReceipt = Hₙ` and `submittedAt`.
5. Run `@orrery/grading` to compute **sealed** auto-grades and write the `AttemptEvent` trail.
6. Set status `SUBMITTED` → `PENDING_REVIEW` (if manual questions exist) or `GRADED` (if not, still sealed).

The student sees the receipt hash on their submission confirmation and again on their released result. A teacher can run the verifier (`pnpm --filter @orrery/grading verify-receipt <attemptId>`), which recomputes the chain from `AnswerRevision` rows and reports the first divergence if any. That is what makes "I didn't change my answer" checkable rather than deniable.

---

## 11. What a student is told, and when

Pre-exam screen, in this order, in plain language:

1. What this exam is, how long, how many questions, whether it can be paused.
2. **Every enforced condition, itemised**, and what happens if it is broken.
3. **Exactly what is recorded**: window focus changes, fullscreen exits, tab switches, copy attempts — and that these appear for a human to read.
4. **What is never recorded**: keystrokes, screen contents, camera, microphone, clipboard contents.
5. Whether accommodations are available and how to request them.
6. What happens to their data: answers go to the teacher; auto-graded items are not shown until the teacher releases the whole set.

Mid-exam, the countdown, the per-question timer, the durability indicator, and any policy state are always visible. There are no surprise modals and no unannounced rule changes.

---

## 12. Failure modes we have designed for

| Failure | Behaviour |
|---|---|
| Fullscreen API denied by policy (locked-down school device) | Preflight reports DEGRADED; the exam runs without it and says so |
| Pointer lock unavailable | Same; default profile counts pointer-lock losses as WARN only |
| Student closes the tab mid-exam | Attempt stays `IN_PROGRESS`; resume allowed; elapsed time preserved; closing is logged |
| Student is removed from the classroom mid-exam | Next request 403; attempt frozen; teacher decides. Recorded, not deleted |
| Network drops for 90 s | Answers queue; timer keeps running (server-side); restores and flushes; UI honest throughout |
| Network drops and never returns | Server state is authoritative; unsent answers are lost and this is disclosed in the pre-exam terms |
| Student submits twice | Second call is an idempotent success, returns the same receipt |
| Student tampers with the client bundle | Server recomputes all grades from stored answers; the client is never trusted for scoring |
| A simulation crashes mid-question | The embed fails closed with a static fallback; the student's existing answer is preserved; `SIM_LOAD_FAILED` logged; the student is never penalised for our bug |
| Clock skew of ±3 days | Irrelevant; server-time authority |
| Two teachers grade the same submission | Optimistic locking per response; the second save gets a conflict, never a silent overwrite |
| Student uses a screen reader | Accommodations mode; tab switching, copy/paste and pointer lock all relaxed; focus order and ARIA are first-class in the exam UI |
