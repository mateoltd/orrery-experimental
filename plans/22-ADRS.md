# 22 — Architecture Decision Records

Status: `Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Rejected`.
Each record states Context, Decision, Consequences, and at least one rejected alternative. Where research drove the decision, the `RN-*` is cited.

---

### ADR-0001 — Platform name and scope
**Status:** Accepted
**Context:** Greenfield; need a name and a one-sentence scope to keep the build honest.
**Decision:** The platform is **Orrery** — an open-registration educational portal with four coupled products: Studio (authoring), Simulations (200+ sandboxed interactives), Classroom, and Assessment/Grading with teacher-gated release. TypeScript monorepo.
**Consequences:** Everything in `00-MASTER-PLAN.md` serves those four products. Features serving none of them are out of scope by default.
**Rejected:** Positioning as a generic "LMS" (invites a feature comparison we would lose); positioning as a "content marketplace" (contradicts the assessment depth that is the actual differentiator).

### ADR-0002 — TypeScript end to end
**Status:** Accepted
**Context:** The hardest correctness risk is a contract that must agree across the app, the editor, the grader, the sim SDK and 220 simulations.
**Decision:** TypeScript 5.9 `strict`, Node 24 LTS, one language, one toolchain, no `any` at boundaries.
**Consequences:** `@orrery/contracts` is the single source of truth, shared by client, server, worker and sims. Cost: Node-only libraries are unavailable; a few scientific libraries need thin wrappers.
**Rejected:** Python/Django (second language, duplicated contract); Go (excellent concurrency, poor velocity for editor work).

### ADR-0003 — pnpm workspaces + Turborepo
**Status:** Accepted
**Decision:** pnpm 10 workspaces, Turborepo 2 for ordering and caching.
**Consequences:** Fast and deterministic; sims are excluded from the main pipeline and built by their own job. Cost: build-graph config must be maintained.
**Rejected:** Nx (more power, far more config to get wrong under autonomous work); no workspace tooling (no caching, no ordering, slow CI).

### ADR-0004 — Biome for lint and format, ESLint retained only for boundaries
**Status:** Accepted
**Context:** ESLint's long dependency chain is a recurring supply-chain concern, and a large lint surface is a large autonomous-work surface. `RN-08`
**Decision:** **Biome** for lint and format. **ESLint retained solely** for package import boundaries and the no-barrel rule, which Biome does not express. ESLint is pinned and minimised.
**Consequences:** One fast tool for the 90% case; two boundary rules stay explicit and testable. Cost: two tool configurations.
**Rejected:** ESLint + Prettier (larger supply-chain surface for rules Biome covers); Biome-only (would mean dropping the boundary enforcement that keeps `packages/db` and `sims/` honest).

### ADR-0005 — One Next.js app; exam runtime deliberately isolated
**Status:** Accepted
**Decision:** Next.js 15 LTS App Router with React 19. Public and studio pages are Server Components; exam, editor and grading are client islands. The exam route has its own error boundary and a minimal provider tree, and no route outside `/exam/*` may crash it.
**Consequences:** One deployable, one type system, one auth path. Cost: explicit isolation work, and a rule that is easy to violate accidentally — hence the boundary lint rule.
**Rejected:** Vite SPA + separate API (two services, duplicated auth and types, worse library SEO); Remix (excellent, but weaker fit for the library/marketing surfaces).

### ADR-0006 — tRPC for the app surface, frozen REST for exam-critical paths
**Status:** Accepted
**Context:** End-to-end types are our biggest agentic-build safety net, but answer saves must survive page unload, be idempotent, version-conflicted, and independently load-testable. `RN-10`
**Decision:** tRPC v11 with **superjson** for everything except `/api/exam/v1/*`, which is hand-written REST with explicit `idempotencyKey`, `revision` conflicts, `sendBeacon`-friendly semantics, and a **frozen** `/v1` contract.
**Consequences:** The exam path is deliberately dumb and explicit, which is what you want when a deadline is running. Cost: two API styles, mitigated by a shared Zod contract layer and a lint rule on exam routers.
**Rejected:** tRPC everywhere (unattractive failure modes at unload, harder to isolate in load tests, no stable external contract); REST everywhere (loses end-to-end types).

