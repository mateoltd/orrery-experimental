# Architecture Decision Records

Status values: `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Rejected`.

---

### ADR-0001 — Platform name and scope
**Status:** Accepted
**Context:** Greenfield. Need a name and a one-sentence scope to keep the build honest.
**Decision:** The platform is **Orrery** — an open registration educational portal with four coupled products: Studio (authoring), Simulations (200+ sandboxed interactives), Classroom, and Assessment/Grading with teacher-gated result release. Built as a TypeScript monorepo.
**Consequences:** Everything in `PLAN.md` is in service of those four products. Features that serve none of them are out of scope by default.

### ADR-0002 — TypeScript end to end
**Status:** Accepted
**Context:** The hardest correctness risk is a question/answer/simulation contract that must agree across the app, the editor, the grader, the sim SDK and 200 simulations.
**Decision:** TypeScript 5.9, `strict`, one language, one toolchain, no `any` at boundaries.
**Consequences:** Contracts in `@orrery/contracts` are the single source of truth and are shared by client, server, worker and sims. Cost: Node-only libraries are off the table; a few scientific libraries need thin wrappers.
**Rejected:** Python/Django (strong scientific ecosystem, but a second language and a duplicated contract); Go (excellent concurrency, poor authoring-experience velocity for the editor work).

### ADR-0003 — pnpm workspaces + Turborepo
**Status:** Accepted
**Context:** ~10 packages, 2 apps, 200 sims, heavy test matrix.
**Decision:** pnpm workspaces with Turborepo for task caching and dependency-ordered execution.
**Consequences:** Fast, deterministic, minimal config. Cost: build-graph config must be maintained; sims are excluded from the main pipeline and built by their own job.
**Rejected:** Nx (more power, much more config to get wrong); a single-repo with no workspace tooling (no caching, no ordering, slow CI).

