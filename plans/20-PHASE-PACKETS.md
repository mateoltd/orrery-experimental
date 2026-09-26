# 20 — Phase Packets

The task tables. **Task IDs are stable** and are referenced by commits (`Task: <id>` trailers), reviews and the board. Packets are generated from these rows at dispatch time (`19` §2).

Sizes: **S** ≈ half a day · **M** ≈ 1–2 days · **L** ≈ 3–5 days · **XL** ≈ 1–2 weeks.
Hours are ideal single-agent hours, excluding review and integration overhead.

---

## P0 — Foundation & decisions · M · 24h

**Goal:** one command boots the whole stack; every load-bearing decision is written; the plan's own top risks have been attacked.

| ID | Task | Deps | Size |
|---|---|---|---|
| P0-T1 | Monorepo scaffold: pnpm workspaces, Turborepo, tsconfig bases, empty packages with correct exports and no barrels | — | S |
| P0-T2 | Tooling: Biome + ESLint (import boundaries, no-barrel), Vitest + Playwright projects, Husky + lint-staged | P0-T1 | S |
| P0-T3 | Local infra: Compose (PG 16, Redis, MinIO, Mailpit, OTel), `.env.example`, Zod `env.ts` that fails at boot, `env:check` | P0-T1 | S |
| P0-T4 | `@orrery/db`: Prisma 8 schema from `02-DATA-MODEL.prisma`, migration pipeline, seed, Testcontainers fixture, **sweep for `undefined` in `where` clauses** (`RN-06`) | P0-T3 | M |
| P0-T5 | Next.js app skeleton: route groups, error boundaries, Sentry, Pino with `redact()`, `/healthz` `/readyz` | P0-T2 | M |
| P0-T6 | `@orrery/clock`, `@orrery/ids`, `@orrery/rng` with tests. Load-bearing for P8 | P0-T1 | S |
| P0-T7 | CI: install → generate → lint → typecheck → unit+integration → build → e2e on Compose | P0-T5 | M |
| P0-T8 | ADRs 0001–0024 accepted; `22-ADRS.md` index | P0-T1 | M |
| P0-T9 | **Plan risk review:** find the top 10 risks in `plans/`, resolve or record each with a rationale. Includes a build-vs-Webpack decision for production (`RN-10`) | P0-T1 | M |
| P0-T10 | Observability skeleton: OTel in web + worker, `requestId` correlation, metrics endpoint, Grafana dashboard JSON | P0-T5 | M |
| P0-T11 | ESLint rules: no bare `Date.now()`, no `Math.random()`, no `process.env` outside `env.ts`, no ownership comparisons outside `packages/auth` | P0-T2 | S |

**Exit:** `pnpm setup && pnpm dev` gives web + worker + healthy services; all five gates pass from a clean clone; every ADR accepted with a rejected alternative recorded; `@orrery/clock` proven by a test that freezes time and asserts expiry.

---

## P1 — Identity, sessions & the `can()` kernel · M · 28h

| ID | Task | Deps | Size |
|---|---|---|---|
| P1-T1 | Better Auth: email+password, magic link, verification, DB sessions with `familyId`, `User.status` | P0-T4 | M |
| P1-T2 | Profile: name, avatar, locale, timezone, prefs, `isMinor`/`guardianEmail` | P1-T1,P0-T3 | S |
| P1-T3 | Auth UI: sign in/up/verify/reset, resend, cooldown UX, rate limits, no enumeration | P1-T1 | M |
| P1-T4 | Session middleware, `getSession()` cache, route protection, session list/revoke UI | P1-T1 | M |
| P1-T5 | Account deletion: grace, cascade, anonymisation, export-as-JSON, dry run, terminal audit | P1-T1 | M |
| P1-T6 | **The `can()` kernel**: data-declared matrix, obligations, totality check, 2,000+ cells tested | P1-T1 | L |
| P1-T7 | Anti-abuse: throttles, disposable-domain review signal, risk-triggered CAPTCHA, security events | P1-T1 | S |
| P1-T8 | Playwright fixtures: `user()`, `teacher()`, `student()`, deterministic identities | P1-T3 | S |
| P1-T9 | MFA enrolment/verification + the teacher-grading gate | P1-T1 | M |
| P1-T10 | Impersonation: audited, read-only, 15 min, banner, writes denied | P1-T6 | M |

