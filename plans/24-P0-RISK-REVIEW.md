# 24 — P0-T9 Plan Risk Review

The task whose job is to find the top risks **in this plan** and resolve or record them. Three independent reviews have already run (`23-REVIEW-ACTIONS.md`); this document covers what they missed, and closes the two decisions they flagged as blocking (D-22, D-36).

Findings are labelled:
- **MISSED** — a gap none of the three reviews found.
- **CLOSED** — an open question from a review, now decided.
- **CONTRADICTION** — the plan contradicting itself, found by checking rather than reading.

---

## CLOSED-1 — The 750-concurrent-taker target has no source

Review D-22 flagged that the plan is indexed, replica'd and load-tested for 750 concurrent exam takers while the pilot is 30 students, and left the decision open.

**Decision: 150, and 750 becomes a claim rather than a constraint.**

| Where it appeared | What it drove | At 150 instead |
|---|---|---|
| `00` §4.2 scale assumptions | every index decision | indexes are sized for 150 |
| `18` §3 "~4 web replicas" | replica count and cost | 2 replicas |
| `P8-T16` load suite | 8h of load engineering | same suite, smaller profile, still real |
| `P15-T3` hardening | — | unchanged |
| `P15-T8` read replica (M) | a whole task | **deferred** — unjustified at 150, and a read replica is exactly the kind of premature infrastructure that becomes permanent |
| `18` §9 cost table | — | unchanged |

Recorded in `.env.example` as `TARGET_CONCURRENT_EXAM_TAKERS=150`.

**What is NOT given up:** the architecture stays scale-horizontal (no global mutable state, no in-process rate limiting, all limits in Redis, the sim origin separate), so raising the number is a matter of adding replicas and re-running the load profile. What is given up is *paying* for 750 before anyone needs it, and pretending to have tested what we have not.

**Trigger to revisit:** a committed cohort above 100 concurrent exam takers, or a signed customer above 30 classrooms. Not a hunch.

---

## CLOSED-2 — P2 has no kill-switch

Review D-36 found that `R11` names the editor risk and `P2-T11` is a sanctioned fallback, but a fallback that is *a task in the same phase* is not a trigger.

**Trigger.** Abandon the TipTap editor and ship the block-list authoring UI if, **at any point before P2-T3 merges**, either holds:
- more than 3 blockers on the ProseMirror custom-node + node-view work, or
- `P2-T3` has consumed 2× its estimate (2× 5 days = 10 days) without the happy path working end to end.

**Decision-maker:** the P2 director, unilaterally, without escalation. The whole point of a kill-switch is that it must not require consensus.

**What is lost:** the slash palette, block drag handles, and the three-way conflict panel drop to their fallback equivalents. `P2-T11` exists precisely so this is a downgrade and not a rewrite.

**Where it is recorded:** `20-PHASE-PACKETS.md` P2-T3 and P2-T11, and `05-CONTENT-AUTHORING.md` §3.

---

## MISSED-1 — "Anyone can register" makes a classroom an abuse surface, and the threat model does not have it

`00` §1 promises that **anyone can register and create content**. `00` §1.1 then describes classrooms where "teachers own classrooms, invite students". Those two promises are in tension and the plan never resolves it.

A 14-year-old can register, create six classrooms, and send 20 invitations to each. That is 120 unsolicited emails from our domain, per hour, indefinitely. The per-classroom rate limit (`04` §6: 20/hour) is the wrong control: it assumes a trusted teacher, and "anyone can register" is the product's headline feature.

Not addressed anywhere in `14-SECURITY-PRIVACY.md` §9.

**Resolution.**
1. **Aggregate invitation rate limiting by actor, not by classroom.** A cap on invitations sent per *user* per day, enforced across every classroom they own. Per-classroom limits do nothing against a creator with six classrooms.
2. **Email invitations require a verified sender** before the first one. A verified account that sends 50 invitations in a day is capped and queued for review; unverified accounts get a much lower cap. Cheap, and it removes the cheapest spam relay.
3. **Classroom creation is rate-limited per user per day**, and creating a classroom is a stronger action than creating a resource.
4. **Unsubscribe in one click from every invitation email**, and unsubscribing from classroom invitations does not disable their account.
5. **Model classroom abuse in the threat model** as its own actor, not as a variant of "content spam".

**New invariant, `INV-ABUSE-1`:** aggregate abuse limits are keyed on the **actor**, never on the container. A limit that can be sidestepped by creating more containers is not a limit.

**Tasks:** folded into `P4-T3` (aggregate limits) and `P4-T7` (unsubscribe), plus a new row in `P14-T1`.

---

## MISSED-2 — There is no storage quota, and three features each write unbounded bytes

B15 fixed the sim-state amplification. Three other write paths have no bound:

| Path | Bound today | Consequence |
|---|---|---|
| `Asset` uploads (media library, `file_submission`) | none | a user uploads 5 GB of "images", all in the primary's row store, all served by us |
| `Resource.blocks` JSONB | none | a lesson with 50,000 blocks; every read re-materialises it |
| `EmailOutbox` payloads | retention only | a bulk roster import queues a row per recipient with a full payload |

