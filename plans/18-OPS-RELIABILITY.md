# 18 — Infrastructure, Observability & Reliability

---

## 1. Environments

| Env | Purpose | Data | Infra |
|---|---|---|---|
| `local` | Development | Synthetic seed | Compose: PG 16, Redis 7, MinIO, Mailpit, OTel collector, Grafana |
| `preview` | Per-PR | Synthetic seed, ephemeral | Ephemeral containers, torn down after the run |
| `staging` | Release candidate | Synthetic seed | Single-region, production-shaped, production config |
| `prod` | Live | Real | Multi-AZ, managed PG with PITR, managed Redis, S3 |

**Staging is production-shaped and gets the release rehearsal.** A deploy that works only in staging is a deploy that will fail on a Friday.

---

## 2. Local development

```bash
pnpm setup     # install · generate · docker compose up · migrate · seed
pnpm dev       # web :3000 · worker · watch-mode sim build
pnpm reset:e2e # rebuild from seed fixtures, < 30 s
```

Provided: Postgres 16 with `pg_stat_statements`, Redis 7, MinIO with a seeded `mc` alias, Mailpit (web UI on `:8025`), an OTel collector with local Grafana, and a seeded simulation registry so the playground has something to embed.

**Every external dependency has a local substitute. No test requires a third-party network call.**

---

## 3. Production topology

```
Cloudflare — CDN, WAF, rate limiting, TLS, app origin, sims origin
  ├── web      ×N  (2+ replicas, health-checked, rolling deploys)
  ├── worker   ×N  (Inngest consumer, autoscaled on queue depth)
  └── migrate       (one-shot, pre-deploy)
Managed Postgres 16 — primary + read replica, PITR to 15 min, daily snapshots 35 d
Managed Redis     — cache, rate limits
S3               — assets, content-addressed sim bundles, exports, backups
Email provider    — transactional, domain-authenticated
Sentry · Grafana · Tempo
```

**Scale assumptions:** 750 concurrent exam takers ≈ 4 web replicas. Autoscaling on request rate and p95, with a **floor of 2 during any published exam window**, because a cold start during an exam is a real incident, not a metrics curiosity.

---

## 4. Observability

### 4.1 Signals
| Signal | Contains | Never contains |
|---|---|---|
| Traces (OTel → Tempo) | request/job spans, `requestId`, **`attemptId`**, `assignmentId`, `classroomId`, route, status, duration | answer content, PII, tokens, keys |
| Metrics (→ Grafana) | RED per route, DB pool, queue depth, job outcomes, sim load timings, autosave latency and error rate, strike counts, release durations | per-student identifiers in labels (cardinality) |
| Logs (Pino → Loki) | structured, correlated, sampled | anything from the evidence table; PII redacted at the logger |
| Errors (Sentry) | stack, breadcrumbs (route and action names only), release, user id **hash** | request bodies by default |
| Audit (Postgres) | every consequential action, immutable, teacher- and admin-queryable | — this is the record of truth |
| Product analytics | aggregate counts, funnels, feature usage | no answer content, no free text, no PII |

**Scrubbing is enforced, not remembered.** A `redact()` helper is the only way to build a log object, and a CI test seeds canary values (a fake answer-key marker, a fake email, a fake token) and asserts they never appear in captured log output.

### 4.2 The `attemptId` spine
Every exam-related trace, log line, metric exemplar and error carries `attemptId`. One grep reconstructs a student's entire exam journey, from start through every save and evidence event to release. This is the single most valuable debugging affordance we will build, and it is why the client sends `attemptId` on every request — including the ones that would fail.

---

## 5. SLOs and alerts

| SLO | Target | Alert |
|---|---|---|
| Exam start succeeds | 99.9% | 5-min burn > 2% |
| Answer save acknowledged | 99.95%, p95 < 250 ms | 5-min burn > 1% |
| Autosave error rate | < 0.5% | > 2% for 5 min |
| Submit success | 99.9% | 5-min burn > 2% |
| Deadline sweep completes | 99.9% within 60 s of schedule | one missed cycle |
| **Release atomicity** | **100%** | **any assertion failure pages immediately** |
| Release duration | p95 < 60 s for 5,000 attempts | > 5 min |
| Sim load success | 99.5% | < 98% over 15 min |
| Sim conformance suite | 100% green | any failure blocks deploy |
| Web p95 (non-exam routes) | < 400 ms | 15-min burn |
| RPO / RTO | 15 min / 4 h | verified by drill |

### 5.1 Alerts that page a human
Release **atomicity failure** · deadline sweep missed twice · autosave error spike during a live exam · replica lag affecting reads · any error touching grading or release paths · backup failure · a sim conformance regression in production · MFA or session-reuse security events.