**Exit:** register → verify → session → suspend → refuse → delete → anonymise; `can()` at 100% branch with a mechanically-proven complete matrix; zero ownership comparisons outside `packages/auth`; a teacher cannot grade without MFA.

---

## P2 — Content model, block schema & editor · L · 64h

| ID | Task | Deps | Size |
|---|---|---|---|
| P2-T1 | Block schema: 16 types as a Zod discriminated union in `@orrery/contracts`, with `schemaVersion` and migrations | P0-T6 | L |
| P2-T2 | Block renderer: sanitised HTML from typed data, KaTeX with **MathML** output, lazy media, table/figure semantics | P2-T1 | M |
| P2-T3 | Editor shell: TipTap v3, custom nodes for all 16, slash palette, block handles with accessible names, keyboard block movement, virtualisation | P2-T1 | XL |
| P2-T4 | Autosave + optimistic concurrency; three-way conflict panel (mine / theirs / both) | P2-T3 | M |
| P2-T5 | Versioning: write-once versions (`INV-CONTENT-1`), version list, structural diff, restore-as-new-version | P2-T4 | M |
| P2-T6 | Media library: presigned upload, allowlist, magic bytes, re-encode, EXIF strip, **SVG rejected**, alt-text enforcement, video captions | P2-T1 | M |
| P2-T7 | Editor + renderer a11y: focus management, no traps, contrast, `2.5.7` keyboard alternatives to drag | P2-T3 | M |
| P2-T8 | State machine draft/published/archived + visibility, with a permission re-check on every read | P2-T5,P1-T6 | M |
| P2-T9 | Resource library UI: mine, ownership transfer, duplicate, "used in N classrooms" | P2-T5 | S |
| P2-T10 | **`validateForPublish`**: a checklist with per-issue deep links and one-click fixes | P2-T5,P2-T6 | M |
| P2-T11 | **Sanctioned fallback:** a plain block-list authoring UI, proving the schema and renderer stand alone | P2-T2 | M |

**Exit:** all 16 block types authored, rendered, versioned, diffed, published; a 500-block fixture stays responsive; alt-text and caption enforcement blocks publish; axe clean; the fallback UI works.

---

## P3 — Subjects, library, search & moderation · M · 30h

| ID | Task | Deps | Size |
|---|---|---|---|
| P3-T1 | `Subject` hierarchy (cycle-safe moves), `Tag` merge/rename, resource classification | P2-T1 | M |
| P3-T2 | Seed ~120 subjects across all target areas | P3-T1 | M |
| P3-T3 | Public library: subject tree, tag filter, sort, pagination, empty states | P3-T1 | M |
| P3-T4 | Search: Postgres FTS weighted `title > summary > tags > body`, `pg_trgm` fallback, facets, **zero-result logging** | P3-T3 | M |
| P3-T5 | Ratings, comments (moderation-gated for minors), flagging, takedown SLA | P3-T1 | M |
| P3-T6 | Slugs, canonical URLs, OG images, sitemap | P3-T3 | S |

**Exit:** a visitor with no account can find and read any public resource; a 10-term query set returns correct ranked results; a subject move is cycle-safe; zero-result logging feeds a content report.

---

## P4 — Classrooms, membership, invites, notifications · L · 46h

See `12-CLASSROOM-COLLAB.md` §8 for the deliverable list (P4-T1…T8).

**Exit:** invite → accept → participate → remove; code join → revoke → fail; a removed student loses classroom access within one request but keeps their own records; a 1,000-row CSV import completes with a downloadable error report; the role matrix is enforced by an exhaustive test.

---

## P5 — Assignments, pinning, question banks & blueprints · L · 56h

