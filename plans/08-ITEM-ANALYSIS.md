# 08 — Item Analysis & Reporting

The statistics we show teachers about their questions — and, just as importantly, the statistics we refuse to show them about their students.

This document is deliberately cautious. `RN-05` is unambiguous that naive item analysis produces confident nonsense, and a teacher's next action after a nonsense number is to blame a child.

> **Heavily corrected after review** (`23-REVIEW-ACTIONS.md` P-6…P-20, V-1…V-8). The original version reported point estimates from a single administration with **no confidence interval anywhere**, used a bias correction it never named, and applied a "bias correction" that pointed the opposite way from its own stated rationale. The largest single change is the addition of **§9 Form inequivalence**, which is the biggest validity threat in the product and was not mentioned at all.

---

## 1. Purpose and boundary

**In scope:** diagnostics that help a teacher improve a question, a pool, or a blueprint.

**Out of scope, permanently:** any statistic used to rank, stream, sanction, or compare students. No "at-risk" flag derived from item performance. No cohort ranking. No adaptive path that silently withholds questions from a student based on their responses. Item analysis exists to improve **instruments**, not to sort **children**. (`D13`)

The UI copy enforces this: every report is framed as *"this question"* or *"this pool"*, never *"this student is behind"*.

---

## 2. Classical item statistics

### 2.1 Facility — two distinct quantities, never conflated
> Corrected after review (`P-8`). The original reported one number called "facility" and, elsewhere, a different number also called "facility", with summative bands attached to both.

| Field | Definition | Used for |
|---|---|---|
| `pFull` | fraction of scorable responses earning **full** credit | single-answer items, and the interpretation bands below |
| `pCredit` | **mean proportion of credit** earned | partially credited items |

```
pFull  = count(fullCredit) / count(scorable)
pCredit = mean(pointsAwarded / maxPoints)     // over scorable responses
```
Where they diverge sharply on a partially credited item, that divergence **is the finding**: a class scoring `pFull ≈ 0` but `pCredit ≈ 0.5` identifies half the correct options reliably, and the item is fine. Reporting only `pFull` would have put it in the `< 0.30` band below and generated a false item revision.

Bands apply to `pFull`, are keyed to **purpose**, and are never applied to formative items:

| `pFull` | Summative reading | Formative reading | Suggested action |
|---|---|---|---|
| > 0.90 | too easy | **as intended** — the student just read this | check it measures what you think |
| 0.70 – 0.90 | healthy | healthy | — |
| 0.50 – 0.70 | healthy | healthy | — |
| 0.30 – 0.50 | hard | hard | check reading level, unseen context, or a mis-key |
| < 0.30 | very hard | investigate | investigate before reusing |

`pFull` is **uncorrected for guessing**, and the bands assume a single-answer item. For a guessable multi-select under NC, raw `pFull` is badly inflated; `pCredit` is the better read. The UI says which is which.

### 2.2 Discrimination
> Corrected after review (`P-6`, `P-7`, `P-13`, `D-26`). The original said "apply the published bias correction factor" without naming one, and asserted a property test — *corrected D is never greater than uncorrected* — that Kelley's factor violates at every positive value.

**Corrected `D` is computed on the REST-SCORE, not by a multiplicative factor.** These are two different problems and the original conflated them:

| Problem | What it is | Remedy used here |
|---|---|---|
| **Self-inclusion** — the item contributes to the total that splits the groups | part-whole | compute the split from the **rest-score** (total minus the item). This is the actual fix. |
| **Restricted range** in the criterion | scale | Kelley's `2D/(1+D)` exists, but it **increases** D, returns `−2.0` at `D = −0.5` (outside `[−1,1]`), and is calibrated on samples far larger than a classroom quiz. **Not applied.** |

```
Pupper = mean full-credit rate of the upper 27% by rest-score
Plower = mean full-credit rate of the lower 27% by rest-score
D      = (Pupper − Plower) / (Pupper + Plower)        // rest-score split
```

**Direction of the residual bias, stated honestly:** rest-score `D` is **attenuated** (the item no longer correlates with its own contribution); uncorrected `D` is **inflated**. Neither is unbiased. We report the rest-score value, label it, and do not print the item count next to it — the item count *is* the bias parameter, so printing it is decoration, not correction.

