# 21 — Research Notes

The evidence this plan was built on. Every `RN-*` referenced elsewhere resolves here. If a citation is wrong or has been misapplied, that is a defect in the plan and should be escalated (`19` §7).

---

## RN-01 — Online proctoring: high specificity, catastrophically low sensitivity

**Sources**
- *On the Efficacy of Online Proctoring using Proctorio* (CSEDU 2021, University of Twente). Controlled evaluation: 6 students instructed to cheat, 5 instructed to act nervously to elicit false positives. Result: **automated analysis detected none of the cheating students; human reviewers detected 1 of 6.** False positives: **0% automated, 4% human.** Conclusion drawn by the authors: specificity is achievable but "useless in the light of the disastrous sensitivity".
- Same study: after adoption of online proctoring, scores **dropped 10–20%**, interpreted as evidence that cheating had previously been common.
- *Examining the Examiners: Students' Privacy and Security Perceptions of Online Proctoring Services* (USENIX SOUPS 2021). Students most comfortable with lockdown browsers, least comfortable with browser-history monitoring; only ~18% found monitoring a positive experience; extension installation is a significant stated barrier.
- *Educators' Perspectives of Using (or Not Using) Online Proctoring* (USENIX 2023). Mixed effectiveness reports; multiple educators reported false positives and false negatives; educators were most comfortable with lockdown browsers (85%) and least comfortable with live-not-visible proctoring and eye movement.
- *A Systematic-Narrative Review of Online Proctoring* (ERIC EJ1481131). Automated flagging "needs to be overcautious, necessitating a large proportion of false positives", with a danger of **profiling students** based on flagged behaviour.
- *Security for Online Exams: Digital Proctoring* (ERIC ED626600, 2021).

**What it changed**
1. Integrity output is **evidence for a human, never a verdict**. `ADR-0017`, `09-EXAM-INTEGRITY.md` §1, `INV-TELEMETRY-1`.
2. **No automated punitive action.** No auto-void on violation count.
3. The `IntegrityVerdict` object requires a named human decision with a reason.
4. Rejected: `debugger` timing traps, devtools heuristics used to fail a student, auto-voiding.
5. UI copy is evidence-framed and quotes this finding in the tool's help text, because a teacher who believes the software is a lie detector will use it as one.
6. We will **measure and disclose the score delta** after enabling stricter controls, since a 10–20% drop is the expected effect and an unexplained cohort collapse will be read as a broken release.

---

## RN-02 — Proctoring harms some students disproportionately

**Sources**
- Online Teaching & Learning guidance, University of Denver: explicitly **advises against the facial-detection feature** because false flags are **disproportionately attached to students of colour, students with particular accommodation needs, and students who may not have stable internet or technological access**. Notes facial detection issues for darker skin tones are lighting-dependent and worsened by slow connections reducing frame rate.
- *Internet-Based Proctored Assessment: Security and Fairness Issues* (PMC7404853). Proctoring can increase test anxiety and diminish performance.
- SOUPS 2021 (above): students' discomfort is concentrated on the most invasive techniques.

**What it changed**
1. **No biometric proctoring in v1 — absent, not "off by default"** (`D11`, `00` §3.2). If ever built it needs its own bias audit, per-institution consent, and a human review queue.
2. **Accommodations mode is a first-class, auditable, zero-penalty policy variant** (`09` §8, `INV-ACC-1`), grantable in two clicks **during a live exam**.
3. `blockCopyPaste` is disabled under accommodations, because paste-blocking breaks screen readers and switch access.
4. Fullscreen and pointer-lock controls each have a `DEGRADED` path that never dead-ends a student (`09` §6.2).
5. A published integrity policy students can read in advance, and a non-penalising refusal path for proctoring consent.

---

## RN-03 — The effective anti-cheat levers are item-level, not browser-level

**Sources**
- Steger et al. (2020), meta-analysis of 49 studies with over 100,000 test takers, cited in PMC7404853: unproctored internet-based testing favours online by about **0.20 SD**, but the effect size **falls to near zero** when (a) the test has strict time limits, (b) content is not internet-searchable, and (c) a lockdown browser is employed.
- Same source: a meta-analysis of "computer adaptive test (CAT) design to minimize the likelihood that two test takers receive the same items" among the recommended controls; Duolingo's approach cited as combining lockdown browser, test-taker authentication, eye tracking, a deep item pool and CAT, with a 48-hour review period before score release.
- Alessio et al. (2017), cited in EJ1450469: students taking proctored (lockdown-only) exams **completed in half the time** of unproctored peers and **scored significantly lower** on the same exam.