| ID | Task | Deps | Size |
|---|---|---|---|
| P5-T1 | `Assignment` with a pinned `resourceVersionId`, window, attempts, weight, late penalty, policy override | P4-T1,P2-T5 | M |
| P5-T2 | `AssignmentStudentOverride` (window, attempts, extra time, reason) | P5-T1 | S |
| P5-T3 | Assignment builder: pick resource → pick version → window → policy → **preview as student** | P5-T1 | L |
| P5-T4 | Student "to do": available / upcoming / completed / expired | P5-T1 | M |
| P5-T5 | **Pinning invariant enforcement**: lint rule on assessment routers + the mutation test (`INV-ASSIGN-1`) | P5-T1,P0-T11 | M |
| P5-T6 | `QuestionBank` CRUD, sharing to classrooms, move/duplicate items | P2-T1,P1-T6 | M |
| P5-T7 | `QuestionPool` with the four draw strategies + `poolHealth` (M vs N, distinct, **expected overlap `N²/M`**) | P5-T6 | L |
| P5-T8 | `Blueprint` + `BlueprintCheck` with **worst-case** coverage over simulated draws | P5-T6 | L |
| P5-T9 | `AssessmentSpec` slots (FIXED / POOLED) + `variantMap` resolution written once (`INV-BANK-2`) | P5-T7,P5-T8 | L |
| P5-T10 | Version publish snapshots every drawable question (`INV-BANK-3`) | P5-T9,P2-T5 | M |
| P5-T11 | "Too similar" guard: stem trigram, key-set and numeric-answer similarity with acknowledgement | P5-T6 | M |
| P5-T12 | Publish gates: `POOL_UNDERSIZED`, `BLUEPRINT_UNSATISFIED`, missing metadata | P5-T9,P2-T10 | M |

**Exit:** the pinning invariant is proven by a test that mutates the resource post-assignment and asserts identical output; a pool can be published only if drawable; 5 students with different seeds demonstrably receive different items; blueprint coverage reports worst case honestly.

---

## P6 — Simulation platform + 24 gold sims · XL · 92h

See `10-SIMULATIONS.md` for the protocol and `§10` for the 24 sims.

| ID | Task | Deps | Size |
|---|---|---|---|
| P6-T1 | `sim-host@1` spec: frames, handshake, capability negotiation, versioning, error taxonomy, timeouts | P0-T8 | M |
| P6-T2 | `sim.manifest.schema.json` + Zod mirror + `sim:validate` CLI | P6-T1 | M |
| P6-T3 | `@orrery/sim-sdk`: **zero runtime deps**, host bridge, state serialisation, param binding, `reportAnswer`, a11y helpers, seeded RNG | P6-T1 | M |
| P6-T4 | Build pipeline: esbuild → hashed, cache-busted ESM + CSS, content-addressed, emitted to the sim origin | P6-T3 | M |
| P6-T5 | **Dual-target enforcement**: `./browser` + pure `./grader` runnable in Node, proven in CI (`INV-SIM-2`) | P6-T3 | L |
| P6-T6 | Sandbox host: `sandbox="allow-scripts"`, separate origin, strict CSP, nonce messaging, resize protocol, offline check, failure UI | P6-T1,P2-T2 | XL |
| P6-T7 | `embedSimulation` block: manifest-driven param editor, seed policies, lazy mount, static fallback, print fallback, state capture | P6-T6 | L |
| P6-T8 | Registry: `simId@version`, install/disable/deprecate, `replacedById`, metadata index, catalogue page | P6-T4 | M |
| P6-T9 | **Conformance matrix** over every registered sim: handshake, sandbox assertions, scripted interaction, answer, Node grade, keyboard reachability, text alternative, state round-trip, screenshots | P6-T8 | L |
| P6-T10 | Authoring docs, `sims/_template`, `pnpm sim:new`, dev playground with a protocol inspector | P6-T3 | M |
| P6-T11 | 24 gold sims | P6-T9 | XL |
| P6-T12 | Sim Studio: declarative compiler for the closed primitive set | P6-T8 | L |
| P6-T13 | **Sandbox escape test** as a permanent CI gate | P6-T6 | M |