**Point-biserial `r_pb` is the primary index, and it requires `N ≥ 100`.**
> Corrected after review (`P-7`). The original allowed `N = 30`, where a true `r = 0.30` has a 95% CI of **[−0.07, +0.60]** — statistically indistinguishable from zero. A teacher acting on that is acting on noise.

| N | 95% CI for a true `r = 0.30` |
|---|---|
| 30 | [−0.07, +0.60] |
| 50 | [+0.02, +0.53] |
| 100 | [+0.11, +0.47] |
| 200 | [+0.17, +0.42] |

**Every correlation is displayed as `r [95% CI]`, and an item is flagged only when the UPPER bound falls below the 0.30 acceptance floor** — positive evidence of poor discrimination, not absence of evidence of good discrimination. The conventional 0.30 point-biserial floor is retained (`RN-05`).

**Rank-biserial** is reported alongside, not as an independent "check": for a dichotomous item it is algebraically related to `r_pb` (approximately `2·r_pb`), so three numbers a teacher might read as independent estimates are related. It uses the full rank information in the criterion, which the upper/lower-27% split discards, and its variance differs from `r_pb` depending on the item's facility. The UI labels the relationship.

**Polytomous items.** For partially credited items the relevant index is the **polytomous item-total correlation** — Pearson correlation between the item score and the rest-score, both continuous. The original claimed a dichotomised index is "conservative"; it is not conservative, it estimates a **different construct** (full-credit attainment) from the one the grade is made of.

### 2.3 Distractor analysis
> Corrected after review (`P-10`). The original said "the facility of students who selected it", which does not parse — facility is a property of an item, not of a subgroup.

The intended quantity is the **distractor discrimination index**:

```
d_j = P(correct | student did NOT select j)  −  P(correct | student DID select j)
```

A strongly negative `d_j` identifies a distractor that attracts students who are wrong — either a real misconception worth teaching to, or a mis-key. The report says exactly that and decides nothing.

- `d_j` is reported with a 95% CI and compared against a null **derived from the item's own facility**, not against a bare threshold.
- The original `> 40% selection` threshold is gone: a distractor on a `pFull = 0.95` item is chosen by 60% of students and means nothing.
- **`N ≥ 30` for any distractor flag** (the original floor was 5, where 40% of five students is two).
- Stratified by scoring method, because under a negative-credit method a high selection rate is partly an artefact of the penalty structure.

### 2.4 Time on item
Median and interquartile range per question, versus the author's `estimatedSeconds` **and** versus the class median.

> Corrected after review (`V-8`). The original concluded that a high 90th percentile means "badly written or badly taught". There is a third cause, systematically present in this product: **a screen-reader or magnification user reading a maths or science item**, which reliably inflates the tail for a perfectly well-written item.

The report therefore offers three readings, and flags **presentation review** as a distinct outcome:
- tail high + whole class slow → item or teaching
- tail high + a small identifiable subset slow → **presentation or accessibility** (stratified for item diagnosis only — see the carve-out below)
- tail high + the class median high → the estimate is wrong, not the students

---

## 3. The validity caveats we surface in the product

These are not fine print. Each appears in the report UI with an icon and a tooltip.

### 3.1 Local item dependency (LID)
> Corrected after review (`P-11`, `V-3`). The original used a **fixed 0.3** threshold with an `AND shares-a-topic` condition. Both are wrong: 0.3 is uninterpretable because the null depends on N and on the number of pairs, and the `AND` condition is **inverted** relative to the literature.

If two items measure effectively the same thing, a student who gets one right is likely to get the other right for **non-substantive** reasons. This **manufactures** apparent discrimination.

**Threshold from a multiplicity-controlled test on Fisher z**, not a fixed constant:

```
threshold = tanh( z_{1 − α/m} / sqrt(N − 3) ),   m = k(k−1)/2
floor 0.20, minimum N = 100
```

Expected pairs falsely flagged at independence, which is why a fixed threshold cannot work:

| N | thr 0.20 | thr 0.25 | thr 0.30 |
|---|---|---|---|
| 30 | 466 | 303 | **186** |
| 50 | 266 | 135 | **62** |
| 100 | 76 | 22 | **4.9** |
| 200 | 7.8 | 0.7 | 0.04 |