### ADR-0007 — PostgreSQL 16 as the only datastore
**Status:** Accepted
**Decision:** PostgreSQL 16. JSONB for block content, question specs, policy and evidence; constraints; CTEs; `tstzrange`; `LISTEN/NOTIFY` available; RLS available as defence in depth.
**Consequences:** Real constraints and a genuinely transactional release. Cost: a local container; Testcontainers for integration tests.
**Rejected:** MySQL (weaker JSONB ergonomics and range types); SQLite (cannot host the release transaction); Mongo (weaker transactions and constraints for highly relational data).

### ADR-0008 — Prisma 8, and we lean into its strictness
**Status:** Accepted
**Context:** Prisma 8 is GA. Prisma 6+ **rejects `undefined` in a `where` clause** instead of silently dropping the filter — a class of bug that produces authorisation holes. `RN-06`
**Decision:** **Prisma 8.x** for schema, migrations, writes and simple reads. Named query modules in `packages/db/src/queries/` use parameterised raw SQL for analytics, with hand-verified fixtures. `packages/db` is the only module that imports Prisma and exports functions, never a client. Strictness is a feature: a filter that "did not apply" becomes a hard error.
**Consequences:** Declarative schema and checked-in SQL migrations, the lowest-risk surface for autonomous work; a whole bug class eliminated. Cost: the 5→8 upgrade breaks `undefined` filters, so P0-T4 includes an explicit sweep.
**Rejected:** Drizzle (excellent SQL control, less forgiving migrations for agents); raw SQL (no type safety, high typo risk).

### ADR-0009 — Database sessions, not JWT
**Status:** Accepted
**Context:** A teacher suspending a student, or removing them from a classroom, must take effect on the next request — including mid-exam.
**Decision:** Sessions stored in Postgres with `tokenHash`, `familyId` rotation, reuse detection, and `revokedAt` + `revokedReason`. `INV-AUTH-1`
**Consequences:** Immediate revocation; immediate suspension; immediate classroom removal. A DB read on the hot path, mitigated by a short-lived cache. Cost: a session store.
**Rejected:** JWT-only sessions (**cannot be revoked — disqualifying**); Clerk (vendor dependency and per-MA cost before revenue); hand-rolled auth (never).

### ADR-0010 — ProseMirror JSON as the canonical block format; no author HTML
**Status:** Accepted
**Context:** User content must render safely, version immutably, and diff structurally. `RN-12`
**Decision:** TipTap v3 / ProseMirror JSON, validated as a **closed discriminated union** on every write. The renderer emits HTML from typed data. **User-supplied HTML is never accepted.**
**Consequences:** XSS-by-content is structurally prevented — there is no sanitiser to keep patched — and diffs are structural. Cost: a real editor to build; a plain block-list fallback is a sanctioned escape hatch (P2-T11).
**Rejected:** MDX (executes author JSX — disqualifying); raw HTML passthrough; raw Markdown with a sanitiser (sanitiser drift is a standing XSS liability).

### ADR-0011 — Simulations: sandboxed iframe, postMessage RPC, separate origin
**Status:** Accepted
**Decision:** Each sim is an ESM bundle in a `sandbox="allow-scripts"` iframe **with no `allow-same-origin`**, on a **dedicated static origin** with a strict CSP, communicating over a versioned `postMessage` protocol (`sim-host@1`) with a per-mount nonce.
**Consequences:** `INV-SIM-1` holds. A sim cannot reach the app even if browser sandboxing weakens. Cost: a protocol to maintain; a cross-origin frame has no `localStorage`, so persistence is host-mediated.
**Rejected:** React components (full host privileges — disqualifying); WebAssembly-only (excludes the entire authoring skill set); Web Components (same privilege problem); a trusted plugin model (same, worse optics).