**Exit:** an author with no repo access builds and registers a sim from the template alone; the conformance suite is green over all 24; a sim question is auto-graded server-side from stored state with no browser; a malicious sim provably cannot touch host DOM, cookies, storage or network.

---

## P7 — Quiz runtime, question types & auto-grading · L · 72h

| ID | Task | Deps | Size |
|---|---|---|---|
| P7-T1 | `QuestionSpec` union in contracts + `publicQuestionSpec()` / `teacherQuestionSpec()`, exhaustively typed | P2-T1 | L |
| P7-T2 | `@orrery/grading` core: pure, total, bounded, versioned; 100% branch | P7-T1 | XL |
| P7-T3 | The **five partial-credit methods** NC / NG / SU / RI / PM with fixtures and property tests (`RN-05`) | P7-T2 | L |
| P7-T4 | Remaining graders: numeric tolerance + sig figs, short-text matchers, ordering adjacency, sim grader dispatch | P7-T2 | L |
| P7-T5 | Hand-computed `answerFixtures` for every type × method, **reviewed by a second person** | P7-T3,P7-T4 | M |
| P7-T6 | Student attempt runtime: one-at-a-time or all-at-once, lock-after-answer, navigation, flags, autosave, outbox | P7-T1,P0-T6 | L |
| P7-T7 | Renderers + interaction for all 10 types incl. file upload and sim response, keyboard and AT support | P7-T6 | XL |
| P7-T8 | Policy engine v1: attempts, shuffle, per-question time, total time, window, navigation, reveal policy, **practice attempt** | P0-T6 | L |
| P7-T9 | Submit: idempotent, auto-grade, `AnswerRevision` chain, receipt hash | P7-2,P7-8 | M |
| P7-T10 | Sealed grades gate + `audit:seals` | P7-T9 | M |
| P7-T11 | Multi-tab / multi-device: session header, second-tab warning, revision 409 UX | P7-T6 | M |
| P7-T12 | `bank.testGrader` harness: run the real grader on a sample, show points + rationale | P7-T2 | M |
| P7-T13 | Property tests over grader, shuffler, deadline math | P7-T3 | M |
| P7-T14 | Preflight + resume UX, durability indicator, server-offset countdown | P7-T6 | M |

**Exit:** a 30-question mixed quiz with 2 sim questions survives a hard refresh and a simulated network drop; all auto-grades match the hand-computed fixtures; `audit:seals` green; the public projection of every type is asserted to contain no key material.

---

## P8 — Exam runtime & integrity · XL · 108h

**The highest-risk phase.** Read `09-EXAM-INTEGRITY.md` first.

| ID | Task | Deps | Size |
|---|---|---|---|
| P8-T1 | `@orrery/exam-engine`: policy model, defaults, validation, deep-freeze, versioned snapshot (`INV-POLICY-1/2`) | P7-T8 | L |
| P8-T2 | Deadline engine: absolute server deadlines, per-question deadlines, grace, RTT-midpoint sync, skew detection, property-tested | P0-T6 | M |
| P8-T3 | Session issuance: signed single-use token, DB row, time handshake, preflight record | P8-T2 | M |
| P8-T4 | `fullscreenGuard` + the recovery overlay (never a dead end) | P8-T3 | M |
| P8-T5 | `pointerLockGuard` with grace, and honest `Escape` semantics in the copy | P8-T3 | M |
| P8-T6 | `focusGuard`, `lifecycleGuard`, `tabGuard`, `clockGuard` | P8-T3 | M |
| P8-T7 | Evidence pipeline: batched signed writer, `sendBeacon` on unload, closed schemas, seq/idempotency, reclassification, retention | P8-T6 | L |
| P8-T8 | Copy/paste/context-menu/print hardening with policy switches and the a11y escape hatch | P8-T4 | M |
| P8-T9 | Server enforcement: reject late writes (`INV-LATE-1`), per-question close, deadline cron, write shedding | P8-T2,P0-T7 | L |
| P8-T10 | Submit + receipt + `verify-receipt` tool | P8-T9 | M |
| P8-T11 | Escalation ladder, strike counters, teacher terminate/reinstate/void | P8-T7 | L |
| P8-T12 | **Accommodations**: grantable mid-exam, watchdog routing, extra time, `INV-ACC-1` | P8-T5,P8-T11 | M |
| P8-T13 | Exam UX: palette, one-at-a-time, submit confirm, deadline UX, leave-and-return rules | P8-T9 | L |
| P8-T14 | Teacher evidence timeline + `IntegrityVerdict` with required reason and evidence-framed copy | P8-T11 | L |
| P8-T15 | Adversarial suite: clock skew, refresh, tab switch, second device, network loss, forged events, replayed saves, malformed sim state | P8-T11 | L |
| P8-T16 | Load test at 750 concurrent takers including a deadline stampede | P8-T10 | M |

