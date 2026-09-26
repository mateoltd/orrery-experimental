# API Surface

Conventions, then the routers and endpoints. This is a design contract for P6–P11, not a generated reference (that is generated from tRPC at build time).

---

## 1. Conventions

- **tRPC** for the application surface: typed end-to-end, colocated routers, TanStack Query on the client.
- **REST under `/api/exam/v1/*`** for exam-critical paths: answer saves, sim state, telemetry, heartbeat, sync, submit. Explicit versioning because these contracts must not break mid-exam, and because they need to be load-tested and monitored independently.
- **Mutation safety:** every mutation is either idempotent (accepts `idempotencyKey`) or naturally idempotent. Every mutation writes an audit event inside the same transaction.
- **Errors:** RFC 9457 problem documents. Stable machine `code` plus a human `detail`. Never leak internals, stack traces, or whether an account exists.
- **Pagination:** opaque cursor, default 50, max 200. Every list response is `{ items, nextCursor, total? }`.
- **Optimistic concurrency:** mutable records carry `revision`; a stale write returns `409` with the current server copy.
- **No score fields in any student-facing payload before release.** Enforced by the DTO layer and verified by `P10-T8`.

### 1.1 Standard error codes
```
UNAUTHENTICATED  FORBIDDEN  NOT_FOUND  VALIDATION_FAILED  RATE_LIMITED
CONFLICT         PRECONDITION_FAILED  IDEMPOTENCY_MISMATCH
ATTEMPT_NOT_STARTABLE   ATTEMPT_NOT_ACTIVE   MULTI_TAB
WINDOW_CLOSED   WINDOW_CLOSING  SESSION_EXPIRED  GRADE_SEALED
```

---

## 2. tRPC routers

### `auth`
`register` · `verifyEmail` · `resendVerification` · `signIn` · `signOut` · `requestPasswordReset` · `resetPassword` · `session` · `deleteAccount` · `exportMyData` · `updateProfile` · `preferences`

### `resource`
`create` · `get` · `list` (mine) · `updateMeta` · `saveDraft` (optimistic) · `publish` · `unpublish` · `archive` · `delete` · `duplicate` · `transfer` · `versions` · `version` · `diff` · `restore` · `usage` · `validateForPublish` (checks sim versions exist, questions valid, alt text present)

### `taxonomy`
`subjects` · `createSubject` · `moveSubject` (cycle-safe) · `mergeTag` · `renameTag` · `classify`

### `library`
`search` · `browse` · `subject` · `similar` · `rate` · `comment` · `flag` · `trending`

### `classroom`
`create` · `get` · `list` · `update` · `archive` · `transferOwnership` ·
`members` · `invite` · `inviteBatch` · `revokeInvite` · `regenerateCode` ·
`acceptInvite` · `joinByCode` · `leave` · `removeMember` · `changeRole` ·
`rosterImport` (dry run + apply) · `rosterExport` · `summary`

### `assignment`
`create` · `get` · `list` · `update` · `publish` · `withdraw` · `delete` · `previewAsStudent` · `bulkCreate` · `resolvePolicy` · `extendDeadlineForAll`

### `assessment` (teacher-side authoring)
`questions` · `createQuestion` · `updateQuestion` · `reorder` · `delete` · `duplicate` ·
`validateGrading` (run the grader against sample answers and show the outcome — lets a teacher *see* the key working) · `importQuestions` · `exportQuestions` · `simulateGrading`

### `attempt` (student-side, pre-release)
`myAttempts` · `attemptSummary` (status only, no score) · `startOrResume` · `flagResponse` · `resilienceInfo` (what is saved, what is not) · `submit` · `receipt`

### `grading` (teacher-side)
`queue` · `queueCounts` · `claim` · `release` · `submission` · `responses` · `saveGrade` · `quickScore` · `applyRubric` · `bulkAction` · `flagAutoGrade` · `replaySimulation` · `overrideSimulation` · `excuse` · `void` · `regrade` (dry run + apply) · `studentHistory`

### `release`
`batches` · `createBatch` · `batchDetail` · `blockers` · `release` · `cancel` · `reopen` (creates an audited exception, never silently un-releases)

### `analytics`
`gradebook` · `studentDetail` · `itemAnalysis` · `integrityReport` · `similarity` · `exports.create` · `exports.status`

### `simulation`
`registry` (index for catalogue) · `manifest` · `myDrafts` · `createDraft` · `compileDraft` · `previewDraft` · `usageImpact` · `deprecate` (teacher-suggested)

### `platform`
`health` · `me` · `notifications` · `markRead` · `auditLog` (classroom-scoped) · `admin.users` · `admin.suspend` · `admin.impersonate` (audited, time-boxed, read-only)

---

## 3. Exam REST API (`/api/exam/v1`)

All require `x-attempt-session: <token>` (except `start` and `sync`, which use the normal session). All responses are `Cache-Control: no-store`.

### `POST /attempts/:attemptId/start`
Request
```jsonc
{ "preflight": { "viewport": {...}, "screen": {...}, "features": {...}, "network": {...} } }
```
Response `201`
```jsonc
{
  "attemptId": "...", "sessionToken": "...", "serverNow": "2026-03-04T10:00:00.000Z",
  "startedAt": "...", "deadlineAt": "...", "gracePeriodSec": 0,
  "policy": { /* effective, frozen */ },
  "questions": [ /* PUBLIC projections only — no keys, no model answers */ ],
  "questionDeadlines": { "<qid>": "..." },
  "preflightVerdict": { "status": "OK", "relaxations": [] }
}
```
Errors: `409 ATTEMPT_NOT_STARTABLE` (window, attempts exhausted, already in progress elsewhere), `422` (policy invalid — a bug, alerts).