**What it changed**
1. **Question banks, pools, blueprints, per-student variants and a deep item pool were promoted to core scope** in P5, not deferred (`06-QUESTION-BANK-BLUEPRINT.md`).
2. "CAT-lite" — stratified balanced draws from pools — is the v1 answer; full IRT/CAT is explicitly out of scope until the item counts justify it.
3. The expected-overlap calculation (`N²/M`) is surfaced in the product so a teacher can see whether their pool is deep enough.
4. A **48-hour review period before score release** is treated as a normal, expected part of the release model rather than an odd delay.
5. The plan is explicit that a platform whose main anti-cheat story is browser lockdown is **leaning on its weakest lever**, and says so in `09` §1.

---

## RN-04 — Established LMS mechanics worth copying exactly

**Sources**
- **Moodle** quiz settings (docs.moodle.org, versions 23 through 4.x): countdown timer in the navigation block; **auto-submit on timeout with whatever answers are filled in**; three timeout behaviours — auto-submit, grace period with no further answers permitted, or must-submit-before-expiry; "**no marks are awarded for any answers entered after the time ran out**"; a submission grace period governed by `quiz|graceperiodmin` with a **60-second default**; question-order shuffling; sequential navigation; per-group and per-user overrides for open date, close date, time limit, attempts, and password; review options controlling what a student sees after the quiz closes; Safe Exam Browser as an *optional* integration.
- **Canvas** (Yale and Delaware guidance): shuffle answers; quiz time limit that "will not be paused if the student navigates away" and auto-submits at expiry; multiple-attempt limits; **one-question-at-a-time with "Lock Questions"** so an answered question cannot be revisited; **question banks and question groups** with randomised selection; Moderate Quiz for additional attempt views after grading; and the explicit institutional recommendation to run an **ungraded practice quiz requiring the lockdown tool**, with unlimited attempts, so students can shake out their device first.
- **Respondus LockDown Browser** (Delaware guidance): "intended for use in proctored settings and can support — but not replace — the proctor's role"; "**not suitable for take-at-home exams**"; institution-specific builds, so a download from a different institution does not work; and the advice to consider allowing extra time because students need time to close applications and remove extensions before launch.

**What it changed**
1. `INV-LATE-1`: **late writes are rejected and the last accepted value retained** — directly from Moodle's "no marks after the time ran out". This is the entire justification for server-authoritative deadlines.
2. `gracePeriodSec` defaults to **60**.
3. Per-question limits are implemented as **server-set immutable `questionOpenedAt`**, which is a stronger version of Canvas's client-side "Lock Questions".
4. **Ungraded practice attempts** are a first-class feature (`allowPracticeAttempt`), including a recommendation to grant extra time.
5. Per-group / per-user / per-assignment overrides exist as `AssignmentStudentOverride` and `Accommodation`.
6. Review options control what a student sees after close, independent of release.
7. The "not suitable for take-at-home" honesty is adopted: our integrity posture is documented per assignment so a teacher knows what they are relying on.

---

## RN-05 — Auto-grading validity and item analysis are disciplines, not lookups

**Sources**
- Koçdar (2016), *Analysis of the Difficulty and Discrimination Indices*: item difficulty is the **percentage of learners who answered correctly**, range 0.0–1.0; the discrimination index measures the ability to distinguish high and low performers; the paper discusses a **point-biserial correction coefficient of at least 0.3** as an acceptance criterion.
- Journal of Education and Practice (2015), ERIC EJ1083861: a **p-value of 0.5** is the target after correction for guessing, and a **discrimination index of at least 0.3** is the stated acceptance threshold.
- ETS Research Bulletin RB-58-13 (Levine & Lord, 1958): test-level reliability and validity coefficients are **not** indices of discrimination for the test as a whole; pointwise discrimination is a different quantity.
- Kelley / classical item analysis literature (ERIC ED071352): **D and B are positively biased** because the item contributes to the total used to split groups, and the bias "may be pronounced when only a few items contribute to total scores, as is usually the case for short criterion-referenced tests". **Rank-biserial correlation** is proposed to retain interpretability while avoiding the upper/lower-group dichotomisation defect.
- METRON (Springer, 2023), *Theoretical evaluation of partial credit scoring*: **all partial-credit scoring functions improve reliability over no-credit (NC) and no-guessing (NG)**, and the argument for using at least some form of partial credit is "strong". Partial-credit functions are framed as suppressing guessing a priori rather than accounting for it a posteriori.
- Betts, Muntean, Kim & Kao (2022), *Educational and Psychological Measurement*: comparative evaluation of multiple-response partial-credit methods — **SU (subset), RI (Ripkey), PM (plus/minus), PCM, dichotomous**. RI is more lenient than SU because irrelevant selections can be forgiven; PM showed the best IRT fit (lowest average infit 1.16, outfit 1.33) with narrower variability.
- NAEP Technical Documentation: the **Generalized Partial Credit Model** for polytomous items, and the distinction between dichotomous and polytomous items.

