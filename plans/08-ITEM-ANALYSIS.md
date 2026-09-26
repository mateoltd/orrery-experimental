# 08 — Item Analysis & Reporting

The statistics we show teachers about their questions — and, just as importantly, the statistics we refuse to show them about their students.

This document is deliberately cautious. `RN-05` is unambiguous that naive item analysis produces confident nonsense, and a teacher's next action after a nonsense number is to blame a child.

---

## 1. Purpose and boundary

**In scope:** diagnostics that help a teacher improve a question, a pool, or a blueprint.

**Out of scope, permanently:** any statistic used to rank, stream, sanction, or compare students. No "at-risk" flag derived from item performance. No cohort ranking. No adaptive path that silently withholds questions from a student based on their responses. Item analysis exists to improve **instruments**, not to sort **children**. (`D13`)

The UI copy enforces this: every report is framed as *"this question"* or *"this pool"*, never *"this student is behind"*.

---

## 2. Classical item statistics

### 2.1 Facility / difficulty
```
p = (number of correct responses) / (number of scorable responses)
```
Conventions, stated explicitly because the literature uses both: we report **`facility` = p** and label higher = easier. Some texts call `1 − p` "difficulty"; we avoid that ambiguity by never using the word "difficulty" alone in the UI.

Interpretation bands (teaching guidance, not a verdict):

| Facility | Reading | Suggested action |
|---|---|---|
| > 0.90 | Everyone gets it | Too easy; check it is measuring what you think |
| 0.70 – 0.90 | Healthy for a low-stakes check | — |
| 0.50 – 0.70 | Healthy for a summative exam | — |
| 0.30 – 0.50 | Hard | Check reading level, unseen context, or a mis-key |
| < 0.30 | Very hard | Investigate before reusing; often a wording or key problem, not a cohort problem |

A very low facility on a *well-written* item usually means the cohort has not been taught it. The report says so, and does not suggest blaming students.

### 2.2 Discrimination
Two indices, because each has a known defect:

**Point-biserial correlation** (correct/incorrect against corrected total score) — the conventional index. Acceptance floor **≥ 0.30** (`RN-05`).

**Corrected D** (Kelley upper-27% / lower-27%):
```
D = (P_upper − P_lower) / (P_upper + P_lower)      # where P = proportion correct in each group
```
`D` is **positively biased** because the item contributes to the total used to split the groups, and the bias is pronounced when few items make up the total — which is exactly the case for a short classroom quiz (`RN-05`). We therefore:
- always apply the published bias correction factor,
- report the number of items in the assessment next to `D`, and
- suppress `D` entirely when the assessment has fewer than 10 items.

**Rank-biserial** is computed as a third check where a tie-correction is cheap, because it avoids the upper/lower-group dichotomisation that discards information (`RN-05`).

### 2.3 Distractor analysis
For every option in a single- or multi-select item: selection frequency, and the facility of students who selected it. A distractor chosen by > 40% of students is either a **misconception worth teaching to** or a **mis-key**. We show it without deciding which, and the copy says exactly that. This is frequently the most actionable thing in the whole report and it costs nothing to compute.

### 2.4 Time on item
Median and interquartile range per question, versus the author's `estimatedSeconds`. A question where the 90th percentile is far above the estimate is either badly written or badly taught; both are the teacher's business.

---

## 3. The validity caveats we surface in the product

These are not fine print. Each appears in the report UI with an icon and a tooltip.

### 3.1 Local item dependency (LID)
If two items measure effectively the same thing, a student who gets one right is likely to get the other right for **non-substantive** reasons. This **manufactures** apparent discrimination: a redundant item pair will show a high point-biserial that reflects nothing but redundancy.

Detection: residual correlations after removing the total-score effect; flag any pair with `|r| > 0.3` where both items share a topic or stem similarity above threshold.

UI copy: *"These two questions overlap heavily. The second one adds little information and will make the test look more reliable than it is. Consider replacing one."*

### 3.2 Small samples
Suppression rules, applied without exception:

| Statistic | Minimum `N` |
|---|---|
| Facility | 5 |
| Point-biserial | 30 |
| Corrected D (upper/lower 27%) | 30, **and** at least 8 students in each group |
| Rank-biserial | 30 |
| Distractor frequency | 5 |
| Time-on-item percentiles | 10 |
| Free-text similarity clusters | 10, and clusters of ≥ 3 |

Below the threshold the cell renders **"— not enough responses"**, never a number. A facility of 0.0 from four students is the single most misleading thing an analytics product can show a teacher.

### 3.3 Multiple comparisons
An assessment with 40 items produces 40 facility values and 40 discrimination values. At conventional thresholds, some will look "bad" by chance. We therefore:
- sort by severity and show the top issues rather than a wall of numbers,
- label any item with a negative or near-zero index as *"unreliable — not evidence of a problem"*,
- and never highlight an item on the basis of a single index alone.

### 3.4 Grading-model dependence
With partial credit (`RN-05`, `07` §3), a response is polytomous, not dichotomous, and the classical dichotomy-based indices above are approximations. For multi-select items graded with a partial-credit method we report the **polytomous** facility (mean proportion of credit) and say in the tooltip that the discrimination index is computed on the dichotomised 0/1 form and is therefore conservative.

### 3.5 Unequal item counts
Pooled draws (`06`) mean different students saw different items. Reported statistics are therefore always labelled with the *actual* `N` used, and never pooled across items without saying so.

---

## 4. Reliability

Per assessment, where the item count permits:
```
Cronbach's α = (k / (k−1)) · (1 − Σ sᵢ² / s_total²)
```
Reported **only** when `k ≥ 10`, with the explicit caveat that classroom assessments are not high-stakes instruments and α in the 0.7–0.8 range is normal and not a problem. Its uses are narrow and specific: deciding whether a pool is deep enough to draw from, and flagging a blueprint that has drifted toward redundancy.

We do **not** report standard error of measurement to students, and we do not report a score band ("you are at 72nd percentile"). Both invite a defensiveness of measurement that does not suit a classroom quiz, and neither changes what a teacher should do next.

---

## 5. Answer-similarity analysis (free text)

Used to help a teacher notice an issue, never to accuse a student.

```
normalise(text)  = lowercase, strip punctuation, collapse whitespace, remove stopwords,
                   normalise unicode, collapse character runs
tokenSet(text)   = shingled 5-grams of the normalised string
fingerprint      = sha256(normalised)
similarity(a, b) = Jaccard(tokenSet(a), tokenSet(b))
```
Clustering: connected components over pairs with `similarity ≥ 0.85`, within a single assignment, **only** among students whose attempt reached that question. Minimum cluster size 3.

Presentation, and this wording is deliberate:
> *"9 responses are near-identical. This often has an innocent explanation — a shared model answer, a group assignment, or a lecture everyone copied from. It is not evidence of misconduct. Review the work and decide whether anything needs following up."*

No student is named as an accused party, no score is adjusted automatically, and `IntegrityVerdict` records a human's conclusion with a reason. `RN-01` again: the machine's job is to point a human at something, not to reach a conclusion.

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