### ADR-0004 — Next.js App Router as the only web deployable
**Status:** Accepted
**Context:** Public content wants SSR/SEO; the exam runtime wants a fast, isolated client island; we want to avoid operating two services.
**Decision:** One Next.js app. Server Components for public and studio pages; client components for the exam runtime, editor and grading workspace. Exam-critical endpoints are REST inside the same app but written as standalone handlers with their own tests and load tests.
**Consequences:** One deployable, one type system, one auth path. Cost: the exam route must be deliberately isolated (own error boundary, minimal providers) so an unrelated page failure cannot affect a student mid-exam.
**Rejected:** Vite SPA + separate API (two services, duplicated auth and types, worse public SEO); Remix (excellent, but Next's ecosystem and RSC fit the library/marketing surfaces better).

### ADR-0005 — tRPC for the app surface, REST for the exam-critical path
**Status:** Accepted
**Context:** Type safety everywhere is desirable, but answer saves must survive page unload, be idempotent, versioned, and load-testable in isolation.
**Decision:** tRPC v11 for everything except `/api/exam/v1/*`, which is hand-written REST with explicit `idempotencyKey`, `revision` conflicts and frozen versioning.
**Consequences:** The exam path is deliberately dumb and explicit, which is what we want when a deadline is running. Cost: two API styles; mitigated by a shared Zod contract layer and a lint rule on the exam routers.
**Rejected:** tRPC everywhere (unattractive failure modes at page unload, harder to load-test in isolation, no stable external contract); REST everywhere (loses end-to-end types, which is our biggest agentic-build safety net).

### ADR-0006 — PostgreSQL
**Status:** Accepted
**Decision:** PostgreSQL 16 as the only datastore. JSONB for block content, question specs and policy; `tstzrange` and CTEs available; `LISTEN/NOTIFY` if needed; row-level security available as defence in depth.
**Consequences:** We get real constraints and transactional release. Cost: local dev needs a container; Testcontainers needed for integration tests.
**Rejected:** MySQL (weaker JSONB ergonomics and range types); SQLite (cannot be the release transaction's home); Mongo (transactions and constraints weaker, and our data is highly relational).

### ADR-0007 — Prisma with raw-SQL escape hatches
**Status:** Accepted
**Context:** Schema changes are the highest-risk autonomous operation, and analytics needs SQL Prisma does not express.
**Decision:** Prisma 6 for schema, migrations and all writes/simple reads. Named query modules in `packages/db/src/queries/` use parameterised raw SQL for analytics, with hand-verified fixtures. `packages/db` is the only place Prisma is imported; it exports functions, never a client.
**Consequences:** Declarative schema and checked-in SQL migrations, which is the lowest-risk surface for many autonomous agents. Cost: two query styles; analytics queries are reviewed by hand because Prisma cannot type-check them.
**Rejected:** Drizzle (excellent SQL control, but migrations and agent ergonomics are less forgiving); raw SQL everywhere (no type safety, high typo risk under autonomous work).

### ADR-0008 — Better Auth with database sessions
**Status:** Accepted
**Context:** We need registration, verification, magic links, and — critically — sessions we can revoke mid-exam.
**Decision:** Better Auth, sessions stored in Postgres, Argon2id, email verification required before publishing or creating a classroom.
**Consequences:** Session revocation takes effect on the next request, which is what mid-exam removal requires. No vendor lock-in. Cost: an evolving library; pin the version and upgrade deliberately.
**Rejected:** JWT-only sessions (cannot be revoked — disqualifying); Clerk (excellent, but a vendor dependency and a per-MA cost before we have revenue); hand-rolled auth (never).

### ADR-0009 — Tailwind + shadcn/ui
**Status:** Accepted
**Decision:** Tailwind CSS 4 with shadcn/ui components copied into `packages/ui` and owned by us.
**Consequences:** Full control over accessibility and exam-critical UI, no runtime component-library dependency, no design-system lock-in. Cost: we own the components.
**Rejected:** Mantine/Chakra (a dependency we would fight for the exam surface's strict a11y needs).

### ADR-0010 — ProseMirror JSON as the canonical block format
**Status:** Accepted
**Context:** User content must be rendered safely, versioned immutably, diffed, and rendered identically on server and client.
**Decision:** TipTap v3 / ProseMirror JSON, validated against a closed block union on every write. The renderer emits HTML from typed data; **user-supplied HTML is never accepted.**
**Consequences:** XSS-by-content is structurally prevented, and diffs are structural rather than textual. Cost: a real editor to build and maintain; if it slips, a plain block-list authoring UI is the fallback.
**Rejected:** MDX (executes author-supplied JSX — unacceptable for multi-tenant content); raw Markdown with an HTML sanitiser (sanitiser drift is a security liability).

### ADR-0011 — Simulations: sandboxed iframe, postMessage RPC, dual target
**Status:** Accepted
**Context:** The platform's differentiator is hundreds of simulations, authored by many people, embeddable in lessons, and gradable as exam questions.
**Decision:** Each sim is an ESM bundle in a `sandbox="allow-scripts"` iframe on a **separate origin** with a strict CSP, communicating over a versioned `postMessage` protocol (`sim-host@1`) with a per-mount nonce. Each sim exports a pure `./grader` that runs in **Node**, so auto-grading never needs a browser.
**Consequences:** Simulations are isolated (INV-SIM-1) and server-gradable (INV-SIM-2), which is what makes sim questions valid exam items. Registry and conformance suite scale to hundreds. Cost: a protocol to maintain, and a cross-origin iframe cannot use `localStorage` — persistence is host-mediated.
**Rejected:** React components (full host privileges — disqualifying); WebAssembly-only (excludes the entire authoring skill set); a trusted plugin model (same problem, worse optics).

### ADR-0012 — Inngest for background work
**Status:** Accepted
**Context:** Auto-submit sweeps, atomic releases, exports, emails and the sim build pipeline all need retries, step history and observability.
**Decision:** Inngest for durable jobs plus Postgres cron for fixed schedules. Versioned event names; additive payloads within a version; unknown event names fail loudly.
**Consequences:** Retries and step history are free, and grading/release have an auditable execution trail. Cost: a service dependency; the self-hosted option exists.
**Rejected:** BullMQ (we would own the worker supervision and the dashboards); Temporal (correct but heavy for our scale and a large operational surface).

### ADR-0013 — Vitest + Playwright for everything
**Status:** Accepted
**Decision:** Vitest for unit and integration (with Testcontainers for real Postgres/Redis), Playwright for E2E **and** for the simulation conformance matrix. `fast-check` for property-based tests.
**Consequences:** One toolchain, and the conformance matrix doubles as the E2E harness for sims. Cost: Playwright is the slowest gate; we keep it small and shard it.
**Rejected:** Jest (slower, weaker TS, separate toolchain); Cypress (weaker multi-origin iframe and API testing, which is exactly what the sim host needs).

### ADR-0014 — Container deploy, not Vercel-only
**Status:** Accepted
**Context:** The sim registry is a build pipeline producing content-addressed bundles; the worker runs long-lived jobs.
**Decision:** OCI images deployed to a container platform (Fly.io / Render / K8s) with managed Postgres, Redis and S3. Next.js runs in standalone mode.
**Consequences:** Full control of the sim build and the workers, and the app origin is separable from the sim origin — which ADR-0011 depends on. Cost: we operate containers.
**Rejected:** Vercel-only (acceptable for the app, but it complicates the sim-build pipeline, the worker story, and the required separate sim origin with its own CSP).

### ADR-0015 — Graded simulations require a pure Node grader
**Status:** Accepted
**Context:** A simulation question must be auto-graded on the server, from stored state, without a browser — otherwise exam grading would require re-running a browser per submission, and the grade could not be reproduced for an appeal.
**Decision:** Every sim with `capabilities.grading: true` exports a pure `grader(state, params, answer)` with no DOM, no I/O, no clock and no unseeded randomness. CI proves determinism by running it repeatedly in a bare Node context. If a sim's state fails its schema at grading time, the question is routed to a human rather than scored zero.
**Consequences:** INV-SIM-2 holds. A student is never auto-zeroed because our code failed. Cost: sim authors must keep the model in a pure module — which is good discipline anyway.
**Rejected:** Grading in the browser and trusting the reported score (untrusted client — disqualifying); headless-browser grading (correct but far too slow and fragile at 5,000 submissions).

### ADR-0016 — Results are withheld atomically
**Status:** Accepted
**Context:** The product requires that automatically graded items are visible only when the rest of the feedback and grades are released.
**Decision:** Scores are computed at submission and stored sealed. Student-facing DTOs have no branch that returns a score while `releasedAt IS NULL`. Release is one database transaction across the whole batch. A machine-checked audit enumerates every student-facing route and asserts no score-bearing field is reachable pre-release.
**Consequences:** The product's central promise is enforced structurally and verified continuously, rather than by discipline. Cost: students cannot see early feedback even when it would be helpful; accepted deliberately, and the pre-release screen is designed to be reassuring rather than evasive.
**Rejected:** Progressive release of auto-graded items (contradicts the requirement); UI-only hiding (a single leaky query parameter would break a promise teachers depend on).

### ADR-0017 — Integrity telemetry is evidence, never truth
**Status:** Accepted
**Context:** Browser integrity controls can be bypassed, and naive detection (devtools traps, `debugger` loops) produces false positives that ruin legitimate students' grades and are indefensible on appeal.
**Decision:** The server is authoritative for time, grading and release. Integrity controls are deterrents that produce a human-readable evidence timeline. Client events are re-stamped and reclassified server-side and can never affect a score. No automated punitive action; only a teacher can void an attempt, with a recorded reason.
**Consequences:** The platform tells the truth about what it can and cannot detect, which is both fairer and more defensible. Anti-cheat value comes from server authority, per-student randomised variants and human review. Accommodations mode is a first-class policy variant.
**Rejected:** `debugger`/timing-trap detection (false positives, trivially defeated, user-hostile); auto-voiding on violation count (unfair, unappealable, legally risky); camera-based proctoring in v1 (privacy, consent and legal review required — deferred to v2, opt-in).

### ADR-0018 — No user-uploaded simulation code in v1
**Status:** Accepted
**Context:** Executing user-supplied JavaScript in our users' browsers is a legal and supply-chain risk, and the long tail of demand is "a slider that shows this graph".
**Decision:** Simulation code comes from our registry, built in CI. Sim Studio (P6-T12) generates simulations from a **closed declarative spec** — a finite set of composable primitives — so teachers get custom simulations without anyone writing code.
**Consequences:** Zero user-code execution risk, and Studio output is automatically conformant, accessible and gradable. Cost: Sim Studio's expressiveness is bounded by the primitive set, so exotic teacher requests become feature requests.
**Reversible:** yes — if sandboxed user code ever becomes necessary, ADR-0011's isolation is the foundation, and it would be a v2 decision with its own threat model.
