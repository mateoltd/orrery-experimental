# Agent Execution Protocol

How work gets done. Read this before touching anything. The human's latest instruction always takes precedence over this document.

---

## 1. Ground rules

1. **The plan is the contract.** `PLAN.md` holds stable task IDs (`P8-T4`). IDs never change; tasks may be split (the new task references its parent) or added, with a note in the board. Never silently drop a task.
2. **Definition of Done is non-negotiable.** `PLAN.md` §12. A task that does not meet it is not done, regardless of how well it works.
3. **Machine gates decide, humans review.** Lint, types, tests, e2e, dependency audit, sim validation. If a gate fails, fix it; do not negotiate with it.
4. **Never weaken a gate to make a task pass.** No skipped tests, no `.only`, no `# type: ignore` to silence a real error, no lowered coverage threshold, no deleted test. If a gate is genuinely wrong, change the gate *as its own reviewed task* with a rationale.
5. **Never commit secrets.** No `.env` values, no tokens, no connection strings with passwords. `.env.example` carries placeholders only.
6. **Never write code you have not read.** Read the neighbouring files and match their style. If a file is the only thing that implements a behaviour and it is wrong, fix it in its own task.
7. **Schema is a contract.** If your change needs a migration, the migration ships in the same PR as the code that needs it, plus a reversal note.
8. **Stay in your lane.** Work only in your task's worktree. If you need a change in another task's area, write it up in the PR description as a dependency rather than editing their files.
9. **Report honestly.** A blocked task, a failing test you could not fix, a shortcut you took — all of it goes in the PR description. Manufactured progress is the worst possible outcome.
10. **When the plan is wrong, say so.** If a task turns out to be underspecified or a design decision is missing, stop and escalate with options. Do not invent a third option and proceed.

---

## 2. Getting a task

Tasks are dispatched as **packets** in `tasks/`. A packet is generated from the row in `PLAN.md` and contains everything an agent needs without reading the whole plan.

```markdown
# P8-T4 · Fullscreen guard

Phase:      P8 — Exam runtime & integrity
Depends on: P8-T3 (attempt session issuance)
Blocks:     P8-T7, P8-T13
Size:       M  (~1 ideal agent-day)

## Goal
Enforce the policy's fullscreen requirement during an exam, with re-entry,
a blocked mode, and no dead ends for students.

## Read first (in this order)
- docs/05-EXAM-INTEGRITY.md §3, §6.1, §6.2
- docs/01-DOMAIN-MODEL.md §9 (telemetry event table)
- docs/06-API-SURFACE.md (telemetry endpoint contract)
- apps/web/src/features/exam/README.md
- packages/exam-engine/src/deadline.ts          (style reference)

## Do
1. …

## Do not
- Do not implement pointer lock here (that is P8-T5).
- Do not change the telemetry event list without an ADR.

## Files you own
- apps/web/src/features/exam/watchdogs/fullscreenGuard.ts
- apps/web/src/features/exam/watchdogs/__tests__/fullscreenGuard.test.ts
- apps/web/src/features/exam/ExamShell.tsx (fullscreen branch only)

## Definition of done
- [ ] all 12 items from PLAN.md §12
- [ ] `pnpm --filter @orrery/exam-engine test -- --coverage` ≥ threshold
- [ ] unit tests: enter, exit, deny, re-entry, teardown, policy=OFF/WARN/REQUIRE
- [ ] an integration test proving a BLOCKED state renders the recovery UI
- [ ] axe clean on the blocked-mode UI

## Verify
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e -g "exam fullscreen"

## Definition of ready
- [ ] P8-T3 merged (AttemptSession issuance exists)
- [ ] policy schema from P8-T1 is available
```

Packet quality is the director's responsibility. If a packet is ambiguous, fix the packet before starting.

---

## 3. Workflow

```
1. READ      the packet, then the listed documents, then the code you will touch
2. PLAN      write 3-6 lines of approach in the PR description *before* writing code
3. BRANCH    worktree + branch
4. BUILD     smallest correct increment; commit early and often
5. VERIFY    run the full gate list; paste real output into the PR
6. CHECK     walk PLAN.md §12 item by item, literally
7. HANDOFF   open a PR with the Task trailer; link it to the board
8. WAIT      do not self-approve; do not merge your own PR
```

### 3.1 Branch and worktree
```bash
git worktree add .worktrees/P8-T4 -b phase/08-exam-runtime/P8-T4-fullscreen-guard origin/main
cd .worktrees/P8-T4
```
One task, one worktree, one branch. Never work on `main`. Never use `--force` on a shared branch. If two tasks touch the same file, they are not independent — the second one depends on the first (see §5).

### 3.2 Commits
```
feat(exam): add fullscreen guard with policy-driven re-entry

A blocked student must always have a way forward, so REQUIRE mode renders a
recovery overlay rather than an error. Denied capability degrades to WARN
instead of blocking, because locked-down school devices legitimately refuse
fullscreen.

Task: P8-T4
```
- Conventional Commits. One logical change per commit.
- The `Task: <id>` trailer is how the board updates. Never omit it.
- The body explains *why*, especially where a decision was non-obvious.
- No "fix typo", "wip", "address review" as a whole commit. During review, `git commit --amend` is fine **on your own unmerged branch**.