### ADR-0012 — Dual-target simulations: pure Node graders
**Status:** Accepted
**Context:** A simulation question must be auto-graded on the server from stored state, with no browser — otherwise exam grading would need a browser per submission and a grade could not be reproduced for an appeal.
**Decision:** Every sim with `capabilities.grading: true` exports a pure `grader(state, params, answer)` with no DOM, no I/O, no clock, no unseeded randomness. CI proves determinism in a bare Node context. If a stored state fails its schema the question routes to a human — **never auto-zeroed**. `INV-SIM-2`
**Consequences:** A student is never auto-zeroed because our code failed, and a reviewer's replay is the same code as the live grade. Cost: sim authors must keep the model pure — good discipline.
**Rejected:** Grading in the browser and trusting the score (untrusted client — disqualifying); headless-browser grading (far too slow and fragile at 5,000 submissions).

### ADR-0013 — Zero-dependency simulation SDK
**Status:** Accepted
**Context:** H5P, the closest prior art, is held back by a decade-old bundled `jQuery 1.9.1` and years of iframe-editor breakage. `RN-07`
**Decision:** `@orrery/sim-sdk` ships with **zero runtime dependencies**. A sim may depend only on the SDK and a small allowlist. No per-sim `npm install`. All editors stay outside iframes.
**Consequences:** No dependency rot in 220 sims, small bundles, fast conformance runs, and no iframe CSS/focus pathology. Cost: we implement the stepper, state serialisation and a11y helpers ourselves — roughly a day of work, once.
**Rejected:** A rich sim framework (the dependency becomes our oldest liability); sharing the app's UI components (would drag React and the design system into every frame).

### ADR-0014 — Container deploy, not Vercel-only
**Status:** Accepted
**Context:** ADR-0011 requires a **separate sim origin** with its own CSP, and the sim registry is a build pipeline.
**Decision:** OCI images to a container platform, with managed Postgres, Redis and S3. Next.js standalone.
**Consequences:** Full control of the sim build and the workers, and the origin separation the sandbox depends on. Cost: we operate containers.
**Rejected:** Vercel-only (complicates the sim build, the worker story, and the separate sim origin).

### ADR-0015 — Explicit caching, Webpack for production builds
**Status:** Accepted
**Context:** Next.js 15 changed caching to be **uncached by default** for `fetch`, GET Route Handlers and client navigations, which is a footgun; Turbopack is stable for dev but source-map quality and bundle predictability are release gates for the exam runtime. `RN-10`
**Decision:** Every cache decision is explicit, with cache keys including visibility tier, owner and version. **Web** for production builds until P0 measures otherwise. `useActionState`, not `useFormState`. All `cookies()`/`headers()`/`params` awaited.
**Consequences:** No reliance on framework defaults we might misremember. Cost: slightly slower builds.
**Rejected:** Relying on framework caching defaults (a private resource served from a public cache entry is a data breach); Turbopack for production (build speed is not our bottleneck; determinism is).

### ADR-0016 — No barrel files
**Status:** Accepted
**Context:** Barrel files are the largest single cause of bundle bloat and server/client boundary violations in App Router projects. `RN-09`
**Decision:** Explicit subpath exports everywhere; a lint rule enforces it.
**Consequences:** Bundle size is predictable and the RSC boundary stays clean. Cost: more verbose imports.
**Rejected:** Barrel files for developer ergonomics (the ergonomics are not worth a bundle regression in the exam runtime).

### ADR-0017 — Integrity telemetry is evidence, never truth
**Status:** Accepted
**Context:** The evidence is unusually clear. Automated proctoring has high specificity and **catastrophic sensitivity** — 0 of 6 staged cheaters detected — while human review caught 1. Scores fall 10–20% after adoption. Educators report false positives and false negatives. Flagging "needs to be overcautious", risking profiling of students. `RN-01`
**Decision:**
- The server is authoritative for time, item selection, grading and release.
- Integrity controls are **deterrents that produce a human-readable evidence timeline**.
- Client events are re-stamped and reclassified server-side and **can never affect a score**.
- **No automated punitive action.** Only a named teacher voids an attempt, via `IntegrityVerdict`, with a recorded reason.
- Rejected outright: `debugger` timing traps; devtools heuristics that fail a student; auto-void on violation count; biometric monitoring.
- The finding is quoted in the product's help text, because a teacher who believes this is a lie detector will use it as one.
**Consequences:** The platform tells the truth about what it can and cannot detect. Anti-cheat value comes from server authority, item variation (`ADR-0018` in `06`) and human review. Teachers can defend a decision, and a student can appeal.
**Rejected:** "Deterrence theatre" that claims prevention; a points-based integrity score.

