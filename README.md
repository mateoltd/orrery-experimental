# Orrery

An educational portal where anyone can register and create content, quizzes and exams; embed hundreds of interactive simulations; run classrooms; and grade submitted work.

**→ The build plan is [`plans/`](plans/). Start at [`plans/00-MASTER-PLAN.md`](plans/00-MASTER-PLAN.md).**

`PLAN.md` and `docs/` are an earlier, higher-level draft, retained for history. `plans/` supersedes them.

---

## What this is

| Product | |
|---|---|
| **Studio** | Block-based authoring for anyone who registers. Lessons, quizzes, exams, with math typesetting and embedded simulations. |
| **Simulations** | A sandboxed, versioned catalogue of 220 interactive simulations across maths, physics, chemistry, biology, earth science, astronomy, computing and engineering. Embeddable in lessons *and* gradable as exam questions. |
| **Classroom** | Teachers own classrooms, invite students, assign a **pinned version** of a resource. |
| **Assessment** | Quizzes auto-grade. Exams run under configurable integrity conditions. **Every** response goes to the teacher for review, and automatically graded items stay hidden until the teacher releases the whole batch. |

## The three rules the architecture serves

1. **The server is the only authority.** Client clocks and client scores are untrusted. Deadlines, grading and release are computed server-side.
2. **Content is immutable once assigned.** An assignment pins a resource version. Editing afterwards never changes what a student is assessed on.
3. **Withholding is atomic.** A student never sees a partially graded result. Enforced structurally and verified by a machine-checked route audit.

## Documentation

| | |
|---|---|
| [`PLAN.md`](PLAN.md) | Phases 0–14, task tables, gates, risks, definition of done |
| [`docs/EXECUTION-PROTOCOL.md`](docs/EXECUTION-PROTOCOL.md) | How agents execute: packets, worktrees, review, escalation |
| [`docs/01-DOMAIN-MODEL.md`](docs/01-DOMAIN-MODEL.md) | Entities, state machines, invariants |
| [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) | Topology, lifecycles, scaling |
| [`docs/03-SIMULATIONS.md`](docs/03-SIMULATIONS.md) | `sim-host@1` protocol, manifests, SDK, scale-out |
| [`docs/04-ASSESSMENT.md`](docs/04-ASSESSMENT.md) | Question types, grading, review, release |
| [`docs/05-EXAM-INTEGRITY.md`](docs/05-EXAM-INTEGRITY.md) | Policy, threat model, server-authoritative time, telemetry |
| [`docs/06-API-SURFACE.md`](docs/06-API-SURFACE.md) | tRPC routers, exam REST, events, idempotency |
| [`docs/07-SECURITY-PRIVACY.md`](docs/07-SECURITY-PRIVACY.md) | Threat model, sandboxing, privacy, retention |
| [`docs/08-TESTING.md`](docs/08-TESTING.md) | Gates, layers, fixtures, load and chaos |
| [`docs/09-OPS.md`](docs/09-OPS.md) | Infra, observability, SLOs, runbooks, DR |
| [`docs/10-SIM-CATALOGUE.md`](docs/10-SIM-CATALOGUE.md) | The 220-simulation coverage plan |
| [`docs/DATA-MODEL.prisma`](docs/DATA-MODEL.prisma) | Draft schema — the contract for P0-T4 |
| [`docs/adr/README.md`](docs/adr/README.md) | 18 architecture decision records |

## Status

Planning complete. Execution starts at **Phase 0 — Foundation**. Track progress in `tasks/BOARD.md` (created at execution start).

## Status legend for this document

Nothing is implemented yet. Every document in `docs/` is a design contract to be built against, and each carries a phase reference so it can be revised deliberately rather than silently.