**Which pairs get flagged — the inversion.** Dependency *within* a declared content cluster is expected and largely harmless: the author chose it. The diagnostic concern is dependency **between** clusters, which the original rule could not see. So:
- pairs **outside** a declared content cluster → the multiplicity-controlled threshold
- pairs **inside** one → **no flag**, but they are recorded and shown
- stem similarity above threshold is reported as a **separate** signal, not conjoined with `r`

**LID is also a random error, not just an inflation** (`V-3`). Under per-student draws, which pair a student happens to receive determines whether their score is inflated, producing **non-exchangeable** measurement error: a student who draws the dependent pair is advantaged by luck. So a detected dependent pair is added to `QuestionPool.incompatibleItemPairs` and **cannot co-occur in one form**.

UI copy: *"These two questions overlap heavily. The second adds little information and will make the test look more reliable than it is. Consider replacing one."*

### 3.2 Small samples
> Corrected after review (`P-7`, `P-10`, `P-11`). The original permitted `r_pb` at `N = 30`, where the 95% CI spans zero, and had **no N floor at all** for LID.

Suppression rules, applied without exception. Below a threshold the cell renders **"— not enough responses"**, never a number. A facility of 0.0 from four students is the single most misleading thing an analytics product can show a teacher.

| Statistic | Minimum `N` | Why this number |
|---|---|---|
| `pFull`, `pCredit` | 5 | a proportion is readable early |
| Distractor selection frequency | 5 | descriptive only |
| Distractor discrimination `d_j` | 30 | a difference of two proportions |
| Time-on-item percentiles | 10 | p90 is meaningless below this |
| **Point-biserial `r_pb`** | **100** | at N=30 a true r=0.30 has CI [−0.07, +0.60] |
| **Rank-biserial** | **100** | same reasoning |
| **Rest-score `D`** | **100** | and ≥ 8 students in each 27% group |
| **LID residual correlation** | **100** | see §3.1 — at N=30 a 0.3 rule flags a quarter of all pairs by chance |
| **Cronbach's α** | see §4 | fixed-form only |
| **Spearman–Brown prediction** | 20 items | |
| Form-variability report | 200 | needs enough forms to have a spread |

### 3.3 Multiple comparisons
An assessment with 40 items produces 40 facility values and 40 discrimination values. At conventional thresholds, some will look "bad" by chance. We therefore:
> Corrected after review (`P-8`). The original said "sort by severity and show the top issues". That is **selection on the dependent variable**: it guarantees the teacher edits whichever items happened to produce the largest random deviation. It is the single most effective way to manufacture false item revisions.

- **All items are shown, with intervals. Nothing is ranked by a single index.**
- An item with a negative or near-zero index is labelled *"unreliable — not evidence of a problem"*, not "problem".
- An item is flagged only when an interval **excludes** the threshold (see §2.2), and the flag text says *"prompt a human re-read of this item"*, never *"defect"*.
- Multiple comparisons use a multiplicity-adjusted bound, so 40 items producing 40 indices does not guarantee a false positive at the conventional threshold.

### 3.4 Grading-model dependence
With partial credit (`RN-05`, `07` §3), a response is polytomous, not dichotomous, and the classical dichotomy-based indices above are approximations. For multi-select items graded with a partial-credit method we report the **polytomous** facility (mean proportion of credit) and say in the tooltip that the discrimination index is computed on the dichotomised 0/1 form and is therefore conservative.

### 3.5 Unequal item counts
Pooled draws (`06`) mean different students saw different items. Reported statistics are therefore always labelled with the *actual* `N` used, and never pooled across items without saying so.

---

## 4. Reliability
> Corrected after review (`P-12`). The original used Cronbach's α to answer *"is this pool deep enough to draw from?"*. **That question cannot be answered by α**, and α was absent from Spearman–Brown, which is the tool that answers the version of it that can be.

### 4.1 α — fixed-form only
```
α = (k / (k − 1)) · (1 − Σ sᵢ² / s_total²)
```
α is a function of the **assembled form**: `k`, item homogeneity, score spread. A deeper pool does **not** raise it. Computing α over pooled draws silently mixes a random-forms model into a fixed-forms statistic — the between-form item-difficulty variance is never charged to the individual — so a single α is **unidentified** for a student who received one arbitrary draw.

