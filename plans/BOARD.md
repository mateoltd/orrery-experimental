# Board

Live task state. One row per task. Updated by the director, or by any agent for their own row.

**Rules**
- A task may only enter `in_review` with **all gates green**.
- A task may only enter `done` after a merge to `main`.
- A task may only enter `ready` when its *Definition of Ready* is satisfied (`19` §8).
- `blocked` rows must name the blocker and the person or task that can clear it.

**Statuses:** `pending` · `ready` · `in_progress` · `in_review` · `done` · `blocked` · `cancelled`

---

## Current

Nothing is in flight. The first executable unit is **P0-T1**.

| Task | Status | Owner | PR | Gates | Blocked by | Notes |
|---|---|---|---|---|---|---|
| P0-T1 | pending | — | — | — | — | Monorepo scaffold. Start here. |
| P0-T2 | pending | — | — | — | — | |
| P0-T3 | pending | — | — | — | — | |
| P0-T4 | pending | — | — | — | — | Includes the `undefined`-in-`where` sweep (`RN-06`) |
| P0-T5 | pending | — | — | — | — | |
| P0-T6 | pending | — | — | — | — | Load-bearing for P8 |
| P0-T7 | pending | — | — | — | — | |
| P0-T8 | pending | — | — | — | — | ADRs 0001–0024 |
| P0-T9 | pending | — | — | — | — | **Plan risk review.** Do not skip. |
| P0-T10 | pending | — | — | — | — | |
| P0-T11 | pending | — | — | — | — | The lint rules that protect P1–P8 |

---

## Parallel lane map

Lanes available: **6**. P0 is mostly sequential; P0-T1, T2, T3 and T6 can run in parallel once T1 lands.

| Lane | Suggested first assignment |
|---|---|
| 1 | P0-T1 → P0-T2 → P0-T11 |
| 2 | P0-T3 → P0-T4 |
| 3 | P0-T5 → P0-T7 |
| 4 | P0-T6 → P0-T10 |
| 5 | P0-T8 |
| 6 | P0-T9 (after T1, reads `plans/`) |

---

## Phase status

| Phase | Status | Tasks done / total | Milestone |
|---|---|---|---|
| P0 Foundation | pending | 0 / 15 | M0 |
| P1 Identity & access | pending | 0 / 10 | M1 |
| P2 Content & authoring | pending | 0 / 11 | M1 |
| P3 Discovery & search | pending | 0 / 6 | M1 |
| P4 Classroom & collab | pending | 0 / 8 | M2 |
| P5 Assignments, banks, blueprints | pending | 0 / 15 | M2 |
| P6 Simulation platform | pending | 0 / 12 | M3 |
| P7 Quiz runtime & grading | pending | 0 / 14 | M4 |
| P8 Exam runtime & integrity | pending | 0 / 16 | M5 |
| P9 Review & grading | pending | 0 / 10 | M6 |
| P10 Release & results | pending | 0 / 10 | M6 |
| P11 Item analysis & reporting | pending | 0 / 12 | M7 |
| P12 Sim scale-out | pending | 0 / 7 | M8 |
| P13 Accessibility & i18n | pending | 0 / 9 | M8 |
| P14 Security, privacy, compliance | pending | 0 / 10 | M10 |
| P15 Reliability & performance | pending | 0 / 8 | M10 |
| P16 Interoperability | pending | 0 / 9 | M9 |
| P17 Pilot & GA | pending | 0 / 7 | M10 |
| | | **0 / 191** | |

---

## Counting rule

The task count is **machine-derived, not asserted** — the previous figure (173) was wrong
and survived two reviews because nobody counted. `scripts/count-tasks.mjs` recomputes it
from the task tables in `20-PHASE-PACKETS.md` plus the per-document tables for P4, P13 and
P16, and fails if `BOARD.md` disagrees. A board whose totals are fiction cannot be used to
decide whether the plan is finished.

Reconciling note: review K6 found 183 where the board said 173. Seven tasks were then added
by the review dispositions (P0-T12..T15 provisioning/staging/packets/kill-switch, and
P5-T13..T15 interop-skeleton/can-matrix/item-authoring). P6-T12 (Sim Studio) is deferred to
v2 and is excluded from the active count.

## Blockers and escalations

| Opened | Task | Issue | Owner | Status |
|---|---|---|---|---|
| — | — | — | — | — |

## Decisions needed from the human

All `D1`–`D13` in `00-MASTER-PLAN.md` §11 have a taken default, so execution is **not blocked**. Raise a concern if a default is wrong for you; reversing one is cheap now and expensive after P5.

| # | Decision | Default taken | Confirmed? |
|---|---|---|---|
| D1 | Market | All three; pilot is one secondary-school classroom | ☐ |
| D2 | Hosting | Hosted SaaS, single-tenant-ready schema | ☐ |
| D3 | Compliance | GDPR-shaped, EU region, no third-party analytics | ☐ |
| D4 | Managed school devices | Hard requirement; zero-install, degrading preflight | ☐ |
| D5 | User-uploaded sims | No; declarative Sim Studio instead | ☐ |
| D6 | Auto-release | Never for exams; quizzes may opt in | ☐ |
| D7 | Student identity | User-chosen name, per-classroom override | ☐ |
| D8 | Languages | en-GB, en-US, plus one non-Latin locale | ☐ |
| D9 | Sim count | 220 planned, 200 is the GA gate | ☐ |
| D10 | Custom lockdown client | No | ☐ |
| D11 | Biometric proctoring | Absent from v1 entirely | ☐ |
| D12 | Grading transparency | Students may see *how* auto-grading worked, after release only | ☐ |
| D13 | Item analysis use | Instruments only; never to rank students | ☐ |
