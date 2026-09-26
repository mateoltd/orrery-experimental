# 06 — Question Banks, Pools & Blueprints

The machinery that makes per-student variation real, and the anti-collusion lever that the evidence says actually works (`RN-03`).

---

## 1. Why this is core, not a nice-to-have

`RN-03` is the most consequential research finding in this plan. A meta-analysis of 49 studies and over 100,000 test takers found unproctored internet testing favours online by about 0.20 SD — an effect that **collapses to near zero** when three things are combined: strict time limits, content that is not internet-searchable, and a lockdown environment. The same literature concludes that the durable mitigation against answer-sharing is **item selection**: deep item pools and adaptive/balanced selection so that no two students receive the same items, and no single leaked key is worth anything.

That points somewhere uncomfortable and important: **a platform whose main anti-cheat story is browser lockdown is leaning on its weakest lever.** The stronger lever is item-level design, which is also the lever that improves teaching. So banks, pools, blueprints and per-student variants are promoted to core scope in P5, not deferred.

Canvas reaches the same place from the product side: question banks, question groups, and pools that draw N of M, with per-group and per-student overrides (`RN-04`).

---

## 2. Objects

| Object | What it is |
|---|---|
| `QuestionBank` | A named, owned, shareable collection of items. The unit a teacher builds over a course year, and the unit that makes a deep pool possible. |
| `Question` | One item, with `spec` (the key), `points`, `gradingMode`, optional `timeLimitSec`, `estimatedSeconds`, `cognitiveDemand`, tags, `modelAnswer`, `rubric`. |
| `QuestionPool` | A selection rule over a bank: `strategy`, `drawCount` (N), optional JSON-Schema `filter`, `minDistinct`. |
| `Blueprint` | A coverage matrix: topic × cognitive demand × points, with tolerance bands. |
| `AssessmentSpec` | The slot list inside a resource version: `FIXED(questionId)` or `POOLED(poolId, drawCount)`. |
| `variantMap` | The resolved draw, written once on the attempt. |

### 2.1 Draw strategies
| Strategy | Behaviour | Use when |
|---|---|---|
| `RANDOM_WITHOUT_REPLACEMENT` | Uniform draw of N distinct items | Default |
| `RANDOM_BALANCED_TOPICS` | N items, topic proportions matching the pool's topic distribution | Heterogeneous pools where a uniform draw would cluster |
| `RANDOM_BALANCED_DEMAND` | N items balanced across cognitive demand (remember / understand / apply / analyse / evaluate / create) | Blueprint-driven assessments |
| `FIXED` | Always the same N | Reproducible tests; never for a live exam |

### 2.2 INV-BANK-1 — a pool must be drawable
An assessment referencing a pool is **not publishable** unless `availableCount ≥ drawCount` **and** `availableCount ≥ minDistinct`. Where a cohort is large, the authoring-time check additionally warns when `distinctItems < expectedCohortSize / targetOverlapTolerance`, because a pool of 12 drawn 3-at-a-time converges to the same items for a class of 30. The check reports the *expected overlap*, not just a pass/fail, so a teacher can see the maths.

### 2.3 INV-BANK-2 — the draw is written once
`rngSeed` and `variantMap` are written at attempt start and read forever. Nothing re-derives "what did this student get" by re-running a draw. The attempt is therefore reproducible and auditable years later, and a regrade always uses the same items.

### 2.4 INV-BANK-3 — content is snapshotted
At publish, every question a slot can draw from is snapshotted into version-scoped rows. Editing a bank item afterwards affects only *future* versions. The escape hatch (`variantSource = BANK`, live reads from the bank) exists for formative quizzes where a teacher explicitly accepts mid-flight edits, must be opted into per assessment, and is recorded on every affected attempt so nobody is surprised later.

---

## 3. Blueprints

A blueprint is a contract about what an assessment measures.

```jsonc
{
  "name": "GCSE Physics — Forces and Motion, end of unit",
  "matrix": [
    { "topic": "forces",         "demand": "understand", "points": 8,  "tolerance": 0 },
    { "topic": "forces",         "demand": "apply",      "points": 12, "tolerance": 2 },
    { "topic": "motion",         "demand": "apply",      "points": 10, "tolerance": 2 },
    { "topic": "motion",         "demand": "analyse",    "points": 6,  "tolerance": 1 },
    { "topic": "energy",         "demand": "understand", "points": 4,  "tolerance": 0 }
  ],
  "minSimulationQuestions": 1
}
```

`BlueprintCheck` produces a machine-generated coverage report over the *resolved* assessment: per cell `{ required, actual, status }`, plus a **worst-case** column showing coverage for the least favourable possible draw. That matters: a balanced draw can satisfy a blueprint and an unlucky one can fail it, and a teacher should see the risk *before* the exam, not discover it from a student's result.

Publishing with a failing blueprint is a **warning requiring an explicit acknowledgement**, not a block. Teachers improvise, and a tool that refuses to let them teach is a tool they will route around.