**Rule:** α is reported only for single-variant (fixed-form) assessments, and labelled as such. Never for a pooled assessment.

α in the 0.7–0.8 range is normal for a classroom quiz and is not a problem. Its narrow uses are: deciding whether a pool is deep enough, and flagging a blueprint that has drifted toward redundancy — and for the first of those, use 4.2 instead.

### 4.2 Spearman–Brown and the real quantity: form variability
> Added after review. **Spearman–Brown was absent from the entire plan** — the standard tool for "what would reliability be if this test were *k* items?", which is the only version of the stated use that is answerable.

```
SB(k') = (k' · r) / (1 + (k' − 1) · r)        // predicted reliability at length k'
```

But the number a teacher actually needs is not a reliability coefficient — it is **how much a student's score moves because of which form they drew**:

```
form variability = SD over M=1000 simulated draws of (mean score of that form)
```
That SD **is** the form-equating error, and it is the single most useful number in this document for a teacher who is about to enable per-student draws. It is reported per pool, prominently, and it is the reason §9 exists.

We do **not** report standard error of measurement to students, and we do not report a score band or a percentile. Both invite defensiveness of measurement that does not suit a classroom quiz, and neither changes what a teacher should do next.

## 5. Answer-similarity analysis (free text)

Used to help a teacher notice an issue, never to accuse a student.

```
normalise(text)  = lowercase, strip punctuation, collapse whitespace, remove stopwords,
                   normalise unicode, collapse character runs
tokenSet(text)   = shingled 5-grams of the normalised string
fingerprint      = sha256(normalised)
similarity(a, b) = Jaccard(tokenSet(a), tokenSet(b))
```
Clustering: **complete-linkage**, not single-linkage. > Corrected after review (`C-24`): single-linkage at a 5-gram threshold chains through any shared sentence of boilerplate and manufactures one giant cluster presented as "9 responses are near-identical". Complete-linkage requires every member to be similar to every other. Cluster **diameter** is reported alongside size. Within a single assignment, **only** among students who reached the question. Minimum cluster size 3.

Presentation, and this wording is deliberate:
> *"9 responses are near-identical. This often has an innocent explanation — a shared model answer, a group assignment, or a lecture everyone copied from. It is not evidence of misconduct. Review the work and decide whether anything needs following up."*

No student is named as an accused party, no score is adjusted automatically, and `IntegrityVerdict` records a human's conclusion with a reason. `RN-01` again: the machine's job is to point a human at something, not to reach a conclusion.

> **Added after review (`V-14`, `U-5`).** Two innocent causes are **systematic** in this product and must be named in the copy, not left for the teacher to guess: a **shared model answer**, and **assistive technology** — a student using dictation or speech-to-text, or a translation tool. Cluster membership on such a student is a disability-adjacent false accusation sitting in a teacher-facing report. Dictation and speech-to-text are accommodations (`09-EXAM-INTEGRITY.md` §8), and **cluster membership can never contribute to an `IntegrityVerdict` without a human explicitly noting the accessibility context** (`IntegrityVerdict.consideredAccessibilityContext`).

---

## 6. Gradebook

- Per assignment and per student; weighted course totals; `onTime` / `late` / `missing` / `excused` / `void` flags.
- Weights are configuration on the assignment; the total is a **derived view**, never stored truth.
- Per-student view shows the resolved variant ("saw 12 of a possible 60-item pool"), which matters when items differ in difficulty.
- Export CSV with injection escaping, and PDF. Streamed for large cohorts.
- A freshness timestamp on every figure, and an explicit "recomputing" state after a regrade, rather than a stale number presented as current.

---

## 7. Integrity report

Per attempt: the evidence timeline from `09-EXAM-INTEGRITY.md` §7, the preflight record, threshold crossings, force-exit reports, similarity cluster membership, and the **teacher's recorded verdict** (`IntegrityVerdict`).

