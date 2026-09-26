# 19 — Execution Protocol

How work actually gets done here. Read this before touching anything. The human's latest instruction always takes precedence over this document.

---

## 1. Ground rules

1. **The plan is the contract.** `20-PHASE-PACKETS.md` holds stable task IDs (`P8-T4`). IDs never change. Tasks may be split (the new task references its parent) or added with a board note. Never silently drop a task.
2. **Definition of Done is non-negotiable** (`00-MASTER-PLAN.md` §12).
3. **Machine gates decide; humans review.** If a gate fails, fix it. Do not negotiate with it.
4. **Never weaken a gate to make a task pass.** No skipped tests, no `.only`, no lowered thresholds, no deleted assertions, no `# type: ignore` over a real error. If a gate is genuinely wrong, changing it is its own reviewed task with a rationale.
5. **Never commit secrets.** `.env.example` carries placeholders only.
6. **Never write code you have not read.** Read the neighbouring files and match their style.
7. **Schema is a contract.** A migration ships with the code that needs it, plus a reversal note.
8. **Stay in your lane.** If you need a change in another task's area, write it up as a dependency rather than editing their files.
9. **Report honestly.** A blocked task, an unfixed failing test, a shortcut — all of it goes in the PR description. Manufactured progress is the worst possible outcome.
10. **When the plan is wrong, say so.** If a task is underspecified or a design decision is missing, stop and escalate with options. Do not invent a third option and proceed.
11. **The invariants in `01-DOMAIN-MODEL.md` §14 are not negotiable in a PR.** Changing one is an ADR plus a plan amendment, reviewed separately.

---

## 2. Getting a task

Tasks are dispatched as **packets** in `tasks/`, generated from the rows in `20-PHASE-PACKETS.md`. A packet contains everything an agent needs without reading the whole plan.

```markdown
# P8-T4 · Fullscreen guard

Phase:      P8 — Exam runtime & integrity
Depends on: P8-T3 (attempt session issuance)
Blocks:     P8-T7, P8-T13
Size:       M

## Goal
Enforce the policy's fullscreen requirement during an exam, with re-entry,
a blocked mode, and no dead ends for students.

## Read first (in this order)
- plans/09-EXAM-INTEGRITY.md §3, §4, §6.1, §6.2
- plans/01-DOMAIN-MODEL.md §14 (INV-ACC-1, INV-TELEMETRY-1)
- plans/04-API-SURFACE.md (telemetry endpoint contract)
- apps/web/src/features/exam/README.md
- packages/exam-engine/src/deadline.ts          (style reference)

## Do
1. …

## Do not
- Do not implement pointer lock here (that is P8-T5).
- Do not change the evidence event list without an ADR.

## Files you own
- apps/web/src/features/exam/watchdogs/fullscreenGuard.ts
- apps/web/src/features/exam/watchdogs/__tests__/fullscreenGuard.test.ts
- apps/web/src/features/exam/ExamShell.tsx (fullscreen branch only)

## Definition of done
- [ ] all 12 items from 00-MASTER-PLAN.md §12
- [ ] unit tests: enter, exit, deny, re-entry, teardown, policy OFF/WARN/REQUIRE
- [ ] an integration test proving a BLOCKED state renders the recovery UI
- [ ] accommodation relaxation produces zero strike increments (INV-ACC-1)
- [ ] axe clean on the blocked-mode UI

## Verify
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e -g "exam fullscreen"

## Definition of ready
- [ ] P8-T3 merged
- [ ] the policy schema from P8-T1 is available
```

Packet quality is the director's responsibility. **If a packet is ambiguous, fix the packet before starting.**

---

## 3. Workflow

```
1. READ      the packet, then the listed documents, then the code you will touch
2. PLAN      write 3-6 lines of approach in the PR description BEFORE writing code
3. BRANCH    worktree + branch
4. BUILD     smallest correct increment; commit early and often
5. VERIFY    run the full gate list; paste real output into the PR
6. CHECK     walk 00-MASTER-PLAN.md §12 item by item, literally
7. HANDOFF   open a PR with the Task trailer; link it on the board
8. WAIT      do not self-approve; do not merge your own PR
```

### 3.1 Branch and worktree
```bash
git worktree add .worktrees/P8-T4 -b phase/08-exam-runtime/P8-T4-fullscreen-guard origin/main
cd .worktrees/P8-T4
```
One task, one worktree, one branch. Never work on `main`. Never force-push a shared branch. If two tasks touch the same file they are not independent — the second depends on the first.

### 3.2 Commits
```
feat(exam): add fullscreen guard with policy-driven re-entry

A blocked student must always have a way forward, so REQUIRE mode renders a
recovery overlay rather than an error. A denied capability degrades to WARN
instead of blocking, because locked-down school devices legitimately refuse
fullscreen (D4).

Task: P8-T4
```
- Conventional Commits, one logical change per commit.
- The `Task: <id>` trailer is how the board updates. Never omit it.
- The body explains **why**, especially where a decision was non-obvious.
- No "fix typo", "wip", "address review" as a whole commit. During review, amend freely **on your own unmerged branch**.

