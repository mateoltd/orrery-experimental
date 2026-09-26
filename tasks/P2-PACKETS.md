# P2 — Content Model, Block Schema & Editor

**13 tasks · ~64 h + editor risk · milestone M1.** Generated from `plans/20-PHASE-PACKETS.md`.

> ## ⚠ THE KILL-SWITCH IS DECIDED. READ THIS FIRST.
>
> **Trigger** (`plans/24-P0-RISK-REVIEW.md` CLOSED-2): abandon the TipTap editor and ship the block-list authoring UI (`P2-T11`) if, at any point before **P2-T3 merges**, either holds:
> - more than **3 blockers** on the ProseMirror custom-node / node-view work, or
> - **P2-T3 has consumed 2× its estimate** (2 × 5 days = 10 days) without the happy path working end to end.
>
> **Decision-maker: the P2 director, unilaterally, without escalation.** A kill-switch that needs consensus is not a kill-switch.
>
> **What is lost:** the slash palette, block drag handles, and the three-way conflict panel, down to their fallback equivalents. `P2-T11` exists precisely so this is a downgrade and not a rewrite.
>
> **P2 is on the critical path** and the editor is the single largest unpriced risk in the phase. Do not discover the trigger in week 3.

**Carry forward from P0/P1**
- Five gates, mutation-verified: `pnpm run gates`. Gate-file changes need `GATE-CHANGE:` in the body.
- `gate:invariants` checks `plans/invariants.json`. Four invariants become due in P2: `INV-QUOTA-1`, `INV-MIGRATE-1`, plus `INV-CONTENT-1`.
- Hard lint: no `Date.now()` / `new Date()` (use `@orrery/clock`, `isoNow()`), no `Math.random()` (use `@orrery/rng`), no `next` import in `packages/*`, no `**/index` barrel.
- `pnpm audit:deps`, `pnpm a11y` become real this phase.

---

## P2-T1 · The block schema

**Depends on** P0-T6 · **Blocks** everything in P2 · **Size** L

**Read first** `plans/05-CONTENT-AUTHORING.md` §1–§2 · `plans/07-ASSESSMENT-GRADING.md` §2 (question snapshot interplay) · `plans/21-RESEARCH-NOTES.md` RN-12

**Do**
1. All 16 block types as a Zod discriminated union discriminated on `type`, in `@orrery/contracts`, with `.strict()` on every inbound schema.
2. `schemaVersion` on the document envelope.
3. Every block carries a stable `id` so diffs and analytics survive versions.
4. `embedSimulation` pins `simId` + `simVersion` + `params` + `seedPolicy` (`FIXED | PER_STUDENT | PER_VIEW`).
5. `embedExternal` is a **provider allowlist with fixed URL templates** — never a user-supplied URL. This closes an entire class of embedding abuse and clickjacking.

**Do not**
- Do not accept user HTML. There is no sanitiser to keep patched because there is nothing to sanitise (`RN-12`).
- Do not add a 17th block type without a renderer, an authoring node, a diff case, and a migration step.

**Files** `packages/contracts/src/blocks/**`

**Done when** every type has a schema, a renderer case, an editor node, and a fixture; invalid documents are rejected with field paths.

---

## P2-T1b · Block migration framework + fixture corpus

**Depends on** P2-T1 · **Blocks** P2-T10, P2-T12b · **Size** L · **added by the P0-T9 risk review**

**Read first** `plans/24-P0-RISK-REVIEW.md` MISSED-3 · `INV-MIGRATE-1`

**Why this exists.** Content written in month 1 must render in month 18. The plan previously mentioned `schemaVersion` and said migrations would be "explicit, tested and reversible" — **and no task built them.** Without this, every schema change either breaks old content or triggers an emergency content migration nobody planned, and the fallback is to freeze the block schema forever, which means the editor can never improve.

**Do**
1. `migrateBlocks(blocks, from, to)` as a **pure** function: a total, ordered list of step functions, each `(blocks) => blocks`, each independently unit-tested.
2. A **committed fixture corpus** of every historical block shape, with a test that every corpus entry migrates to current **and round-trips** (migrate forward, then back, and assert the original). A migration that loses data fails on the corpus, not on a user's lesson.
3. Additive-then-deprecated-then-remove, matching the database's expand/contract discipline.