### ADR-0018 — No biometric proctoring, at all
**Status:** Accepted
**Context:** Facial detection in proctoring is documented as **disproportionately false-flagging students of colour, students with accommodation needs, and students on unstable connections**. Universities publish advice to instructors not to enable it. `RN-02`
**Decision:** **No camera, microphone, screen or eye tracking in v1** — absent, not "off by default" (`D11`). If ever built it requires its own bias audit, per-institution consent, a human review queue, and a separate ADR. Accommodations mode is a first-class, zero-penalty, teacher-grantable policy variant.
**Consequences:** We lose a feature competitors advertise, and gain a materially better privacy position, a cleaner story for institutions, and no bias liability. Hard to reverse, and deliberately so.
**Rejected:** "Off by default with an opt-in" — an opt-in that is measurably biased is a liability the moment a school enables it.

### ADR-0019 — Item-level variation is core scope, not an enhancement
**Status:** Accepted
**Context:** A meta-analysis of 49 studies and 100k+ test takers found the online-testing advantage collapses to near zero under strict time limits, non-searchable content and lockdown — and that **deep item pools and adaptive selection** are what stop answer-sharing. A platform whose main anti-cheat story is browser lockdown is leaning on its weakest lever. `RN-03`
**Decision:** Question banks, pools, blueprints, per-student variants, balanced strategies and an expected-overlap display are **P5 core scope**. A pool that cannot be drawn blocks publication. "CAT-lite" (stratified balanced draws) replaces full IRT/CAT for v1.
**Consequences:** The strongest available integrity lever ships early; pools are visible as too shallow rather than silently converging. Cost: real authoring effort for item banks, and an honest admission that variation features over an empty bank are theatre.
**Rejected:** Deferring pools until after GA (they are the lever that matters); full IRT/CAT (overkill at our item counts and it needs far more data).

### ADR-0020 — Named partial-credit methods, defaulting to NG
**Status:** Accepted
**Context:** Multi-select partial credit is a genuine measurement problem with at least five established methods and different validity properties; negative crediting measurably improves reliability over no-credit, and methods suppress guessing differently. `RN-05`
**Decision:** Implement **NC, NG, SU, RI, PM** as named, documented choices, defaulting to **NG**. Expose them in the authoring UI with a plain-language trade-off and a live `testGrader` demonstration over four sample responses.
**Consequences:** Authors make an informed measurement decision rather than flipping a boolean; the grader's edge cases are exercised by real content. Cost: five implementations to keep correct, all under the 100% branch threshold.
**Rejected:** A single "all-or-nothing vs proportional" switch (measurement-simplistic); omitting partial credit entirely (lowers reliability and rewards guessing).

### ADR-0021 — Item analysis is for instruments, never for students
**Status:** Accepted
**Context:** `RN-01` warns that flagging "needs to be overcautious" with a danger of **profiling students**. `RN-05` shows naive statistics produce confident nonsense. Small-N results are the most misleading thing an analytics product can display.
**Decision:** Item analysis exists to improve questions, pools and blueprints. **No statistic is ever used to rank, stream, sanction or compare students.** No cohort ranking, no percentile-to-student reporting, no "at-risk" flag from item performance. No adaptive path that silently withholds questions. Suppression at small N, with `null` rather than a number. Validity caveats (LID, multiple comparisons, polytomous approximation) surfaced in the UI. A permanent prohibition on showing students cohort aggregates. `D13`
**Consequences:** The product cannot be used to discriminate, which is both an ethical commitment and, given the documented profiling risk, a liability reduction. Teachers get less than a competitor might offer, and more they can trust.
**Rejected:** Percentile reporting against the cohort (invites defensiveness of measurement and is meaningless for a 20-student quiz); "insight" features that rank students.