---

## 4. Expected overlap — the number teachers actually need

For a pool of `M` items drawing `N` without replacement, the probability that a specific item appears in a given student's draw is `N/M`. For two students, the expected number of shared items is `N²/M`.

| Pool `M` | Draw `N` | P(item used by a student) | Expected overlap between two students | Verdict |
|---|---|---|---|---|
| 12 | 3 | 25% | 0.75 | Unusable for a cohort of 30 — the class converges |
| 30 | 3 | 10% | 0.30 | Acceptable for ≤ 30 students |
| 60 | 5 | 8.3% | 0.42 | Good |
| 120 | 8 | 6.7% | 0.53 | Strong |

This table is computed live in the pool-health UI. It converts "your pool is too small" from an opinion into a number a teacher can act on, and it tells the content team exactly which subjects need more items.

---

## 5. Per-student variants beyond item selection

Three further levers, all seeded from the attempt's `rngSeed` so they are reproducible:

| Lever | Mechanism | Caution |
|---|---|---|
| **Option shuffling** | Permute choice order per student | Never shuffle when an option is "all of the above" or "none of the above"; never shuffle when option order carries meaning (steps in an ordered list) |
| **Numeric parameterisation** | Generate values from a declared generator, with the answer derived analytically rather than looked up | The generator must be **invertible**: given the answer, the parameters are recoverable, or the item cannot be auto-graded |
| **Scenario selection** | A simulation's `scenarios` array chosen per student | The chosen scenario must be recorded in the attempt, and the grader must handle all scenarios |

### 5.1 The inversion requirement
This is the most commonly botched feature in parameterised assessment. A parameterised item is only auto-gradable if the grading function is a true inverse of the generator. Our contract:

```ts
// The generator and the grader are declared together, and the test suite
// proves the round trip for randomised parameter sets.
interface ParameterisedItem {
  generate(rng: Rng): { params: Record<string, number>; answer: ExpectedAnswer }
  grade(params: Record<string, number>, response: ResponseAnswer): GradeOutput
}
// property test: for all rng seeds, grade(params, answer) === maxPoints
```
If a team cannot write the inverse, the item is authored as a fixed-parameter item. This is a hard rule, and it is why `autoGraderVersion` is stored per response.

---

## 6. Authoring workflow

```
1. Create or open a bank
2. Add items (author, or import via QTI — plans/16)
3. Tag each item: topic, cognitive demand, difficulty estimate, discrimination estimate
4. Build pools; the health panel shows M, N, expected overlap, and topic balance
5. Attach a blueprint; the check shows coverage, worst case, and gaps
6. Compose the assessmentSpec (fixed items + pooled slots)
7. previewAsStudent: pick a seed, see exactly what a student with that seed receives
8. Publish → snapshot, check, pin
```

### 6.1 Item metadata is not optional
`topic`, `cognitiveDemand` and an optional difficulty estimate are **required** on publish. Without them, blueprints cannot be checked and item analysis cannot feed authoring (`08-ITEM-ANALYSIS.md`). We would be building an item bank we could not use.

### 6.2 The "too similar" guard
On publish, new items are compared against existing items in the same bank on: normalised stem text (trigram similarity), answer key set, and numeric answer. Items above a similarity threshold require an explicit acknowledgement. Duplicate items in a pool silently destroy the variation the pool exists to provide, and this is the cheapest possible guard against that.

---

## 7. Phase and volume planning

P5 delivers the machinery; P12 and P17 fill it.

| Milestone | Bank depth target |
|---|---|
| M2 (P5 done) | The machinery works; seed 3 demo banks of 40+ items each |
| M4 (P7) | 20 items per subject for the pilot subjects |
| M8 (P12) | ≥ 12 items per topic for pilot subjects; ≥ 60 per subject overall |
| M10 (GA) | Every published public assessment must be drawable for a cohort of 30 |

**The honest constraint:** pools are only as good as the item bank behind them, and item authoring is slow human work. The plan's job is to make the *mechanism* correct and to make the shortfall visible (`poolHealth`, zero-result search logs, `expected overlap`) so the shortfall gets prioritised rather than discovered. Shipping a variation feature over an empty bank would be theatre.

---

## 8. Testing

| Test | Property |
|---|---|
| Property | `draw` returns exactly `N` distinct items when `M ≥ N`; throws `POOL_UNDERSIZED` when `M < N` |
| Property | Same `rngSeed` → same draw, always |
| Property | A draw is a permutation of the eligible set, never a duplicate |
| Property | Balanced strategies satisfy their balance tolerance within 1 item |
| Integration | `variantMap` is written once; a subsequent bank edit does not change an existing attempt |
| Integration | A version publish snapshots every drawable item |
| Integration | `BlueprintCheck` worst-case coverage is computed over simulated draws and never over-reports |
| Unit | Expected-overlap math matches the closed-form `N²/M` for uniform draws |
| E2E | Teacher builds a pool, publishes, 5 students with different seeds receive demonstrably different items |