Framing requirements, enforced in copy review:
- A banner stating that this is evidence, not a determination.
- Severity language that describes *events*, not intent: "left fullscreen 3 times", never "tried to cheat".
- A required verdict with a reason before any void action.
- `RN-01` is quoted in the tool's help text, because a teacher who believes the software is a lie detector will use it as one.

---

## 8. Simulation analytics

Per sim: mounts, completion rate, median and p95 session duration, parameter distributions, and **conformance flakiness**. No answer content, no free text, no PII. Used to retire sims nobody uses and to find sims that are too slow.

---

## 9. Form inequivalence — the largest single threat in this product
> Added after review (`V-1`, `V-2`). This was **not mentioned anywhere** in the original plan, and it is a direct consequence of the product's headline feature.

Students receive **different items by design** (`06-QUESTION-BANK-BLUEPRINT.md`). `01-DOMAIN-MODEL.md` §10.1 then reports one `percentage` per student, computed as `Σ points / Σ points over the resolved variant`.

**Two students with identical knowledge who draw forms of different mean difficulty receive different percentages.** Nothing in the original plan detected this, bounded it, corrected it, or disclosed it.

This is not a caveat to add to a report. It is the difference between a number that measures a student and a number that measures a random seed.

### 9.1 What we do about it in v1
| Action | Detail |
|---|---|
| **Disclose it** | Every gradebook row shows the resolved variant ("saw 12 of a possible 60-item pool") and the form's mean score. `08` §9.1's form-variability SD is shown next to the student's score. |
| **Bound it** | `poolHealth` reports form variability at authoring time, and the publish gate warns above a threshold. |
| **Quasi-balance** | `QUOTA_TOPICS` / `QUOTA_RESPONSE_PROCESS` draws (§`06`) reduce the spread by construction, and `06` §3's exact worst-case blueprint check bounds the *extremes*. |
| **Refuse extreme cases** | A pool whose form-variability SD exceeds a configured fraction of the form mean **cannot be published** as summative. This is a real constraint on authoring, and it is the honest one. |
| **Do not pretend to fix it** | Full correction needs IRT scaling with anchors and equating. `00-MASTER-PLAN.md` §3.2 defers IRT. So the product ships a **disclosed, bounded** inequivalence, not a corrected one. |

### 9.2 The stated consequence, in one sentence for the teacher-facing copy
> *"Students in this assessment did not all receive the same questions. Forms differed slightly in difficulty. We report how much, so you can read a score difference of less than that amount as meaning nothing."*

That sentence is the honest version of a feature that would otherwise quietly manufacture a difference in a student's grade.

### 9.3 Pooled draws also change what the item statistics mean
> `V-2`. The model above assumes a fixed form. Under per-student draws, a student who receives hard items does badly on **all** of them, so an item's covariance with the total contains a **between-form, between-item-difficulty** component that is not item discrimination in the intended sense. Every index in §2 is computed under a fixed-form model the product does not satisfy.

Consequence: statistics are **form-stratified** where the cohort is large enough, and the report states the form count alongside every correlation. Below that, the report says so rather than implying a fixed-form reading.

## 9. Implementation notes

- All formulas live in `@orrery/analytics` as **pure functions** with hand-verified fixtures and property tests. Raw SQL only for the aggregation that feeds them.
- Suppression is implemented in the query layer *and* in the pure functions, so a bug in one does not produce an unsuppressed number.
- `@orrery/analytics` holds a **100% branch coverage threshold**, because a statistics bug produces a wrong number that looks exactly as trustworthy as a right one.
- Precomputed rollups per assignment, invalidated on regrade and on release, with the freshness timestamp shown.
- p95 target: gradebook, item analysis, integrity report and CSV for a 500-student, 30-question assignment in under 5 s.

### Property tests
| Property | Assertion |
|---|---|
| Facility bounds | `0 ≤ facility ≤ 1` for any input, including all-correct and none-correct |
| Suppression | Below any threshold, the function returns `null`, never a number |
| D bounds | `−1 ≤ D ≤ 1`; corrected D is never greater than uncorrected |
| Group split | Upper/lower 27% groups are disjoint, sorted, and never smaller than the minimum when computed at all |
| Determinism | Same input → identical output; no hidden clock or RNG |
| Cluster purity | A cluster never spans two assignments |
| Monotonicity | Adding correct responses never lowers facility |