**Resolution.**
- A **per-user storage quota**, checked transactionally at upload completion (not at presign time, which is advisory). Default 1 GB, configurable. Exceeding it is a clear error, not a silent truncation.
- **`Resource.blocks` size cap** at publish: 2 MB. A lesson that exceeds it is a *collection of lessons*, which is what the content model should have had anyway. Checked at publish, so authoring is unconstrained and only publishing is.
- **`EmailOutbox` payload references, not payloads.** A queued email holds a template name and a small key set; the rendered body is produced at send time and discarded.

**New invariant, `INV-QUOTA-1`:** every write path that stores user-controlled bytes has a quota enforced at the transaction that stores them.

**Tasks:** `P2-T6` (asset quota + blocks cap at publish), `P4-T7` (outbox by reference).

---

## MISSED-3 — Block schema evolution is specified as a comment and implemented by no task

`05-CONTENT-AUTHORING.md` §2 has `schemaVersion` on the block schema, and §"Risks" says *"migrations are explicit, tested against a fixture corpus, and reversible"*. **No task builds them.**

This is the long-horizon failure of a content platform. Content written in month 1 must render in month 18. Without a migration path, every schema change either breaks old content or triggers an emergency content migration that nobody planned, and the fallback is to freeze the block schema — which means the editor can never improve.

**Resolution.** A block migration is a first-class, versioned artefact:
- `packages/contracts` exports `migrateBlocks(blocks, from, to)` as a pure function: a total ordered list of step functions, each `(blocks) => blocks`, each independently unit-tested.
- **A publish is refused** if a version's `schemaVersion` is not the current one AND no migration path exists to reach current. This forces the decision at the moment it is cheap.
- A **fixture corpus** of every historical block shape, committed, with a test that every corpus entry migrates to current and round-trips. A migration that loses data fails on the corpus, not on a user's lesson.
- Migrations are **additive-then-deprecated-then-remove**, matching the database's expand/contract discipline. A block type is never removed while any content uses it; `archetype` (list of resource version ids using it) makes that check a query.

**New invariant, `INV-MIGRATE-1`:** no stored block ever requires a human to fix it. Every readable version migrates forward automatically or the content is refused at publish.

**Tasks:** new `P2-T1b` (migration framework + corpus) and `P2-T10` (publish refuses unmigratable versions).

---

## MISSED-4 — Two clocks, and `@orrery/clock` is only half the answer

C4 fixed the *symptom*: deadline comparisons are evaluated in SQL against the primary, because `serverNow` from an app replica and `now()` from the database can disagree, and with 4+ replicas a student can find the one with the earliest clock.

But the seam is not closed, and the new `scripts/schema-gate.mjs` proves the shape of the problem exists: **123 instant columns are stamped by the database, and the application stamps a different set with `@orrery/clock`.** Two sources of truth for the same concept, in one repository.

Concrete exposure: `ExamAttempt.startedAt` written by the app from `systemClock.now()`, compared in SQL against `now()`. A 2-second replica skew is a 2-second difference in a student's exam, and the skew direction is not ours to choose.

**Resolution, three parts.**
1. **A single authority for anything that gates a deadline: the database.** `startedAt` comes from a `RETURNING` clause, never from the application clock. `@orrery/clock` remains authoritative for *display*, *durations*, and *tests* — which is what it was built for.
2. **A startup assertion** that every replica's clock is within 100 ms of the database's, failing fast at boot. A drifted replica is a configuration error, not something to discover mid-exam.
3. **A test that asserts the seam is only ever used for display.** Grep-based, in CI: a SQL predicate comparing an application-supplied instant to a deadline column is a finding, not a style note.

**Why this was missed:** the reviews looked at the deadline *arithmetic* (correct) and at the *schema* (correct), and nobody asked which clock writes the value that the arithmetic reads.

---

## MISSED-5 — The two highest-stakes reviews were still incomplete when I read them

One review invocation returned an empty result on the first attempt. That is recorded in `23-REVIEW-ACTIONS.md`, and it is the right thing to record — but the consequence deserves stating plainly:

> **A review that returns nothing is not a clean bill of health, and it is not a low-priority failure.**

If a review silently produces no output and the build treats it as a pass, the most dangerous possible thing happens: the plan is marked "reviewed" on the strength of a process that did not run. The psychometric lens in particular was the one that found the doctored citation — the most serious single defect in the plan.

**Resolution.**
1. **A review is a task with a status, not an event.** `empty` is a distinct outcome from `passed`, and an `empty` review re-runs.
2. **Review coverage is recorded, not assumed.** `23-REVIEW-ACTIONS.md` names the lens for each review. A phase whose high-risk areas lack a named review lens is not ready to exit.
3. **Re-run on any change to a reviewed section.** The dispositions in `23` were themselves edits to the documents under review, so the corrections are unreviewed. That is stated here rather than glossed: the fix for a defect found by review is itself, briefly, unreviewed.

