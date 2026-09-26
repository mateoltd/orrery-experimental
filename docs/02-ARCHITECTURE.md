# Architecture

---

## 1. Runtime topology

```
                        ┌───────────────────────────────┐
   student / teacher ──▶│  CDN + WAF  (static, cache)   │
                        └───────────────┬───────────────┘
                                        │
                        ┌───────────────▼───────────────┐
                        │  web  (Next.js, N replicas)    │
                        │  · RSC pages (public, studio)  │
                        │  · tRPC + REST handlers        │
                        │  · exam runtime (client)       │
                        │  · sim host (client)           │
                        └────┬──────────┬───────────┬────┘
                             │          │           │
              ┌──────────────▼──┐  ┌────▼─────┐  ┌──▼──────────────┐
              │ PostgreSQL 16   │  │  Redis   │  │ S3 (assets,     │
              │ primary + 1 RO  │  │ cache,   │  │ sim bundles)    │
              │ + PITR          │  │ rate lim │  └─────────────────┘
              └────────┬────────┘  └──────────┘
                       │
              ┌────────▼────────┐        ┌──────────────────────┐
              │ worker (Inngest)│───────▶│ email / sim build / │
              │ cron + steps    │        │ exports (workers)    │
              └─────────────────┘        └──────────────────────┘

  sims.<domain>  — separate static origin, strict CSP, hosts bundles only.
                    Referenced by the sim host iframe. No cookies. No API.
```

**Why a separate origin for simulations:** it makes the sandbox real rather than advisory. Even if a future browser relaxes iframe sandboxing, cross-origin + CSP means a sim can never reach the app.

**Why autosave and telemetry are REST and not tRPC:** they run on a critical path with hard deadlines, must survive page unload (`sendBeacon`), need explicit idempotency keys and version-based conflicts, and must be trivially load-testable in isolation from the rest of the API. tRPC is for everything else.

---

## 2. Deployable units

| Unit | Contents | Scaling signal |
|---|---|---|
| `web` | Next.js standalone server, tRPC, REST, RSC | request rate + p95 latency |
| `worker` | Inngest event consumer, cron, background jobs | job queue depth |
| `sim-build` | Registry build + screenshot capture | registry diff size |
| `migrate` | One-shot job, run before web/worker roll out | — |

Deploy order: `migrate` → `worker` (consumes new event schemas) → `web`. Rolling, never big-bang, because an exam in progress must not be interrupted by a deploy. Worker and web are backward-compatible with each other for at least one release (expand/contract on every schema and event change).

---

## 3. Request lifecycles

### 3.1 Read a resource (public)
```
CDN (cached, stale-while-revalidate) ──▶ origin: RSC page render
  → session lookup (Redis-cached, 60 s)
  → can(view, resource) — the only authorisation path
  → Prisma: resource + pinned version + block refs
  → render blocks to sanitised HTML + KaTeX
  → cache key includes visibility, owner and version
```
Cache keys include the visibility tier so a private resource can never be served from a public cache entry. Private responses are `private, no-store`.

### 3.2 Take an exam (the one that must not break)
```
GET  /exam/assignments/:id/start
  → resolve effective policy (assignment override ⊕ version policy)
  → create attempt, freeze policySnapshot, generate seed + variantMap
  → issue AttemptSession, record preflight
  → return questions as PUBLIC projections + deadlines + nonce

loop (client)
  → edits → debounced PUT /responses/:qId      (fetch, retry, outbox)
  → sim state → debounced POST /sim-state/:qId
  → watchdogs → batched POST /telemetry        (sendBeacon on unload)
  → heartbeat every 30 s

POST /submit
  → assert submittable, close windows, fold hash chain, persist receipt
  → pure grader over stored answers → SEALED scores
  → PENDING_REVIEW (or GRADED), ReviewTask created
  → 202 Accepted with the receipt
```

### 3.3 Grade and release
```
teacher grades → PUT /grading/responses/:id  (optimistic lock)
                → recompute attempt, append GradeChange + AttemptEvent
teacher releases → POST /releases/:batchId   (202, background)
  → worker: verify all attempts releasable (or override reason present)
  → single transaction: unseal + final scores + releasedAt
  → invalidate rollups, enqueue notifications, write audit
```

---

## 4. Frontend structure

