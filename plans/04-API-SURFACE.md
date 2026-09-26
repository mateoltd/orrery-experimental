# 04 — API Surface

Conventions, routers, exam REST endpoints, events, idempotency, rate limits, versioning.

This is a design contract for P4–P16. The generated tRPC reference and the OpenAPI document are build artefacts, not source.

---

## 1. Conventions

- **tRPC v11** (superjson transformer) for the application surface. End-to-end types, colocated routers, TanStack Query on the client.
- **REST under `/api/exam/v1/*`** for exam-critical paths. Explicitly versioned because these contracts must not break mid-exam and must be load-testable in isolation.
- **Idempotency**: every mutation is naturally idempotent or accepts an `idempotencyKey`.
- **Audit**: every consequential mutation writes an `AuditEvent` in the same transaction.
- **Errors**: RFC 9457 problem documents — a stable machine `code` plus a human `detail`. Never internals, never stack traces, never whether an account exists.
- **Pagination**: opaque cursor, default 50, max 200. `{ items, nextCursor, total? }`.
- **Optimistic concurrency**: mutable records carry `revision`; a stale write returns `409` with the current server copy.
- **No score-bearing field in any student-facing payload before release.** Enforced by the DTO layer and verified by the P10 route audit.

### 1.1 Error codes
```
UNAUTHENTICATED  FORBIDDEN  NOT_FOUND  VALIDATION_FAILED  RATE_LIMITED
CONFLICT  PRECONDITION_FAILED  IDEMPOTENCY_MISMATCH  PAYLOAD_TOO_LARGE
ATTEMPT_NOT_STARTABLE  ATTEMPT_NOT_ACTIVE  ATTEMPT_ALREADY_ACTIVE
MULTI_TAB  SESSION_EXPIRED
WINDOW_CLOSED  WINDOW_CLOSING
GRADE_SEALED  POOL_UNDERSIZED  BLUEPRINT_UNSATISFIED
```

---

## 2. tRPC routers

### `auth`
`register` · `verifyEmail` · `resendVerification` · `signIn` · `signOut` · `mfa.enrol` · `mfa.verify` · `mfa.disable` · `requestPasswordReset` · `resetPassword` · `session` · `sessions.list` · `sessions.revoke` · `deleteAccount` · `exportMyData` · `updateProfile` · `preferences` · `setTimezone`

### `resource`
`create` · `get` · `listMine` · `updateMeta` · `saveDraft` (optimistic) · `publish` · `unpublish` · `archive` · `delete` · `duplicate` · `transfer` · `versions` · `version` · `diff` · `restoreAsNewVersion` · `usage` · `validateForPublish`

### `taxonomy`
`subjects` · `createSubject` · `moveSubject` (cycle-safe) · `deleteSubject` · `mergeTag` · `renameTag` · `classify`

### `library`
`search` · `browse` · `bySubject` · `similar` · `rate` · `comment` · `flag` · `trending` · `autocomplete`

### `classroom`
`create` · `get` · `listMine` · `update` · `archive` · `transferOwnership` ·
`members` · `invite` · `inviteBatch` · `revokeInvite` · `regenerateCode` · `invitations` ·
`acceptInvite` · `joinByCode` · `leave` · `removeMember` · `changeRole` ·
`rosterImport` (dry run + apply) · `rosterExport` · `summary`

### `assignment`
`create` · `get` · `list` · `update` · `publish` · `withdraw` · `delete` ·
`previewAsStudent` · `bulkCreate` · `resolvePolicy` · `studentOverrides.*` · `extendDeadlineForAll` · `counters`

### `bank`
`banks` · `createBank` · `updateBank` · `deleteBank` · `shareToClassroom` ·
`questions` · `createQuestion` · `updateQuestion` · `duplicateQuestion` · `deleteQuestion` · `moveToBank` · `bulkTag` · `importQuestions` · `exportQuestions` ·
`pools` · `createPool` · `updatePool` · `poolPreview` (draw N, show the distribution) · `poolHealth` (M vs N, distinct, coverage) ·
`testGrader` (run the real grader against a sample answer and show the outcome) · `simulateGrading`

### `blueprint`
`blueprints` · `createBlueprint` · `updateBlueprint` · `check` (run a coverage check against a version) · `report`

### `accommodation`
`list` · `grant` · `revoke` · `history` (auditable record for the institution)

### `assessment` (teacher-side authoring of a version's assessment)
`spec` (the slot list) · `setSpec` · `validateSpec` · `preview` (what a given student would see, given a seed) · `orderSlots` · `publishAssessment`

