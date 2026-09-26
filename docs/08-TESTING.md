# Testing Strategy

Testing is the mechanism that makes an autonomous multi-agent build trustworthy. Gates are cheap, deterministic, and run on every change.

---

## 1. The five gates

| Gate | Command | Runs on | Blocking |
|---|---|---|---|
| Lint | `pnpm lint` | every push | yes |
| Types | `pnpm typecheck` | every push | yes |
| Unit + integration | `pnpm test` | every push | yes |
| E2E | `pnpm test:e2e` | every PR + main | yes |
| Dependencies | `pnpm audit:deps` | every PR, scheduled daily | yes (high/critical) |

Domain gates, active once their phase lands:

| Gate | Command | From |
|---|---|---|
| Simulation conformance | `pnpm sim:conformance` | P6 |
| Simulation validation | `pnpm sim:validate` | P6 |
| Accessibility | `pnpm a11y` | P2 |
| Answer-key leak audit | `pnpm audit:seals` | P7 (grows to full route audit in P10) |
| Payload/PII scanner | `pnpm audit:payloads` | P1 |
| i18n completeness | `pnpm i18n:check` | P13 |
| Load | `pnpm test:load` | P8, P13 |

---

## 2. Coverage policy

Coverage is a *signal*, not a target. The policy:

| Package | Threshold | Rationale |
|---|---|---|
| `@orrery/grading` | **100% branch** | Decides grades. A missed branch is a mis-graded student. |
| `@orrery/exam-engine` | **100% branch** | Decides deadlines and escalation. Off-by-ones here are real. |
| `@orrery/contracts` | 100% statement | The validators are the security boundary |
| `@orrery/auth` (`can()`) | 100% branch | The authorisation matrix |
| `@orrery/sim-sdk` | 95% | Covered heavily by per-sim conformance tests |
| `apps/web` features | 80% | Integration-covered by e2e |
| `apps/worker` | 80% | Jobs are hard to test; the money ones get extra fixtures |

Global floor: 85% lines. A PR that lowers any threshold is rejected in review.

---

## 3. Test layers

### 3.1 Unit
Pure functions with no I/O: the grader, the deadline engine, the policy resolver, the shuffle, the escalation ladder, the clock, the RNG, the receipt hasher, all Zod schemas, `can()`, every block renderer.

Mandatory properties (see §5).

### 3.2 Integration
Real Postgres and Redis via Testcontainers. Every tRPC procedure and every REST endpoint has at least one happy path, one authorisation refusal, and one validation failure.

Key fixtures:
- `seedFactory` — a builder producing a coherent world (users, classroom, enrollment, resource, version, questions, assignment, attempts) in any requested shape. A coherent fixture is what makes authorisation tests cheap to write.
- `frozenClock` — every test that involves time injects `FrozenClock`. There are no real sleeps in unit or integration tests.
- `answerFixtures` — hand-computed expected grades for every question type, reviewed by a second person. These are the numbers that decide students' grades.

### 3.3 Contract
The simulation conformance matrix: for every registered `simId@version`, mount it in the real host, assert the handshake, assert the sandbox, replay the scripted interaction, assert the reported answer, assert the Node-side grade, assert keyboard reachability, assert state round-trip, capture screenshots. This is the mechanism that makes hundreds of simulations safe to ship.

### 3.4 E2E — the twelve golden paths
1. **Author** — register → create a resource using all 14 block types, two sims, three equations → publish → view as a stranger.
2. **Pin** — assign v1 → edit to v2 → student is assessed on v1 (the invariant test).
3. **Classroom** — teacher creates → invites by email → student registers → accepts → appears in the roster.
4. **Join by code** — generate a code → student joins → code revoked → join fails.
5. **Quiz** — 30 mixed questions including 2 sim questions → autosave → refresh → resume → submit → auto-grades computed.
6. **Withholding** — student cannot see any score before release, via UI, via API, via a direct fetch, via the response headers.
7. **Release** — teacher reviews free responses → releases the batch → all students see results atomically.
8. **Exam happy path** — full integrity policy → fullscreen → answer → submit → receipt.
9. **Exam violation** — exit fullscreen, switch tab, copy → events recorded → escalation visible → teacher sees the timeline.
10. **Exam deadline** — short limit → wait it out → cron auto-submits → correct server-held state.
11. **Offline resilience** — kill the network mid-exam → answers queue → restore → flush → nothing acknowledged is lost.
12. **Accommodations** — teacher grants extra time → student gets a longer deadline, and tab switches are not counted as violations.