### `GET /session/:sessionId/sync`
`{ serverNow, startedAt, deadlineAt, questionDeadlines, attemptStatus, saveStateByQuestion }` — the clock handshake, pollable.

### `PUT /attempts/:a/responses/:questionId`
```jsonc
// request
{ "answer": { /* per-type */ }, "revision": 4, "idempotencyKey": "uuid", "clientTs": "..." }
// 200
{ "revision": 5, "serverNow": "...", "questionDeadlineAt": "...", "saveState": "SAVED" }
```
`409 WINDOW_CLOSED` (past the per-question or total window) · `409 WINDOW_CLOSING` (final seconds; shed) · `409 CONFLICT` (stale revision, includes `{ serverAnswer, serverRevision }`) · `422` (answer fails its schema).

### `POST /attempts/:a/sim-state/:questionId`
`{ simState, checksum, revision }` → `200 { revision }`. Same window rules. Validated against the sim's `stateSchema`; an invalid state is accepted-but-flagged rather than rejected, because losing a student's exploration is worse than storing something we will ignore.

### `POST /telemetry`
```jsonc
{ "events": [ { "seq": 12, "type": "TAB_HIDDEN", "clientTs": "...", "payload": { "atMs": 4213 } } ] }
```
→ `202 { accepted: 9, reclassified: 1, dropped: 0 }`. Idempotent per `(attemptId, seq)`. Payload schemas are closed; unknown keys stripped. Never returns anything score-bearing.

### `POST /heartbeat` → `{ serverNow, sessionValid, mustResync, strikeCount, policyState }`. Every 30 s. This is how escalation reaches the client.

### `POST /attempts/:a/submit`
`{ confirmUnanswered: 3, idempotencyKey: "uuid" }` → `202 { receipt, submittedAt, isLate, status }`. Idempotent: a repeat returns the same receipt. Marks `isLate` but does **not** apply the penalty — penalties are computed at grading time so they stay adjustable and auditable.

### `GET /attempts/:a/receipt` → the hash chain root and its verification status.

---

## 4. Events

| Event | Producer | Consumers |
|---|---|---|
| `exam.attempt.started.v1` | exam service | notifications, analytics, presence |
| `exam.attempt.submitted.v1` | exam service | `grade.auto`, notifications, analytics |
| `exam.attempt.expired.v1` | deadline sweep | `grade.auto`, notifications |
| `exam.attempt.auto_graded.v1` | `grade.auto` | review queue, analytics |
| `exam.response.graded.v1` | grading service | attempt recompute, rollup invalidation |
| `grading.regrade.requested.v1` | teacher action | `grade.recompute` |
| `release.batch.released.v1` | `release.batch` | notifications, rollups, audit |
| `classroom.member.added.v1` | classroom service | notifications, roster |
| `assignment.published.v1` | assignment service | notifications, student digest |
| `sim.registry.updated.v1` | sim build | registry index, catalogue cache invalidation |
| `account.deletion_requested.v1` | account service | `dsar.*` |
| `retention.sweep_completed.v1` | retention | audit |

Rules: versioned names; additive-only payload changes within a version; consumers must ignore unknown fields; an unknown event name is a hard failure, never a silent drop.

---

## 5. Asset and file upload
```
POST /api/assets/uploads        → { uploadUrl, key, headers }     (presigned, single use, 15 min)
PUT  <uploadUrl>                → direct to S3
POST /api/assets/:id/complete   → { status, width, height, checksum, altText? }
GET  /api/assets/:id            → authorised signed read URL, or a proxied stream for private files
```
Constraints: content-type allowlist, size cap, server-side image dimension extraction and EXIF strip, checksum verification on completion, and a scan status before a student submission becomes gradeable.

---

## 6. Rate limits

| Route class | Limit | Response |
|---|---|---|
| `auth.register`, `signIn`, password reset | 5 / 15 min / IP + 10 / day / identifier | 429 with a generic message |
| Invitation send | 20 / hour / classroom, 3 / hour / email | 429 |
| Join-code attempts | 10 / 15 min / IP, 30 / day / classroom | 429, silent |
| `exam.telemetry` | 120 / min / session | accepted, dropped silently (telemetry may be incomplete) |
| `exam.responses` PUT | 60 / min / session (a burst allowance of 10) | 429 → client queues and retries |
| `exam.submit` | 10 / attempt | 429 (idempotent anyway) |
| Sim frame origin | none needed (no API) | — |
| General API | 600 / min / session | 429 |

Answer-save limiting is deliberately generous: a legitimate student editing quickly must never be throttled, because a rejected save during an exam is a grading injustice. The client also coalesces and debounces, so real traffic is far lower than the limit.

---

## 7. Webhooks (outbound, future)
`user.registered`, `assignment.published`, `exam.attempt.submitted`, `release.batch.released`, with HMAC signatures, replay protection, and a delivery log. Not v1; the schema is designed to accommodate it.

---

## 8. Versioning policy
- tRPC: additive-only within a deploy. Breaking changes require a parallel endpoint for one release.
- Exam REST: `/v1` is frozen for the life of the platform. Additive fields only. A new field is always optional and always ignored by an old client.
- Never remove or rename a field that a shipped client reads. Ever. A student mid-exam on a cached bundle is the reason.