### `attempt` (student-side, pre-release)
`myAttempts` · `attemptSummary` (status only) · `startOrResume` · `flagResponse` · `resilienceInfo` · `receipt` · `surrender` (voluntary give-up, recorded honestly rather than as abandonment)

### `grading` (teacher-side)
`queue` · `queueCounts` · `claim` · `unclaim` · `submission` · `responses` · `saveGrade` · `quickScore` · `applyRubric` · `bulkAction` · `flagAutoGrade` · `replaySimulation` · `overrideSimulation` · `excuse` · `extendDeadline` · `overridePolicy` · `terminate` · `reinstate` · `void` · `regrade` (dry run + apply) · `verifyReceipt` · `studentHistory`

### `release`
`batches` · `createBatch` · `batchDetail` · `blockers` · `release` · `cancel` · `reopen` (audited exception, never a silent un-release)

### `analytics`
`gradebook` · `studentDetail` · `itemAnalysis` · `integrityReport` · `similarity` · `variantAudit` · `exports.create` · `exports.status` · `simAnalytics`

### `simulation`
`registry` (metadata index only) · `manifest` · `myDrafts` · `createDraft` · `compileDraft` · `previewDraft` · `usageImpact` · `reportIssue` · `suggestDeprecation`

### `interop`
`qti.export` · `qti.import` · `xapi.statements` · `lti.platforms` · `lti.launchUrl` · `oneroster.sync` · `bindings`

### `platform`
`health` · `me` · `notifications` · `markRead` · `auditLog` (classroom-scoped) · `admin.users` · `admin.suspend` · `admin.impersonate` (audited, read-only, 15 min)

---

## 3. Exam REST API — `/api/exam/v1`

All routes require `x-attempt-session: <token>` except `start` and `sync`. All responses are `Cache-Control: no-store`. The `/v1` contract is **frozen**; new fields are always optional and ignored by old clients.

### `POST /attempts/:attemptId/start`
```jsonc
// request — preflight record only; nothing here is trusted for enforcement
{ "preflight": {
    "viewport": { "w": 1440, "h": 900 },
    "screen":   { "w": 2560, "h": 1440, "colorDepth": 24 },
    "features": { "fullscreen": true, "pointerLock": true, "indexedDb": true,
                  "storage": true, "pageLifecycle": true, "broadcastChannel": true },
    "network":  { "rttMs": 40, "effectiveType": "4g", "saveData": false },
    "a11y":     { "reducedMotion": false, "forcedColors": false, "screenReaderGuess": null }
} }

// 201
{ "attemptId": "…", "sessionToken": "…", "serverNow": "…",
  "startedAt": "…", "deadlineAt": "…", "gracePeriodSec": 60,
  "policy": { /* effective, frozen — INV-POLICY-1 */ },
  "questions": [ /* PUBLIC projections; no keys, no model answers */ ],
  "variantMap": { "slot-3": ["q_1a", "q_7c"] },
  "preflightVerdict": { "status": "OK", "relaxations": [], "notes": [] } }
```
Errors: `409 ATTEMPT_NOT_STARTABLE` (outside the window, attempts exhausted, already running elsewhere), `422` (invalid policy — a bug, alerts).

### `GET /session/:sessionId/sync`
The clock handshake. `{ serverNow, startedAt, deadlineAt, questionDeadlines, attemptStatus, escalationState, saveStateByQuestion }`. Pollable; also the mechanism that pushes escalation to the client.

### `PUT /attempts/:a/responses/:questionId`
```jsonc
// request
{ "answer": { /* per type */ }, "revision": 4, "idempotencyKey": "uuid", "clientTs": "…" }
// 200
{ "revision": 5, "serverNow": "…", "questionDeadlineAt": "…", "saveState": "SAVED" }
```
`409 WINDOW_CLOSED` — past the per-question or total window; the last accepted value is retained and the student is told (`INV-LATE-1`).
`409 WINDOW_CLOSING` — final seconds, deliberately shed.
`409 CONFLICT` — stale revision; includes `{ serverAnswer, serverRevision }` so the UI can offer "keep mine / keep theirs".
`422` — answer fails its schema. `413` — absurdly large.

### `POST /attempts/:a/sim-state/:questionId`
`{ simState, checksum, revision }` → `200 { revision, needsHuman }`. Validated against the sim's `stateSchema`; an invalid state is **accepted and flagged** rather than rejected, because losing a student's exploration is worse than storing something we will ignore. `needsHuman: true` routes the question to review instead of auto-zeroing it (`INV-SIM-2`).

### `POST /telemetry`
```jsonc
{ "events": [ { "seq": 12, "type": "TAB_HIDDEN", "clientTs": "…", "payload": { "atMs": 4213 } } ] }
```
→ `202 { accepted: 9, reclassified: 1, accommodationRelaxed: 0, dropped: 0 }`. Idempotent per `(attemptId, seq)`. Closed payload schemas, unknown keys stripped and counted. Returns nothing score-bearing.

