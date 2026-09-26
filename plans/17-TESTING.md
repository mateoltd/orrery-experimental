# 17 — Testing Strategy

Testing is the mechanism that makes a long autonomous build trustworthy. Gates are cheap, deterministic, and non-negotiable.

---

## 1. Gates

| Gate | Command | Runs on | Blocking |
|---|---|---|---|
| Lint | `pnpm lint` | every push | yes |
| Types | `pnpm typecheck` | every push | yes |
| Unit + integration | `pnpm test` | every push | yes |
| E2E | `pnpm test:e2e` | every PR + main | yes |
| Dependencies | `pnpm audit:deps` | every PR, daily | yes (high/critical) |

Domain gates activate as their phase lands:

| Gate | Command | From |
|---|---|---|
| Simulation validation | `pnpm sim:validate` | P6 |
| Simulation conformance | `pnpm sim:conformance` | P6 |
| Answer-key leak audit | `pnpm audit:seals` | P7, widening in P10 |
| Payload / PII scanner | `pnpm audit:payloads` | P1 |
| Accessibility | `pnpm a11y` | P2 |
| Blueprint coverage | `pnpm test:blueprints` | P5 |
| i18n completeness | `pnpm i18n:check` | P13 |
| Load | `pnpm test:load` | P8, P15 |

---

## 2. Coverage policy

Coverage is a **floor**, not a target. A PR that lowers any threshold is rejected.

| Package | Threshold | Why |
|---|---|---|
| `@orrery/grading` | **100% branch** | Decides grades |
| `@orrery/exam-engine` | **100% branch** | Decides deadlines and escalation |
| `@orrery/analytics` | **100% branch** | Reports statistics about students to their teachers |
| `@orrery/contracts` | 100% statement | The validators are a security boundary |
| `@orrery/auth` (`can()`) | **100% branch** + completeness proof | The authorisation matrix |
| `@orrery/sim-sdk` | 95% | Also covered by per-sim conformance |
| everything else | 85% lines | — |

---

## 3. Layers

### 3.1 Unit
Pure functions with no I/O: the grader and every partial-credit method, the deadline engine, the policy resolver, pool draws, the escalation ladder, the clock, the RNG, the receipt hasher, every Zod schema, `can()`, every block renderer, every item-analysis formula.

### 3.2 Integration
Real Postgres and Redis via Testcontainers. Every tRPC procedure and every REST endpoint gets at least one happy path, **one authorisation refusal** (second user, cross-classroom, anonymous — three separate assertions), and one validation failure.

Fixtures:
- `seedFactory` — a coherent world builder (users, classroom, enrollments, resource, version, bank, pool, blueprint, questions, assignment, attempts) in any requested shape. A coherent fixture is what makes authorisation tests cheap to write, and cheap authorisation tests are what make the matrix complete.
- `frozenClock` — every test involving time injects it. **No real sleeps** in unit or integration tests.
- `answerFixtures` — hand-computed expected grades for every question type × every partial-credit method, **reviewed by a second person**. These are the numbers that decide students' grades.
- `itemAnalysisFixtures` — hand-computed facility, point-biserial, corrected D and Cronbach's α on a small known dataset, verified against the published formulas.

### 3.3 Contract
The simulation conformance matrix (`10` §6.1): for every registered `simId@version`, mount it in the real host, assert the handshake, assert the sandbox, replay the scripted interaction, assert the reported answer, assert the Node-side grade, assert keyboard reachability, assert state round-trip, capture screenshots.

This is the mechanism that makes 220 simulations safe to ship. It is also the **only** automated check that a canvas-based sim is keyboard-reachable and has a text alternative, which is why it matters beyond simulation correctness.

### 3.4 E2E — the twelve golden paths
Defined in `00-MASTER-PLAN.md` §6.4. One spec file each, run in CI on every PR.

### 3.5 Adversarial
A dedicated suite for things that must not be possible:
- IDOR across users, classrooms, assignments, attempts
- Forged telemetry, replayed events, out-of-order `seq`, client timestamps 3 days out
- Replayed saves, stale revisions, concurrent writes from two devices
- Answer payloads failing their schema; absurdly large answers
- Sim frames attempting cookie/storage/fetch access, sending unknown protocol frames, or reporting a state that fails its schema
- Timing attacks: submit at `deadline − 1ms`, at `deadline`, at `deadline + grace`, at `deadline + grace + 1ms`
- A client whose system clock is wrong by days
- A response payload crafted to look like a score
- **Pre-release score reachability** via every student-facing route, including error payloads, meta tags, and payload-size or timing oracles

### 3.6 Property-based (`fast-check`)