**Exit:** with the system clock wrong by days the exam still ends on server time; killing the network for 90 s loses no acknowledged save; refreshing resumes with server state and preserved elapsed time; a forged event cannot change a score; every enforced rule is disclosed before start and every relaxation is teacher-grantable.

---

## P9 — Teacher review & grading workspace · L · 64h

| ID | Task | Deps | Size |
|---|---|---|---|
| P9-T1 | Review queue: filters, claim, priority, age, bulk claim, counts | P7-T9 | M |
| P9-T2 | Grading workspace: prompt/answer/sim-replay side by side, keyboard-first, drafts | P9-T1 | XL |
| P9-T3 | Rubric editor and band application with prefilled editable feedback | P9-T2 | L |
| P9-T4 | Feedback: per-question, whole-attempt, attachments, visibility, drafts | P9-T2 | M |
| P9-T5 | Bulk actions: score, feedback, excuse, void, release | P9-T2 | M |
| P9-T6 | Sealed auto-grade review + "this key looks wrong" flag → reviewed assignment-wide regrade | P9-T2 | M |
| P9-T7 | Sim answer replay: re-run the Node grader, show the trace, audited override | P9-T2 | M |
| P9-T8 | Concurrent grading safety: optimistic locking, presence, no silent overwrite | P9-T2 | S |
| P9-T9 | Regrade: dry run, background apply, `GradeChange`, student notice | P9-T6 | M |
| P9-T10 | "Grading needed" notification (in-app only) | P9-T1,P4-T7 | S |

**Exit:** two teachers grade one classroom concurrently without loss; a 500-attempt regrade completes as a background job with progress and a full audit trail; a sim answer can be replayed and overridden with a recorded reason.

---

## P10 — Atomic release & student results · M · 46h

| ID | Task | Deps | Size |
|---|---|---|---|
| P10-T1 | `ReleaseBatch` model and state machine, membership frozen on `RELEASING` | P9-T4 | M |
| P10-T2 | Atomic release worker: verify-all then one transaction; idempotent; resumable | P10-T1,P0-T7 | L |
| P10-T3 | Pre-release gate with an explicit, recorded override | P10-T1 | M |
| P10-T4 | Student results view: outcomes, feedback, correct answers where allowed, breakdown, receipt, accommodations marker | P10-T2 | L |
| P10-T5 | Pre-release "sealed" view: reassuring, score-free, honest | P10-T2 | L |
| P10-T6 | Late/absent: excused, missing, late penalty, extend-deadline with reason | P10-T1 | M |
| P10-T7 | Release notification + student digest | P10-T2,P4-T7 | S |
| P10-T8 | **Route leak audit**: enumerate every student-facing route and assert no score is reachable pre-release | P10-T5 | M |
| P10-T9 | Atomicity test under a concurrent reader loop; 5,000-attempt release | P10-T2 | M |
| P10-T10 | LTI/xAPI boundary: nothing score-bearing crosses before release | P10-T2 | S |

**Exit:** P10-T8 green with a machine-checked route list; a student polling every student route before release finds no grade data anywhere, including error payloads, headers and cached responses; a concurrent reader never observes a partial batch.

---

## P11 — Item analysis, gradebook & integrity reporting · L · 58h

