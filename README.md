# Orrery (experimental)

> AI slop on purpose: this repository was built almost entirely by coding agents to test harnessing
> capabilities with one stealth, unreleased model. Read it as a stress test of agent-driven development,
> not as a finished product. Nothing here is production ready.

An educational portal where anyone can register and create content, quizzes and exams; embed interactive
simulations; run classrooms; and grade submitted work.

**The build plan is [`plans/`](plans/). Start at [`plans/00-MASTER-PLAN.md`](plans/00-MASTER-PLAN.md).**
Execution state lives in [`.tmp/TRACKER.md`](.tmp/TRACKER.md), which is authoritative: every task row names
its status and the commits that earned it.

## What this is

| Product | |
|---|---|
| **Studio** | Block-based authoring for anyone who registers. Lessons, quizzes, exams, with math typesetting and embedded simulations. |
| **Simulations** | A sandboxed, versioned catalogue of interactive simulations across maths, physics, chemistry, biology, earth science, astronomy, computing and engineering. Embeddable in lessons *and* gradable as exam questions. |
| **Classroom** | Teachers own classrooms, invite students, assign a **pinned version** of a resource. |
| **Assessment** | Quizzes auto-grade. Exams run under configurable integrity conditions. **Every** response goes to the teacher for review, and automatically graded items stay hidden until the teacher releases the whole batch. |

## The three rules the architecture serves

1. **The server is the only authority.** Client clocks and client scores are untrusted. Deadlines, grading and release are computed server-side.
2. **Content is immutable once assigned.** An assignment pins a resource version. Editing afterwards never changes what a student is assessed on.
3. **Withholding is atomic.** A student never sees a partially graded result. Enforced structurally and verified by a machine-checked route audit.

## How to verify it (instead of trusting this file)

- `pnpm gates` runs the full gate chain: schema, board integrity, bundle budget, route audits, registry audit, and the rest. A gate that cannot fail is treated as a defect here, and several were found and fixed by planting violations.
- `node scripts/check-tracker.mjs` verifies the tracker: every commit that names a task must have moved that task's row.
- `node scripts/count-tasks.mjs` verifies the board count against the plans.

## Documentation

| | |
|---|---|
| [`PLAN.md`](PLAN.md) | Phases 0-14, task tables, gates, risks, definition of done |
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
| [`docs/10-SIM-CATALOGUE.md`](docs/10-SIM-CATALOGUE.md) | The simulation coverage plan |
| [`docs/DATA-MODEL.prisma`](docs/DATA-MODEL.prisma) | Draft schema, retained for history |
| [`docs/adr/README.md`](docs/adr/README.md) | 18 architecture decision records |

## Status

Active agent-driven execution across phases P0-P17. `.tmp/TRACKER.md` holds the per-task truth, including
blocked items (provisioning, external systems, a human accessibility audit, real pilot users) and an
explicit terminal-state section with a checkable stop condition.