**Atomicity is a correctness guarantee, not a metric.** It pages at 3 a.m. even for three occurrences, because it means a student may have seen a partial grade — the single worst thing this product can do.

### 5.2 Alerts that do not page
Sim load latency · search latency · registry index staleness · email queue depth. These are ticket-level, not wake-up-level.

---

## 6. Runbooks

One page each, written **before** the system needs them, and rehearsed in a drill.

| Runbook | Contents |
|---|---|
| Exam start failing for a cohort | Triage, common causes, mitigations, **communication template** |
| Autosave error spike mid-exam | Diagnosis; whether to extend deadlines; how to notify students |
| Deadline sweep stalled | Manual sweep procedure, verification queries |
| Release job failed | **Verify atomicity first**, then retry, then manual release path |
| Sim origin down | CDN failover, or degrade to static fallbacks |
| Database failover | Connection handling, queue drain, verification queries |
| Restore from backup | Step by step, with expected timings |
| Suspected account compromise | Session revocation, audit query, notification |
| Suspected sim supply-chain issue | Disable a version, find pinned resources, notify affected classrooms |
| Mass abuse (registration flood, scraper) | Rate limits, CAPTCHA threshold, blocklist |
| Content bug affecting a live cohort | Flag the version, freeze assignments, communicate, fix forward |

Every runbook ends with **"who to tell and what to say"**. A platform that fails silently while a class sits in an exam is worse than one that admits it.

---

## 7. Backup and disaster recovery
- **PITR to 15 minutes** on the primary. Daily snapshots retained 35 days. Cross-region snapshot copy.
- **Restore drill quarterly, and once before GA**: restore into a clean environment, run the full test suite against it, measure the real RTO, and write down what was harder than expected. An untested backup is a hypothesis.
- **Recovery order:** database → object storage (assets and sim bundles are content-addressed and immutable, so they restore last and safely) → configuration → deploy.
- **Degradation ladder:** assets down → placeholders, lessons still render; sims down → static fallbacks; analytics rollups gone → rebuild; **only the database and the exam path are hard dependencies.**

---

## 8. Migrations in production
1. **Expand/contract, always.** Add nullable columns and new tables → deploy code that writes both → backfill → deploy code that reads the new shape → drop the old column in a later release.
2. Every migration declares a lock level and an estimated duration. Anything over 5 s on production-sized data needs a reviewed plan.
3. `CREATE INDEX CONCURRENTLY` on populated tables. Never a table rewrite inside a release.
4. Destructive migrations require a written `MIGRATION.md` with the data-copy step and the rollback story, plus a dry run against a production-sized copy.
5. Deploy order `migrate` → `worker` → `web`, and the previous release stays deployable throughout — so a rollback never meets a schema it cannot read.

---

## 9. Cost

| Lever | Action |
|---|---|
| Sim bundles | Content-addressed, immutable, long-lived CDN cache, never in the app bundle |
| Assets | Presigned direct upload (bytes never traverse our servers), resized derivatives generated once, CDN-served |
| Analytics rollups | Precomputed per assignment, invalidated on regrade, never computed per page view |
| Autosave | Debounced and coalesced; the DB sees ~1 write per 5 s per student, not one per keystroke |
| Web | Server Components by default; the exam runtime is the only heavy client island |
| Registry index | One cached JSON metadata index of 220 sims — never their code |
| Observability | Head-based sampling with `attemptId` **always** retained; exam traces are never sampled out |
| Read scaling | A read replica for library search, discovery and analytics, so an exam cohort never competes with browsing traffic |

---

## 10. Release process

```
PR merged → CI green → preview deployed → smoke E2E on preview
          → staging deploy → rehearsal (seed a classroom, run an exam, release it)
          → canary 5% of web for 30 min → full rollout
          → post-release smoke on prod → announce
```
Release windows avoid published exam windows. A deploy during an active cohort is permitted only for a security fix, and only with the exam-path regression suite green.

Feature flags for anything a pilot teacher may need to turn off, **server-authoritative**, with the flag state recorded on any attempt it affects — so we always know whether a given exam ran with a flag on or off.

---

## 11. Load test design

`pnpm test:load` is a first-class artefact, not an ad-hoc script:

| Property | Requirement |
|---|---|
| Realistic | 750 virtual students with think-time distributions taken from the item time-on-item percentiles (`08` §2.4), not a flat loop |
| Realistic saves | Answer saves at the observed debounce rate, not a synthetic 10 rps |
| Realistic deadline | The stampede scenario: all 5,000 attempts released into the same 10-second window |
| Assertions | Not just latency: **zero lost acknowledged saves**, no partial release observed, no 5xx above 0.1% |
| Repeatable | Seeded, so a failure is reproducible |
| Versioned | Results committed to the repo, so a regression is visible against history |

Latency without correctness assertions is how teams ship a load test that passes while the product loses student answers.