| Subject | Properties |
|---|---|
| Deadline engine | No write accepted after its window; reload never moves `questionOpenedAt`; total deadline dominates; grace is exact, not off-by-one-tick |
| Grader | `0 ≤ points ≤ maxPoints`; idempotent; malformed responses never throw; proportional credit monotone in correctness; symmetric where expected |
| Partial-credit methods | NG and PM never score above maxPoints; every method returns 0 for an empty response; NC and SU agree on the all-correct response |
| Pool draws | Exactly `N` distinct items when `M ≥ N`; `POOL_UNDERSIZED` when `M < N`; same seed → same draw; balanced strategies within 1 item of balance |
| Shuffle | A permutation; deterministic given a seed; disjoint seeds differ with high probability; never shuffles when the question forbids it |
| Receipt chain | Deterministic for a fixed answer set; changes if any answer changes; order-sensitive |
| Policy resolver | Total over valid policies; invalid policies rejected with field paths; defaults applied exactly once |
| Escalation | Monotone in strike count; never escalates past the configured maximum; accommodation-relaxed events never increment a strike |
| Item analysis | `0 ≤ facility ≤ 1`; `−1 ≤ D ≤ 1`; corrected D never exceeds uncorrected; below-threshold input returns `null`, never a number |
| `can()` | Total over the matrix; default deny for an unknown pair |

### 3.7 Load and chaos

| Scenario | Target |
|---|---|
| 750 concurrent exam takers, continuous answer saving | p95 save < 250 ms; **zero lost acknowledged saves** |
| Deadline stampede (5,000 attempts at T−10 s) | < 0.1% 5xx; write shedding absorbs the spike |
| 5,000-attempt release | Completes; a concurrent reader loop **never observes a partial batch** |
| Worker killed mid-release | Nothing released; retry completes it |
| Postgres failover | No data loss, no attempt corruption |
| Redis down | Degraded caching, correct behaviour, no 5xx on the exam path |
| Sim origin blocked | Every sim degrades to a static fallback; the exam continues |
| Clock skew injection | Deadlines unaffected |
| Registry at 220 sims | Conformance suite green; app bundle size unchanged from the 24-sim baseline |

---

## 4. Determinism and fixtures
- Seeded RNG everywhere; a test needing variety takes a seed and **prints it in the failure message**.
- Frozen clock; no `setTimeout` except through a virtual-timer harness.
- Golden files for block rendering and QTI export, with an explicit `--update-golden` that requires a human to inspect the diff.
- Expected-value charts (SVG of `simulate()` at fixed `t`) for every sim, so a physics regression is a diff, not an argument.
- No real personal data, ever. Synthetic fixtures only. Uploaded-file fixtures are committed KB-scale binaries, generated not downloaded.
- `pnpm reset:e2e` rebuilds from seed fixtures in under 30 s, so E2E is fast enough for every PR.

---

## 5. The twelve paths, and what each is really protecting

| # | Path | Protects |
|---|---|---|
| 1 | Author everything | The block model and the renderer |
| 2 | Pin | `INV-ASSIGN-1` — the invariant the whole grading model rests on |
| 3 | Email invite | Classroom onboarding |
| 4 | Code join + revoke | Bearer-token handling |
| 5 | Quiz with autosave | The durability model |
| 6 | **Withholding** | `INV-RELEASE-2` — the product's central promise |
| 7 | Atomic release | `INV-RELEASE-1` |
| 8 | Exam happy path | The server-authoritative clock |
| 9 | Exam violation | Evidence-not-verdict, and the escalation ladder |
| 10 | Deadline expiry | The cron and `INV-LATE-1` |
| 11 | Offline resilience | The outbox and honest durability messaging |
| 12 | Accommodations | `INV-ACC-1` and `RN-02` |

---

## 6. Anti-patterns we reject

| Anti-pattern | Why | Instead |
|---|---|---|
| Snapshot-testing a whole page | Brittle, low signal, enormous diffs | Assert on roles and semantics; snapshot only small stable components |
| `sleep(1000)` then assert | Flaky and slow | Frozen clock, virtual timers, explicit condition awaits |
| Testing private methods | Couples tests to internals | Test the public surface; extract pure functions and test those |
| A test that passes if the feature is deleted | Worthless | Every test names the behaviour it protects; reviewers check it fails without the fix |
| Mocking the database in authorisation tests | Misses the actual query scope | Real Postgres; assert the generated query is scoped |
| Mocking the grader to test the exam | Tests nothing | The real grader, with fixture states |
| One giant E2E covering everything | Fails for unrelated reasons | Small specs named by behaviour |
| Coverage as a target | Teaches line-count gaming | Coverage as a floor; property tests as the real quality signal |
| A conformance suite that only checks "it loads" | Would let 220 inaccessible sims ship | The suite asserts keyboard reachability and text alternatives too |

---

## 7. CI shape

```
lint ─┬─ typecheck ─┬─ unit + integration (sharded by package)
      │             └─ build
      └─ sim:validate (when sims/ changes)
                        │
                        └─ e2e (compose stack, seeded, sharded)
                              └─ sim:conformance (when the registry changes)
                                    └─ audit:seals · audit:payloads · a11y · i18n:check
                                          └─ audit:deps
```
Preview environments are ephemeral and torn down after the run. E2E is the slow gate, so it is sharded and the seed reset is under 30 s. A nightly run adds the load suite and a restore drill.