**Done when** a hypothetical v1→v2 step added in a test moves the corpus forward and back with no loss; the corpus is committed; `INV-MIGRATE-1` flips to `active`.

---

## P2-T2 · Block renderer

**Depends on** P2-T1 · **Blocks** P2-T8 · **Size** M

**Do** server-render blocks to HTML generated from typed data; **KaTeX with `trust: false`, `strict: 'error'`, and MathML emitted alongside the visual output** (MathML is a WCAG requirement, not a nicety); lazy media; real `<table>` semantics with `<caption>` and `<th scope>`; figures for images.

**Do not** — Do not enable `\href`, `\htmlClass`, or any author-controlled macro.

**Done when** all 16 render (15 plus the `embedSimulation` fallback); axe reports no violations; an XSS payload in every text field renders as text.

---

## P2-T3 · Editor shell — ⚠ THE KILL-SWITCH TASK

**Depends on** P2-T1 · **Blocks** P2-T4, P2-T7 · **Size** XL · **the largest single risk in the phase**

**Read first** `plans/05-CONTENT-AUTHORING.md` §3 · this file's kill-switch box

**Do**
1. TipTap v3 with custom nodes for all 16 block types; `embedSimulation`, `embedExternal`, `table` and `code` are **atomic nodes** with React node views.
2. Slash-command palette, block drag handles with **real accessible names**, keyboard block movement (`Ctrl+Shift+↑/↓`), indent/outdent.
3. Virtualisation — a 500-block fixture in the test suite, and it must stay responsive.
4. **No keyboard trap anywhere.** Every block handle is a real focusable control.
5. A documented, stable key map. Screen-reader labelling on every interactive surface.
6. Simulation parameters open in a **side panel driven by the manifest's JSON Schema**, not an inline form — this keeps the editor free of sim-specific code and is why `P6-T7` is cheap.

**Do not**
- Do not put an editor inside an iframe (`RN-07`: H5P spent years on exactly that CSS and focus breakage).
- Do not pull React or the design system into a sim frame (`ADR-0013`).

**Done when** every block type can be created, edited, moved and deleted by keyboard alone; the 500-block fixture stays responsive; axe is clean.

**Report** blockers against the trigger **as you hit them**. Hitting the trigger is not a failure; failing to notice it is.

---

## P2-T4 · Autosave and the three-way conflict panel

**Depends on** P2-T3 · **Size** M

**Do** 800 ms debounced autosave with an honest indicator (`Saving…` / `Saved` / `Couldn't save — retrying`); optimistic concurrency against the version; on `409`, a **three-way panel**: *your version* / *saved version* / *both*, merging per-block where blocks are independent.

**Do not** — Do not implement CRDTs (`ADR-0024`, `RN-11`). This is the largest scope reduction in the plan and it protects P2.

**Done when** two concurrent editors produce a merge the user can understand and choose from; a save failure is never silent.

---

## P2-T5 · Write-once versioning, structural diff, restore

**Depends on** P2-T4 · **Blocks** P2-T8, P5-T1 · **Size** M

**Do** immutable `ResourceVersion` creation with a checksum; a version list; a **structural** diff (added / removed / changed / moved, not textual); restore **as a new version**, never by rewriting history.

**Read first** `INV-CONTENT-1` — history is never rewritten.

**Do not** — `packages/db` must expose `createResourceVersion` and **no content update path**. A test asserts the update path does not exist.

**Done when** v1 → edit → v2 → diff → restore-as-v3 leaves v1 and v2 intact and byte-identical.

---

## P2-T6 · Media library, quotas, and the blocks cap

**Depends on** P2-T1, P0-T3 · **Blocks** P7-T7 · **Size** M

**Read first** `plans/14-SECURITY-PRIVACY.md` §4, §8 · `plans/24-P0-RISK-REVIEW.md` MISSED-2