| ID | Task | Deps | Size |
|---|---|---|---|
| P11-T1 | `@orrery/analytics` core: facility, point-biserial, corrected D, rank-biserial, distractor analysis, time-on-item; 100% branch | P10-T2 | L |
| P11-T2 | **Suppression rules** at small N, implemented in both the query and the pure layer | P11-T1 | M |
| P11-T3 | Validity caveats surfaced in the UI: LID, multiple comparisons, polytomous approximation, unequal item counts | P11-T1 | L |
| P11-T4 | Local item dependency detection (residual correlations) | P11-T1 | M |
| P11-T5 | Cronbach's α, reported only when `k ≥ 10`, with the caveat copy | P11-T1 | S |
| P11-T6 | Gradebook: per assignment and student, weighted totals, status flags, resolved-variant display | P10-T2 | L |
| P11-T7 | Answer-similarity clustering with the non-accusatory presentation (`RN-01`) | P11-T1 | M |
| P11-T8 | Integrity report: evidence timeline, preflight, force-exits, similarity, teacher verdict | P8-T14 | L |
| P11-T9 | Variant audit: prove seeds and draws were applied and logged | P5-T9 | S |
| P11-T10 | Exports: gradebook, submissions, item analysis, integrity PDF; streamed, injection-escaped | P11-T6,P11-T8 | M |
| P11-T11 | Rollups + freshness timestamps + invalidation on regrade | P11-T6 | M |
| P11-T12 | Hand-computed `itemAnalysisFixtures` verified against the published formulas | P11-T1 | M |

**Exit:** a 500-student, 30-question assignment produces gradebook, item analysis, integrity report and CSV in under 5 s at p95; suppression never emits an unsuppressed number; a hand-computed fixture matches to 4 decimal places.

---

## P12 — Simulation scale-out to 220 · XL · ~132h (parallel)

| ID | Task | Deps | Size |
|---|---|---|---|
| P12-T1 | Catalogue plan from `11`, with spec cards and the 3-point review rubric | P2-T1 | M |
| P12-T2 | 6 parallel author lanes, one sim in flight each: card → code → conformance → review | P12-T1 | XL |
| P12-T3 | Per-sim review: pedagogy, technical conformance, accessibility; licence and provenance mandatory | P12-T2 | L |
| P12-T4 | Registry hygiene: versioning, deprecation, replacement, per-sim analytics, flakiness tracking | P12-T2 | M |
| P12-T5 | Catalogue polish: subject browsing, auto-captured screenshots, search, "used in N resources" | P6-T8 | M |
| P12-T6 | Bundle budget enforcement; prove the app bundle is unchanged from the 24-sim baseline | P12-T4 | M |
| P12-T7 | Content QA sweep: all 220 load, grade, and pass accessibility; any regression blocks merge | P12-T3 | M |

**Exit:** registry ≥ 200, conformance 100% green, screenshots present, bundle budget held, app bundle independent of registry size.

---

## P13 — Accessibility (WCAG 2.2 AA) & i18n · L · 60h

See `15-A11Y-I18N.md` §6 for the deliverable list (P13-T1…T9).

**Exit:** automated axe clean on every key route; an independent manual audit with no open AA findings; accommodations proven with a real screen-reader session; three locales with no hardcoded strings and correct RTL behaviour.

---

## P14 — Security, privacy & compliance · L · 60h

| ID | Task | Deps | Size |
|---|---|---|---|
| P14-T1 | Threat model walk-through; OWASP Top 10 review; findings fixed or recorded | P10-T5 | L |
| P14-T2 | CSP tightening, `audit:payloads` hardening, canary log-scrubbing test | P14-T1 | M |
| P14-T3 | Sandbox escape re-test against the production host component | P6-T13 | M |
| P14-T4 | Rate-limit audit; verify every limit by test | P14-T1 | M |
| P14-T5 | Dependency audit and the documented exception process | P14-T1 | S |
| P14-T6 | Data inventory and retention schedules; retention sweep in dry-run then live | P14-T1 | M |
| P14-T7 | DSAR export and erasure, rehearsed end to end with timings | P14-T6 | M |
| P14-T8 | Minors posture, consent versioning, sub-processor register, privacy policy and terms drafts | P14-T6 | M |
| P14-T9 | File scanning live; `svg` rejection and CSV-injection escaping verified | P14-T1 | S |
| P14-T10 | **Published academic-integrity policy** and student-facing integrity disclosure | P8-T14 | M |