### ADR-0022 — Results are withheld atomically
**Status:** Accepted
**Context:** The product requires that automatically graded items are visible only when the rest of the feedback and grades are released. A teacher depends on this promise.
**Decision:** Scores are computed at submission and stored sealed. Student-facing DTO builders take `{ attempt, released }` and have **no branch that returns a score field** when `released` is false — not `null`, not rounded, not a hint. Release is **one database transaction** across the whole batch. A machine-checked audit enumerates every student-facing route and asserts nothing score-bearing is reachable pre-release, and it is a **release gate**.
**Consequences:** The central promise is structural rather than disciplinary. Cost: students get no early feedback even where it would help — accepted deliberately, and the pre-release screen is designed to be reassuring rather than evasive. Applies across the LTI and xAPI boundaries too.
**Rejected:** Progressive release of auto-graded items (contradicts the requirement); UI-only hiding (one leaky query parameter would break a promise teachers rely on).

### ADR-0023 — No user-uploaded simulation code
**Status:** Accepted
**Context:** Executing user-supplied JavaScript in our users' browsers is a legal and supply-chain risk. But "a teacher wants a slider that shows this graph" is a real long tail.
**Decision:** Simulation code comes from our CI-built registry. **Sim Studio** generates simulations from a **closed declarative spec** — a finite set of composable primitives — so teachers get custom simulations without anyone writing code.
**Consequences:** Zero user-code execution risk, and Studio output is automatically conformant, accessible and gradable. Cost: Studio's expressiveness is bounded by the primitive set; exotic requests become feature requests.
**Reversible:** yes, if sandboxed user code ever becomes necessary — ADR-0011's isolation is the foundation, and it would be a v2 decision with its own threat model.

### ADR-0024 — Optimistic concurrency, not CRDTs
**Status:** Accepted
**Context:** Real-time collaborative editing is a large architectural commitment — a second data model, conflict-free merge semantics, presence — and the requirement is single-author authoring with version history. `RN-11`
**Decision:** The editor uses optimistic concurrency against a version counter with a **three-way conflict panel** (mine / theirs / both, with block-level merge where blocks are independent).
**Consequences:** This is the single largest scope reduction in the plan, and it protects P2, which every other phase depends on. Cost: two people cannot type in the same document at once.
**Reversible:** yes, in v2, if demand appears — the version model is already a reasonable base.
**Rejected:** CRDTs (Yjs/Automerge) up front (a quarter of engineering for a feature nobody asked for); last-write-wins (silent data loss).

---

## Index

| ADR | Decision | Status |
|---|---|---|
| 0001 | Platform name and scope | Accepted |
| 0002 | TypeScript end to end | Accepted |
| 0003 | pnpm workspaces + Turborepo | Accepted |
| 0004 | Biome + minimal ESLint | Accepted |
| 0005 | One Next.js app; exam runtime isolated | Accepted |
| 0006 | tRPC + frozen exam REST | Accepted |
| 0007 | PostgreSQL only | Accepted |
| 0008 | Prisma 8, lean into strictness | Accepted |
| 0009 | Database sessions, not JWT | Accepted |
| 0010 | Closed block union, no author HTML | Accepted |
| 0011 | Sandboxed sim iframe, separate origin | Accepted |
| 0012 | Dual-target sims, pure Node graders | Accepted |
| 0013 | Zero-dependency sim SDK | Accepted |
| 0014 | Container deploy | Accepted |
| 0015 | Explicit caching, Web for builds | Accepted |
| 0016 | No barrel files | Accepted |
| 0017 | Evidence, never verdict | Accepted |
| 0018 | No biometric proctoring | Accepted |
| 0019 | Item variation is core scope | Accepted |
| 0020 | Named partial-credit methods, NG default | Accepted |
| 0021 | Item analysis for instruments, not students | Accepted |
| 0022 | Atomic result withholding | Accepted |
| 0023 | No user-uploaded sim code | Accepted |
| 0024 | Optimistic concurrency, not CRDTs | Accepted |