**What it changed**
1. `08-ITEM-ANALYSIS.md` specifies formulas, **bias correction**, and the requirement to report the item count alongside `D`.
2. **Suppression rules with minimum N** per statistic, and a rule that below-threshold output is `null` — never a number. A facility of 0.0 from four students is the most misleading thing an analytics product can show.
3. **Local item dependency is surfaced as a first-class caveat**, because redundant items manufacture apparent discrimination.
4. The word "difficulty" is avoided in the UI in favour of **facility**, because the literature uses both conventions.
5. `07-ASSESSMENT-GRADING.md` §3 implements a **named five-method partial-credit taxonomy (NC, NG, SU, RI, PM)** with **NG as the default**, justified by the reliability finding and the guessing-suppression framing.
6. Multiple-comparison and small-sample caveats are stated in the product, not just in this document.
7. `@orrery/analytics` gets a 100% branch coverage threshold, because a statistics bug produces a wrong number with exactly the same authority as a right one.
8. `RN`-derived decision: item analysis is **for improving instruments, never for ranking students** (`D13`).

---

## RN-06 — Prisma 6+ rejects `undefined` filters; Prisma 8 is GA

**Sources**
- Prisma release notes (Sept 2026): **Prisma 8 is GA** and available as `prisma@latest`; Prisma Compute GA. In the 5 → 6 transition, `selectRelationCount` went GA and the preview flag now errors; **passing `undefined` as a value in a `where` clause, which was silently ignored in Prisma 5, is now an error**; the Edge client configuration was unified.
- Community migration reports: the `undefined`-in-`where` change is called out as the one that "hurts the most because there is no compile-time error" in the old behaviour.

**What it changed**
1. Stack pins **Prisma 8.x**, not 6.
2. We **lean into the strictness**: a whole class of "the filter silently did not apply" bugs — a classic source of authorisation holes — becomes a hard error. This is called out as a feature for an autonomous build in `00` §4 and `03` §5.
3. The practical risk is acknowledged: the same reports note this change **does** break code on upgrade, so the P0 migration task includes a sweep for `undefined` in `where` clauses.

---

## RN-07 — H5P: the closest prior art to our simulation host, and its traps

**Sources**
- H5P Core API (`H5P.resizeIframe(contentId, height)`, `H5P.isFramed`, `H5P.fullScreen`): resize is driven by the content **calling into the parent**; H5P documentation and forum threads note that **fullscreen inside an iframe does not work by default** and requires a custom `postMessage` process, implemented as `h5p-resizer-script.js`.
- H5P changelog: "**The H5P Editor is now inside an iframe to avoid messing up css styling**" — followed by years of related fixes across the WordPress and Joomla plugins for styling and editor breakage.
- H5P bundles **jQuery 1.9.1** as a core dependency.
- H5P is embedded in LMSs via LTI and as plain iframes, with an `Iframe Embedder` content type.

**What it changed**
1. Our sim host uses an explicit **`postMessage` resize protocol**, and fullscreen is treated as a **host** capability that a sim can request but never owns (`10` §2.2).
2. **All editors stay outside iframes** (`05` §3). Only runtime code is sandboxed.
3. `@orrery/sim-sdk` ships with **zero runtime dependencies** and a dependency allowlist; no per-sim install.
4. Versioned, content-addressed bundles with a JSON descriptor, since that is the part of H5P's model that worked.
5. Deferred H5P import, and an explicit note that H5P is not our compatibility target.

---

## RN-08 — Tooling consolidation

**Observation:** Biome is now widely adopted as a combined linter and formatter, frequently replacing ESLint + Prettier, and ESLint's long dependency chain is a recurring supply-chain concern.

**What it changed**
1. **Biome** for lint and format, with **ESLint retained only** for the two things Biome does not express: package import boundaries and the no-barrel rule. ESLint is pinned and treated as a deliberate, minimised risk rather than a default.
2. `scripts/scan-secrets.sh` plus `osv-scanner` in CI, given the reduced tooling surface is now partly load-bearing.

---

## RN-09 — App Router engineering conventions

**Sources:** the widely used production Next.js 15 + Turborepo + tRPC + Prisma monorepo pattern (for example the public `turborepo-nextjs` reference implementation), which documents three choices explicitly: **no barrel files** ("prevents bundle bloat and maintain clear server/client boundaries in React Server Components"), end-to-end type safety via tRPC with a superjson transformer, and the package/feature split separating presentation, business logic and data.

