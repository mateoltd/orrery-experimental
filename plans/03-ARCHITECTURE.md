# 03 — Architecture

Runtime topology, deployable units, request lifecycles, caching, scaling, configuration.

---

## 1. Topology

```
                     ┌──────────────────────────────────────┐
  student / teacher  │  CDN + WAF + rate limiting + TLS      │
        ───────────▶│  (static assets, long-lived sim bundles)│
                     └───────────────────┬──────────────────┘
                                         │
              ┌──────────────────────────▼───────────────────────────┐
              │  sims.<domain>   static only, strict CSP, no cookies  │
              │  no API. CSP: default-src 'none'; script-src 'self'; │
              │  connect-src 'none'; frame-ancestors <app origin>     │
              └──────────────────────────▲───────────────────────────┘
                                         │ sandboxed iframe + postMessage
                     ┌───────────────────┴──────────────────┐
                     │  web  (Next.js, N replicas)          │
                     │  · RSC: marketing, library, studio   │
                     │  · tRPC: app surface                 │
                     │  · REST: /api/exam/v1 (frozen)        │
                     │  · exam runtime + sim host (client)  │
                     └──┬──────────┬──────────┬────────────┘
                        │          │          │
          ┌─────────────▼──┐  ┌────▼─────┐  ┌─▼────────────────┐
          │ PostgreSQL 16  │  │  Redis   │  │ S3 (assets, sim  │
          │ primary + RO   │  │ cache,   │  │ bundles, exports)│
          │ PITR 15 min    │  │ limits   │  └──────────────────┘
          └────────┬───────┘  └──────────┘
                   │
        ┌──────────▼───────────┐      ┌──────────────────────────┐
        │ worker (Inngest)     │─────▶│ side workers: sim build, │
        │ consumer + cron      │      │ email, export, retention │
        └──────────────────────┘      └──────────────────────────┘
```

**Why a separate sim origin.** It makes the sandbox real rather than advisory. Even if a future browser relaxed iframe sandboxing, cross-origin plus CSP means a sim can never reach the app: no DOM, no cookies, no storage, no network. This is a load-bearing part of `INV-SIM-1` and of `ADR-0014` (container deploy, not Vercel-only).

**Why exam-critical paths are hand-written REST, not tRPC.** `RN-10` — the exam path must survive page unload (`sendBeacon`), be idempotent, version-conflicted, load-testable in isolation, and stable enough that a student on a week-old cached bundle is never broken. tRPC is for everything else.

---

## 2. Deployable units

| Unit | Contents | Scale signal |
|---|---|---|
| `web` | Next.js standalone; tRPC, REST, RSC | request rate, p95 |
| `worker` | Inngest consumer, cron, background jobs | queue depth |
| `sim-build` | registry build, screenshots, conformance | registry diff size |
| `migrate` | one-shot pre-deploy job | — |

**Deploy order:** `migrate` → `worker` → `web`. Rolling, never big-bang: an exam may be in progress and a deploy must not interrupt it. Every schema and event change is **expand/contract**, and the previous release stays deployable for at least one cycle, so a rollback never meets a schema it cannot read.

**Feature flags** are server-authoritative. A client cannot enable a control the server has not granted, nor disable one it has. Any flag affecting an assessment is recorded **on the attempt**, so we always know whether a given exam ran with a flag on or off.

---

## 3. Request lifecycles

### 3.1 Public resource read
```
CDN (stale-while-revalidate)
  → RSC render
  → session lookup (Redis 60 s)
  → can(view, resource)                   ← the only authorisation path
  → Prisma: resource + pinned version + sim refs
  → blocks → sanitised HTML + KaTeX
```
Cache keys include the visibility tier, owner and version, so a private resource can never be served from a public cache entry. Private responses are `private, no-store`.

### 3.2 Assessment surface (student)
```
GET /exam/assignments/:id/start
  → resolve effective policy: assignment override ⊕ version policy ⊕ student override ⊕ accommodation
  → if a slot is POOLED: draw N of M with rngSeed, write variantMap ONCE
  → create attempt, freeze policySnapshot, set startedAt/deadlineAt
  → issue AttemptSession (single active), record preflight
  → respond: PUBLIC question projections + deadlines + nonce
loop
  → edits         → debounced PUT /responses/:qId      (fetch, retry, IndexedDB outbox)
  → sim state     → debounced POST /sim-state/:qId
  → watchdogs     → batched POST /telemetry            (sendBeacon on unload)
  → heartbeat     → every 30 s, returns escalation state
POST /submit
  → assert submittable · close windows · fold hash chain · persist receipt
  → pure grader over stored answers → SEALED scores
  → PENDING_REVIEW (or GRADED) + ReviewTask
  → 202 with the receipt
```

### 3.3 Grade and release
```
teacher grades   → PUT /grading/responses/:id   (optimistic lock, GradeChange appended)
teacher releases → POST /releases/:batchId     (202, background)
  → worker: verify EVERY attempt releasable (or an override reason is recorded)
  → single transaction: unseal, final scores, releasedAt, batch RELEASED
  → invalidate rollups · enqueue notifications · write audit (outside the transaction)
```

### 3.4 Deadline sweep (cron, 30 s)
```
1. IN_PROGRESS with deadlineAt + grace < now  → auto-submit server state (CRON)
2. per-question windows past deadline          → close per policy, record event
3. inside the final 10 s of a cohort deadline   → answer writes get 409 WINDOW_CLOSING
```
Goal: the database sees a flat ~200 writes/s, not a 5,000-request spike.