### 3.3 PR description
```markdown
Task: P8-T4
Phase: P8 — Exam runtime & integrity
Depends on: P8-T3

## What changed
…

## How it was verified
```
$ pnpm lint          # clean
$ pnpm typecheck     # clean
$ pnpm test          # 148 passed, 2 skipped (skips: WebGL, requires --gpu flag)
$ pnpm test:e2e -g "exam fullscreen"  # 6 passed
```
*(real output, not a summary)*

## Design decisions
- …

## What is explicitly NOT covered
- Pointer lock (P8-T5)
- Accommodations relaxation of the fullscreen guard (P8-T12)

## Follow-ups
- P8-T13: the recovery overlay needs a focus-trap review
```

**Reviewer checklist** (used by whoever reviews):
- Does it do what the packet said, and only that?
- Are the gates real? (Look for skipped tests, `.only`, loosened thresholds, `# type: ignore`.)
- Is the DoD walked item by item?
- Is anything a hardcoded value that should come from the policy or config?
- Any `Date.now()`, `Math.random()`, `any`, `TODO`, commented-out code?
- Does the error path leak information it should not?
- Are the tests the kind that would actually catch the bug this code is likely to have?

---

## 4. Where work happens

| Area | Rule |
|---|---|
| `apps/web` | Pages, features, API routers. Feature-first: `src/features/<domain>/` with its own `README.md` explaining the shape. |
| `apps/worker` | Inngest functions, cron jobs, background consumers. No HTTP handlers. |
| `packages/*` | Pure, framework-light, independently testable, no Next.js imports. A package that imports `next` is doing the wrong job. |
| `packages/db` | The only place Prisma is imported. Exports query functions, never a client instance, to the app. |
| `sims/*` | Simulation sources. Never imported by app code. |
| `e2e` | Playwright specs, including the sim conformance matrix. |
| `infra` | Terraform, Dockerfiles, compose. |

**Import boundaries are enforced by ESLint `no-restricted-imports`**, not by convention. A PR that needs to break a boundary is a design conversation, not a lint suppression.

---

## 5. Dependencies and parallelism

The phase graph in `PLAN.md` §6 is the authority. Within a phase:

- Tasks with no shared files and no data dependency run **in parallel, one lane each**.
- Tasks that touch the same file run **sequentially**, in the listed order.
- A task that changes the schema or a shared contract **must merge before** any task that consumes it. The consumer's packet says "Definition of ready".

Coordination rules:
- If you are blocked on a merged PR, ask for it to be prioritised; do not reimplement the dependency in your branch.
- If you discover your packet was wrong, stop and file it. A wrong packet poisons every lane downstream.
- The director re-plans after each phase and re-issues packets. Do not start a task whose packet does not exist.

---

## 6. The board

`tasks/BOARD.md` is a single table, updated by the director (or by any agent for their own row):

| Task | Status | Owner | PR | Gate | Blocked by | Notes |
|---|---|---|---|---|---|---|
| P0-T1 | ✅ done | — | #12 | green | — | |
| P0-T2 | 🔄 review | agent-3 | #14 | green | — | 1 comment |
| P8-T4 | ⏳ ready | — | — | — | P8-T3 | |
| P9-T2 | 🚫 blocked | — | — | red | P9-T1 | waiting on schema |

Statuses: `pending` → `ready` → `in_progress` → `in_review` → `done` / `blocked` / `cancelled`.
A task may only enter `in_review` with all gates green. A task may only enter `done` after a merge to `main`.

---

## 7. Escalation

Stop and escalate, rather than guessing, when:
- a task's design is genuinely ambiguous and the options lead to materially different schemas or APIs;
- a task requires breaking an invariant in `01-DOMAIN-MODEL.md`;
- a task needs a migration on a populated database that could lose data;
- a gate has been failing for reasons outside your task's scope;
- you find a security or privacy problem in existing code;
- the honest thing to do would be to ship something knowingly wrong.

An escalation is a short document: what you found, what you tried, the options with trade-offs, and your recommendation. Then wait.

---

## 8. Definition of Ready (before starting any task)

- [ ] The packet exists and is unambiguous.
- [ ] All dependencies are merged to `main`.
- [ ] The documents the packet lists as "read first" exist.
- [ ] The files the packet claims you own are not currently being edited in another open PR.
- [ ] You can state, in three lines, how you will verify success.

If any of these is false, the task is not ready. Fix that first.

---

## 9. Anti-patterns seen in agentic builds

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| Writing code without reading the neighbouring files | Inconsistent, duplicated, and it erodes the codebase | Read first, always |
| "Temporarily" disabling a test or a lint rule | The temporary thing becomes permanent | Fix the cause, or escalate |
| Broad refactors inside a feature task | Unreviewable, merge-conflict magnet | Separate PR, separately reviewed |
| Adding a dependency to solve a small problem | Attack surface, licence review, install time | Write the 30 lines |
| Silently widening scope | The plan stops being trustworthy | Note the follow-up task explicitly |
| Passing tests by weakening assertions | The gate is theatre | Write the test that would catch the real bug |
| Guessing at a missing design decision | Incoherent architecture across lanes | Escalate; it is usually a 10-minute answer |
| One giant commit at the end of a long task | Unreviewable, no bisect, no partial value | Small commits as you go |
| Marking a task done without running the gate | The board lies; the plan stops working | Paste real output |