**What it changed**
1. **No barrel files** anywhere; explicit subpath exports (`03` §4.3).
2. tRPC with **superjson**, so `Date`, `Decimal` and `Map` cross the wire without custom serialisation.
3. A feature-module split with strict server/client boundaries.
4. A single Prisma client in development with proper singleton handling across hot reload, and separate clients for web and worker.

---

## RN-10 — Next.js 15/16 specifics

**Sources:** Next.js 15 and 15.1 release notes and the version-15 upgrade guide.
- **Async request APIs** are a breaking change: `cookies()`, `headers()` and `params`/`searchParams` are now async. `next/headers` and `next/cache` are stable.
- **Caching semantics changed**: `fetch`, GET Route Handlers and client navigations are **no longer cached by default**.
- React 19 is stable and supported; React 18 remains supported.
- Turbopack is stable for dev and the default bundler there; the Rust-based compiler is the default in dev from 15.5.
- `useFormState` is **deprecated** in favour of `useActionState`.
- Partial Prerendering is a stable configuration option.
- Version tracking shows 15.5.x as the current LTS line in August/September 2026, with Next 16 referenced in the wild; `use hook` for React promises is available.

**What it changed**
1. **Explicit caching decisions everywhere.** No implicit reliance on framework defaults, because the 15 change is a footgun. Cache keys explicitly include visibility tier, owner and version (`03` §3.1).
2. All `cookies()` / `headers()` / `params` access is awaited — a compile error, so cheap to enforce.
3. `useActionState`, not `useFormState`.
4. **Web not Turbopack for production builds** until P0 measures it, because the exam runtime's bundle budget and source-map quality are release gates and stability matters more than build speed.
5. Node 24 LTS asserted in CI.

---

## RN-11 — Collaborative editing is not required

**Observation:** CRDT-based collaborative editing is a large architectural commitment (a second data model, conflict-free merge semantics, presence) and is not needed for the stated requirement, which is single-author authoring with version history.

**What it changed**
The editor uses optimistic concurrency against a version counter with a **three-way conflict panel**, not a CRDT (`05` §3). Real-time collaboration is deferred to v2 if demand appears. This is the single largest scope reduction in the plan and it protects P2, which everything else depends on.

---

## RN-12 — Author-supplied content must not be a program

**Sources:** MDX evaluates author-supplied JSX; HTML sanitiser bypasses are a recurring CVE class; the block-JSON approach used by modern collaborative editors.

**What it changed**
Content is a **closed discriminated union rendered to HTML we generate** (`05` §1). There is no sanitiser to keep patched because there is nothing to sanitise. MDX, raw-HTML passthrough and raw-Markdown-with-sanitiser are all rejected in the ADR record with reasons.

---

## RN-13 — Interoperability standards

**Sources:** 1EdTech/IMS specification pages and the LTI Advantage Implementation Guide.
- **LTI 1.3** uses separate authentication mechanisms for messages and services under the **IMS Security Framework 1.0**; HTTPS is mandatory for both messages and services and for all resource URLs.
- LTI Advantage = Core 1.3 + **Deep Linking 2.0**, **Names and Role Provisioning Services 2.0**, **Assignment and Grade Services 2.0**. For **Learning Platforms**, *Advantage Complete* (all three services) is the **only** certification option; Tools may be certified with Core plus one or two services.
- AGS 2.0 defines the grade passback line item score and is the mechanism by which an external LMS would learn a student's result.
- **QTI 3.0** was released in **May 2022** and consolidates QTI and APIP; QTI 2.x remains the broadly supported version. 1EdTech describes QTI as the interoperability standard for authoring and delivering online tests.
- OneRoster 1.2 for roster and gradebook sync.

**What it changed**
1. `16-INTEROPERABILITY.md` sequences **export before import, launch before parity**, with LTI implemented as Core + Deep Linking + AGS (Tool-certified territory) rather than attempting full Platform certification.
2. **Grade passback sends nothing before `releasedAt`** — a partial passback would break `INV-RELEASE-2` in a system we could not even observe.
3. QTI 3.0 is the target, QTI 2.2 for broad tool support.
4. `Question.spec` is a versioned discriminated union and `QuestionBank` is a first-class object, because the standards model them that way.

---

## How to use this document

When a design decision looks arbitrary, there is usually an `RN-*` behind it. When you are tempted to simplify something away, check whether an `RN-*` is what stops you. And when reality contradicts one of these notes, **escalate** (`19` §7) rather than quietly working around it — the plan's credibility depends on its evidence being honest.