**Exit:** the `14` §10 checklist is fully ticked; the threat model and the integrity policy are each reviewed by someone who did not write them.

---

## P15 — Reliability, performance, load & DR · L · 72h

| ID | Task | Deps | Size |
|---|---|---|---|
| P15-T1 | Performance pass: Core Web Vitals per route, exam bundle budget, sim lazy loading, image pipeline | P11-T11 | L |
| P15-T2 | Index review with `EXPLAIN (ANALYZE, BUFFERS)` on the documented hot paths | P15-T1 | M |
| P15-T3 | Load suite as a versioned artefact with **correctness assertions**, not just latency (`18` §11) | P8-T16 | L |
| P15-T4 | Chaos: worker kill mid-release, Postgres failover, Redis down, sim origin blocked | P15-T3 | L |
| P15-T5 | SLOs, alerts, and a runbook per alert — written before needed | P15-T1 | M |
| P15-T6 | Migration rehearsal from staging; rollback drill | P15-T1 | M |
| P15-T7 | **Restore drill** into a clean environment; real RTO measured and written down | P15-T1 | M |
| P15-T8 | Read-replica split so browsing never competes with an exam cohort | P15-T2 | M |

**Exit:** 750 concurrent takers with zero lost acknowledged saves; a concurrent reader never sees a partial release; the restore drill completed and timed; every alert has a runbook.

---

## P16 — Interoperability: QTI, xAPI, LTI 1.3, OneRoster · L · 56h

See `16-INTEROPERABILITY.md` §8 for the deliverable list (P16-T1…T9).

**Exit:** round-trip byte-identical for the supported subset; every dropped element reported; a full LTI launch-and-gradeback works against a reference harness; a CI test proves no score crosses the LTI or xAPI boundary before release.

---

## P17 — Pilot, seed content, docs & GA · L · 64h

| ID | Task | Deps | Size |
|---|---|---|---|
| P17-T1 | 30 curated seed resources, each with at least one simulation, validated in registry CI | P12-T7 | L |
| P17-T2 | Demo classroom, teacher and student with realistic content | P17-T1 | M |
| P17-T3 | Onboarding: teacher first-run, student first-run, and the practice-attempt recommendation | P3-T5 | L |
| P17-T4 | **Pilot**: 3 classrooms, 30 students, 2 full exam cycles, every defect triaged to fixed | P17-T2,P17-T3 | L |
| P17-T5 | Support tooling: in-app reporting, admin impersonation audit, suspension | P1-T7 | M |
| P17-T6 | Documentation: author, sim author, teacher, student, admin runbook, API reference | P12-T3 | M |
| P17-T7 | GA checklist: all P0–P16 gates, migration rehearsal, rollback plan, launch monitoring | P17-T4 | M |

**Exit:** a pilot cohort completes a proctored exam with zero data loss, and every P0–P16 exit criterion has a linked, re-runnable verification command.

---

## Critical path and parallelism notes

**Critical path:** `P0 → P1 → P2 → P6 → P8 → P10 → P14 → P15 → P17`

- **P6 is on the critical path.** That is why the simulation substrate lands early and gets the largest early investment, and why the 24 gold sims are worth their XL cost: they de-risk everything downstream.
- **P12 is the shock absorber.** Embarrassingly parallel; must start no later than P9. It cannot start earlier because authoring 220 sims before the contract has survived a real exam would be wasted work.
- **Longest single tasks:** P2-T3 (editor), P6-T11 (24 sims), P7-T7 (renderers), P8-T14 (evidence timeline), P12-T2 (author lanes). Each should be split into subtasks with their own IDs if it exceeds one lane-week.
- **Do not start P16 late.** Interop touches the `Question` and `Assignment` models; discovering that in P16 means a schema change under time pressure. P16-T1 (the codec skeleton and `ExternalBinding`) should land in P5.