**Do**
1. Presigned direct upload; content-type allowlist; **magic-byte verification**; server-side image re-encode stripping EXIF; **SVG rejected as an image** (SVG is script); captions required, alt text required before publish.
2. **A scan adapter with a no-op locally and ClamAV in production** (`D-12`: the original scheduled scanning 7 phases after the media library, leaving a window of unscanned student uploads, and `P7-T7` depended on a capability that did not exist).
3. **`INV-QUOTA-1`:** a per-user storage quota enforced **in the transaction that stores the bytes** — not at presign time, which is advisory. Default 1 GB.
4. A **2 MB cap on `Resource.blocks` at publish**, not during authoring, so writing is unconstrained and only publishing is gated. A lesson that exceeds it is a collection of lessons.

**Done when** a `.png` containing HTML is rejected; an SVG upload is refused with a reason; exceeding quota is a clear error; a 3 MB lesson cannot publish; a scan status blocks a submission from being gradeable.

---

## P2-T7 · Editor and renderer accessibility

**Depends on** P2-T3 · **Size** M

**Read first** `plans/15-A11Y-I18N.md` §1.1, §2

**Do** focus management on every route change and block insertion; `role="application"` only where justified, with a documented key map; **WCAG 2.2 `2.5.7` — every drag has a keyboard alternative with the same outcome**; contrast in both themes; `2.4.11` focus-not-obscured with sticky editor chrome.

**Done when** the whole editor is completable keyboard-only; axe clean; every block handle has a spoken name.

---

## P2-T8 · Lifecycle and visibility

**Depends on** P2-T5, P1-T6 · **Blocks** P3, P5 · **Size** M

**Do** `DRAFT → PUBLISHED → ARCHIVED` plus `WITHDRAWN`; `PRIVATE | UNLISTED | PUBLIC`; a **permission re-check on every read**, not only on write. Cache keys include the visibility tier, owner and version, so a private resource can never be served from a public cache entry; private responses are `private, no-store`.

**Done when** a second user cannot read a private resource by direct id, by search, or from cache; a `403` and a `404` do not leak existence differently in a way that matters (`14` §3).

---

## P2-T9 · Resource library UI

**Depends on** P2-T5 · **Size** S

**Do** mine / ownership transfer / duplicate / "used in N classrooms", so a teacher can see the blast radius before deleting or transferring something a live exam depends on.

---

## P2-T10 · `validateForPublish` — a checklist with fixes

**Depends on** P2-T5, P2-T6, P2-T1b · **Blocks** P5 · **Size** M

**Do** a checklist where **each issue is a deep link to the offending block**, plus a one-click fix where one exists. Also: **refuse to publish a version whose `schemaVersion` has no migration path to current** (`INV-MIGRATE-1`).

**Do not** — Do not make it a wall of red. The publish gate is a checkpoint that helps; a gate that blocks without explaining is a gate teachers route around.

**Done when** every failure mode is fixable from the checklist without leaving the screen; an unmigratable version is refused with the reason.

---

## P2-T11 · The sanctioned fallback: a block-list authoring UI

**Depends on** P2-T2 · **Size** M · **This is the kill-switch's destination**

**Do** a plain, honest form-based editor for all 16 block types. Unstyled relative to the ProseMirror editor, fully accessible, and sufficient to author and publish a complete resource.

**Do not** — Do not build this as a lesser experience you would rather not ship. If the kill-switch fires, **this is the product**, and it is good enough to teach with.

**Done when** a complete resource is authored, published and read using only this UI. This is what makes the kill-switch a downgrade rather than a rewrite.

---

## P2-T12b · Block deprecation query

**Depends on** P2-T1b · **Size** S

**Do** `archetype(resourceVersionIds using a block type)` so a block type is never removed while content still uses it. This is the block analogue of the migration discipline, and it makes "can we delete this yet?" a query rather than an investigation.

**Done when** deleting a block type that is in use is refused, naming the resources.

---

## Phase exit

- [ ] 15 of 16 block types rendered; `embedSimulation` renders its documented static fallback (wired properly in `P6-T7`)
- [ ] Alt text and table captions enforced at publish
- [ ] A 500-block document stays responsive
- [ ] axe clean on the editor and the read view
- [ ] `next build` green, all five gates green
- [ ] **The block-list fallback can author and publish a complete resource on its own**
- [ ] `INV-CONTENT-1`, `INV-QUOTA-1`, `INV-MIGRATE-1` flip to `active` in `plans/invariants.json` with real files
- [ ] Recorded: whether the editor kill-switch fired, and why
