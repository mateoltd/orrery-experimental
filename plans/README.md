# Orrery — Implementation Plan Set

**Status:** authoritative. This directory supersedes the earlier draft in `../docs/`.
**Scope:** every phase, subsystem, contract, gate and risk needed to build and launch the platform.
**Audience:** humans setting direction, and autonomous agents executing it.

---

## Read in this order

| # | Document | Read it when |
|---|---|---|
| 00 | [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md) | Always. Product scope, stack, standards, all 18 phases, risks, DoD. |
| 01 | [`01-DOMAIN-MODEL.md`](01-DOMAIN-MODEL.md) | Before touching any entity, state machine or permission. |
| 02 | [`02-DATA-MODEL.prisma`](02-DATA-MODEL.prisma) | Before any migration. The machine-readable contract. |
| 03 | [`03-ARCHITECTURE.md`](03-ARCHITECTURE.md) | Before choosing where code runs. |
| 04 | [`04-API-SURFACE.md`](04-API-SURFACE.md) | Before writing a router or endpoint. |
| 05 | [`05-CONTENT-AUTHORING.md`](05-CONTENT-AUTHORING.md) | Before building the editor or renderer. |
| 06 | [`06-QUESTION-BANK-BLUEPRINT.md`](06-QUESTION-BANK-BLUEPRINT.md) | Before building question storage, pools or variants. |
| 07 | [`07-ASSESSMENT-GRADING.md`](07-ASSESSMENT-GRADING.md) | Before writing a grader or the grading UI. |
| 08 | [`08-ITEM-ANALYSIS.md`](08-ITEM-ANALYSIS.md) | Before writing any statistics about students. |
| 09 | [`09-EXAM-INTEGRITY.md`](09-EXAM-INTEGRITY.md) | **Before touching the exam runtime.** Highest-risk document here. |
| 10 | [`10-SIMULATIONS.md`](10-SIMULATIONS.md) | Before building or embedding a simulation. |
| 11 | [`11-SIM-CATALOGUE.md`](11-SIM-CATALOGUE.md) | Before authoring simulations beyond the 24 gold sims. |
| 12 | [`12-CLASSROOM-COLLAB.md`](12-CLASSROOM-COLLAB.md) | Before building classrooms, invites or notifications. |
| 13 | [`13-IDENTITY-AUTHZ.md`](13-IDENTITY-AUTHZ.md) | Before touching auth or the permission kernel. |
| 14 | [`14-SECURITY-PRIVACY.md`](14-SECURITY-PRIVACY.md) | Before handling any personal data. |
| 15 | [`15-A11Y-I18N.md`](15-A11Y-I18N.md) | Before building any UI or shipping any locale. |
| 16 | [`16-INTEROPERABILITY.md`](16-INTEROPERABILITY.md) | Before any import/export or LTI work. |
| 17 | [`17-TESTING.md`](17-TESTING.md) | Before writing a test, and before marking anything done. |
| 18 | [`18-OPS-RELIABILITY.md`](18-OPS-RELIABILITY.md) | Before deploying, paging, or trusting a backup. |
| 19 | [`19-EXECUTION-PROTOCOL.md`](19-EXECUTION-PROTOCOL.md) | Before executing any task. How agents work here. |
| 20 | [`20-PHASE-PACKETS.md`](20-PHASE-PACKETS.md) | The task tables. Task IDs are stable. |
| 21 | [`21-RESEARCH-NOTES.md`](21-RESEARCH-NOTES.md) | Why the design is what it is. Citations. |
| 22 | [`22-ADRS.md`](22-ADRS.md) | Before arguing with a decision. |
| 23 | [`23-REVIEW-ACTIONS.md`](23-REVIEW-ACTIONS.md) | **Read this.** Every finding from three independent reviews, with its disposition. |
| — | [`BOARD.md`](BOARD.md) | Live task state. |

---

## Document rules

1. **These are contracts, not suggestions.** Code is written against them. Changing one is a reviewed task with an ADR, not an edit in passing.
2. **No document owns another's content.** Cross-reference instead. The single source of truth for each fact is stated once.
3. **Every non-obvious decision cites its reason** — either an invariant (`INV-*`), an ADR (`ADR-*`), or a research note (`RN-*`).
4. **Where research contradicts intuition, research wins.** `21-RESEARCH-NOTES.md` records where that happened and what changed as a result.
5. **The plan is expected to be wrong somewhere.** P0 includes a task whose job is to find the top ten risks in this document and either fix them or record why they are acceptable.

---

## Current state

**Phase P0 — Foundation.** Execution started. Working state is tracked in `.tmp/TRACKER.md`.

> The plan was reviewed three times before execution began and the reviews found real
> defects: a Prisma schema that did not validate, a release design that could not meet its
> own SLO, a citation that had been edited to support the opposite of what it says, a
> sizing model that understated the work by 2.7×, and a gate on 220 simulations that could
> not pass against its own catalogue. All of it is recorded with a disposition in
> [`23-REVIEW-ACTIONS.md`](23-REVIEW-ACTIONS.md). **The corrected sizing is ~4,500–5,500 h
> over 15–21 weeks in two releases, not the 7–10 weeks originally claimed.** The repository contains this plan set, the earlier `../docs/` draft, and a git history with the plan commits.

The first executable unit is **P0-T1** in `20-PHASE-PACKETS.md`.