### `POST /heartbeat`
`→ { serverNow, sessionValid, mustResync, escalationState, accommodationActive }`. Every 30 s.

### `POST /attempts/:a/submit`
`{ confirmUnanswered: 3, idempotencyKey: "uuid" }` → `202 { receipt, submittedAt, isLate, status }`. Idempotent. Sets `isLate` but does **not** apply the penalty — penalties are computed at grading time so they stay adjustable and auditable.

### `GET /attempts/:a/receipt`
`{ receipt, chainLength, verifiedAt }` — the hash-chain root and when it was last verified.

---

## 4. Events

| Event | Producer | Consumers |
|---|---|---|
| `exam.attempt.started.v1` | exam service | notifications, presence, analytics |
| `exam.attempt.submitted.v1` | exam service | `grade.auto`, notifications, analytics |
| `exam.attempt.expired.v1` | deadline sweep | `grade.auto`, notifications |
| `exam.attempt.auto_graded.v1` | `grade.auto` | review queue, rollups |
| `exam.response.graded.v1` | grading service | attempt recompute, rollup invalidation |
| `exam.variant_drawn.v1` | exam service | variant audit, item analysis |
| `grading.regrade.requested.v1` | teacher | `grade.recompute` |
| `grading.verdict.recorded.v1` | grading service | audit, integrity report |
| `release.batch.released.v1` | `release.batch` | notifications, rollups, xAPI |
| `classroom.member.added.v1` | classroom | notifications, OneRoster sync |
| `assignment.published.v1` | assignment | notifications, student digest |
| `sim.registry.updated.v1` | sim build | registry index, catalogue cache |
| `account.deletion_requested.v1` | account | `dsar.*` |
| `retention.sweep_completed.v1` | retention | audit |
| `interop.sync_completed.v1` | interop | audit |

Rules: versioned names; additive payloads within a version; consumers ignore unknown fields; an **unknown event name is a hard failure**, never a silent drop.

---

## 5. Assets and file upload
```
POST /api/assets/uploads     → { uploadUrl, key, headers }   (presigned, single use, 15 min)
PUT  <uploadUrl>             → direct to S3; bytes never touch our servers
POST /api/assets/:id/complete → { status, width, height, checksum, altText? }
GET  /api/assets/:id         → authorised signed URL, or proxied for private files
```
Content-type allowlist · size cap · magic-byte verification · server-side image re-encode stripping EXIF and embedded payloads · **SVG rejected as an image** (SVG is script) · async scan status before a student submission becomes gradeable · CSV-injection escaping on every export.

---

## 6. Rate limits

| Route class | Limit | Behaviour |
|---|---|---|
| `auth.register` / `signIn` / reset | 5 / 15 min / IP **+** 10 / day / identifier | 429, generic message |
| MFA verify | 5 / 15 min / account | 429, and alert on repeated failure (possible takeover) |
| Invitation send | 20 / hour / classroom, 3 / hour / email | 429 |
| Join-code attempts | 10 / 15 min / IP, 30 / day / classroom | 429, silent |
| `exam.telemetry` | 120 / min / session | accepted then dropped (telemetry may be incomplete) |
| `exam.responses` PUT | 60 / min / session, burst 10 | 429 → client queues and retries |
| `exam.submit` | 10 / attempt | 429 (idempotent regardless) |
| Sim origin | none (no API) | — |
| General API | 600 / min / session | 429 |

**Answer-save limiting is deliberately generous.** A legitimate student editing quickly must never be throttled, because a rejected save during an exam is a grading injustice. Real traffic is far below the limit because the client coalesces and debounces.

---

## 7. Versioning policy
- **tRPC**: additive only within a deploy. A breaking change ships a parallel endpoint for one release.
- **Exam REST**: `/v1` frozen for the life of the platform. Additive optional fields only. Never remove or rename a field a shipped client reads — a student on a cached bundle is the reason.
- **Sim protocol** (`sim-host`): additive frames only; unknown frames are ignored, not fatal; a version mismatch degrades with a clear panel rather than crashing.
- **Events**: versioned names, additive payloads.

---

## 8. xAPI emission points
`xapi` statements are emitted for: attempt started, question answered, question graded, attempt submitted, attempt graded, results released, simulation launched, simulation completed. Verb IDs follow the ADL xAPI vocabulary where one exists; our own namespace otherwise. Payload includes no answer content — only the interaction, duration and outcome — so xAPI never becomes a side channel around `INV-Q-1`.