### 3.3 PR description
```markdown
Task: P8-T4
Phase: P8 — Exam runtime & integrity
Depends on: P8-T3

## What changed
…

## How it was verified
$ pnpm lint          # clean
$ pnpm typecheck     # clean
$ pnpm test          # 148 passed, 2 skipped (skips: WebGL, needs --gpu)
$ pnpm test:e2e -g "exam fullscreen"  # 6 passed
```
*(real output, not a summary)*

## Design decisions
- …

## What is explicitly NOT covered
- Pointer lock (P8-T5)
- Accommodations relaxation (P8-T12)

## Follow-ups
- P8-T13: the recovery overlay needs a focus-trap review (WCAG 2.2 §2.4.11)
```

**Reviewer checklist:**
- Does it do what the packet said, and only that?
- Are the gates real? Look for skipped tests, `.only`, lowered thresholds, `# type: ignore`.
- Is the DoD walked item by item?
- Is anything hardcoded that should come from the policy or config?
- Any `Date.now()`, `Math.random()`, `any`, `TODO`, commented-out code?
- Does any error path leak information it should not?
- Would these tests actually catch the bug this code is most likely to have?
- Does it respect the invariants in `01` §14? If it needs to break one, stop.

---

## 4. Where work happens

| Area | Rule |
|---|---|
| `apps/web` | Routes thin; domain logic in `src/features/<domain>/` with its own `README.md` describing the shape |
| `apps/worker` | Inngest functions, cron, consumers. No HTTP handlers |
| `packages/*` | Pure, framework-light, independently testable. **No package imports `next`** |
| `packages/db` | The only place Prisma is imported; exports query functions, never a client |
| `sims/*` | Simulation sources. Never imported by app code |
| `e2e` | Playwright specs, including the sim conformance matrix |
| `infra` | Terraform, Dockerfiles, compose |

**Import boundaries are enforced by tooling** (ESLint `no-restricted-imports` plus a no-barrel rule), not by convention. A PR that needs to break a boundary is a design conversation, not a lint suppression.

---

## 5. Dependencies and parallelism

The phase graph in `00-MASTER-PLAN.md` §7 is the authority. Within a phase:
- Tasks with no shared files and no data dependency run **in parallel, one lane each**.
- Tasks touching the same file run **sequentially**, in listed order.
- A task changing the schema or a shared contract **merges before** anything that consumes it; its packet says "Definition of ready".

Coordination:
- Blocked on an unmerged PR? Ask for it to be prioritised. Do not reimplement the dependency in your branch.
- Packet wrong? Stop and file it. A wrong packet poisons every lane downstream.
- The director re-plans after each phase and re-issues packets. **Do not start a task with no packet.**

---

## 6. The board

`BOARD.md` is a single table, updated by the director, or by any agent for their own row.

Statuses: `pending` → `ready` → `in_progress` → `in_review` → `done` · `blocked` · `cancelled`

A task may only enter `in_review` with all gates green, and only `done` after a merge to `main`.

---

## 7. Escalation

Stop and escalate rather than guessing when:
- a task's design is genuinely ambiguous and the options lead to materially different schemas or APIs;
- a task requires breaking an invariant in `01-DOMAIN-MODEL.md` §14;
- a task needs a migration on a populated database that could lose data;
- a gate has been failing for reasons outside your task's scope;
- you find a security or privacy problem in existing code;
- the honest path is to ship something knowingly wrong;
- you believe a **research finding** in `21-RESEARCH-NOTES.md` has been misapplied. Say so — that is the most valuable escalation available.

An escalation is short: what you found, what you tried, the options with trade-offs, and your recommendation. Then wait.

---

## 8. Definition of Ready

- [ ] The packet exists and is unambiguous
- [ ] All dependencies are merged to `main`
- [ ] The documents the packet lists as "read first" exist
- [ ] The files the packet claims you own are not in another open PR
- [ ] You can state, in three lines, how you will verify success

If any is false, the task is not ready. Fix that first.

---

## 9. Anti-patterns in agentic builds

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| Writing code without reading the neighbours | Inconsistent, duplicated, erodes the codebase | Read first, always |
| "Temporarily" disabling a test or lint rule | The temporary thing becomes permanent | Fix the cause, or escalate |
| Broad refactors inside a feature task | Unreviewable, merge-conflict magnet | Separate PR, separately reviewed |
| Adding a dependency to solve a small problem | Attack surface, licence review, install time | Write the 30 lines |
| Silently widening scope | The plan stops being trustworthy | Note the follow-up task explicitly |
| Passing tests by weakening assertions | The gate becomes theatre | Write the test that would catch the real bug |
| Guessing at a missing design decision | Incoherent architecture across lanes | Escalate; it is usually a 10-minute answer |
| One giant commit at the end | Unreviewable, no bisect, no partial value | Small commits as you go |
| Marking a task done without running the gate | The board lies; the plan stops working | Paste real output |
| Treating a research citation as decoration | The design drifts away from the evidence | Cite the `RN-*` in the code comment where it constrains a choice |