---

## 4. Frontend structure

```
apps/web/src/
├─ app/                      # routes only — thin, no business logic
│  ├─ (marketing)/  (library)/  studio/  classroom/  learn/
│  └─ exam/[attemptId]/       # EXAM SURFACE
├─ features/<domain>/         # domain logic + components + tests + README.md
│  authoring/ classroom/ assessment/ exam/ grading/ simulation/ banks/
├─ server/                    # tRPC routers, exam REST, services (transactions live here)
└─ lib/                       # cross-cutting helpers only
```

### 4.1 The exam surface is deliberately isolated
Its own error boundary, its own minimal provider tree, no dependency on features that might break, and **a hard rule that a route outside `/exam/*` cannot crash it**. If a marketing page throws at 10:00 on exam day, nothing happens to that student. This is a design constraint, not a nicety.

### 4.2 State management
- Server state: TanStack Query (tRPC adapter) everywhere **except** the exam runtime.
- Exam runtime: a purpose-built reducer in `@orrery/exam-engine` plus the IndexedDB outbox. No React Query in the answer path — retry ordering and durability semantics matter more than cache sophistication when a deadline is running.
- Draft editing: a local reducer with optimistic concurrency against the version counter. Not a CRDT (`RN-11` — collaborative editing would jeopardise P2 and is not needed for single-author authoring).

### 4.3 No barrel files
`RN-09`: barrel files are the largest single cause of bundle bloat and server/client boundary violations in App Router projects. Every package exports from explicit subpaths, enforced by an ESLint boundary rule.

---

## 5. Data access
- Only `packages/db` imports Prisma. It exports named query functions — never a client instance.
- Multi-table writes go through a service function that owns the transaction and the audit events. Routers never open transactions.
- Analytics read models are parameterised raw SQL in `packages/db/src/queries/`, each with hand-verified fixtures. Prisma is for writes and simple reads; it is not an analytics engine.
- `Prisma` is instantiated as a single client with connection pooling sized for the web replica count, and a **separate** client for the worker. `RN-06` — Prisma 6+ rejects `undefined` in a `where` clause instead of silently dropping the filter; that strictness is a feature here and we lean into it rather than working around it.
- Indexes are declared in the schema and reviewed quarterly with `EXPLAIN (ANALYZE, BUFFERS)` against the hot paths in `18-OPS-RELIABILITY.md`.

---

## 6. Asynchronous work

| Job | Trigger | Guarantee |
|---|---|---|
| `exam.deadlineSweep` | cron 30 s | auto-submit, close windows, shed writes |
| `grade.auto` | attempt submitted | pure grader; sealed results written |
| `grade.recompute` | manual grade, policy change | totals recomputed; audit appended |
| `release.batch` | teacher action | atomic, idempotent, resumable |
| `notifications.email` | domain event | per-recipient, retryable, deduped on `(user, kind, ref)` |
| `export.gradebook` | teacher action | streamed CSV/PDF, expiring signed link |
| `sim.build` | registry diff | bundle, screenshot, conformance, register |
| `analytics.rollup` | release, regrade | per-assignment precomputed aggregates |
| `retention.sweep` | cron daily | telemetry, sessions, invitations, exports; dry-run mode |
| `dsar.export` / `dsar.erase` | account request | data inventory; anonymisation with dry run |
| `interop.sync` | schedule / manual | QTI, OneRoster, LTI roster and grade push |
| `sim.telemetry` | batched | usage counters, allowlisted fields only |

Event names are versioned (`exam.attempt.submitted.v1`). Payloads are additive within a version. Consumers tolerate unknown fields and **fail loudly on unknown event names** — a typo must be a visible failure, not a silently dropped grade.

---

## 7. Configuration
- All environment access goes through a Zod-validated `env.ts` that **fails at boot** on a missing or malformed variable. No `process.env` outside it (ESLint-enforced).
- Secrets live in the platform secret store, injected at runtime, never in the image, never in git, never in logs. `scripts/scan-secrets.sh` runs in CI.
- `pnpm --filter @orrery/config env:check` validates the whole environment without starting the app — a fast pre-deploy gate.

---

## 8. Performance budget

| Route / artefact | Budget |
|---|---|
| Public resource | LCP < 1.8 s · JS < 180 KB gz · no sim bundle until visible |
| Library / dashboard | JS < 220 KB gz |
| Studio | JS < 400 KB gz (the editor is the heaviest thing we ship) |
| **Exam runtime** | JS < 250 KB gz · interactive < 2 s on a 2019 mid-range laptop · **zero layout shift after start** |
| Sim frame | lazy; per-sim budget 350 KB, 1.2 MB hard ceiling |
| App bundle vs registry size | **must not grow** — sims are content-addressed and loaded on demand |

The exam budget is a release gate. A heavy exam start is a real failure: a student on school wifi must be able to begin.

---

## 9. Architectural constraints that bind everything

1. **The client is untrusted.** All validation server-side; client validation is UX only.
2. **The server is the clock.** One time source, injected everywhere.
3. **Content is immutable once assigned.** Version pinning is why a grade means anything.
4. **Simulations are untrusted code on a separate origin**, with dual targets so grading needs no browser.
5. **Release is a transaction.** There is no partial-visibility state to reason about.
6. **Evidence is not verdict.** Integrity telemetry informs a human and never decides.