Each golden path is one spec file and is run in CI on every PR. They are slow and they are worth it: they are the executable definition of the product.

### 3.5 Adversarial
A dedicated suite for things that must not be possible:
- IDOR across users, classrooms, assignments, attempts
- forged telemetry, replayed events, out-of-order `seq`
- replayed saves, stale revisions, concurrent writes from two devices
- answer payloads that fail their schema, or that are absurdly large
- sim frames that attempt cookie/storage/fetch access, send unknown protocol frames, or report a state that fails its schema
- timing attacks: submit at `deadline - 1ms`, at `deadline`, at `deadline + grace`, at `deadline + grace + 1ms`
- a client whose system clock is ±3 days
- a response payload crafted to look like a score

### 3.6 Property-based (`fast-check`)
| Subject | Properties |
|---|---|
| Deadline engine | No write accepted after its window; reload never moves `questionOpenedAt`; total deadline dominates; grace is exact, not off-by-one-tick |
| Grader | `0 ≤ points ≤ maxPoints`; idempotent; malformed responses never throw; partial credit monotone in correctness for proportional strategies; symmetric where expected |
| Shuffle | A permutation; deterministic given a seed; disjoint seeds give different orders with high probability |
| Receipt chain | Deterministic for a fixed answer set; changes if any answer changes; order-sensitive |
| Policy resolver | Total over valid policies; invalid policies rejected with field paths; defaults are applied exactly once |
| Escalation ladder | Monotone in strike count; never escalates past the configured maximum |

### 3.7 Load and chaos
| Scenario | Target |
|---|---|
| 750 concurrent exam takers, continuous answer saving | p95 save < 250 ms, 0 lost acknowledged saves |
| Deadline stampede (5,000 attempts at T−10 s) | No 5xx above 0.1%; write shedding absorbs the spike |
| 5,000-attempt release | Completes; atomicity verified by a concurrent reader loop that never observes a partial batch |
| Worker killed mid-release | Nothing released; retry completes it |
| Postgres failover | Brief errors, no data loss, no attempt corruption |
| Sim origin blocked | Every sim degrades to a static fallback; the exam continues |
| Redis down | Degraded caching, correct behaviour, no 500s on the exam path |

---

## 4. Fixtures and determinism
- Seeded RNG everywhere (`@orrery/rng`); a test that needs variety takes a seed and prints it in the failure message.
- Frozen clock; no `setTimeout` in tests except through a virtual-timer harness.
- Golden files for block rendering, with an explicit update command (`--update-golden`) that requires a human to inspect the diff.
- Charts of expected values (SVG output of `simulate()` at fixed `t`) for every sim, so a physics regression is a diff, not a debate.

---

## 5. Anti-patterns we reject
| Anti-pattern | Why | Instead |
|---|---|---|
| Snapshot-testing an entire page | Brittle, low signal, enormous diffs | Assert on semantics and roles; snapshot only small stable components |
| `sleep(1000)` then assert | Flaky and slow | Frozen clock, virtual timers, explicit awaits on the condition |
| Testing private methods | Couples tests to internals | Test through the public surface; extract logic into pure functions and test those |
| A test that passes when the feature is deleted | Worthless | Every test names the behaviour it protects; reviewers check that the test fails without the fix |
| Mocking the database in authorisation tests | Misses the actual query scope | Real Postgres, assert the generated query is scoped |
| Mocking the grader to test the exam | Tests nothing | The real grader, with fixture states |
| One giant e2e that covers everything | Fails for unrelated reasons, tells you nothing | Small specs named by behaviour |
| Coverage as a target | Teaches line-count gaming | Coverage as a *floor*; property tests as the real quality signal |

---

## 6. Test data
- No real personal data, ever. Synthetic fixtures only, generated by seed.
- A `data/seed/` directory of JSON fixtures for subjects, taxonomy, and demo content, version-controlled and validated by a schema test.
- A `reset:e2e` script that rebuilds the database from the seed in under 30 s, so E2E is fast enough to run on every PR.
- Uploaded-file fixtures are committed small binaries (a few KB), generated rather than downloaded.