---

## MISSED-6 — `AssessmentSlot` and `Question.spec` can disagree, and the pinning test cannot see it

`INV-ASSIGN-1` says an assessment derives only from the pinned version and the policy snapshot, and `P5-T5` proves it with a mutation test on the *renderer*. But the renderer's correctness depends on the slot list agreeing with the question rows, and nothing checks that.

Failure mode: an author reorders questions in the editor; the slot rows update but a pooled draw was already resolved for an in-flight attempt; or a slot points at a question whose snapshot belongs to a different version. The renderer then faithfully renders the wrong thing, and the mutation test still passes because it only checks that `currentVersionId` is not read.

**Resolution.**
- A **referential integrity check at publish**: every `FIXED` slot's `questionId` must be a snapshot whose `resourceVersionId` equals the version being published; every `POOLED` slot's `poolId` must have `availableCount ≥ drawCount` (`INV-BANK-1`); every slot's `position` is dense and unique. Refuse to publish otherwise.
- An **extension to the pinning test**: assert not only that `currentVersionId` is unread, but that the resolved attempt's questions are byte-identical to the pinned version's slot list. That is the property that actually matters, and it catches a whole class of drift the identifier check misses.

---

## MISSED-7 — Nothing verifies that the plan's own invariants are *tested*

The plan has 26 invariants in `01-DOMAIN-MODEL.md` §14 and each is labelled with an enforcing mechanism. Nobody checked that the mechanism exists.

Concretely: `INV-BANK-3` says "enforced by the publish transaction". `INV-RELEASE-2` says "machine-checked route audit". `INV-TELEMETRY-1` says "ingest re-stamping + test". These are claims in a document, in the same genre as the sandbox checklist that shipped with every box already ticked (`D-31`) — which the delivery review called "the clearest example of rigorous-looking theatre in the plan".

**Resolution: an invariant registry that can fail.**

| Invariant | Enforced by | Verified that this exists |
|---|---|---|
| 26 invariants | a named gate, test or code path | `scripts/invariant-registry.mjs`, run in CI |

The registry is a data file mapping each `INV-*` to its enforcing mechanism and the file that implements it, and a script that fails if an invariant has **no** mechanism, if its mechanism is a comment rather than code, or if the named file does not exist. A new invariant cannot be added without naming what enforces it, and a deleted enforcing file breaks the build.

This is the same lesson as the pre-ticked checklist, applied before it costs anything rather than after.

---

## CONTRADICTION-1 — `P6-T11` re-costing was dispositioned but not applied

`23-REVIEW-ACTIONS.md` D-20 correctly established that the 24 gold sims were sized at 2 h each when a realistic first-sim rate against a brand-new SDK is 8–12 h. The disposition says `FIXED`, but `20-PHASE-PACKETS.md` still carries P6-T11 as **XL** with no revised figure, and the phase totals in `00` §7.1 are the old ones.

**Resolution:** P6-T11 is re-costed to 240 h (24 × 10 h), and the P6 total moves from 92 h to ≈ 240 h. This alone is the difference between the 4,500–5,500 h estimate being roughly right and being optimistic again.

## CONTRADICTION-2 — The `11-SIM-CATALOGUE.md` coverage gate still cannot be satisfied

Review K7 found the catalogue fails its own CI gate: the gate requires **≥ 12 per grading strategy** and `SE` appears **9** times. The disposition says `FIXED`; the catalogue is unchanged, because the fix (renaming an id) was applied and the *count* was not.

**Resolution:** with the scope cut to 60 sims, the gate thresholds are restated against the reduced catalogue: ≥ 4 per grading strategy in the shipped 60, ≥ 12 across the full 220 roadmap, and the shipped set must cover all nine target subject areas. A gate that the shipped content cannot pass is a gate that will be quietly ignored.

---

## What the reviews still do not cover

Stated so the next reviewer knows the gaps rather than assuming they are closed:

| Area | Reviewed? |
|---|---|
| Correctness of the psychometrics | Yes, thoroughly (21 findings) |
| Schema, concurrency, atomicity | Yes, thoroughly (18 blocking, 27 risks) |
| Executability, sizing, gate integrity | Yes, thoroughly (37 findings) |
| **Content/pedagogy of the 60 simulations** | **No.** The spec-card template exists; no sim has been written |
| **Whether the editor UX is any good** | **No.** P2 is XL and nobody has prototyped it |
| **Migration off v0 to v1 of a real schema** | **No.** Expand/contract is written; never rehearsed |
| **Operational runbooks** | **No.** `18` §6 lists ten runbooks; none has been walked through |
| **Whether teachers will actually use the grading workspace** | **No.** It is designed from first principles and volume arguments, with no user |

The last one is the most likely to be wrong in a way no review can catch, because it is an empirical question and nobody has asked a teacher.