```
apps/web/src/
├─ app/                     # routes only: thin, no business logic
│  ├─ (marketing)/          # public, mostly static
│  ├─ (library)/            # public resources
│  ├─ studio/               # authoring
│  ├─ classroom/            # teacher
│  ├─ learn/                # student
│  └─ exam/[attemptId]/     # EXAM SURFACE — minimal deps, own error boundary,
│                           #   no global providers that could break mid-exam
├─ features/<domain>/       # domain logic + components + tests + README.md
│  ├─ authoring/
│  ├─ classroom/
│  ├─ assessment/
│  ├─ exam/                 # watchdogs, runtime state machine, answer store
│  ├─ grading/
│  └─ simulation/           # sim host component
├─ server/                  # tRPC routers, REST handlers, services
│  ├─ routers/
│  ├─ exam/                 # exam-critical REST
│  └─ services/             # transactions live here
└─ lib/                     # cross-cutting helpers only
```

**The exam surface is deliberately isolated.** It has its own error boundary, its own minimal provider tree, and no dependency on features that might break. If a marketing page throws during a student's exam, nothing happens to that student. This is a real design constraint, not a nicety.

### 4.1 State management
- Server state: TanStack Query (tRPC adapter) everywhere **except** in the exam runtime.
- Exam runtime: a purpose-built reducer (`@orrery/exam-engine` state machine) with the IndexedDB outbox. No React Query in the answer path — retries, ordering and durability semantics matter more than cache sophistication during an exam.
- Draft editing: a local reducer with optimistic concurrency against the version counter, not a live-collaborative editor. CRDTs are a v2 decision; the plan does not need them and they would jeopardise P2.

---

## 5. Data access rules
- Only `@orrery/db` touches Prisma. Services call named query functions; no ad-hoc queries in components or routers.
- Multi-table writes go through a service function that owns the transaction and the audit events. Routers never open transactions.
- Read models for analytics are raw SQL modules in `packages/db/src/queries/` with hand-verified fixtures. Prisma is for writes and simple reads; it is not an analytics engine.
- Indexes are declared in the schema and reviewed quarterly with `EXPLAIN (ANALYZE, BUFFERS)` on the hot paths listed in `09-OPS.md`.

---

## 6. Asynchronous work

| Job | Trigger | Guarantee |
|---|---|---|
| `exam.deadlineSweep` | cron, 30 s | Auto-submit, close question windows, shed writes |
| `grade.auto` | attempt submitted | Pure grader run; sealed results written |
| `grade.recompute` | manual grade, policy change | Attempt totals recomputed; audit appended |
| `release.batch` | teacher action | Atomic unseal; idempotent; resumable |
| `notifications.email` | domain event | Per-recipient, retryable, idempotent per (user, kind, ref) |
| `export.gradebook` | teacher action | Streamed CSV/PDF, expiring download link |
| `sim.build` | registry diff | Bundle, screenshot, conformance, register |
| `retention.sweep` | cron, daily | Deletes expired telemetry, sessions, invitations, exports |
| `dsar.export` / `dsar.erase` | account request | Data inventory export; anonymisation with dry run |
| `analytics.rollup` | release, regrade | Per-assignment precomputed aggregates |
| `sim.telemetry` | batched | Usage counters, allowlisted fields only |

Event bus is Inngest. Events are versioned (`exam.attempt.submitted.v1`); consumers tolerate unknown fields and refuse unknown *event names* loudly, so a typo is a visible failure rather than a silently dropped job.

---

## 7. Configuration and secrets
- All environment access goes through a Zod-validated `env.ts` that **fails at boot** on a missing or malformed variable. No `process.env` reads outside that module (ESLint-enforced).
- Secrets live in the platform's secret store, injected at runtime, never in the image, never in git, never in logs. `scripts/scan-secrets.sh` runs in CI.
- Feature flags exist for anything a teacher might need to turn off mid-pilot (e.g. `EXAM_POINTER_LOCK=off`) and are server-authoritative — a client cannot enable a control the server has not granted, and cannot disable one it has.

---

## 8. Front-end performance budget

| Route | Budget |
|---|---|
| Public resource | LCP < 1.8 s, JS < 180 KB gz, no sim bundle until visible |
| Library / dashboard | JS < 220 KB gz |
| Studio | JS < 400 KB gz (editor is the heaviest thing we ship) |
| **Exam runtime** | JS < 250 KB gz, first interaction-ready < 2 s on a 2019 mid-range laptop, **zero layout shift after start** |
| Sim frame | lazy, per-sim budget from `03-SIMULATIONS.md` |

The exam runtime's budget is a release gate. A heavy exam start is a real failure: a student on school wifi must be able to begin.

---

## 9. Architectural decisions that constrain everything else

1. **The client is untrusted.** All validation happens server-side; the client validates for UX only.
2. **The server is the clock.** One time source, injected everywhere.
3. **Content is immutable once assigned.** Version pinning is the reason grades mean something.
4. **Simulations are untrusted code in a separate origin.** Dual-target so grading can happen without a browser.
5. **Release is a transaction.** There is no partial-visibility state to reason about.
6. **Telemetry is evidence, never truth.** It informs a human; it never decides.
