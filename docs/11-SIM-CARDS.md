# P12-T1 — Spec cards, one per simulation in `plans/11`

**Companion to [`11-SIM-CATALOGUE-PLAN.md`](11-SIM-CATALOGUE-PLAN.md).** That document holds the count
audit, the plan-versus-code disagreement register, the review rubric and the conformance manifest schema.
This one holds the cards.

**Read Part 0 before any card.** It is the host contract, the nine tolerance classes, the three seed
strategies, the per-modality keyboard and non-visual rules, the licence rules and the determinism and
replay requirements — everything that is identical for all 219 simulations, stated once. A card is
incomplete without it, and an authoring agent is handed this file and one card and needs nothing else.

**A card is a specification, not a conformance claim.** None of these simulations exists except the 24
already built, and the plan's §3 records where those 24 disagree with the code that will grade them.
## Generated content — 219 cards

Every card below is generated from one authored source, so the FIELD SET cannot drift between sims: a card missing a field is a generator defect rather than an authoring slip. The card's *content* is authored per sim and is the thing a reviewer judges; the preamble is the part that is identical for all 219 and is stated once.

An authoring agent is handed this file and one card and needs nothing else: the host contract, the tolerance classes, the seed strategies and the per-modality keyboard rules are all in Part 0 below.

## Part 0 — the contract every card carries

### 0.1 What the host gives the sim, and what it must return

**Given** (`sim:init`): `params` (clamped by the SDK at the trust boundary), `seed`, `mode`, optional `initialState`, optional `grading`. **Returns**: `sim:ready` with `capabilities` matching the manifest, then `sim:resize`, `sim:state` (checksummed), `sim:answer`, `sim:readyForInput`. **Frames it must never send**: `sim:gradePreview` with `surface: 'student'`, and anything at all on `PROHIBITED_API` (`protocol.ts:191-207`: `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `navigator.clipboard`). `grade` is `grade(state, params, answer)` — **three** positional arguments, checked at load by `defineSim` (`packages/sim-sdk/src/define.ts:147-154`) because a two-argument grader is handed the parameters as its answer and scores every answer zero without reporting an error.

### 0.2 Tolerance classes, and why there are nine

`withinTolerance` (`packages/sim-sdk/src/grading.ts:84-105`) takes the bound `max(absolute, relative x max(|given|, |expected|))` — **the LARGER of the two, and symmetric**, which is what makes `tolerance(a,b)` and `tolerance(b,a)` agree. So declaring both silently widens the band, and declaring `absolute` alone silently widens it to everything near zero. Measured against the shipped `maths.projectile-motion` declaration (`absolute: 0.5, relative: 0.02`), run through the real helper:

| answer | declared `absolute` | effective half-width | verdict |
|---|---|---|---|
| 8 m | 0.5 m | 0.5000 m | the absolute bound wins |
| 63.71 m | 0.5 m | **1.2742 m** | 2% wins — 2.5x the declared bound |
| 1200 m | 0.5 m | **24.0000 m** | 48x the declared bound |

Each class therefore names WHICH bound is declared, and why that one. `abs: 0, rel: 0` means EXACT, not 'nothing is within it' (`grading.ts:98-104`), which is why T-A is a real instrument.

**T-A · exact integer.** `abs: 0, rel: 0`; strategy `EXACT` or `NUMERIC`. The answer is a count read off the sim, so anything else is a different claim.**

	*Trap:* none from floats — the hazard is `EXACT`, which string-compares and will not accept `4` for `4.0`.

**T-B · absolute only.** `relative` OMITTED: `withinTolerance` takes `max(abs, rel x max(|a|,|b|))`, so a `relative` beside an `absolute` overrides it at scale. `abs` = the precision the question asks for.**

	*Trap:* wrong when the answer can exceed ~50× the declared `abs` — then it is T-C.

**T-C · relative only.** `absolute` OMITTED: an absolute floor accepts everything near zero, since `withinTolerance(0.0001, 0, {abs: 0.5})` is true.**

	*Trap:* wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D.

**T-D · both, and both mean something.** `relative` carries the model error (an irrational quantity, a solved root, a numerical integration); `absolute` carries the precision the question asked for. The only class where declaring both is honest rather than accidental.**

	*Trap:* the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210`.

**T-F · closed vocabulary.** `EXACT` against a list the card ENUMERATES. `canonicalText` does not normalise `0.30`→`0.3`, `½`→`1/2` or `x²`→`x^2`, so `EXACT` is safe only on an enumerated set.**

	*Trap:* **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead.

**T-G · set of labels.** `SET`, with `caseSensitive` decided and stated. Partial credit is Jaccard (`grading.ts:290-297`), so an omission costs exactly what an extra costs.**

	*Trap:* **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct.

**T-H · ordered sequence.** `ORDER`, never `SET`: `orderMatch` credits per POSITION over `max(expected, given)` (`grading.ts:355-379`), the only reading in which a reversed sequence scores badly.**

	*Trap:* a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated.

**T-I · rubric.** `RUBRIC`; the sim never decides, it produces the counts and bands a marker needs.**

	*Trap:* **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL`.

### 0.3 Seed strategies

`sim:init` carries a `seed` (`protocol.ts:212-241`) and the host derives it from a `SeedPolicy` (`apps/web/src/features/sim/hostBridge.ts:216-254`), which **hashes** the identity for `PER_STUDENT` so an attempt id never reaches a sim's PRNG directly. `grade(state, params, answer)` is given **no seed argument at all** — which is the whole reason a randomised sim must carry its seed in its state, and the reason the conformance cell reads the seed from the state rather than from `sim:init` (`scripts/sim-conformance.mjs:911-925`).

**S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it.**

	*Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all.

**S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`).**

	*Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`).

**S-2 · seeded parameters.** `randomised: true` because the ANSWER differs per student, though the model is pure in its parameters. `PER_STUDENT/ATTEMPT_ID`; the parameter set is derived from the seed **in the browser layer** and written into state.**

	*Also:* `grade(state, params, answer)` gets `params` from the RESOLVED VARIANT, not from the state of the sim (`protocol.ts:41`, `plans/10` §5.1) — a sim inventing its own parameter set is silently regraded against the wrong question.

### 0.4 Keyboard, announcement and non-visual rules, by modality

`plans/15` §1.2: "Canvas is invisible to a screen reader." So what the student operates and what a screen reader meets are different questions, and the second one has to be answered per card. Every card names its modality and the three rows below follow from it. The **non-visual row is the load-bearing one**: a canvas is decorative (`aria-hidden`) and the same data is in a real table, so the screen-reader path reads the SAME numbers the grader reads rather than a description of them.

**`canvas`**

	*Keyboard:* Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber..  
*Announced:* A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit..  
*Non-visual:* Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test..

**`svg`**

	*Keyboard:* Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down..  
*Announced:* A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle..  
*Non-visual:* The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`..

**`form`**

	*Keyboard:* Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box..  
*Announced:* On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing..  
*Non-visual:* The form is the whole interaction — there is no canvas to mirror..

**`table`**

	*Keyboard:* Tab into the table, then ArrowUp/ArrowDown between cells that are editable; every editable cell is an input inside a `<th scope>`-headed row..  
*Announced:* The cell the student just left is announced by the browser (it is an input), and the sim adds nothing on a cell-by-cell edit..  
*Non-visual:* The table is the interaction. Nothing is visual-only..

**`three-d`**

	*Keyboard:* Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart..  
*Announced:* Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame..  
*Non-visual:* The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it..

**`diagram`**

	*Keyboard:* Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging..  
*Announced:* The part that changed and what it is attached to; one announcement per completed edit, not one per keypress..  
*Non-visual:* The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too..

### 0.5 Licence and provenance

`licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes.

### 0.6 Purpose of every card

Every gold sim exists to break a specific assumption in the conformance suite (`plans/10` §10). If this one breaks nothing, the suite is weaker than it looks and the card has not said which assumption.

### 0.7 Determinism and replay, stated once

**Purity.** `simulate(params, state, t)` and `grade(state, params, answer)` are pure functions. The type split in `defineSim` is the enforcement rather than a promise: `grader` has no DOM type in any parameter, and `browser` is deliberately `void` of DOM types so it cannot be imported into a grader bundle (`packages/sim-sdk/src/define.ts:2-23`). `sim:validate` refuses `Date.now`, `new Date`, `performance.now`, `Math.random`, `fetch`, `XMLHttpRequest`, `process.env`, `document.`, `window.` and `navigator.` **by name** in the grader (`scripts/sim-validate.mjs:189-224`) — which is a narrow check and the file says so rather than claiming dataflow analysis.

**The determinism probe is weak and every card must survive it.** `runDeterminism` (`scripts/sim-validate.mjs:288-330`) grades the literal state `{ probe: true }` three times. A grader that destructures `state.mass` on `undefined` throws, and a throw is reported as `GRADER_FAILED`. Every card therefore owes a `validateState` and a grader that tolerates a state it does not recognise.

**Replay.** `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(module, { state, params, answer })` (`define.ts:223-240`) re-runs `validateState`, re-clamps the params at the same trust boundary the browser used, and calls `grade`. That is the whole replay story and it is what `P11-T9`'s variant audit needs: the seed is in the state, the parameters are re-derivable from the resolved variant, and the grader is a pure function of the two.

**A sim whose output cannot be reproduced is not gradeable**, and the three ways that happens are: an answer that depends on a value not in the state (a magnet's speed, a slider reading, the wall clock); a draw not derived from the recorded seed; and an answer that depends on the rendering rather than on the model. Each card names which of the three its answer risks, or says none.

#### 1. `astronomy.orrery` — Solar system orrery

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compare orbital periods and distances and say why the picture on the wall is wrong. |
| Interaction | Drag the bodies and scrub time with the slider; the orbits and the positions render; type a period and a distance. |
| Model | **3D WebGL, continuous time, large-but-legal bundle, hostile time slider** (`plans/10` §10). The bodies' positions are computed from `a`, `e` and `T` at the requested `t`, so a scrubbed view and a played view at the same `t` agree — which the hostile slider exists to test, because a slider that jumps to a large `t` in one step is how a sim ends up integrating the wrong interval. The SHIPPED gold sim's spec card records that this row's tolerance gap was the fixed-timestep promise. |
| Answer | `{ period: number, distance: number, speed: number }` — days, AU, km/s, to 3 sf. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `ordering` for the bodies by period, which is order-sensitive and is the reasoning question · `multi_select` for which bodies are in the habitable zone · `true_false` for the scale claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `T = 2π√(a³/μ)` and `μ = GM`, so the answer is a square root of a cube — a 1% error in `a` becomes a 1.5% error in `T`. `rel: 0.005, abs: 0.5 days` on the period and `rel: 0.005, abs: 0.001 AU` on the distance. **The card states the units because the solar system's natural scales are AU and days and a student in km and seconds is right.** |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A 3D view of the solar system with the orbits drawn as ellipses and the Sun at the centre, with each body's period and distance listed. The task is to report the orbital period and distance of one named body. The alternative gives every body's semi-major axis and orbital period as numbers, so both answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Period is proportional to distance rather than to distance cubed. (2) The orbital periods in the solar system can be read off the picture, and a to-scale picture cannot show them because the Earth would be a speck. (3) A body's speed is greatest at perihelion. |

#### 2. `astronomy.orbital-mechanics` — Orbital mechanics

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can use vis-viva and say what a transfer orbit costs. |
| Interaction | Set the transfer's two radii; the transfer ellipse and the burn points render; type the delta-v at each burn and the transfer time. |
| Model | Vis-viva `v² = μ(2/r − 1/a)` is evaluated from the transfer's semi-major axis `a = (r₁+r₂)/2`, and the two burns are the DIFFERENCE between the circular speeds at each radius and the transfer speed at each point — which is the derivation, and a sim that reported the transfer speed as the answer would miss the row's focus entirely. |
| Answer | `{ deltaV1: number, deltaV2: number, transferTime: number, speedAtApoapsis: number }` — km/s to 3 dp, days. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for which burn is larger · `true_false` for the Hohmann-optimality claim · `ordering` for the sequence of burn, coast and circularisation, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | A square root of a difference of reciprocals: near a circular orbit `2/r − 1/a` is the difference of two nearly equal numbers, so the CONDITIONING IS POOR and a small error in `r` produces a large relative error in `v`. **The card requires the radii to 4 significant figures and states the conditioning**, because at `r₁ = 1.5 r₂` a 3-sf radius gives a delta-v that is right to 1% and at `r₁ = 1.01 r₂` gives one right to 10%. `rel: 0.01`. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | Two circular orbits drawn round a central body with an elliptical transfer orbit tangent to both and the two burn points marked. The task is to report the change in velocity needed at each burn and the time the transfer takes. The alternative gives the two orbital radii, the central mass and the body's current circular speed. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Transfer orbits are circular. (2) Both burns need the same delta-v, because the two orbits are the same size. (3) A faster transfer arrives sooner and needs no more fuel. |

#### 3. `astronomy.stellar-evolution` — Stellar evolution

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can place a star on the HR diagram and say which stage of its life its position implies. |
| Interaction | Set the star's mass; the HR position and the evolutionary track animate; type the stage and the lifetime. |
| Model | Mass drives everything, so the track is a DECLARED function of mass rather than a set of paths, and the lifetime follows `t ∝ M^−3` — the row's focus names 'HR diagram, fusion stages, lifetimes' and the −3 exponent is the counterintuitive part a sim must make visible rather than assert. Mass above about 8 M☉ leaves the main sequence within a human lifetime, and the sim's TIME SCALE is logarithmic for exactly that reason. |
| Answer | `{ stage: string, lifetime: number, endProduct: string }` — years in scientific notation. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the stage and the end product · `numeric` for the lifetime · `multi_select` for which fusion reactions occur at a stated stage · `true_false` for the mass-lifetime claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | `M^−3` spans ten orders of magnitude across the mass range, so a lifetime is a LOGARITHMIC quantity and the card grades it as an ORDER — `multi_select` over lifetime bands — rather than as a value. A `rel` band on a quantity spanning ten decades is either vacuous or useless. **If a value is required the card fixes the mass to 1 sf and grades `rel: 0.1` on the decade.** |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A Hertzsprung-Russell diagram with the main sequence running diagonally and one star's evolutionary track drawn across it. The task is to name the stage the star is at and its total lifetime, and to say what it becomes. The alternative gives the star's mass and the Sun's mass, so the lifetime's order of magnitude is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A more massive star lives longer because it has more fuel. (2) All stars end as white dwarfs. (3) The Sun is currently on the main sequence because that is where stars are born. |

#### 4. `astronomy.light-distance` — Light, distance and parallax

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compute a parallax distance and say why a magnitude is not a distance. |
| Interaction | Change the baseline and the star's distance; the two viewing positions and the parallax angle draw; type the distance and the apparent magnitude. |
| Model | `d(pc) = 1/p(arcsec)` is the small-angle approximation, and the sim computes the parallax angle as `atan(b/d)` rather than `b/d` — the difference is 5×10⁻⁹ at realistic distances, which is small, and the card says which is used so a student using either is credited. The APPARENT MAGNITUDE is a logarithmic flux ratio and is reported separately from the distance, because the row's focus names 'redshift, magnitude' and conflating brightness with distance is the misconception. |
| Answer | `{ distance: number, parallax: number, magnitude: number, flux: number }` — pc, arcsec, mag. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for whether a given value is brighter or further · `true_false` for the brightness-is-distance claim · `ordering` for stars by distance from their parallaxes, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `1/p` is a reciprocal, so a 0.01 arcsec parallax error is a 1% distance error but a 0.001 arcsec error on a 0.1 arcsec parallax is 1%. The banding therefore DEPENDS on the parallax, which is why the card requires `rel: 0.01` (T-C) and forbids an absolute floor: `abs: 0.01 pc` would accept every distance for a faint star. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | Two viewing positions on a baseline with a distant star and the two apparent positions marked, and the angle between them drawn. The task is to work out the star's distance from its parallax angle. The alternative gives the baseline length and the measured parallax angle in arcseconds. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A brighter star is a nearer star. (2) A larger parallax angle means a more distant star. (3) Apparent magnitude is a measure of distance. |

#### 5. `astronomy.black-holes` — Black holes

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute a Schwarzschild radius and say what tidal forces do to an infalling body. |
| Interaction | Change the mass and the infall radius; the horizon and the tidal stretching render; type the radius and the tidal acceleration. |
| Model | `r_s = 2GM/c²` with `c = 3×10⁸`, and the TIDAL acceleration is the gradient of the field `GM/r²` — so the sim differentiates the field rather than comparing two point accelerations, because the gradient and the difference are different quantities and the row's focus names 'tidal effects' specifically. The card requires the answer to report WHICH quantity is asked for, because the Schwarzschild radius and the tidal radius scale differently with mass. |
| Answer | `{ schwarzschild: number, tidalAcceleration: number, horizonTime: number }` — metres, m/s², seconds. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the tidal claim · `single_choice` for what happens at the horizon · `ordering` for what a falling observer sees, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `2GM/c²` is linear in mass and `c² = 9×10¹⁶`, so the answer is around 3000 m per solar mass — small, and a student who forgets the factor of 2 gets 1500 m, which no tolerance should hide. `rel: 0.01, abs: 1 m`, with `G` and `c` stated on the card because both are rounded. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A sphere drawn with a horizon marked and an infalling body stretching along the field lines. The task is to report the radius of the horizon, the tidal acceleration across the body and the time to reach the horizon. The alternative gives the mass, the body's size and its mass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The Schwarzschild radius is the same for stars of the same mass but different size. (2) Tidal forces are weak near a black hole because its gravity is strong. (3) An infalling observer notices nothing special at the horizon. |

#### 6. `astronomy.exoplanets` — Exoplanet detection

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can work out a planet's radius from a transit and its mass from a radial velocity, and say which method finds what. |
| Interaction | Set the planet's radius and orbit; the transit light curve and the radial-velocity curve plot; type the radius, the mass and the detection method. |
| Model | **Two independent models with different observables, not one model with a method flag.** Transit depth is `(R_p/R_*)²` and the curve is generated by a declared limb-darkening law, so a student reading the depth gets the radius. Radial velocity is `K = (m_p sin i)·(2πG/P)^(1/3)·M_*^(−2/3)·(1/√(1−e²))` and the SIMPLIFICATION is deliberate: the sim has no inclination for a transit method and says so, because 'sin i' is the row's focus ('transit depth, radial velocity, both methods') and an unspecified inclination would silently assume edge-on. |
| Answer | `{ radius: number, mass: number, semiMajorAxis: number, method: 'transit'\|'radial-velocity'\|'both' }` — Earth radii, Earth masses, AU. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the method that can find what · `multi_select` for what each method constrains · `true_false` for the inclination claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `(R_p/R_*)²` means a 1% error in the depth is a 0.5% error in the radius, and the depth is a square of a ratio of two numbers each of which is measured. `rel: 0.02` on the radius (T-C, no absolute floor — a planet smaller than Earth's radius must still be distinguishable). The mass from radial velocity is linear in K, so `rel: 0.02` as well. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two plots: a light curve with a dip in it and a radial-velocity curve oscillating about zero. The task is to report the planet's radius, its mass and its orbital distance, and to say which method gave which measurement. The alternative gives the stellar radius, the stellar mass, the period and the depth and semi-amplitude. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The transit method measures a planet's mass. (2) A radial-velocity detection means the planet is edge-on. (3) A large transit depth means a large planet rather than a close one. |

#### 7. `astronomy.lunar-phases` — Lunar phases and eclipses

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work out the geometry of a phase and say what node angle an eclipse needs. |
| Interaction | Move the Sun, Earth and Moon; the shadow cone and the illuminated fraction draw; type the phase, the illuminated fraction and whether an eclipse occurs. |
| Model | The illuminated fraction is computed from the Sun-Earth-Moon GEOMETRY — `f = (1 + cos α)/2` with `α` the phase angle — and not from a phase-lookup table, because the row's focus names 'geometry of phases, eclipse conditions, node angles' and a table cannot answer the eclipse question. Whether an eclipse occurs is a NODE-ANGLE test: `\|β\| < \|node tolerance\|`, which is a declared threshold rather than a boolean somebody typed. |
| Answer | `{ phase: string, illuminated: number, eclipse: boolean, nodeAngle: number }` — fraction to 3 dp, angle in degrees. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the phase · `numeric` ×2 · `true_false` for the node claim · `multi_select` for which alignments can produce an eclipse · `ordering` for the phases in a synodic month, order-sensitive. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A diagram of the Sun, Earth and Moon with the shadow cone drawn and the visible lit portion of the Moon shown. The task is to name the phase, state how much of the Moon is lit and say whether an eclipse is possible at this geometry. The alternative gives the three bodies' positions and the node angle. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The Moon is shadowed by the Earth at the new moon. (2) A crescent is the same shape at every point in its cycle. (3) An eclipse needs only the right phase, not a near-alignment of the orbital nodes. |

#### 8. `astronomy.tides` — Tides

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say why spring tides coincide with the new and full moons, and what resonance does. |
| Interaction | Change the lunar phase and the basin's dimensions; the tide curve plots; type the range and the period. |
| Model | The tide is computed as a HARMONIC SUM — the M2 and S2 constituents — so the spring/neap beat emerges from the interference of two periods rather than from a rule, which is what makes the row's focus ('spring/neap tides, resonance, basin shape') answerable. The basin's natural period is a declared parameter and the sim REPORTS when it is near M2 — because a resonant basin has a tide far larger than its forcing and a sim that could not produce one would teach that tides are always small. |
| Answer | `{ range: number, period: number, resonant: boolean, amplification: number }` — metres, hours. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the spring-tide claim · `single_choice` for which phase gives the largest range · `ordering` for the tide events through a month, order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The beat period between M2 (12.42 h) and S2 (12.00 h) is 14.77 days and comes from a DIFFERENCE of two close numbers, so it is poorly conditioned. **The card requires the constituents to 3 dp and states the beat period rather than expecting the student to derive it** — a student computing `1/(1/12.42 − 1/12.00)` from 2-dp inputs gets 14.6 days, which is a rounding disagreement and not an error. `rel: 0.05`. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A coastline with a tide curve plotting water height against time for a month, with the spring and neap tides marked. The task is to report the tidal range, the period of the semidiurnal tide and whether the basin is resonant. The alternative gives the basin's dimensions and its natural period. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Spring tides happen at the quarter moons. (2) Tides are caused by the Sun alone. (3) The Moon's phase changes the tide's period. |

#### 9. `astronomy.moon-craters` — Crater counting

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say that more craters means an older surface, and use a cratering rate to date one. |
| Interaction | Choose the cratering rate and the elapsed time; the surface fills with craters; type the expected crater count and the relative age. |
| Model | The crater FIELD is generated by a seeded Poisson process at the DECLARED cratering rate over the DECLARED elapsed time, and the count is the number of craters drawn. Two surfaces with different ages are drawn from the SAME process so the comparison is like-for-like — which is what makes the row's focus ('counting → relative age; cratering rate') answerable, and a sim with two hand-drawn surfaces of different densities teaches nothing. |
| Answer | `{ expectedCraters: number, relativeAge: string, sizeDistribution: string }` — a COUNT and a size-frequency slope. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the relative age · `ordering` for surfaces by age, which is order-sensitive and is the actual reasoning · `single_choice` for the size-frequency slope's meaning. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | A crater COUNT is exactly predicted by the model, so the expected count is EXACTLY graded (T-A) and the realistic variation is a stated band: `abs: 0.15 × expected`, which is a poisson band and is NOT a student-error band. **The card must label it as a model band**, because a reviewer reading a 15% band on an integer answer will otherwise read it as sloppy. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two cratered surfaces shown side by side with crater counts listed and a size-frequency diagram. The task is to say which surface is older and to predict the number of craters after a stated time at a stated rate. The alternative gives both crater counts, both sizes and the cratering rate. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) More craters means a younger surface. (2) All cratering rates are the same across the solar system. (3) A crater count can give an absolute age without a rate. |

#### 10. `astronomy.solar-activity` — Solar activity

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence the solar cycle's phases and say what a prominence is doing to the field. |
| Interaction | Scrub through the cycle; the sunspot number and the field draw; enter the phases in order and the field strength. |
| Model | The cycle is a DECLARED periodic function with an eleven-year period, and the sunspot NUMBER is a real sunspot number formed by weighting each group's spot count by its area — the weighting is the row's focus ('sunspot cycle, prominences, solar wind') and a sim that counted spots equally would produce the wrong shape. |
| Answer | `{ phases: string[], sunspotNumber: number, fieldStrength: number, windSpeed: number }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the cycle phases, order-sensitive · `numeric` ×3 · `single_choice` for what a prominence is · `true_false` for the cycle-length claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A disc with sunspots drawn at different latitudes, and a graph of the sunspot number against time over one cycle. The task is to put the cycle's phases in order and to report the sunspot number at a stated point. The alternative gives the cycle period and the number of spot groups with their areas. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The sunspot cycle is 22 years long. (2) Sunspots appear at the poles. (3) Solar activity is constant through a cycle. |

#### 11. `astronomy.coordinates` — Constellations and coordinates

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can convert between RA/Dec and altitude/azimuth and find a star by hand. |
| Interaction | Set the time, the latitude and the longitude; the celestial sphere rotates; type the altitude and the azimuth. |
| Model | The conversion is spherical trigonometry with the LOCAL SIDEREAL TIME derived from the date, the longitude and the time — and the card requires the sidereal time to be reported, because `24 h` of solar time is not `24 h` of sidereal time and a student who treats them as equal is wrong by about four minutes a day. Declination and right ascension are stored as declared coordinates and the rendering is derived from them, never the reverse. |
| Answer | `{ altitude: number, azimuth: number, siderealTime: number, dec: number, ra: string }` — degrees and hours. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `short_text` for the RA in hours-minutes-seconds · `single_choice` for which constellation · `true_false` for the sidereal-time claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | Spherical-trigonometric chains of four or five operations compound the input errors, and RA in HOURS and DEC in DEGREES are two different units for a conversion the student must do. `abs: 0.5°` on the altitude and azimuth (T-B — a relative band on an angle is meaningless) and the card states both units explicitly. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A horizon-coordinate grid with a star marked at its altitude and azimuth, and a star chart. The task is to report a star's altitude and azimuth at a stated time and place. The alternative gives the star's right ascension and declination, the date, the time, the latitude and the longitude. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Right ascension and hour angle are the same quantity. (2) A star transits at the same clock time every night. (3) Altitude can be read from the declination alone. |

#### 12. `astronomy.signal-in-noise` — Signal detection in noise

| Field | Value |
|---|---|
| Subject · band · age | `astronomy` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can work out how long a search must be to see a signal, and say what a false positive is. |
| Interaction | Set the signal strength and the noise; the spectrum plots with a threshold; type the detection threshold and the number of false positives expected. |
| Model | **The false-positive count is COMPUTED, not asserted.** `N_FP = M·exp(−T²/2σ²)` for M independent frequency bins above a threshold `T`, so the row's focus ('SNR, false positives, why SETI is hard') is a number the student computes rather than a claim they accept — and the sim reports M and σ so the answer is re-derivable. |
| Answer | `{ snr: number, threshold: number, falsePositives: number, integrationTime: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `true_false` for the false-positive claim · `single_choice` for the threshold that gives one false positive · `ordering` for the false-alarm rate against search time, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `exp(−T²/2σ²)` at T = 5σ is `1.5×10⁻⁶`, so the false-positive count is a product of a small number and a large bin count and the answer can straddle 1. **A relative tolerance is meaningless on a COUNT that may be 0.001 or 1000**, so the card requires `abs` in false positives and `rel` on the SNR and the threshold (T-D), and the rationale prints the raw expected count to more digits than the answer so a student is not confused by 0.003 rounding to 0. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A spectrum with a broad noise background and one narrow peak, with the detection threshold drawn as a horizontal line. The task is to report the signal-to-noise ratio, the threshold, the expected number of false positives and how long the observation must last. The alternative gives the signal strength, the noise level, the number of frequency bins and the integration time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A larger integration time always reveals a weaker signal. (2) The threshold can be raised until the false positives are zero. (3) One narrow peak in a spectrum is a detection. |

#### 13. `biology.cell-division` — Mitosis and meiosis

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence the stages of mitosis and say what meiosis does that mitosis does not. |
| Interaction | Step through the stages with the stepper; the chromosome diagram and the ploidy label update; enter the stage sequence in order. |
| Model | **Discrete state machine, stepper, sequence grading** (`plans/10` §10) — and the grading is `orderMatch`, never `setMatch`. `grading.ts:311-326` states why: reusing the set matcher on a sequencing task would mark a completely reversed sequence as a perfect score, which is the exact inversion of the mistake the set matcher exists to prevent. Credit is per POSITION over `max(expected, given)` (`grading.ts:355-379`), so a student who has the right six stages in the wrong order scores on the pairs that happen to land. |
| Answer | `{ mitosis: string[], meiosis: string[], ploidyDaughter: number, crossingOver: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for each sequence, which is the whole question · `numeric` for the ploidy · `multi_select` for which stages involve chromosome duplication · `true_false` for the crossing-over claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | **This is the sim the ordering-vs-set distinction is built on, so the card must state that the answer is graded as a SEQUENCE.** A card that says 'grade the stage names' without saying 'in this order' will produce a set matcher and a reversed sequence will score 4/4. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A cell drawn at one stage of division, with chromosomes drawn as X shapes and centromeres marked, and the ploidy and chromatid counts written beside it. The task is to put the stages in order and to state what meiosis produces that mitosis does not. The alternative gives the stage names as a numbered list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Mitosis produces gametes. (2) The chromosome count is halved in mitosis. (3) Crossing over happens between sister chromatids rather than between non-sister chromatids of a homologous pair. |

#### 14. `biology.genetics-punnett` — Punnett squares

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can complete a Punnett square and read the ratio a genotype maps to. |
| Interaction | Enter the parental genotypes; the square fills; enter the offspring genotypes and the phenotypic ratio. |
| Model | `caseSensitive: true` is MANDATORY here and the codebase says why: `grading.ts:260-263` records that folding case unconditionally compared one phenotype against the other and marked the recessive answer correct. The genotypes are enumerated from the gamete sets, and the ratio is computed from the CELL COUNTS rather than authored — so a monohybrid gives 3:1 and a codominant cross gives 1:2:1 without the sim knowing which case it is in. |
| Answer | `{ offspring: string[], ratio: string }` — genotypes as strings, case preserved. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the offspring genotypes · `short_text` with `EXACT` for the ratio · `single_choice` for the phenotype of a named genotype · `true_false` for codominance. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A Punnett square grid with the parental genotypes along the top and side, and the cells to be filled in. The task is to complete the square, list the offspring genotypes and state the ratio. The alternative gives both parents' genotypes in text and the question as a ratio to state. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The Punnett square's cells are all the same genotype. (2) A 3:1 phenotypic ratio in the square means 75% of the children have the dominant phenotype in any family. (3) A codominant cross produces a 1:2:1 phenotype ratio. |

#### 15. `biology.ecosystem-flow` — Ecosystem energy and matter flow

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can account for energy through a food web and say where matter goes round in circles. |
| Interaction | Build a web of trophic links; the Sankey-style flows redraw with the percentages on each; write what a named disruption does. |
| Model | **Sankey-style diagram with mass-balance invariants, and the invariants are asserted on every redraw** (`plans/10` §10). The total energy leaving a level equals the sum entering it, and matter's total is conserved separately — the row's focus names 'trophic transfers, cycles, disruption cascades', and a cascade cannot be traced through a diagram whose totals do not balance. The sim therefore refuses to draw a link that would break an invariant. |
| Answer | `{ transferEfficiencies: number[], cycleMatterBalanced: boolean, cascade: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` for the transfer efficiencies · `multi_select` for the matter cycle members · `ordering` for the cascade sequence, which is order-sensitive and is the reasoning question · `free_response` for the written account. **MANUAL is mandatory** for the cascade (`readAward`, `grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A food web with a band across it for each trophic level and a number on every arrow giving the energy passed on. The task is to report the transfer efficiency between two named levels and to describe what a named species' removal does to the rest of the web. The alternative gives the web as a list of who-eats-what and the starting biomass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Energy cycles round an ecosystem as matter does. (2) The 10% rule is a law. (3) Matter is lost from the cycle as waste leaves it. |

#### 16. `biology.cell-membrane` — Membrane transport

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which transport moves a substance down its gradient and what the other two cost. |
| Interaction | Set the concentrations and choose the channel and pumps; the membrane and the particle counts draw; enter which process moved it and what it cost. |
| Model | Facilitated diffusion, osmosis and active transport are THREE separate models with their own rate equations, not one diffusion equation with a direction flag — the row's focus names 'diffusion, osmosis, active transport, ATP cost' and the ATP cost is a quantity, so a model that cannot produce a number for it is not modelling it. Particle counts are driven by the rate equations and the counts are the observable the question grades. |
| Answer | `{ process: 'diffusion'\|'facilitated'\|'osmosis'\|'active', atpUsed: number, rateAtEquilibrium: number }` — ATP in moles or molecules per unit time, declared. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the process · `numeric` ×2 · `multi_select` for which processes need energy · `ordering` for the sequence from high to low concentration, which is order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | The ATP cost is a ratio of stoichiometry, so an integer count is exact and EXACT grading is right (T-A/T-F). If the card instead asks for a RATE, the rate is a function of concentration differences and needs `rel: 0.02`. **The card must say which of the two it asks for**, because the two need opposite instruments. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A cell membrane drawn with particles on both sides and arrowed channels through it, with the concentration on each side written. The task is to identify which process moved the substance and to report the energy it cost. The alternative gives the two concentrations, the particle sizes and the temperature. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Osmosis is the movement of solute. (2) Active transport moves a substance down its gradient. (3) Facilitated diffusion needs ATP. |

#### 17. `biology.enzyme-kinetics` — Enzyme kinetics

| Field | Value |
|---|---|
| Subject · band · age | `biology` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can read Km and Vmax off a rate plot and say what a competitive inhibitor does to each. |
| Interaction | Change substrate concentration, temperature, pH and inhibitor type; the Michaelis-Menten curves plot; type the rate at a stated concentration, Km and Vmax. |
| Model | `v = Vmax[S]/(Km + [S])` is evaluated from declared Km and Vmax and the inhibitor models are the standard competitive (`Km' = Km(1+[I]/Ki)`, `Vmax` unchanged) and non-competitive (`Vmax' = Vmax/(1+[I]/Ki)`) forms. **The competitive/non-competitive distinction is a claim about WHICH parameter moves, so the sim plots both curves and reports both parameters** — the row's focus names it and a sim that only showed the curves without the parameter readout would not address it. |
| Answer | `{ v: number, km: number, vmax: number, inhibitedKm: number\|null, inhibitedVmax: number\|null }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×5 · `single_choice` for the inhibition type · `true_false` for the 'competitive inhibition lowers Vmax' claim · `ordering` for the sequence of inhibitor binding, the reasoning question. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The half-maximum is found by solving `v = Vmax/2`, which gives `Km` EXACTLY and analytically — so **Km is an exact quantity and the card grades it with EXACT on the declared precision**, while a rate read off the curve is not. That is two different tolerance classes on one card and the card states which applies to which field. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A family of rate-against-substrate-concentration curves, one per inhibitor condition, with the half-maximum marked on each. The task is to report the rate at a stated substrate concentration, and the value of Km and Vmax with and without the inhibitor. The alternative gives the substrate concentrations and both parameter sets in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A competitive inhibitor increases Vmax. (2) Km is the substrate concentration at which the reaction reaches Vmax. (3) An enzyme denatures at the temperature of maximum activity. |

#### 18. `biology.photosynthesis` — Photosynthesis

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which factor limits the rate and what happens at a compensation point. |
| Interaction | Change light intensity, CO₂ concentration and temperature; the rate plots; type the limiting factor and the rate at the compensation point. |
| Model | The rate is the MINIMUM of three separate saturating functions — light-limited, CO₂-limited and temperature-limited — rather than a product of three terms. The minimum is the honest model of a limiting factor and the row's focus names 'light vs limiting factors, ATP/NADPH, compensation points' explicitly; a multiplicative model would make every combination limiting at once and would not have a compensation point at all. |
| Answer | `{ rate: number, limitingFactor: string, compensationPoint: number\|null }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the limiting factor · `true_false` for the compensation-point claims. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The compensation point is a ROOT of `P - R = 0`, so it is irrational and solver-dependent. `rel: 0.01, abs: 0.5` in the light-intensity unit, and the solver's residual goes in the answer key. The rate itself is a minimum of rational functions: `rel: 0.02`. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of photosynthetic rate against light intensity with three separate curves for different carbon dioxide concentrations and temperatures. The task is to report the rate at a stated light intensity, to name the limiting factor there, and to state the light intensity at which the plant neither gains nor loses carbon. The alternative gives the three curves' saturation points. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Increasing light always increases the rate. (2) Light and dark reactions happen at the same time in the same place. (3) The compensation point is where photosynthesis equals respiration in total, not at all. |

#### 19. `biology.respiration` — Cellular respiration

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence glycolysis through to the electron transport chain and say where the ATP comes from. |
| Interaction | Step the stages; the pathway diagram and the ATP tally update; enter the stages in order and the ATP yield. |
| Model | The pathway is a discrete state machine over STAGES and the ATP tally accumulates from substrate-level phosphorylation at glycolysis and Krebs plus a declared oxidative-phosphorylation yield at the ETC. The stage order is the graded answer and `orderMatch` is the instrument (`grading.ts:311-326`). |
| Answer | `{ stages: string[], atpTotal: number, substrateLevel: number, oxidative: number, oxygenRequired: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the stage sequence · `numeric` ×3 · `true_false` for the oxygen claim · `multi_select` for which stages occur in the cytoplasm. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A pathway diagram with the stages in sequence and the ATP produced at each stage marked. The task is to put the stages in order and to report the total ATP, splitting it between substrate-level and oxidative phosphorylation. The alternative gives the stages as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Most ATP comes from Krebs rather than from the electron transport chain. (2) Glycolysis needs oxygen. (3) The Krebs cycle is the same as the electron transport chain. |

#### 20. `biology.population-dynamics` — Population dynamics

| Field | Value |
|---|---|
| Subject · band · age | `biology` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can fit a logistic curve and say what carrying capacity does to the harvest rate. |
| Interaction | Change birth rate, death rate and carrying capacity; the population plots with both curves; type the growth rate and the sustainable harvest. |
| Model | Exponential and logistic are two SEPARATE models rather than one with a capacity flag, because the row's focus names the contrast and a sim with a flag would not let a student see the exponential curve as the `K → ∞` limit. The harvest rate is the SUSTAINABLE YIELD `rK/4`, computed from the fitted parameters and reported, because 'maximum sustainable yield' is the claim the row is about. |
| Answer | `{ growthRate: number, carryingCapacity: number, maxSustainableYield: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the phase of growth · `true_false` for the exponential-then-logistic claim · `ordering` for which population size gives the fastest growth. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `rK/4` is a maximum of a quadratic, so the parameters propagate with the worst-case sensitivity at `K/2`. `rel: 0.01, abs: 1` individual. **A student who fits their own `r` and `K` from the curve has an answer that differs from the declared ones by more than any tolerance can fairly allow** — so the card requires `r` and `K` to be declared parameters rather than quantities the student estimates. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of population size against time showing an S-shaped curve with its exponential phase and a tangent line drawn at the steepest point. The task is to report the intrinsic growth rate, the carrying capacity and the maximum sustainable harvest. The alternative gives the birth and death rates and the carrying capacity. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Exponential growth continues indefinitely. (2) The carrying capacity is the population's birth rate. (3) Maximum sustainable yield is half the carrying capacity. |

#### 21. `biology.natural-selection` — Natural selection

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can explain selection on a heritable trait and say what drift does differently. |
| Interaction | Run populations with a declared selection pressure and a declared drift seed; the allele-frequency chart plots; write the account. |
| Model | **Allele frequencies are simulated from a SEEDED random walk with a selection term, and the drift seed is in the state** — so the same paper can be re-run, which is what makes a comparison between selection and drift reproducible. The rubric bands are in the card, and the sim does not judge the written account. |
| Answer | `{ finalFrequency: number, generation: number, account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 · `free_response` for the account, carrying the rubric · `true_false` for the selection-vs-drift claim. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`) would report `GRADED: 0`. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A chart of allele frequency against generation for several populations, some under selection and some not. The task is to report the final frequency in a named population and to explain the difference between the two curves. The alternative gives the starting frequency, the selection coefficient, the population size and the seed. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Natural selection acts on individuals rather than on alleles. (2) An allele becomes fixed because it is better adapted. (3) Drift is a form of selection with a small population. |

#### 22. `biology.evolution-trees` — Phylogenetic trees

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read a cladogram and say which characters are shared derived and which are ancestral. |
| Interaction | Build a tree by grouping organisms; the tree redraws; enter the grouping and the shared characters. |
| Model | The tree is built from a MATRIX of character states by a declared clustering rule, and the derived characters are computed by outgroup comparison — so 'shared derived' is a result of the sim's own character matrix rather than a label the student is asked to memorise. The row's focus names 'cladistics, shared derived characters, reading trees' and the matrix is what makes all three addressable. |
| Answer | `{ grouping: string[], sharedDerived: string[], mostRecentCommonAncestor: string }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the correct grouping · `multi_select` for the shared derived characters · `single_choice` for the common ancestor · `ordering` for the nodes from root to tip, which is order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A branching tree with each organism at a tip and characters marked on the branches. The task is to say which organisms form a clade and which characters are shared and derived. The alternative gives the character matrix as a table, so the grouping can be worked out without seeing the tree. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Organisms at the tips are 'more evolved'. (2) A clade is any group of organisms. (3) A shared ancestral character groups species. |

#### 23. `biology.human-circulation` — Circulatory system

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can trace the circuit and say what changes vessel radius and heart rate do to pressure. |
| Interaction | Change vessel radius and heart rate; the pressure trace draws; type the pressure at a named point and the effect of exercise. |
| Model | Pressure is propagated along the circuit by a DECLARED resistance network with the vessel-radius term `∝ 1/r⁴` as a parameter the student controls, so the radius's fourth-power effect is a property of the model rather than a fact in a caption. The circuit is drawn so the path is legible. |
| Answer | `{ pressure: number, flow: number, resistance: number }` — mmHg and mL/s to 2 sf. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which vessel · `ordering` for the circuit path from ventricle to ventricle, which is order-sensitive and the reasoning question · `true_false` for the exercise response. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `1/r⁴` means a 10% error in the radius is a 46% error in the resistance. **This is the strongest error-propagation case in the biology set and the card requires the radius to be entered to 3 sf** — a 2-sf radius makes the answer meaningless and no tolerance can rescue it. `rel: 0.05` on the resistance and `abs: 2 mmHg` on the pressure. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A schematic of the double circulation with the heart, lungs and body as boxes and arrows between them, and a pressure trace along the circuit. The task is to report the pressure at a named point and the resistance of a vessel of a stated radius. The alternative gives the radii, the heart rate and the stroke volume. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Arteries always carry oxygenated blood. (2) Halving a vessel's radius halves the resistance. (3) The heart pumps blood to the lungs and the body in one circuit. |

#### 24. `biology.breathing` — Gas exchange and breathing

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can explain how ventilation moves air and say what the partial pressures drive. |
| Interaction | Change lung volume and the partial pressures; the pressure and volume traces plot against time; type the lung volumes and the direction of flow. |
| Model | The traces are generated from Boyle's law on DECLARED lung volumes — the pressure-volume loop of one breath is computed, not sketched — so the tidal volume and the residual volume the question asks for are the same quantities the trace shows. Partial pressures drive the gas exchange on a separate declared grid. |
| Answer | `{ tidalVolume: number, vitalCapacity: number, residualVolume: number, flowDirection: 'in'\|'out' }` — cm³. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the direction of flow · `ordering` for the sequence of a breath, which is order-sensitive · `true_false` for the partial-pressure claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | Lung volumes are tabulated averages with a wide individual spread, so `rel: 0.1, abs: 100 cm³` is the honest band and a reviewer must read it as a biological-variability band rather than a loose one. **A student with a realistic larger lung volume is not wrong**, and a tight tolerance would penalise the physiology. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A pressure-volume loop against time with the tidal breathing trace drawn inside it, and the alveolar partial pressures beside it. The task is to report the tidal, vital and residual volumes and to say which way air flows at a named point in the cycle. The alternative gives the lung volumes and the atmospheric and alveolar pressures. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Air is drawn into the lungs because of its oxygen content. (2) Inhalation is active and exhalation is always passive. (3) Residual volume is the volume that can be breathed out. |

#### 25. `biology.action-potential` — Action potentials

| Field | Value |
|---|---|
| Subject · band · age | `biology` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say what makes an action potential all-or-none, and what the refractory period is for. |
| Interaction | Change the stimulus strength and the refractory period; the membrane potential traces plot against time; type the peak potential, the threshold and the refractory duration. |
| Model | The action potential is generated by a declared gating model with a THRESHOLD and a refractory window, and the model's refractory period is what prevents a second spike inside it — so the row's focus ('threshold, refractory period, conduction, synapses') is modelled rather than narrated. Stimulus strength below threshold produces nothing at all, which is the all-or-none property the question asks about. |
| Answer | `{ peak: number, threshold: number, refractoryMs: number, fired: boolean }` — mV and ms. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the all-or-none and refractory claims · `single_choice` for 'does a stronger stimulus give a bigger spike' · `ordering` for the sequence of ion channel events, the reasoning question. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The peak is a model constant, so it is EXACTLY graded (T-A) and the threshold likewise. The refractory duration is a model time and is exact. **This is a card where almost everything is exact and only the graded potentials are not** — the card must say so, because a student asked for 'the peak' to 1 dp against a model constant of 30.0 gets 4/4 and one asked for 'the graded potential at 2 mV' needs a tolerance. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A membrane potential trace against time for two stimuli, one below threshold showing nothing and one above showing the full spike, with the refractory period marked. The task is to report the peak potential, the threshold and how long the refractory period lasts. The alternative gives the ion concentrations and the channel parameters. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A stronger stimulus produces a larger action potential. (2) The refractory period exists to prevent the ion channels opening. (3) The resting potential is zero. |

#### 26. `biology.kidney-filter` — Kidney filtration

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compute a filtration rate from pressures and say which substances are reabsorbed. |
| Interaction | Change the blood pressure and the three pressures at the glomerulus; the nephron diagram and the filtrate volumes update; type the filtration rate and the reabsorbed volumes. |
| Model | Filtration rate is `K_f × (P_gc − P_bs − π_gc)` with the three pressures as SEPARATE parameters, so the student can see which one opposes and which one drives — the row's focus names 'glomerular filtration, reabsorption, concentration' and the direction of each pressure is the misconception. Reabsorption is computed as a declared fractional reabsorption per substance, applied to the filtrate volume rather than authored. |
| Answer | `{ filtrationRate: number, reabsorbed: Record<string, number>, concentratedUrine: number\|null }` — mL/min. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `multi_select` for which substances are reabsorbed · `single_choice` for which pressure opposes filtration · `ordering` for the nephron path, which is order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | `K_f × ΔP` is a product, so the errors add in quadrature. `rel: 0.03, abs: 1 mL/min`. **A student who uses a kidney K_f of 12.5 against the card's 12.3 differs by 1.6%** — the card states K_f explicitly for exactly this reason, and the band is sized to the constant's ambiguity. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A nephron drawn with the glomerulus and the three pressures labelled at it, and a table of substance against filtrate concentration and reabsorbed volume. The task is to report the filtration rate and the volume of a named substance reabsorbed. The alternative gives the three pressures, the filtration coefficient and the plasma concentrations. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Filtration is driven by hydrostatic pressure alone. (2) Protein is reabsorbed like glucose. (3) Filtration rate is the same as urine output. |

#### 27. `biology.digestion` — Digestion and absorption

| Field | Value |
|---|---|
| Subject · band · age | `biology` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can put the digestive enzymes in the right place and say what each one breaks down. |
| Interaction | Place enzymes along the alimentary canal; the products update; enter the sequence and the substrate for each enzyme. |
| Model | The tract is a ORDERED chain and the grading is `orderMatch`. Each enzyme is a DECLARED substrate→product mapping with its optimum, and the products of the chain are computed from the substrate the student placed — so a student who puts amylase in the stomach sees the starch unchanged, which is the row's focus ('enzymes, villi, products, energy from food') rather than a caption. |
| Answer | `{ sequence: string[], products: Record<string, string>, energyKJ: number }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the tract sequence and the enzyme placement, both order-sensitive · `multi_select` for the substrates · `numeric` for the energy released · `true_false` for the pH claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — AVAILABLE — the enzyme PLACEMENT is the claim and only the trace shows where along the tract it was placed. |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A diagram of the alimentary canal with a slot at each stop for an enzyme and the pH at that stop written beside it. The task is to place the enzymes and to state what each breaks down. The alternative gives the tract as a list of regions in order with the pH at each. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Protease breaks down starch. (2) Bile is an enzyme. (3) Absorption happens in the stomach. |

#### 28. `biology.plant-transport` — Plant transport

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can explain how water gets to the top of a tall tree and say how sugar is moved. |
| Interaction | Change transpiration, the light and the temperature; the tension and the flow rate plot; type the flow rate and the pressure at the top. |
| Model | **Cohesion-tension is modelled as a tension propagating along a column of DECLARED tube radius, and the sim reports the tension at the top rather than drawing it** — because 'there is negative pressure at the top' is the counter-intuitive claim the row's focus names, and a diagram of a stretched rope is a bad picture of it. Phloem loading is a separate flow with its own parameters, because sucrose transport is not a pressure-flow consequence of transpiration. |
| Answer | `{ tension: number, transpirationRate: number, phloemFlow: number }` — kPa and mol/m/s. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for what happens when a leaf is removed · `true_false` for the cohesion and the source-sink claims · `ordering` for the path of water, which is order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Tension scales with height and with `1/r⁴`, so both errors propagate hard. `rel: 0.05, abs: 1 kPa` and the card requires the height and tube radius to 2 sf in the given data. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plant drawn with a water-potential gradient down a stem and a flow arrow in the phloem. The task is to report the tension at the top of the stem, the transpiration rate, and the sugar flow rate. The alternative gives the tree height, the leaf area, the tube radius and the temperature. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Water is pushed up the xylem by the roots. (2) The phloem's flow is the same as the xylem's. (3) Transpiration is the only way water leaves a leaf. |

#### 29. `biology.photosynthesis-limits` — Limiting factors

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which factor is limiting from the shape of a graph, and what happens when you change it. |
| Interaction | Run the classic three-factor experiment; each rate-versus-light curve plots; type the limiting factor in each regime. |
| Model | Same minimum-of-saturating-functions model as `biology.photosynthesis`, and deliberately the SAME model: the row's focus is 'the classic three-limiting-factors experiment', which is the experiment `biology.photosynthesis` generalises, and two sims with two models would make a cross-reference between them a comparison of models rather than of content. **This duplication is deliberate and the reviewer should confirm it rather than flag it.** |
| Answer | `{ rate: number, limitingFactor: string, plateauRate: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the limiting factor in each named regime · `true_false` for the 'two factors at once' claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A set of rate-against-light-intensity curves, one for each carbon dioxide concentration and each temperature, with plateaus marked. The task is to say which factor is limiting in each curve and to report the plateau rate. The alternative gives the curves' plateau values and the conditions that produced them. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Two factors can be limiting at once. (2) The plateau is the maximum the plant could ever reach. (3) Increasing a non-limiting factor changes the rate. |

#### 30. `biology.immunology` — Immune response

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence innate and adaptive responses and say what clonal selection produces. |
| Interaction | Introduce a pathogen; the response timeline runs; enter the sequence of cell types and what each produces. |
| Model | The response is a discrete state machine over CELL TYPES with an ORDERING answer, and the row's focus ('innate vs adaptive, clonal selection, memory cells') means the set of cells involved and their ORDER are separate graded facts — so the card carries both a `SET` for the cells and an `ORDER` for the sequence, using different fields. |
| Answer | `{ cells: string[], sequence: string[], memoryProduced: boolean, antibodies: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the cells of each response · `ordering` for the sequence, order-sensitive · `short_text` with `EXACT` for an antibody class · `true_false` for the memory-cell claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A timeline of an infection showing the response events in order, with each event labelled with the cell type involved. The task is to put the events in order and to say which cells are involved in each part of the response. The alternative gives the events as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Antibodies are produced by B cells rather than by T cells. (2) Innate immunity is specific and adaptive is not. (3) Memory cells are the same as the original B cells. |

#### 31. `biology.microbiology` — Bacterial growth

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can plot a growth curve and explain each phase, and do a serial dilution correctly. |
| Interaction | Change the temperature and the substrate; the log-phase curve plots; type the generation time and the dilution factor. |
| Model | The growth curve is a FOUR-PHASE model (lag, log, stationary, decline) with the lag phase as a declared delay, because the row's focus names 'exponential growth, stationary phase, serial dilution' and the stationary phase exists because the substrate ran out. The serial dilution factor is `10^n` computed from the number of stages, and the count is held steady ACROSS SEEDS for the same reason `chemistry.particle-view` holds its collision rate steady — a seeded value the question grades would be ungradeable. |
| Answer | `{ generationTime: number, stationaryAt: number\|null, dilutionFactor: number, countAfter: number\|null }` — minutes and cells per mL. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for the phase · `true_false` for the exponential-forever claim · `ordering` for the phases, which is order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Generation time is `log₂(ratio)`, so it carries the LOG's conditioning: at ratio 2 the relative error doubles the absolute error. `rel: 0.05` with `abs: 1 min`. The serial dilution factor is an exact power of ten (T-A) and a student who writes `10^-3` where the convention wants `1000` must be credited — **the card states the sign convention explicitly, because `10⁻³` is the dilution and `1000` is the factor.** |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of the logarithm of cell number against time showing four labelled phases, and a row of tubes at successive dilutions. The task is to report the generation time, when the stationary phase begins, and the factor by which each dilution step dilutes. The alternative gives the starting count, the temperature and the number of dilution stages. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A bacterial population grows exponentially forever. (2) Serial dilution is a way of growing more bacteria. (3) The stationary phase means the bacteria have stopped dividing permanently. |

#### 32. `biology.classification` — Classification

| Field | Value |
|---|---|
| Subject · band · age | `biology` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can place an organism in a hierarchy using a dichotomous key and write its binomial name. |
| Interaction | Choose features for a key; the key builds; follow it to identify a named organism; enter the binomial. |
| Model | The KEY is a real decision tree — each node is a feature with two branches — and the identification is a TRAVERSAL of it, so the route is a path through the tree and is graded with `orderMatch`. The binomial name is checked as a two-part string with the genus capitalised, and the card states the convention because `canis lupus` and `Canis lupus` are the same name and a naive string compare would mark half the class wrong. |
| Answer | `{ keyPath: string[], binomial: string, kingdom: string, phylum: string, class: string }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the key path, order-sensitive · `short_text` with `NORMALISED` for the binomial · `multi_select` for the hierarchy levels · `single_choice` for the identifying feature. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — AVAILABLE — the key path is the deduction and a set-match on the final organism cannot distinguish a lucky guess from a traversal. |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A branching identification key with a question at each fork and two branches. The task is to follow the key to identify the organism and to give its binomial name and its place in the hierarchy. The alternative gives the organism's features as a table, so the key can be applied on paper. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Common names are binomial names. (2) The largest group is the species. (3) A dichotomous key can be followed in either direction from the start. |

#### 33. `biology.ecology-sampling` — Ecological sampling

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can choose a sampling method and compute a density with an uncertainty. |
| Interaction | Choose a method and an area or a marked population; the samples draw and the estimate with error bars plots; type the density and the uncertainty. |
| Model | **The samples are drawn from a seeded stream and the estimate's UNCERTAINTY is computed from the actual sample variance**, not from a formula typed over the top — the row's focus names 'quadrats, transects, mark-recapture, error bars' and an error bar not derived from the drawn sample is a decoration. The four methods are SEPARATE models because they fail differently: quadrats need a random start, mark-recapture needs the marked animal to have mixed. |
| Answer | `{ density: number, uncertainty: number, method: string, sampleSize: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the method · `true_false` for the 'more samples always narrows it by half' claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The uncertainty is `s/√n`, so it is itself a statistical quantity and its band is about the ESTIMATE'S reliability, not the student's arithmetic. **The card must fix the seed** or two students get different correct densities; with `rel: 0.15` on the density to accommodate the sampling error, which is a real band and must be labelled as one on the card. |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A sampled area with quadrats marked, or a grid with marked and unmarked individuals. The task is to report the estimated density, the uncertainty on that estimate, and which sampling method was used. The alternative gives the area, the sample size and the marked and recaptured counts. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A transect gives the same estimate as a quadrat. (2) More samples always improve the estimate without limit. (3) Error bars show the range of the individual values. |

#### 34. `biology.inheritance-linkage` — Linkage and sex linkage

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work out a recombination frequency and say why linked genes do not assort independently. |
| Interaction | Enter the parental genotypes and the gene order; the test cross squares fill; enter the offspring ratios and the recombination frequency. |
| Model | **Gene ORDER is a parameter and the recombination frequency is computed from it**, not the other way round, because the row's focus names 'recombination, gene maps, crosses' and a gene map IS the answer. The test cross with a double recessive partner is what makes the gamete frequencies directly readable from the offspring ratios, and the sim uses it for that reason and says so. |
| Answer | `{ offspringRatios: string[], recombinationFrequency: number, geneOrder: string[], mapUnits: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the offspring ratios · `numeric` ×2 · `ordering` for the gene order, which is order-sensitive and is the answer · `true_false` for the independent-assortment claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A test-cross grid with the gametes along the top and side and the offspring ratios in the cells. The task is to state the offspring ratios, the recombination frequency and the order of the two genes on the chromosome. The alternative gives the parental genotypes and the observed offspring counts. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Genes on the same chromosome assort independently. (2) A recombination frequency above 50% means the genes are on different chromosomes. (3) Sex-linked genes are carried on the autosomes. |

#### 35. `biology.molecular-dna` — DNA structure and replication

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can explain semiconservative replication and say what a mutation does to the sequence. |
| Interaction | Step the replication; the strands separate and new bases pair; enter the stages in order and the sequence of a complementary strand. |
| Model | Replication is a discrete state machine and the graded order is `orderMatch`. The complementary strand is generated from the declared base-pairing RULE and is checked by base complement, not by string equality with a stored answer — so a student may write it 3'→5' or 5'→3' and the card must say which direction it wants, because those are the same molecule written two ways and a string compare marks half of them wrong. |
| Answer | `{ stages: string[], complement: string, direction: '3to5'\|'5to3', mutated: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the stages · `short_text` with `REGEX_SET` over the two directions · `multi_select` for the consequences of a substitution · `true_false` for the semiconservative claim. · `worked_solution` for the replication steps, one per stage with the base count. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A double helix drawn as two strands separating and new bases pairing to each template. The task is to put the stages in order and to write the complementary strand, giving the direction it is written in. The alternative gives one strand in full with its direction marked. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Each new molecule has one old and one new strand. (2) A mutation always changes the amino acid sequence. (3) The two strands of DNA run in the same direction. |

#### 36. `biology.gene-expression` — Gene expression

| Field | Value |
|---|---|
| Subject · band · age | `biology` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can sequence transcription to translation and say how regulation switches a gene off. |
| Interaction | Step the pathway; the mRNA, ribosome and polypeptide appear; enter the stages in order and what the regulator binds. |
| Model | The pathway is a discrete state machine graded with `orderMatch` on the STAGES, and the REGULATORY state is a separate boolean field rather than a stage — because 'transcription is off' is a state of the system and not a step in a sequence, and a sim that modelled it as a step would make the sequence wrong when the gene is off. |
| Answer | `{ stages: string[], regulatorBindingSite: string[], expressed: boolean, proteinPresent: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the stages · `multi_select` for the regulator's binding sites · `true_false` for the regulation and the codon claims · `single_choice` for what happens when the start codon mutates. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A pathway diagram with DNA, a nucleus, mRNA, a ribosome and a polypeptide arranged in sequence. The task is to put the stages in order and to state what the regulator binds to when the gene is off. The alternative gives the stages as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Regulation happens on the translated protein. (2) Every codon codes for an amino acid. (3) Transcription happens on the coding strand. |

#### 37. `biology.homeostasis` — Homeostasis

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can trace a negative feedback loop and say what happens when the set point is displaced. |
| Interaction | Displace a set point; the loop runs and the response traces plot; enter the loop in order and the direction of each response. |
| Model | The loop is a control-loop diagram (sensor → controller → effector → response) with a DECLARED gain and set point, and the traces come from the loop's own dynamics — so a gain of 1 oscillates and a gain above 1 diverges, which is the row's focus ('negative feedback, set points, disruption') and cannot be shown by a diagram with hard-coded arrows. |
| Answer | `{ sequence: string[], overshoot: number, settled: boolean, steadyStateError: number }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the loop, order-sensitive · `numeric` ×2 · `true_false` for the positive-feedback claim · `single_choice` for the gain that is stable. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A control-loop diagram with sensor, controller and effector boxes and arrows, and a graph of the measured quantity against time after a set-point displacement. The task is to put the loop in order, to report the overshoot and to say whether the system settles. The alternative gives the loop's boxes as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Negative feedback amplifies a disturbance. (2) The set point is the same as the current value. (3) Homeostasis means the internal conditions never change. |

#### 38. `biology.biomes` — Biomes and distribution

| Field | Value |
|---|---|
| Subject · band · age | `biology` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can identify a biome from a climate graph and say which two features decide it. |
| Interaction | Choose a climate graph; the biome is offered; type the biome and the two deciding features. |
| Model | The classification is from DECLARED temperature and precipitation bands with a named Köppen letter, and the graph is generated from monthly values rather than drawn — so a student reading the graph is reading the data the answer is keyed on. The row's focus names 'climate graphs → biome identification', which is a recognition task and is honestly a `single_choice`. |
| Answer | `{ biome: string, koppen: string, features: string[] }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `single_choice` is the PRIMARY type here, not `simulation` — a biome identification is a four-way choice and the sim's role is to supply the graph. `simulation` is the fallback when the question needs the student to read a curve they have themselves drawn. `multi_select` for the two deciding features. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A climate graph with a line for temperature and bars for rainfall through the year, and the axis scales marked. The task is to identify the biome the graph describes and to name the two features that decided it. The alternative gives the monthly temperature and rainfall values as a table, so the identification can be made from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Biome is determined by latitude alone. (2) Annual temperature is the deciding feature rather than the temperature and the precipitation together. (3) A climate graph's y-axis is the same scale everywhere. |

#### 39. `biology.organ-systems` — Organ systems

| Field | Value |
|---|---|
| Subject · band · age | `biology` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can map an organ to its system and say how two systems interact. |
| Interaction | Place organs into systems; the interaction links draw; enter the mapping and one interaction. |
| Model | Systems are held as SETS of organs and the interactions as EDGES between them, so 'which system does this organ belong to' is a membership question and 'how do these two systems interact' is an edge question — and both are computed from the same structure rather than from a list the student memorises. An organ in two systems is ALLOWED, because that is the biological truth and the row's focus names 'systems mapping, function matching, interactions'. |
| Answer | `{ mapping: Record<string, string>, interactions: string[], functions: Record<string, string> }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the mapping · `multi_select` for the interactions · `short_text` for the function · `true_false` for the shared-organ claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A silhouette of a human body with organs placed in outline positions and lines between them. The task is to say which system each organ belongs to, name one interaction between two systems and give the function of one named organ. The alternative gives the organs as a list with their positions and the systems as a list to pair them with. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Each organ belongs to exactly one system. (2) Systems do not interact. (3) An organ's function is independent of the system it is in. |

#### 40. `biology.succession` — Ecological succession

| Field | Value |
|---|---|
| Subject · band · age | `biology` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence primary from secondary succession and say what makes soil the difference. |
| Interaction | Step the succession; the community composition plots over time; enter the stages in order and the conditions each needs. |
| Model | The succession is a TIMELINE with a declared species pool drawn from a seeded stream, and the time axis is LOGARITHMIC because the row's focus names 'timelines' and a linear timeline of succession compresses the pioneer stage into nothing. The difference between primary and secondary succession is the presence of soil, and the model makes it a parameter rather than a caption. |
| Answer | `{ stages: string[], type: 'primary'\|'secondary', timesToClimax: Record<string, number>, soilPresent: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the stage sequence, order-sensitive · `single_choice` for the type · `numeric` for the time to a named stage · `multi_select` for the conditions each stage needs. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | Times are on a log axis and are therefore read by ORDER of magnitude, so the graded quantity should be an ORDER rather than a value — `ordering` over stages with their time bands, which is exactly why this card carries `ORDER` and not `numeric`. If a value is wanted the card must fix the seed and state the band. |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plot of species abundance against time on a logarithmic axis, with the stages labelled and the climax community marked. The task is to put the stages in order, say whether the succession is primary or secondary, and state what each stage needs. The alternative gives the stages as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Primary succession is faster than secondary. (2) A climax community stops changing. (3) Pioneer species need soil to establish. |

#### 41. `chemistry.particle-view` — Particle view of matter

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can connect what you can see happening to the particle model underneath it. |
| Interaction | Change temperature, volume and particle count; the animation and its count plot run; type the collision rate per second and whether the state changed. |
| Model | **A collision detector, not an animation.** The shipped gold sim stresses 'large state, event-driven, animation' and its own spec card records that the collision count is measured, that the detector's window had to scale with the box, and that the rate is held steady ACROSS SEEDS — a collision rate that varied with the seed would be ungradeable, and the seed is in the state so it is not. `createRng(seed)` drives every atom. |
| Answer | `{ collisionsPerSecond: number, state: 'solid'\|'liquid'\|'gas', meanSpeed: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the state · `true_false` for the density claim · `ordering` for the states by particle spacing, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | **Large state, and the fixed timestep matters.** The state carries the particle positions, the box dimensions and the seed. `canonicalJson` (`state.ts:36-64`) sorts keys and rejects non-finite numbers, so a particle whose position became `NaN` from a division by a zero-size box makes the sim unsaveable. The card requires the box dimensions to be validated as non-zero before any position is derived, and the shipped sim's tests already assert the states it actually produces are accepted. *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A box containing many small circles moving about, with a line graph of the rate at which they collide. The task is to report the collision rate per second, the mean speed of the particles, and which state of matter the box shows. The alternative gives the box size, the particle count, the temperature and the collision rule. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Heating a liquid makes its particles expand. (2) Particles in a solid do not move. (3) A gas has no mass because it has no fixed shape. |

#### 42. `chemistry.stoichiometry-balance` — Balancing equations

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can balance an equation and say which atoms you conserved to do it. |
| Interaction | Type the equation with coefficients; it is parsed and the per-element atom counts shown; unlimited retries. |
| Model | **Discrete state, exact SET grading, unlimited retries** (`plans/10` §10). The answer is the COEFFICIENT VECTOR, not the string: parsing the student's equation into an element-count vector is what makes `2H₂ + O₂ → 2H₂O` and `4H₂ + 2O₂ → 4H₂O` the same answer by construction, and it means a student who writes `H2+O2->H2O` with no coefficients is told what is missing rather than marked wrong for formatting. The parser counts atoms per element, so an unbalanced equation has unequal counts and the sim says which element. |
| Answer | `{ coefficients: number[], balanced: boolean }` — the coefficient vector, normalised by its GCD. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` over equation spellings · `multi_select` for which elements are conserved · `ordering` for the elements, which is the reasoning question. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **Case folding is wrong here.** `setMatch` folds by default (`grading.ts:264`) and a coefficient list is not a set of labels — so this card sets `caseSensitive: true` and grades the parsed vector, which is why the card requires the parse to happen before the comparison and not after. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | An unbalanced equation and a row of boxes for the coefficients in front of each species. The task is to write coefficients that balance the equation. The alternative gives the equation in full, so the balance can be done on paper. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Coefficients can be fractions. (2) You balance by changing subscripts. (3) A balanced equation tells you how fast the reaction goes. |

#### 43. `chemistry.titration-curve` — Titration curves

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read the equivalence point off a curve and say which indicator suits it. |
| Interaction | Choose the acid and base and their concentrations; the curve plots as titrant is added; type the equivalence volume, the pH at equivalence and the indicator. |
| Model | **The curve is generated from the equilibrium, not drawn.** The pH is solved from the charge balance at each volume by a declared root finder, so the plotted curve and the graded equivalence volume are the same computation. `plans/10` §10 names this sim's corner as 'continuous params, numeric tolerance' and that is exactly the requirement: the answer depends on a solved root, so it is irrational and only a declared relative tolerance is honest. |
| Answer | `{ equivalenceVolume: number, phatEquivalence: number, indicator: string, region: string }` — volume in cm³ to 2 dp, pH to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the indicator · `single_choice` for strong/weak · `true_false` for the pH at equivalence. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The equivalence volume is a root of the charge balance, so it carries the solver's tolerance as well as the physical input error. **The card requires the solver's residual to be reported in the answer key**, and the grading band to be `rel: 0.002, abs: 0.05 cm³`. A band narrower than the solver's own convergence is a grader that fails on a correct answer, which is the false-wrong this phase exists to prevent. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve of pH against volume of titrant added, with the steep region and the equivalence point marked. The task is to report the volume at the equivalence point, the pH there, and which indicator would change colour within that region. The alternative gives the acid and base used, their concentrations and the indicator ranges. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The equivalence point is where the pH is 7. (2) Any indicator changes colour at the equivalence point. (3) The steep part of the curve is the buffer region. |

#### 44. `chemistry.reaction-rate` — Reaction rates

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which factor changed the rate and why concentration does it differently from temperature. |
| Interaction | Change concentration, temperature, surface area and catalyst; the rate and its log plot draw; type the rate and the factor responsible. |
| Model | The rate law is DECLARED as `(aA)^m(bB)^n` with the orders `m, n` as parameters, and the temperature factor is the Arrhenius term. The row's focus names 'concentration/temperature, collision theory', and the misconception list is about the ORDER being a teaching choice rather than a number to look up — so the sim lets the student SET the order and see the slope change, which is the actual insight. |
| Answer | `{ rate: number, order: number, factor: string }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for which factor and for the order · `ordering` for the log-plot slope reasoning, the PATH_SENSITIVE reading. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of concentration against time for several runs, each labelled with the factor that was changed, beside a log plot of the same data. The task is to report the rate constant for one run and to name which factor changed the rate. The alternative gives the starting concentrations, the temperature and the time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Concentration changes the rate by changing the number of collisions AND the fraction that succeed. (2) A catalyst raises the equilibrium yield. (3) A reaction order can be read off the balanced equation. |

#### 45. `chemistry.equilibrium` — Dynamic equilibrium

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict which way a change pushes an equilibrium and explain it with the rate argument. |
| Interaction | Change concentration, pressure or temperature; the composition and the equilibrium constant plot; type the direction of shift and the new equilibrium composition. |
| Model | Le Chatelier is implemented as a KINETIC model — forward and reverse rates computed from the rate law and the equilibrium condition is the point where they match — rather than as a rule that says 'more product pushes left'. That is the difference between a sim that predicts a shift the student can justify and one that predicts it from a lookup, and it is what makes the industrial-conditions half of the row's focus answerable. |
| Answer | `{ shift: 'left'\|'right'\|'none', k: number, composition: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the direction · `true_false` for the catalyst and yield claims. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A container with the equilibrium composition listed and a graph of concentration against time showing the approach from either side. The task is to say which way the equilibrium moves when one condition is changed and to report the new equilibrium constant. The alternative gives the reaction, the equilibrium constant and the change applied. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A catalyst moves the equilibrium. (2) Increasing temperature always increases the yield. (3) Equilibrium means the concentrations are equal. |

#### 46. `chemistry.mole-conversions` — The mole

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can carry out a conversion chain without skipping a step and find the limiting reagent. |
| Interaction | Enter a mass, volume or amount; the chain of conversions shows each step; type the next value in the chain and the limiting reagent. |
| Model | **Every step in the chain is shown and each is a separate reported quantity.** `n = m/M` and `n = cV` are both `1/M` and `1/22.7` per litre respectively, and the row's focus names 'conversion chains, limiting reagent' — so the sim computes each link and displays it rather than only the endpoints, because a chain is the thing being taught and the endpoint is only the evidence. The limiting reagent is the one that yields the least product, computed by comparing `n/ν` for each. |
| Answer | `{ moles: number, limiting: string, productMoles: number }` — moles to 4 significant figures. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the limiting reagent · `ordering` for the conversion chain, which is order-sensitive and the PATH_SENSITIVE reading. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | `M = 24.0 g/mol` and `n = 12.0/24.0 = 0.5` exactly, but `M = 24.05` gives `0.499` and `M = 24.0` against a volume of `22.414 L/mol` gives a fifth figure. **Molar masses are tabulated to varying precision and a student may use a different table** — so the card states which table's values it accepts and grades `rel: 0.005`. This is a data-ambiguity band, not a slack one, and the reviewer should read it that way. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A conversion diagram with the chain from mass through moles to volume, one box per step, and the amounts of two reactants listed. The task is to fill in the chain and to say which reactant is limiting. The alternative gives the substances, their masses and their molar masses. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The limiting reagent is the one with the smaller mass. (2) The theoretical yield uses the excess reagent. (3) Moles can be converted to mass without knowing the molar mass. |

#### 47. `chemistry.gas-laws-applied` — Gas laws applied

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can apply the combined gas law to a mixture and say what the molar volume is at a given state. |
| Interaction | Change the state of a gas; the volume, pressure and temperature update; type the combined-law answer and the molar volume. |
| Model | The combined gas law is applied as a RATIO of states, not by a stored constant, and the molar volume is DERIVED as `V/n` from the current state rather than authored as 22.7 or 24.0 — because the two differ at different states and a sim that carries one of them teaches the number rather than the relationship. |
| Answer | `{ volume: number, molarVolume: number, partialPressure: number }` — volume in dm³, pressure in kPa. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the gas that dominates a mixture · `true_false` for the partial-pressure claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | Ratios of states compound the input uncertainties, so a 1% error in pressure and 1% in temperature gives about 2% in volume. `rel: 0.01` with `abs: 0.1 dm³`; and the card requires the answer in ONE unit because a dm³/L mismatch is not catchable by a relative tolerance. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A piston with the gas state listed as pressure, volume, temperature and amount, and a bar showing the proportion of each gas in a mixture. The task is to report the new volume at a stated pressure and temperature, the molar volume there, and one gas's partial pressure. The alternative gives both states in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The combined gas law applies to one mole only. (2) A gas's volume is independent of the number of moles. (3) Dalton's law gives each gas's contribution to the pressure at constant volume. |

#### 48. `chemistry.solution-concentration` — Solutions and concentration

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work out a dilution's concentration and convert between molarity and ppm. |
| Interaction | Set the volumes and amounts; the solution diagram and the concentration update; type the diluted concentration. |
| Model | `c₁V₁ = c₂V₂` is applied to the actual volumes rather than to added water, and the sim distinguishes 'add 100 cm³ of water' from 'make up to 100 cm³' as two DIFFERENT scenarios — that distinction is the row's focus and a sim with a single 'dilute' action cannot ask it. Molarity and ppm are two declared units with a conversion between them, both reported. |
| Answer | `{ molarity: number, ppm: number, moles: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which dilution was performed · `true_false` for the add-vs-make-up claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A beaker with a stated volume and concentration and a second beaker showing the result of adding solution or water to it. The task is to report the concentration of the second solution in molarity and in ppm. The alternative gives both volumes, both concentrations and the units. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Adding 100 cm³ of water to 100 cm³ of solution halves the concentration. (2) Molarity and ppm are interchangeable. (3) Dilution changes the amount of solute. |

#### 49. `chemistry.ph-scale` — pH and indicators

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can place a solution on the pH scale and say what a log scale means for the numbers. |
| Interaction | Change the acid's concentration; the pH and the indicator colour update; type the pH and the indicator's colour. |
| Model | **`pH = −log₁₀[H⁺]` and the log is the whole point.** Diluting a strong acid by a factor of 10 changes the pH by exactly 1, and the sim's misconception list is about students expecting the pH to be proportional to the concentration. So the sim requires the student to make the dilution and then read the pH, and the answer is graded on the pH rather than the concentration. |
| Answer | `{ ph: number, indicatorColour: string, hydrogenConcentration: number }` — pH to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the indicator colour · `ordering` for the pH of a set of dilutions, which is order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | `−log₁₀(1e-3)` is `3.0000000000000004` in IEEE 754. A student answering `3` is right and `strategy: NUMERIC` would mark them wrong. **`abs: 0.02` and no `rel`** — this is T-B, because a relative tolerance on a pH is meaningless (a pH error of 0.01 is a factor of 1.023 in acidity, and a relative band on the pH VALUE has no physical reading). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A scale marked from 0 to 14 with an indicator's colour band drawn on it and a solution plotted at its pH. The task is to report the pH of the solution and the colour the indicator shows. The alternative gives the acid's concentration and the indicator's transition range. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) pH 3 is three times as acidic as pH 6. (2) A tenfold dilution changes the pH by 0.1. (3) A pH of 7 is neutral whatever the temperature. |

#### 50. `chemistry.buffers` — Buffer solutions

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute a buffer's pH with Henderson-Hasselbalch and say what its capacity measures. |
| Interaction | Change the acid and conjugate base amounts; the pH and the capacity plot draw; type the pH and the capacity at a stated added volume. |
| Model | `pH = pKa + log([A⁻]/[HA])` is evaluated from the CURRENT concentrations, and the sim applies each addition as a stoichiometric step BEFORE computing the pH — the order is the misconception and the sim makes the order visible by reporting the concentrations it used. Buffer capacity is computed as the moles of strong base needed to shift the pH by 1.00, which is the operational definition and not a shape on a curve. |
| Answer | `{ ph: number, capacity: number, pka: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the 'a buffer resists any addition' claim · `single_choice` for which pH range is the buffer's. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The ratio `[A⁻]/[HA]` goes into a logarithm, so an answer near `pH = pKa` (ratio 1) is well conditioned and one three decades away is not. `rel: 0.005, abs: 0.02 pH units` — both, because `pH` can legitimately be near 0 in absolute terms but the RATIO is what carries the error (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A beaker with a stated weak acid and its conjugate base, and a plot of pH against the volume of strong base added, with a shallow region marked as the buffer region. The task is to report the pH and how much strong base must be added to raise it by one unit. The alternative gives both amounts, the pKa and the acid's concentration. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A buffer resists the addition of unlimited acid or base. (2) Buffer capacity and buffer range are the same quantity. (3) Adding acid to a buffer changes its pH by a constant amount. |

#### 51. `chemistry.precipitation` — Precipitation reactions

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can write a net ionic equation and apply the solubility rules without looking them up. |
| Interaction | Choose two solutions; the mixture and the precipitate draw; enter the net ionic equation. |
| Model | **The answer is the NET IONIC EQUATION, compared after cancelling the spectator ions** — the simulator parses both sides into ion inventories and subtracts the common multiset, so a student who writes the full equation is credited and one who writes a different balanced form of the same net equation is also credited. That cancellation is a real transformation the codebase does not otherwise do, and this sim is where it lives. |
| Answer | `{ netIonic: string, precipitate: string, state: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` over the accepted equations and their reordered forms · `single_choice` for which precipitate forms · `true_false` for a solubility rule. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | Two beakers being mixed, with the solid forming in the second one and a table of the ions present. The task is to write the net ionic equation for the reaction and to name the solid. The alternative gives the two solution labels and the solubility rules in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The spectator ions must be written out. (2) A precipitate is any solid that appears. (3) Solubility rules tell you the amount, not only whether one forms. |

#### 52. `chemistry.redox-balancing` — Redox balancing

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can assign oxidation numbers and balance a half-equation without guessing coefficients. |
| Interaction | Enter the half-equation; the oxidation numbers are shown per atom; the balanced form is checked. |
| Model | Oxidation numbers are assigned by a RULES ENGINE with a declared precedence order (free element → group sign → known polyatomic ions → calculate from the total), not by pattern-matching familiar compounds — a sim with a lookup table teaches the table. Balancing is done by the half-reaction method and the state of oxidation is shown changing, so the row's focus 'oxidation numbers, half-reactions, disproportionation' is addressed by the model rather than by a worked example. |
| Answer | `{ balanced: string, oxidationNumbers: Record<string, number> }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `multi_select` for which atoms change oxidation state · `ordering` for the half-reaction steps, the PATH_SENSITIVE reading. · `worked_solution` for the half-equation route, each step graded separately. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A half-equation with the oxidation number written above each atom and a pair of arrows showing electrons being added or removed. The task is to balance the half-equation and to state the oxidation number of one named atom. The alternative writes the half-equation out in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Oxidation is always loss of electrons and never a gain. (2) The total charge in a half-equation need not balance. (3) Disproportionation means two different substances react. |

#### 53. `chemistry.electrochemistry` — Electrochemistry

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can predict the products at each electrode and apply Faraday's law to a mass deposited. |
| Interaction | Build the cell; the potentials and the electrode products show; type the products and the mass deposited. |
| Model | Standard electrode potentials are a declared TABLE and the cell potential is the difference of the two, with the sign convention attached to which electrode is the anode — the sign is the error this row exists for. Faraday's law `m = (MIt)/(nF)` is applied with `n` the number of ELECTRONS, not the coefficient of the species, and the card requires `n` to be an explicit field of the answer rather than inferred. |
| Answer | `{ cellPotential: number, anodeProduct: string, cathodeProduct: string, massDeposited: number }` — V to 3 dp, mass in g to 4 sf. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the products at each electrode · `true_false` for the sign convention · `ordering` for the half-reactions, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `F = 96485 C/mol` is rounded, and the deposited mass is linear in it, so a student using `96500` differs by 0.016%. `rel: 0.005` covers the constant's ambiguity. A student who used `n = 2` where `n = 1` is wrong by a factor of two and no tolerance should hide it. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A cell drawn with two electrodes in solutions, arrows showing electron and ion movement, the electrode potentials labelled and gas bubbles drawn at both electrodes. The task is to name what forms at each electrode and to report the mass deposited in a stated time. The alternative gives the two electrode couples, their standard potentials, the current and the time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The anode is where oxidation happens and reduction too. (2) Cell potential is the sum of the two electrode potentials. (3) A more reactive metal is deposited at the cathode. |

#### 54. `chemistry.acid-base-strength` — Comparing acid strength

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compare two acids from their Ka and say why the stronger one has the lower pH at equal concentration. |
| Interaction | Choose two acids and set the concentration; the pH and the dissociation fraction plot; type the pH and the comparison. |
| Model | `Ka` is a declared parameter per acid and `[H⁺]` is SOLVED from it by a root finder rather than approximated as `√(Ka·c)`, because the approximation is exactly what fails for the weak acids this row is about — a sim that used it would report the wrong pH for the acid it is trying to teach the difference about. The dissociation fraction is reported so the structural argument is visible. |
| Answer | `{ ph: number, dissociationFraction: number, stronger: string }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for which is stronger · `true_false` for the equal-concentration claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | A cubic in `[H⁺]`, so the answer carries the solver's convergence. `rel: 0.002, abs: 0.01 pH units` and the card requires the solver's residual in the answer key, exactly as for `chemistry.titration-curve`. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two weak acids plotted as fraction-dissociated curves against concentration, with their Ka values labelled. The task is to report the pH of one solution and the fraction of the acid dissociated, and to say which acid is stronger. The alternative gives both acids' Ka values and the concentration. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A stronger acid has a higher concentration. (2) Ka measures how much acid has ionised rather than how strongly it ionises. (3) Equal concentrations of two weak acids have equal pH. |

#### 55. `chemistry.organic-structures` — Organic structures

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can name a structure from its formula and count the isomers of a given formula. |
| Interaction | Build or select a structure; the condensed and displayed forms show; enter the name and the isomer count. |
| Model | Structures are held as a BOND GRAPH with explicit atom labels, so the isomer count is computed by an enumeration over the graph rather than asserted from a formula — and a condensed formula that does not round-trip to the graph is refused rather than silently reinterpreted. Isomers are counted by constitution, with stereoisomers reported SEPARATELY, because 'how many isomers' means different things and the row's focus names isomer counting. |
| Answer | `{ name: string, isomers: number, functionalGroups: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` for the name · `numeric` for the isomer count · `multi_select` for the functional groups present · `ordering` for the longest chain, which is order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A displayed structural formula with its carbons and hydrogens shown, and boxes for the name, the number of isomers and the functional groups. The task is to name the structure, count its isomers and identify the functional groups. The alternative gives the condensed formula and the molecular formula in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Structural isomers and stereoisomers are the same thing. (2) Isomers have different molecular formulae. (3) A functional group defines the whole molecule's reactivity. |

#### 56. `chemistry.polymer-build` — Polymers

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can tell addition from condensation polymerisation and say what each wastes. |
| Interaction | Choose monomers and a polymerisation type; the chain draws and the small molecule is identified; enter the repeat unit and the by-product. |
| Model | The chain is BUILT from the declared monomer's bond graph by the declared mechanism — addition opens the double bond and joins carbons, condensation joins monomers and ejects the declared small molecule — and the sim checks the atom balance of the chain against the monomers consumed. That check is the teaching point: a student who draws a condensation polymer without ejecting anything has produced a chain that fails its own atom balance, and the sim says so. |
| Answer | `{ repeatUnit: string, type: 'addition'\|'condensation', byproduct: string\|null }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `single_choice` for the type · `true_false` for the 'no waste' claim about addition. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A chain of repeating units drawn with brackets around the repeat unit and a small molecule drawn leaving the chain for the condensation case. The task is to write the repeat unit and to name the small molecule produced. The alternative gives the monomer's displayed formula in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Both types eliminate a small molecule. (2) A polymer's relative molecular mass is the sum of the monomer masses. (3) Addition polymerisation needs a double bond in the monomer that is retained. |

#### 57. `chemistry.orbital-shapes` — Atomic orbitals

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say which orbitals hold how many electrons and what a node is doing. |
| Interaction | Choose an orbital and a quantum-number set; the isosurface renders; type the capacity, the number of nodes and the shape. |
| Model | The isosurface is computed from the wavefunction's angular part with a DECLARED isovalue, and the node count is counted from the function rather than tabulated — because 'nodes in the angular part' and 'radial nodes' are different counts and conflating them is the misconception. The capacity is `2(2ℓ+1)` computed from `ℓ`. |
| Answer | `{ capacity: number, angularNodes: number, radialNodes: number, shape: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the shape · `true_false` for the 'nodes are where the electron is never' claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **This is a card where the plan's `E`/exact strategy is right and the reason is not obvious.** A node COUNT is an integer and exact grading is correct; a node POSITION would need a tolerance. The card must say which of the two it is asking for, and the answer schema makes them separate fields precisely so it cannot be ambiguous. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A three-dimensional surface enclosing a region around a nucleus, with the lobes shaded. The task is to report how many electrons the orbital can hold, how many angular nodes it has and what its shape is called. The alternative gives the quantum numbers, so every answer is derivable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) An orbital holds two electrons per energy level. (2) A node is where the electron spends most of its time. (3) The p orbitals have the same shape as the s orbital. |

#### 58. `chemistry.periodic-trends` — Periodic trends

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict a trend and say which element breaks it. |
| Interaction | Choose a property; the trend plots across periods and groups with exceptions marked; type which element is the exception and why. |
| Model | Electronegativity, ionisation energy and atomic radius come from a declared DATA TABLE, and the exception is a NAMED entry in that table rather than something the sim decides — because 'which element breaks the trend' is a fact about the periodic table, and a sim that inferred it from a formula would be making it up. The row's focus names '+ exceptions' explicitly, so the exceptions are first-class. |
| Answer | `{ trend: string, exception: string, explanation: string }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the trend direction · `single_choice` for the exception · `multi_select` for which statements hold · `ordering` for the explanation sequence. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A periodic table with one property shaded across it, and a graph of that property against atomic number with the peaks and dips marked. The task is to state the trend and to name the element that does not follow it. The alternative gives the table and the graph in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A trend has no exceptions. (2) Electronegativity and ionisation energy change in the same direction. (3) Atomic radius is the same as ionic radius. |

#### 59. `chemistry.bonding-models` — Bonding models

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict a bond type from the atoms involved and say what a dot-and-cross diagram shows. |
| Interaction | Choose two atoms; the dot-and-cross diagram and the electron shells draw; enter the bond type and the number of bonds. |
| Model | Electron shells are filled by a declared counting model (valence electrons, then octet) and the dot-and-cross diagram is GENERATED from the filled shells — so a diagram that shows four shared pairs cannot be labelled single. The row's focus names 'ionic / covalent, metallic, dot-and-cross' and the sim's job is to make the diagram and the label one object. |
| Answer | `{ bondType: 'ionic'\|'covalent'\|'metallic', bonds: number, sharedPairs: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the bond type · `numeric` ×2 · `multi_select` for the electron movements · `true_false` for the 'metallic bonds share between two atoms' claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | Two atoms drawn with their electron shells and a dot-and-cross diagram between them. The task is to name the bond type and to say how many electron pairs are shared. The alternative gives the two atoms and their group numbers. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Ionic bonds involve shared electron pairs. (2) Metallic bonding is a special case of covalent bonding. (3) A dative covalent bond forms by electron transfer. |

#### 60. `chemistry.structure-determination` — Structure determination

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can read an IR, NMR or mass spectrum and deduce a structure from the evidence. |
| Interaction | Spectra draw; enter the functional groups seen and the deduced structure as a graph; submit. |
| Model | **Spectra are generated from the structure, not selected from a bank.** The IR bands are emitted by declared functional groups with real wavenumbers, the NMR peaks by equivalent hydrogen environments computed by a stated symmetry rule, and the mass spectrum by a declared fragmentation. A student reading a bank-selected spectrum is learning to recognise; a student reading a generated one is learning to deduce, and the row's focus ('deduce structure from IR/NMR/mass data') only holds for the second. |
| Answer | `{ groups: string[], structure: string, formula: string }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the functional groups · `short_text` with `REGEX_SET` for the structure · `numeric` for a peak position or the molecular ion. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Three stacked traces: an infrared absorption spectrum with labelled peaks, a nuclear magnetic resonance spectrum with peak positions and integrals, and a mass spectrum with the molecular ion marked. The task is to list the functional groups the evidence shows and to deduce the structure. The alternative gives each spectrum's peak table as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A spectrum identifies a molecule uniquely on its own. (2) The IR spectrum gives the molecular formula. (3) A missing NMR peak means the environment does not exist. |

#### 61. `chemistry.thermochemistry` — Thermochemistry

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can apply Hess's law to build an enthalpy from steps you did not measure directly. |
| Interaction | Choose a cycle of steps; the energy profile draws; type the total enthalpy change and the sign. |
| Model | **Hess's law is applied as a vector sum of the declared steps**, and the sim checks the cycle CLOSES (the sum of the bond enthalpies round the cycle is zero) before it will compute anything — a sim that adds numbers without checking the cycle closes will happily add two exothermic steps and report an endothermic total, which is the specific error the row's focus names. |
| Answer | `{ deltaH: number, sign: 'exothermic'\|'endothermic', limitingStep: string }` — kJ/mol to 1 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the enthalpy · `single_choice` for the sign and for the limiting step · `ordering` for the cycle, which is order-sensitive and the reasoning question. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Bond enthalpies are tabulated averages with three or four significant figures and a student's table will differ. `abs: 0.5 kJ/mol` (T-B) rather than relative, because the sum of four tabulated values has an ABSOLUTE error, not a proportional one — a relative band on a near-zero ΔH would accept anything. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An energy profile with reactants and products at stated levels and the intermediate steps drawn between them. The task is to work out the overall enthalpy change for the cycle and to say whether it is exothermic or endothermic. The alternative gives each step's enthalpy as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Enthalpy is an extensive quantity that depends on the amount. (2) Bond enthalpies are exact for every bond. (3) Hess's law applies to a cycle that does not close. |

#### 62. `chemistry.entropy` — Entropy and spontaneity

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say which of ΔH and ΔS decides spontaneity at a stated temperature, and compute ΔG. |
| Interaction | Set the temperature; the Gibbs free energy against T plots with the crossover marked; type ΔG at a stated T and the crossover temperature. |
| Model | `ΔG = ΔH − TΔS` is evaluated from declared `ΔH` and `ΔS`, and the **crossover temperature `T = ΔH/ΔS` is computed analytically rather than read off the drawn crossing** — a student reading the crossing off a plot is reading the plotting resolution, and the sim's job is to make that visible by printing the analytic value beside it. |
| Answer | `{ deltaG: number, crossoverTemperature: number, spontaneous: boolean }` — kJ/mol to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for the spontaneity claim · `single_choice` for the phase at a stated temperature. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `T = ΔH/ΔS` divides two tabulated quantities and the result can be enormous or tiny — `+4.2 kJ` over `+5.1 J/K` is 823 K, and `+4.2 kJ` over `−51 J/K` is −82 K. `abs: 1 K` with the units stated, and the card requires ΔH and ΔS to be quoted in MATCHING units so the student does not silently divide kJ by J. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plot of the change in Gibbs free energy against temperature, with a horizontal line at zero and the point where the curve crosses it marked. The task is to report the free energy change at a stated temperature and the temperature at which the direction of spontaneity reverses. The alternative gives the enthalpy and entropy changes and the temperature. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Entropy is a measure of disorder in the everyday sense. (2) A reaction with a positive enthalpy is always spontaneous. (3) The Gibbs free energy change is the same at every temperature. |

#### 63. `chemistry.kinetics-vs-equilibrium` — Kinetics vs equilibrium

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say why a catalyst changes how fast equilibrium is reached and not where it sits. |
| Interaction | Toggle a catalyst; the approach to equilibrium on the time axis animates; type the time to reach 99% of equilibrium with and without. |
| Model | The catalyst changes the FORWARD AND REVERSE rate constants by the SAME FACTOR — and the sim implements it as one multiplier applied to both, not as one applied to the forward rate only. That single line is the whole row: a one-sided multiplier moves the equilibrium, which is the misconception students most often have, and the sim's ratio-of-time-to-equilibrium is computed from the two rate constants the model actually used rather than from a stored doubling. |
| Answer | `{ timeWithout: number, timeWith: number, positionUnchanged: boolean }` — seconds to 1 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for the equilibrium position claim · `ordering` for the approach sequence, the PATH_SENSITIVE reading. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The time to 99% of equilibrium is a LOGARITHM of a rate ratio, so an error in the rate constant is amplified. `rel: 0.02` with `abs: 0.5 s`, and the card requires both times to be reported so a marker can see the RATIO, which is the robust quantity. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two concentration-against-time curves approaching the same equilibrium line, one labelled with a catalyst and one without. The task is to report how long each takes to reach the equilibrium value and to say whether the catalyst changed the equilibrium. The alternative gives both rate constants and the target fraction. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A catalyst shifts the equilibrium to the products. (2) Raising the temperature changes the equilibrium position AND the rate in the same way. (3) The rate at equilibrium is zero. |

#### 64. `chemistry.electrolysis-lab` — Electrolysis lab

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can identify the products at each electrode and calculate the mass deposited from the charge passed. |
| Interaction | Choose the electrolyte and the electrodes; the products form at the electrodes; type the product at each and the mass deposited. |
| Model | The product at each electrode is determined by the DECLARED half-equation set, with the anode/cathode signs tied to the power supply's polarity as a declared parameter — the electron-flow direction is the thing students get wrong and the sim draws it from the supply, not from the species. `m = ItM/(nF)` with `n` explicit in the answer. |
| Answer | `{ anodeProduct: string, cathodeProduct: string, molesOfElectrons: number, mass: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for each product · `true_false` for the electrode-sign claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Linear in `F` and in `M`, both tabulated. `rel: 0.005` and the card states `F = 96500` as the value to be used, because a student using `96485` and one using `96500` must both be credited and a third using `96500 C/mol` written as `96.5 kC/mol` must not be penalised for the scaling. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | An electrolytic cell with two electrodes in an electrolyte, bubbles or a solid deposit drawn at each, and the electron flow arrows shown. The task is to name what forms at each electrode and to report the mass deposited in a stated time at a stated current. The alternative gives the electrolyte, the electrodes, the current and the time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The anode is where reduction happens. (2) The metal with the more reactive behaviour is deposited. (3) The mass deposited depends on the electrode's area. |

#### 65. `chemistry.qualitative-analysis` — Qualitative analysis

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work down a deduction chain from a test result and say which test rules an ion out. |
| Interaction | Choose reagents; the observations and the elimination chain update; enter the deduction steps in order and the ion. |
| Model | The OBSERVATIONS are computed from the ions present and the reagent added — a precipitate's colour comes from the declared colour of the ion that precipitates, and a gas from the declared gas — so a student reading the observations is reading the ion inventory rather than matching a remembered pattern. The elimination chain is a SET DIFFERENCE against the declared candidate list, and the sim reports which candidates remain after each test. |
| Answer | `{ steps: string[], ion: string, ruledOut: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the deduction chain — **order-sensitive, and `orderMatch` is right rather than `setMatch`, because a chain in the wrong order is a different argument** · `multi_select` for which ions are ruled out · `single_choice` for the final ion. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A row of test tubes, each with a reagent listed and the observation written beside it, and a list of the ions still possible. The task is to give the sequence of tests that identifies the ion and to list the ions the evidence rules out. The alternative gives the observations as text in a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A test that gives no precipitate rules the ion out entirely. (2) The deduction chain is order-independent. (3) Colour alone identifies a metal ion. |

#### 66. `chemistry.crystal-structures` — Crystal structures

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can count atoms in a unit cell and get a density from the cell dimensions. |
| Interaction | Choose a structure; the unit cell renders with its atoms counted at the corners, edges, faces and inside; type the atom count per cell and the density. |
| Model | **The atom count is derived from the fractional positions, not from a per-structure constant**: an atom at a corner contributes `1/8`, on an edge `1/4`, on a face `1/2`, inside `1`. The card's focus is 'unit cells, packing, density from dimensions', and the counting rule IS the misconception — a sim with the answer stored per structure cannot show why copper is 4 and diamond is 8. |
| Answer | `{ atomsPerCell: number, density: number, packingFraction: number }` — density in kg/m³ to 3 sf. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the coordination number · `false_false` removed — the real pair is `true_false` for 'the packing fraction can exceed 1'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `ρ = ZM/(N_A·a³)` and the `a³` is a CUBE of a small number, so a 1% error in the lattice parameter is a 3% error in density. `rel: 0.005, abs: 100 kg/m³` — the absolute floor is because a student using `N_A = 6.02×10²³` against the card's `6.022×10²³` differs by 0.03%, and the card wants that credited while a wrong atom count is not (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A cubic unit cell with atoms drawn at its corners, edges, faces and centre, each position labelled with the fraction it contributes, and the cell edge length stated. The task is to report the number of atoms per cell and the density. The alternative gives the atomic masses, Avogadro's number and the cell dimensions as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) An atom at a corner counts once. (2) The unit cell is the smallest repeating unit. (3) Density is a property of the element alone and not of the structure. |

#### 67. `chemistry.green-chemistry` — Green chemistry metrics

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute atom economy and the E-factor and say which of two routes is greener and why that is not the same as cheaper. |
| Interaction | Enter two reaction routes with their masses; the metrics compute; write the justification for choosing one. |
| Model | **The sim computes the metrics and refuses to compute the verdict.** Atom economy is `M_desired/ΣM_reactants` and the E-factor is `mass_waste/mass_product`, both from declared formulae and masses — arithmetic the sim can do. Which route to choose depends on solvent, energy, hazard and source, and a machine that picks would produce a decision that looks made and was not. The rubric bands live in the card. |
| Answer | `{ atomEconomy: number, eFactor: number, justification: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 · `free_response` for the justification, which carries the rubric. **MANUAL is mandatory** — see `readAward` (`grading/simulation.ts:213-246`): an AUTO rubric item is reported as `GRADED: 0` for every student until a marker acts. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | Two reaction routes written as formulae with the masses beside each, and the atom economy and E-factor worked out for each. The task is to state the metrics for each route and to justify which you would choose. The alternative gives the routes in text so the metrics can be calculated without the diagram. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A high atom economy means a safe process. (2) The E-factor depends only on the stoichiometry. (3) Yield and atom economy are the same quantity. |

#### 68. `chemistry.food-chemistry` — Food chemistry

| Field | Value |
|---|---|
| Subject · band · age | `chemistry` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say what triggers browning and denaturation, and predict the change from a temperature or pH. |
| Interaction | Change temperature, pH and time; the reaction curves plot; type the time to reach a stated extent of browning. |
| Model | Maillard reaction rate, caramelisation onset and protein denaturation are SEPARATE rate models with separate parameters, not one 'cooking' curve with a mode flag — the row's focus names all three and they are genuinely different processes with different triggers, and a single model with a flag would make them indistinguishable. The denaturation curve is reported as a fraction of protein unfolded. |
| Answer | `{ timeToBrowning: number, denaturedFraction: number, process: string }` — time to 1 dp, fraction to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for which process · `true_false` for the pH and temperature claims · `ordering` for the sequence of changes on heating. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Three separate curves against temperature: the rate of browning, the temperature at which caramelisation starts, and the fraction of protein denatured. The task is to report the time to reach a stated extent of browning and the denatured fraction at a stated temperature. The alternative gives the three curves' axes and the starting state in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Browning is caramelisation. (2) Denaturation changes the protein's primary structure. (3) Reducing the temperature stops the reaction immediately rather than slowing it. |

#### 69. `computing.sorting-visualiser` — Sorting visualiser

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can count the comparisons a sort makes and say which sorts are stable. |
| Interaction | Choose the sort and the input size; the bars animate with a stepper and a scrubber; type the comparison count and the swap count. |
| Model | **No WebGL, and the count is the answer, not the animation.** The shipped gold sim stresses 'stepper with scrub, comparison counting, no WebGL' (`plans/10` §10) and its own spec card records that the declared script caught a defect where the step button called a method the SDK's stepper does not have — so the counters are incremented in the SAME code path the animation uses, never in a parallel one. The counts are deterministic functions of the input, which is why they can be graded. |
| Answer | `{ comparisons: number, swaps: number, stable: boolean, worstCaseClass: string }` — exact integers. |
| Strategy | `NUMERIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for the stability claim · `single_choice` for the complexity class · `ordering` for the order in which elements were compared, which is order-sensitive and the PATH_SENSITIVE reading. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | **Comparison and swap counts are EXACT integers, so this card is T-A and not T-C**, and the plan's `T` (tolerance) for this row is the wrong instrument: a count of 1,032 is either right or wrong and a `rel: 0.02` band would accept 1,052. **The card overrides the plan's strategy to NUMERIC with `abs: 0, rel: 0`**, which `withinTolerance` treats as exact (`grading.ts:98-104`), and the count is re-derivable from the input array in the state. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — AVAILABLE — the comparison order is the reasoning and it is the only way to ask which sort made fewer comparisons on a stated input. |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A row of bars being reordered, with the number of comparisons and swaps so far written beside it, and the array listed as numbers. The task is to report the total number of comparisons and swaps the sort makes on this input. The alternative gives the starting array and the sort chosen, so both counts are computable by hand. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) All O(n log n) sorts take the same number of comparisons on every input. (2) A sort that changes the array in place cannot be stable. (3) The comparison count is a property of the algorithm rather than of the input. |

#### 70. `computing.search-algorithms` — Searching

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can trace a binary search and say why it needs a sorted array. |
| Interaction | Choose the search and the target; the array animates with the comparison markers; type the number of comparisons and where the search ended. |
| Model | The search is instrumented on the SAME loop the animation follows, so the reported comparison count is the one the student watched — the shipped `computing.binary-search` exists to break that assumption and its spec card is explicit that its grader counts rather than estimates. The sortedness precondition is a DECLARED property of the input and the sim refuses to binary-search an unsorted array with a stated reason, rather than returning a plausible wrong answer. |
| Answer | `{ comparisons: number, found: boolean, index: number\|null, worstCase: number }` — exact integers. |
| Strategy | `NUMERIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the sortedness precondition · `single_choice` for the complexity class · `ordering` for the sequence of indices compared, which is order-sensitive and the reasoning question. |
| Tolerance class | `A` — T-A · exact integer. |
| Float hazard | T-A, exact. **A count of comparisons on a binary search is `⌈log₂(n+1)⌉` and is deterministic**; a relative band on it would accept a linear search that happened to get lucky, which is precisely the misconception the row targets. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A row of boxes holding a sorted array, with the middle element highlighted and the halves eliminated on either side. The task is to report how many comparisons the search makes and whether the target is present. The alternative gives the array and the target so the search can be run by hand. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A binary search needs a sorted array. (2) A linear search is always slower. (3) Binary search finds a value in an unsorted array if it is present. |

#### 71. `computing.linked-structures` — Linked structures

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can describe a linked structure correctly and say what a pointer error does. |
| Interaction | Build nodes and pointers by keyboard; the structure diagram redraws; write the operations your code performs. |
| Model | **The sim checks STRUCTURAL invariants and refuses to draw a broken structure.** Every node's next pointer is either null or an existing node, so a cycle or a dangling pointer is reported rather than drawn — a structure that cannot be drawn is a structure whose behaviour the sim cannot predict and therefore must not grade. The rubric grades the student's OPERATIONS AND REASONING, because the row's focus is 'pointer manipulation; rubric on correctness'. |
| Answer | `{ operations: string[], invariantsHold: boolean, traversal: string[], reasoning: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `ordering` for the traversal order, order-sensitive and auto-checkable · `true_false` for each invariant · `free_response` for the reasoning, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`) reports `GRADED: 0` for an AUTO rubric item. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A diagram of boxes joined by arrows, each box showing a value and the arrow showing where it points, with a null shown where a list ends. The task is to say what the traversal order is and to describe how your code performs the update. The alternative gives the node values and the pointer targets as a list of pairs. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A linked list can be traversed from any node. (2) Removing a node frees it immediately. (3) A cycle in a linked list is detectable by following pointers. |

#### 72. `computing.binary-trees` — Trees and traversal

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can insert into a binary search tree and name a traversal order. |
| Interaction | Insert values; the tree draws with the path highlighted; enter the three traversal orders and the tree's height. |
| Model | Insertion follows the BST invariant and the tree REBALANCES only if a declared balancing mode is on — the row's focus names 'BST invariants, in/pre/post-order, recursion' and the invariant is the teaching content, so an auto-balancing tree would hide the very thing the question is about. The three traversals are computed by separate named functions over the same tree, so no two of them can disagree. |
| Answer | `{ inOrder: string[], preOrder: string[], postOrder: string[], height: number, balanced: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for all three traversals, order-sensitive and `orderMatch` is the only correct instrument · `numeric` for the height · `true_false` for the BST invariant · `single_choice` for which traversal yields sorted order. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A tree of boxes joined by lines, with the root at the top and each node's value written in it. The task is to give the node values in in-order, pre-order and post-order. The alternative gives the nodes as a list of (value, left child, right child) triples. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) All three traversals give the same order. (2) An unbalanced tree is still a valid BST. (3) In-order traversal of a BST yields the values in descending order. |

#### 73. `computing.graph-algorithms` — Graph algorithms

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say which order BFS visits nodes in and how Dijkstra differs. |
| Interaction | Build a weighted graph; the traversal animates with the frontier; enter the visit order and the shortest-path distance and route. |
| Model | BFS, DFS and Dijkstra are SEPARATE algorithms over the same graph structure, each with its own frontier representation, and Dijkstra's priority queue is a DECLARED binary heap rather than a sorted array — the row's focus names 'BFS/DFS, Dijkstra, topological order' and the whole difference between Dijkstra and BFS is the frontier's discipline, so a sim with one frontier for all three teaches none of them. |
| Answer | `{ bfsOrder: string[], dfsOrder: string[], distance: Record<string, number>, path: string[], topologicalOrder: string[]\|null }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for each traversal, order-sensitive · `numeric` ×2 for the distances · `true_false` for the Dijkstra-on-negative-weights claim · `single_choice` for whether a topological order exists. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — AVAILABLE — the frontier discipline is the content of the row and only the trace shows it. |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A network of labelled vertices joined by edges with weights written on them, with the traversal frontier highlighted. The task is to give the visit order for BFS and for DFS and the shortest-path distance and route between two named vertices. The alternative gives the edges as a list of (from, to, weight) triples. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Dijkstra works with negative edge weights. (2) DFS and BFS give the same order. (3) A topological order exists for any directed graph. |

#### 74. `computing.hash-tables` — Hash tables

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can predict where a key lands under a probing scheme and say what the load factor changes. |
| Interaction | Insert keys; the table fills and the probe sequence animates; enter the slot each key lands in and the number of probes. |
| Model | The hash is `h(k) = k mod m` with `m` a declared table size and the PROBING SCHEME is the parameter the student chooses — linear, quadratic and double hashing are three separate probe sequences, not one with a stride parameter, because the row's focus names 'probing strategies' and the primary-clustering behaviour of linear probing is the difference between them. |
| Answer | `{ slots: number[], probes: number[], loadFactor: number, clustered: boolean }` — exact integers. |
| Strategy | `NUMERIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the probe sequence, order-sensitive and the reasoning question · `numeric` ×2 · `single_choice` for the probing scheme's weakness · `true_false` for the load-factor claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | T-A on the slot indices and the probe counts — both are exact integers re-derivable from the declared keys and table size in the state. **A `rel` band on a probe count accepts a scheme that collided when it should not have, which is the entire content of the row.** |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A grid of slots with each key shown in the slot it landed in and the probe path drawn. The task is to report which slot each key occupies and how many probes each insertion took. The alternative gives the keys, the table size and the probing scheme. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Collisions cannot happen if the table is large enough. (2) Linear probing distributes keys evenly. (3) The load factor does not affect probe counts. |

#### 75. `computing.big-o-lab` — Complexity lab

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can predict a growth class empirically and then prove it. |
| Interaction | Run an implementation at a range of sizes; the time plot draws on log-log axes; enter the observed class and the doubling ratio. |
| Model | **This is the PATH_SENSITIVE row's reason to exist.** The timing is measured with a DECLARED warm-up and repetition count and a median rather than a mean, because a mean over a machine with a garbage-collection pause reports the pause; and the sim reports its own measurement noise so a student who concludes 'O(n²)' from two noisy points is wrong for a reason the card can show them. The proof half is prose and is rubricked. |
| Answer | `{ observedClass: string, doublingRatio: number\|null, orderOfGrowth: number\|null, proof: string }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO for the empirical half, **MANUAL** for the proof) · `numeric` ×2 · `single_choice` for the class · `ordering` for the sizes, which is order-sensitive · `free_response` for the proof, carrying the rubric. **The item must split into two questions** — a simulation question for the empirical half and a `free_response` question for the proof — because `gradingMode` is per question (`GRADING_MODES`, `contracts/src/question/index.ts:69`) and a single item cannot be AUTO and MANUAL at once. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | The doubling ratio is a measured ratio of two noisy quantities and is the one place in computing where a RELATIVE band is right — `rel: 0.15` — **but only after the measurement noise has been reported**, because at these ratios the noise is often larger than the band and a card that omits the noise measurement is a card that will fail correct students. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — SPLIT — the empirical half is `ENDPOINT_ONLY` (the measured ratio IS the answer) and the proof half is a `free_response` with a rubric. **A `simulation` item cannot be AUTO and MANUAL at once**: `gradingMode` is per question (`contracts/src/question/index.ts:69`), so the item must be two questions. |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A log-log plot of running time against input size with two implementations plotted. The task is to state the growth class for each implementation and to give the doubling ratio. The alternative gives the measured times at each size as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) One measured curve proves a complexity class. (2) The doubling ratio identifies the class uniquely. (3) Constant factors do not matter in a big-O claim. |

#### 76. `computing.automata` — Finite automata

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can construct a DFA and convert an NFA to one. |
| Interaction | Add states and transitions and accept a string; the automaton traces the input; enter the transition table and the accepted strings. |
| Model | The NFA→DFA conversion is the SUBSET CONSTRUCTION, computed by the sim, and the trace of an input follows the transition function rather than a drawn path — the row's focus names 'DFA construction, NFA→DFA, state equivalence', and a sim that draws a path without computing the closure cannot tell a student their DFA is wrong. State equivalence is the Hopcroft partition, also computed. |
| Answer | `{ states: string[], transitions: Record<string, string[]>, accepts: string[], equivalentPairs: string[][] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the accepting strings · `short_text` with `REGEX_SET` for a transition table · `single_choice` for whether a string is accepted · `ordering` for the closure order of a subset, order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A state diagram with circles for states, double circles for accepting states, and labelled arrows between them, with an input string and the trace of which states it visits. The task is to give the transition table and to say which of a set of strings is accepted. The alternative gives the states and the labelled transitions as a list. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A DFA can have more than one transition per symbol per state. (2) The subset construction loses states. (3) Two states that reach the same sets are distinguishable. |

#### 77. `computing.regex-builder` — Regular expressions

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can write an expression that matches what you mean and say why greedy is not always what you want. |
| Interaction | Type an expression; it is tested against a corpus of strings with each match highlighted; enter the expression and which strings match. |
| Model | The matcher is a BACKTRACKING engine over a declared corpus, and the corpus is the graded artifact alongside the expression — because whether an expression matches is not gradeable on its own, only whether it matches a stated set of strings and rejects the others. Greediness is a property of the engine's backtracking order and the sim shows which alternative was taken, which is the row's focus ('matching, capturing, greediness'). |
| Answer | `{ expression: string, matches: string[], captureGroups: string[], greedy: boolean }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the matching strings · `short_text` with `REGEX_SET` for the expression · `numeric` for a capture group's index · `true_false` for the greedy/lazy claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A list of test strings with the substrings the expression matched highlighted in each. The task is to write an expression that matches the stated strings and rejects the others, and to say what each capture group captures. The alternative gives the corpus as a list of strings with the required pattern described in words. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A greedy quantifier matches as few characters as possible. (2) Anchors change what is matched rather than only where. (3) A capture group cannot be optional. |

#### 78. `computing.stack-machine` — Stack machine

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can evaluate a postfix expression on a stack machine. |
| Interaction | Enter a postfix expression; the stack draws step by step; enter the final stack and the operation sequence. |
| Model | The machine is a DECLARED opcode set evaluated by a real stack, so the trace the student watches is the execution rather than an illustration — and the row's focus names 'postfix evaluation, VM tracing'. The stack's contents at each step are the state and are in the save, so a traced machine can be re-run from a saved point. |
| Answer | `{ result: number, stack: number[], steps: string[], operationSequence: string[] }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the operation sequence, order-sensitive and `orderMatch` is correct · `numeric` for the result · `single_choice` for the stack size at a named step · `true_false` for the postfix/prefix claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A stack drawn as a column of boxes that fills and empties, with each opcode and the input string written beside it. The task is to give the final value, the final stack contents and the order the operations were performed in. The alternative gives the expression and the starting stack as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Infix and postfix expressions are interchangeable. (2) A stack machine can evaluate an expression containing brackets directly. (3) The stack size tells you the value of the expression. |

#### 79. `computing.quantum-circuits` — Quantum circuits

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compose gates and say what a measurement outcome tells you about the state. |
| Interaction | Place gates; the circuit and the state vector update; type the probabilities of the measured outcomes and the gate order. |
| Model | **The state vector is computed, not asserted.** Gates are applied as matrices to the vector by the sim, and the measurement probabilities are `\|amplitude\|²` — so 'superposition' is a property of the arithmetic rather than a label. Measurement is sampled from a SEEDED stream and the seed is in the state, because a single sampled outcome cannot be graded and only the distribution can; the card therefore grades the DISTRIBUTION and reports the sampled outcome as a secondary field. |
| Answer | `{ probabilities: Record<string, number>, sampledOutcome: string, gateOrder: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the outcomes with non-zero probability · `ordering` for the gate order, order-sensitive and the reasoning question · `numeric` for one amplitude's probability · `true_false` for the measurement-destroys-information claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | `1/√2` appears in every Hadamard outcome and `0.7071067811865476` is not `0.7071067811865475`. **The card grades the PROBABILITY to a declared precision with `abs: 0.005` rather than comparing amplitudes**, because amplitudes carry a phase the probability discards and a student's `1/√2` is exactly right while the float is not. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A circuit drawn as columns of gates on wires, with a measurement gate at the end and the outcome register shown. The task is to report the probability of each measurement outcome and the order the gates were applied in. The alternative gives the circuit as a list of gate names per wire. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A measurement collapses the state and destroys it irreversibly. (2) Superposition means the qubit is in both states at once as a fact rather than as a description. (3) Applying a Hadamard twice returns any state to itself. |

#### 80. `computing.neural-network` — A small neural network

| Field | Value |
|---|---|
| Subject · band · age | `computing` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can update a weight by hand and say how overfitting looks. |
| Interaction | Set the inputs and the targets; the network and the loss curve update; type the new weight and the loss. |
| Model | The forward pass and the backpropagation update are computed by the sim with a DECLARED learning rate, and the loss curve is the one the update produces — the row's focus names 'weights, learning by hand, overfitting', and 'by hand' means the student must be able to reproduce ONE update. The card therefore requires the update to be gradeable from three printed quantities (input, weight, learning rate, error), which is only possible if the activation is declared. |
| Answer | `{ newWeight: number, output: number, loss: number, overfitting: boolean, epoch: number\|null }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the overfitting claim · `single_choice` for the activation's effect · `ordering` for the order of the forward pass and the weight update, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | **The weights are floats accumulated over an epoch and the update is `w − η·δ·x`, so the error compounds multiplicatively over many steps.** `rel: 0.001, abs: 0.0001` on a weight and `rel: 0.005` on the loss, and the card requires the arithmetic to 6 dp because a student rounding a weight to 3 dp before the update gets a different answer and is not wrong for it. **This is the row where `numeric` would fail outright** — a weight of `0.1 − 0.1` is `-2.7755575615628914e-17` in IEEE 754 and a student typing `0` is right. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A network drawn as layers of nodes with the weights written on the connections, and a plot of the loss against epoch with a second curve for the validation set. The task is to report the updated weight, the network's output and whether the model is overfitting. The alternative gives the input vector, the weights, the learning rate and the target. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The loss curve always decreases with every update. (2) Overfitting means the model is too simple. (3) A larger learning rate always converges faster. |

#### 81. `computing.data-compression` — Lossy compression

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compute a compression ratio and say what bitrate budgeting costs in quality. |
| Interaction | Change the quality setting and the image size; the image, the bitrate and the artefacts show; type the ratio and the bitrate. |
| Model | **The compression is DONE, not estimated** — the sim quantises to the declared number of levels and measures the ACTUAL entropy of the result, so the ratio is a property of a real artefact rather than of a formula applied to it. That is also what makes 'why is this file bigger than the last one' answerable, which is the row's focus ('compression ratio vs quality, bitrate budgeting'). |
| Answer | `{ ratio: number, bitrate: number, psnr: number, artefacts: string[] }` — ratio and bitrate dimensionless, PSNR in dB. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the quality setting · `multi_select` for the artefact types visible · `true_false` for the lossless claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | PSNR is `10·log₁₀(MSE)` — a LOG of a mean square — so a 2% error in MSE becomes a 0.9 dB error and the band must be in dB, not relative to MSE. `abs: 0.5 dB` (T-B) and `rel: 0.005` on the ratio. **The card must state the PSNR formula's maximum value, because `10·log₁₀(0)` is `-Infinity` and a perfect reconstruction makes the grader's own arithmetic produce `Infinity` rather than a number.** |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An image shown at two quality settings with the compression artefacts visible, and a table of file size and bitrate. The task is to report the compression ratio, the bitrate and the PSNR. The alternative gives the original dimensions and the number of colour levels used. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A higher compression ratio is always better. (2) Lossy compression is reversible. (3) Bitrate depends only on the file size and not on the time. |

#### 82. `computing.packet-routing` — Packet routing

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read a routing table and say which hop a packet takes. |
| Interaction | Edit the routing table; the topology and the path animate; enter the hop sequence, the total latency and the next hop for a stated destination. |
| Model | Routing is LONGEST PREFIX MATCHING over declared routes — not shortest-path-first — because the row's focus names 'route tables, hops, congestion, latency' and a sim that computes a shortest path is not modelling a router. Congestion is a DECLARED per-link queue that grows with traffic, so the chosen path can change with load and the latency the question grades includes the queueing delay. |
| Answer | `{ path: string[], latency: number, nextHop: string, congested: boolean }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the hop sequence, order-sensitive · `numeric` ×2 · `single_choice` for the next hop · `true_false` for the longest-prefix claim · `true_false` for the queueing claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A network diagram with routers labelled and a packet shown moving along a highlighted path, with the routing table listed beside it. The task is to give the sequence of hops, the total latency and the next hop for a stated destination. The alternative gives the topology as a list of links with their latencies and the routing table as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A router picks the shortest path by hop count. (2) A route table entry is matched on any part of the address. (3) Queueing delay does not contribute to the end-to-end latency. |

#### 83. `computing.error-detection` — Error detection

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compute a parity bit and say why a parity bit cannot correct an error. |
| Interaction | Send a word; the parity bit and the received word show; enter the parity bit, the error position and the corrected word. |
| Model | Parity is computed by XOR over the declared bit positions and the Hamming code places the check bits by POWER-OF-TWO SUBSCRIPT, so the row's focus ('parity, Hamming codes, checksums') is modelled by the same rule the code uses. Error POSITION comes from XOR-ing the received syndromes — which is the derivation — and the card requires the position to be reported as an integer in the declared bit-numbering convention, because a student numbering from 1 on the right and the sim numbering from 1 on the left agree on the answer and disagree on the number. |
| Answer | `{ parityBit: number, errorPosition: number\|null, corrected: string, detected: boolean }` — exact integers and bit strings. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `short_text` with `EXACT` for the corrected word · `true_false` for 'parity detects two errors' · `single_choice` for the syndrome. · `worked_solution` for the syndrome computation, one step per check bit. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **This is the clearest T-F card in computing**: the parity bit is a BIT and the corrected word is a STRING, so both are exact and no tolerance is available. A `rel` band on a bit would accept 0.5. The bit-string comparison must be case-insensitive and whitespace-normalised, which `canonicalText` does (`grading.ts:223-236`). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A data word with parity bits marked at the power-of-two positions, and a received word with one bit changed. The task is to report the parity bit, which bit is wrong and the corrected word. The alternative gives both words as strings and names the parity convention. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A parity bit detects and corrects a single error. (2) Two errors in different bits are always detected. (3) The checksum is a different kind of code from the Hamming code rather than a weaker one. |

#### 84. `computing.state-machines` — State machines

| Field | Value |
|---|---|
| Subject · band · age | `computing` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can design a controller and say why it is complete. |
| Interaction | Add states, transitions and outputs; the machine traces an input sequence; write the account of its completeness. |
| Model | **The sim checks the machine and refuses to judge it.** Reachability from the initial state, dead states, and whether every defined input has a transition from every reachable state are all computed — and a machine failing them is REPORTED as incomplete with the offending state named. Whether that is acceptable for the task is the marker's judgement, and the row's focus is 'design a controller; rubric on completeness', so the rubric bands are in the card and the sim supplies the evidence. |
| Answer | `{ states: string[], transitions: string[], complete: boolean, missingTransitions: string[], account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `ordering` for the trace order, order-sensitive · `multi_select` for the missing transitions · `true_false` for the reachability claim · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`) reports `GRADED: 0`. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A diagram of states as circles with labelled transitions between them and the outputs written inside, with one input sequence traced. The task is to report the trace order and to say whether the machine is complete, with reasons. The alternative gives the state list and the input alphabet. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A machine with no dead states is complete. (2) Every state needs a transition on every input. (3) Two states with the same outputs are the same state. |

#### 85. `earth.water-cycle` — The water cycle

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can name the fluxes and the reservoirs and say which of them has the longest residence time. |
| Interaction | Move the flux rates; the cycle diagram and the reservoir boxes update; enter each flux's name and the residence times. |
| Model | Reservoirs hold a STOCK and fluxes move a RATE, and the sim computes residence time as stock ÷ flux rather than storing it — because a residence time is a consequence of the other two and a sim that stores all three has three numbers to keep in step. The row's focus names 'fluxes, reservoirs, residence times' and that is exactly the derivation. |
| Answer | `{ fluxes: string[], residence: Record<string, number> }` — years, in scientific notation. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the fluxes · `numeric` ×2 for a residence time · `ordering` for the reservoirs by residence time, which is order-sensitive and is the answer · `true_false` for the groundwater claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A diagram of the water cycle with arrows between labelled reservoirs and the flow rate written on each arrow, with each reservoir's volume listed. The task is to name each flow and to work out the residence time of two named reservoirs. The alternative gives the volumes and flow rates as a table, so every answer is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Water is created or destroyed in the cycle. (2) All reservoirs have the same residence time. (3) Transpiration moves water between the atmosphere and the ocean. |

#### 86. `earth.carbon-cycle` — The carbon cycle

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can separate the fast and the slow cycles and say where a human perturbation enters. |
| Interaction | Add a flux to either cycle; the stock-and-flow diagram updates; write the account of the perturbation's effect. |
| Model | Two SEPARATE stock-and-flow networks — the fast atmospheric cycle and the slow geological cycle — with a DECLARED transfer between them. The row's focus is 'fast vs slow cycles; human perturbation' and that distinction cannot be made by one diagram with two time scales annotated, which is why there are two networks. The rubric is in the card and the sim does not judge the written account. |
| Answer | `{ perturbedFlux: string, atmosphericChange: number, timescale: string, account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `multi_select` for which cycle a flux belongs to · `numeric` for the atmospheric change · `ordering` for the fluxes by timescale, which is order-sensitive and is the reasoning question · `free_response` for the account. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`) reports `GRADED: 0` for an AUTO rubric item. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | Two diagrams side by side: a fast cycle between the atmosphere, the ocean and living things, and a slow cycle through rock, sediment and the ocean floor, with the flux rates on the arrows. The task is to say which cycle a given flux belongs to and to account for the effect of a stated human input. The alternative gives both networks' stocks and flow rates as tables. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Fast and slow cycles are interchangeable. (2) Fossil carbon is part of the fast cycle. (3) Carbon is only in the atmosphere and the ocean. |

#### 87. `earth.nitrogen-cycle` — The nitrogen cycle

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence fixation, nitrification and denitrification and say what each needs. |
| Interaction | Place the nitrogen forms and the processes; the cycle builds; enter the processes in order and the form each produces. |
| Model | The cycle is a nitrogen-FORM graph (`N₂`, `NH₄⁺`, `NO₃⁻`, organic N) with processes as labelled edges, and the ordering answer is the sequence of processes that moves nitrogen from atmosphere to soil and back. `orderMatch` is the instrument: the order IS the content of the row's focus and a set matcher would mark 'fixation and denitrification, in that order' and 'in the other order' the same. |
| Answer | `{ sequence: string[], forms: Record<string, string>, fixationEnergy: number\|null }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the process sequence, order-sensitive · `short_text` for the form produced by each process · `numeric` for the fixation energy · `true_false` for the lightning and temperature claims. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A cycle diagram with nitrogen in different chemical forms placed as boxes and arrows labelled with the process names. The task is to put the processes in order and to say what form each one produces. The alternative gives the forms and the processes as two lists to be matched and ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Plants take up gaseous nitrogen directly. (2) Nitrification converts nitrate to ammonium. (3) Nitrogen fixation needs no energy. |

#### 88. `earth.rock-cycle` — The rock cycle

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can sequence igneous to sedimentary to metamorphic and say which timescale each step takes. |
| Interaction | Press heat or pressure or erosion; the rock changes and the clock advances; enter the pathway in order and the timescale. |
| Model | **The clock is the point.** Each transition advances a declared model age by an amount depending on the process, so a sedimentary pathway takes millions of years and a metamorphic one takes fewer — and the row's focus names 'pathways, timescale'. The graded ORDER is the pathway, and the log-scale timeline is what shows that a cycle is not reversible on a human timescale. |
| Answer | `{ pathway: string[], age: number, rockType: string, timescale: string }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the pathway, order-sensitive · `numeric` for the age · `single_choice` for the rock type · `true_false` for the 'rocks do not change' claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A timeline with rock types appearing and changing along it, each transition labelled with the process and the time it takes. The task is to put the pathway in order, give the age of the resulting rock and name its type. The alternative gives each process's duration and what it does in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The rock cycle is a closed loop on a human timescale. (2) Sedimentary rock forms from magma. (3) Metamorphism adds or removes material rather than changing it. |

#### 89. `earth.plate-tectonics` — Plate tectonics

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can name the three boundary types and say what each produces. |
| Interaction | Set the plate velocities; the boundary types and the landform produced draw; enter the boundary type, the landform and the rate. |
| Model | **The velocities are the model.** Seafloor spreading rate, subduction rate and the transform slip are computed from the declared plate velocities and the boundary type is DERIVED from their directions — a sim where the boundary type is a chosen label and the velocities follow cannot ask the question the row's focus names ('boundary types, seafloor spreading, subduction'). |
| Answer | `{ boundary: 'divergent'\|'convergent'\|'transform', spreadingRate: number\|null, landform: string, depth: number\|null }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the boundary type · `numeric` ×2 · `multi_select` for the landforms each boundary can produce · `true_false` for the subduction claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | The spreading rate is a difference of two velocities in mm/yr, so it is exactly graded (T-A) — `10 mm/yr` is not `1.0 cm/yr` for a string comparison, so `EXACT` on the numeral and the unit stated in the key. **A card that grades '1.0 cm/yr' against a key of '10 mm/yr' with EXACT will fail every correct student**, and the card must fix one unit. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | Two plates drawn moving apart or together with the boundary between them and the landform produced marked. The task is to name the boundary type and to report the rate at which the plates are moving relative to one another. The alternative gives both plates' velocities as vectors. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Subduction happens at a divergent boundary. (2) Seafloor spreading destroys as much crust as it creates. (3) Transform boundaries produce new crust. |

#### 90. `earth.earthquake-waves` — Seismic waves

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can tell P from S waves and locate an epicentre from an arrival-time difference. |
| Interaction | Place three stations; the wave arrivals plot against time; type the arrival times and the distance to the epicentre. |
| Model | **Arrival time is `distance/v − distance/v_s` and the epicentre is found by trilateration from three stations**, so the sim computes distances from the arrival-time DIFFERENCE and then intersects — which is the row's focus ('travel time, locating an epicentre') and a method a sim that drew circles would only illustrate. The wave speeds are declared parameters, as is the surface-to-hypocentre distance. |
| Answer | `{ distance: number, arrivalP: number, arrivalS: number, epicentre: {x, y} }` — km and seconds. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for which wave arrives first · `ordering` for the arrival times of the three stations by distance, order-sensitive · `true_false` for the shadow-zone claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The distance is a subtraction of two arrival times divided by a difference in speeds, so a 0.1 s timing error on a 6 s difference is a 1.7% error in distance and the three circles intersect at an angle that amplifies it further. `rel: 0.02` with the card requiring the arrival times to 2 dp, and the tolerance band is a real measurement band rather than slack. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A map with three seismic stations marked and circles drawn round each showing the arrival times, and the wave fronts expanding from an epicentre. The task is to report the distance from each station and where the epicentre is. The alternative gives the three arrival times and the two wave speeds, so the distance is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) P waves travel through the core. (2) S waves are faster than P waves. (3) An earthquake's epicentre is where the surface rupture is. |

#### 91. `earth.weather-fronts` — Weather fronts

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read an isobar chart and say which front will arrive and what it will bring. |
| Interaction | Change the isobar pattern; the front symbols and the pressure field draw; enter the front type, its direction and the expected weather. |
| Model | The pressure field is solved from the declared isobar GEOMETRY rather than drawn, and a front is classified from the isobars' angle and the wind change across it — the row's focus names 'isobars, fronts, pressure systems, forecasting' and the classification is a computed consequence of the field, not a label. |
| Answer | `{ front: 'warm'\|'cold'\|'occluded', direction: string, weather: string[], pressure: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the front type · `multi_select` for the expected weather · `numeric` for the pressure · `ordering` for the fronts in arrival order, which is order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A map of isobars with pressure values written on them, fronts drawn with their symbols, and wind arrows at named stations. The task is to name the front, say which way it is moving and what weather it brings. The alternative gives the isobar values and the wind directions at each station. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A cold front brings a longer period of rain than a warm front. (2) Isobars show the wind direction rather than the pressure. (3) Pressure falls behind a cold front and rises. |

#### 92. `earth.climate-zones` — Climate zones

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can place a place in a climate zone from its latitude and insolation and name its Köppen letter. |
| Interaction | Choose a latitude and a season; the insolation and the temperature profile plot; type the climate zone and its Köppen letter. |
| Model | Insolation is computed from latitude and the solar DECLINATION, so the seasonal swing is a consequence of the orbital geometry rather than a lookup — and the row's focus names 'latitude, insolation, Köppen classification', which needs the insolation to be real. The Köppen letter is derived from the temperature and precipitation thresholds declared in the model. |
| Answer | `{ zone: string, koppen: string, insolation: number, meanTemp: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `single_choice` is the PRIMARY type for the zone and the Köppen letter. `simulation` carries the case where the student must read the insolation curve themselves. `numeric` for the insolation. `multi_select` for the features that place a place in a zone. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A graph of insolation against time of year at a chosen latitude, and a temperature profile. The task is to name the climate zone and its Köppen letter. The alternative gives the latitude, the altitude and the monthly temperatures and rainfall as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Climate zone is determined by longitude. (2) Insolation at the equator is constant through the year. (3) The Köppen classification uses rainfall totals alone. |

#### 93. `earth.ocean-circulation` — Ocean circulation

| Field | Value |
|---|---|
| Subject · band · age | `earth` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say how density drives the thermohaline circulation and why upwelling brings nutrients. |
| Interaction | Change temperature and salinity; the density and the overturning plot; type the transport rate and where upwelling occurs. |
| Model | `ρ(T, S)` is a DECLARED equation of state rather than a linear approximation, because the row's focus names 'thermohaline, upwelling, heat transport' and the nonlinearity of density in temperature versus salinity is the physical content. The overturning is a two-box model whose strength is computed from the density difference, and the upwelling is where the divergence is. |
| Answer | `{ density: number, transport: number, upwellingRate: number, heatTransport: number }` — kg/m³, Sv, W. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for the density driver · `true_false` for the upwelling-nutrient claim · `ordering` for the circulation path, order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | Density differences in seawater are around `0.025 kg/m³` on a background of `1025` — a 0.002% difference that decides whether the circulation runs at all. **This is the case where an absolute tolerance is mandatory and a relative one is useless**: `abs: 0.0005 kg/m³` on the density, and `rel: 0.02` on the transport, which is the quantity a student can actually reason about. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A section through the ocean basin with the deep and surface flows drawn as arrows, and a density profile down the water column. The task is to report the density difference driving the circulation, the transport rate and where upwelling brings water to the surface. The alternative gives the surface and deep temperatures and salinities at two latitudes. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Thermohaline circulation is driven by wind alone. (2) Warm water is denser than cold. (3) Upwelling brings warm water to the surface. |

#### 94. `earth.soil-profile` — Soil profiles

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can put the horizons in order and say how each one forms. |
| Interaction | Dig a profile; the horizons stack; enter the horizons in order and what each is made of. |
| Model | The profile is a stack of ORDERED horizons with declared thicknesses, and the grading is `orderMatch` because the ORDER is the content of the row's focus ('horizons, formation rates'). Formation rates are separate declared parameters so a student can be asked how long a horizon takes without that being the ordering answer. |
| Answer | `{ horizons: string[], depths: Record<string, number>, drainage: 'free'\|' impeded'\|'waterlogged' }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the horizons, order-sensitive · `numeric` for a horizon's depth · `single_choice` for the drainage class · `true_false` for the eluviation claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A cut-away soil profile with the horizons labelled top to bottom and their thicknesses marked. The task is to put the horizons in order from the surface down and to give the depth of one of them. The alternative gives the thicknesses and the process descriptions in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Horizons are in the order formed. (2) Eluviation moves material DOWN into a horizon. (3) A waterlogged soil is well aerated. |

#### 95. `earth.atmosphere-layers` — Atmospheric structure

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can order the layers and say what the temperature profile does at each boundary. |
| Interaction | Change the temperature profile; the layers and the ozone column draw; enter the layers in order and where the temperature reverses. |
| Model | The temperature profile is a DECLARED piecewise function with a REVERSAL at each boundary, and the layer names are derived from where the reversal falls — which is the row's focus ('layers, temperature profile, the ozone layer') and the only model in which a student who gets the reversal wrong cannot still place the mesopause. |
| Answer | `{ layers: string[], reversals: number[], ozonePeak: number\|null }` — kilometres. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the layers, order-sensitive · `numeric` ×2 for the reversal heights · `single_choice` for the layer with the ozone · `true_false` for the 'temperature falls all the way up' claim. |
| Tolerance class | `H` — T-H · ordered sequence. |
| Float hazard | a surplus entry occupies a position (`grading.ts:359`), so state whether it is wrong or truncated |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of temperature against height with the layers labelled and the reversals marked, and a band showing where ozone is concentrated. The task is to put the layers in order and to report the heights at which the temperature reverses. The alternative gives the temperature at a set of heights as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Temperature falls monotonically with height. (2) The ozone layer is where temperature is lowest. (3) The troposphere is thicker than the stratosphere. |

#### 96. `earth.energy-balance` — Planetary energy balance

| Field | Value |
|---|---|
| Subject · band · age | `earth` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute an equilibrium temperature from albedo and say why it differs from the surface temperature. |
| Interaction | Change albedo and the emissivity; the incoming and outgoing arrows and the temperature profile draw; type the equilibrium temperature. |
| Model | `T_eq = ((1−A)·S/(4σ))^(1/4)` with `σ = 5.67×10⁻⁸`, and the sim separates the EQUILIBRICON from the SURFACE temperature by applying a declared emissivity to the surface — the row's focus names 'albedo, absorbed vs emitted, equilibrium temperature' and the gap between the two temperatures is the physics. The fourth root means the answer is very insensitive to albedo, which the sim shows by letting the student sweep it. |
| Answer | `{ equilibrium: number, surface: number, albedo: number }` — kelvin. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for 'albedo 0.3 gives a hotter Earth than albedo 0.7'. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | **A fourth root.** A 10% error in albedo becomes about 2.5% in temperature, and the constants `S = 1361 W/m²` and `σ = 5.67×10⁻⁸` are rounded. `rel: 0.005` and the card states both constants. **A card that asked for the temperature in °C would be the `abs`-tolerance case instead, because the °C value is offset from the K value and the same physical band is a much larger fraction of it** — so the card fixes the unit and states why. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A planet drawn with an incoming solar beam, an outgoing thermal beam and a surface, with the albedo and the equilibrium temperature labelled. The task is to report the equilibrium temperature, the surface temperature and the albedo. The alternative gives the solar constant, the albedo and the emissivity. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The equilibrium temperature is the surface temperature. (2) Incoming and outgoing radiation balance at every altitude. (3) Doubling the albedo doubles the temperature. |

#### 97. `earth.glaciers` — Glaciers and mass balance

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say how accumulation and ablation balance and read a consequence for sea level. |
| Interaction | Change the snowfall and the temperature; the glacier's extent and the mass-balance line plot; type the equilibrium line altitude and the annual mass change. |
| Model | Mass balance is `accumulation − ablation` computed from DECLARED functions of altitude and temperature, and the equilibrium line altitude is a ROOT of that difference — so it is solver-dependent and the card requires the residual. Sea-level contribution is computed as the volume of ice lost divided by the ocean AREA, which is the step students skip, and the card requires that intermediate value to be reported. |
| Answer | `{ equilibriumLine: number, annualBalance: number, seaLevelRise: number\|null }` — metres and mm/year. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the regime (advancing or retreating) · `true_false` for the 'ice displaces water' claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The equilibrium line is a root of a difference of two exponentials in altitude, which is stiff. `abs: 50 m` on the line altitude and `rel: 0.05` on the mass balance, and the card requires the solver's residual — a stiff root at a coarse grid gives a line altitude that is wrong by hundreds of metres and a band narrow enough to hide it would be dishonest. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A glacier drawn with its surface and the snowline marked, and a graph of annual mass balance against altitude crossing zero. The task is to report the equilibrium line altitude, the annual mass balance at the snout and the resulting sea-level change. The alternative gives the snowfall and temperature profiles with altitude. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Floating ice raises sea level when it melts. (2) A glacier advances when ablation exceeds accumulation. (3) The equilibrium line is at the bottom of the glacier. |

#### 98. `earth.hazards` — Natural hazards

| Field | Value |
|---|---|
| Subject · band · age | `earth` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can write a mitigation proposal and say why the risk is not the same as the hazard. |
| Interaction | Set the hazard, exposure and vulnerability; the risk score and the loss estimate compute; write the mitigation proposal. |
| Model | **The sim computes the risk score and refuses to compute the recommendation.** Risk = hazard × exposure × vulnerability is arithmetic; which mitigation is appropriate depends on cost, timescale and who bears the risk, and a machine that chose would produce advice nobody should act on. The rubric bands are in the card; the shipped precedent for a rubric sim is `physics.free-body-diagram`. |
| Answer | `{ risk: number, expectedLoss: number, proposal: string, justification: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 · `free_response` for the proposal, carrying the rubric · `ordering` for the sequence of mitigation measures by timescale, order-sensitive · `true_false` for the hazard-versus-risk claim. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A map of a settlement in a hazard zone with the hazard, exposure and vulnerability scores listed for two named locations. The task is to report the risk score and the expected loss for each and to propose a mitigation. The alternative gives the three factors for each location as numbers. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Risk is the same as hazard. (2) Building defences always reduces exposure. (3) Vulnerability depends only on the physical setting. |

#### 99. `general.data-literacy` — Reading a graph

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can say what a chart's axes and scale are doing to the claim it makes. |
| Interaction | Rescale the axes, truncate the axis and change the interval; the chart redraws; name which claim the chart now supports. |
| Model | **The SAME data is drawn six ways and the sim grades the CLAIM, not the chart.** Each axis manipulation is a declared transform applied to one dataset, so the student is comparing interpretations of a fixed fact, which is the row's focus ('axis honesty, scale, misleading charts'). The claim set is enumerated in the card, which is what makes T-F the right instrument. |
| Answer | `{ misleading: boolean, which: string, trueTrend: string, correction: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `single_choice` is the PRIMARY type — which-of-these-charts-supports-the-claim is a four-way choice. `simulation` carries the case where the student must produce the misleading chart themselves, which is the PATH_SENSITIVE version. `true_false` per manipulation. `multi_select` for the manipulations present. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two versions of the same chart side by side, differing only in the axis treatment, with both axes labelled and their ranges printed. The task is to say which version supports the claim and to describe the underlying trend correctly. The alternative gives the underlying data as a table so the trend can be established without either chart. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A chart showing a steep rise from a truncated axis shows a steep rise. (2) The scale of a chart does not affect what it shows. (3) Two charts of the same data can both be honest. |

#### 100. `general.spreadsheet-modelling` — Spreadsheet modelling

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can build a model whose structure makes its assumptions visible. |
| Interaction | Enter values and formulas in a grid; the outputs recalculate; write the account of the model's structure and assumptions. |
| Model | **The grid recalculates a declared formula graph and the sim reports which cells the outputs DEPEND ON** — the row's focus is 'build a model; rubric on structure and assumptions' and structure means the dependency graph, which is computable even though adequacy is not. The sim shows circular references and hard-coded constants, which are the two structural defects, and refuses to accept a model with either unmarked. |
| Answer | `{ outputs: Record<string, number>, dependencies: Record<string, string[]>, constants: string[], account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 for the outputs · `multi_select` for the hard-coded constants · `ordering` for the calculation order, which is order-sensitive and is the structure question · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A grid of labelled cells with the inputs shaded, the formulas shown and the outputs boxed, with the dependencies drawn as arrows between cells. The task is to report the output values and to account for the model's structure and assumptions. The alternative gives the inputs and the formulas as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A model is correct if its outputs are right for one input. (2) Circular references are a normal modelling technique. (3) A hard-coded number inside a formula is harmless. |

#### 101. `general.uncertainty` — Measurement uncertainty

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can propagate an uncertainty and say when worst case and RSS disagree and why. |
| Interaction | Enter quantities with uncertainties; both propagation rules compute; type the two answers and the significant figures. |
| Model | **Both rules compute from the same declared uncertainties, and the sim reports the RATIO between them** — because the row's focus names 'worst case vs RSS' and the ratio IS the disagreement, so a card that graded only the two numbers separately would let a student miss the point. `maths.measurement-error` is the same physics with a different framing and the two sims deliberately share the model. |
| Answer | `{ worstCase: number, rss: number, ratio: number, significantFigures: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for when worst case and RSS agree · `true_false` for the 'errors cancel' claim · `ordering` for the steps of a propagation, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The two rules differ by a factor of between `√n` and `n`, so **a card that grades only one of them has removed the question.** `rel: 0.005` on each and on the ratio, with `abs` on the significant figures as an integer (T-A for that field). The card must grade all three numbers. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A table of measured quantities each with an uncertainty, and two bars showing the propagated uncertainty by each rule. The task is to report the result by both rules, the ratio between them and the number of significant figures the answer supports. The alternative gives every measurement and its uncertainty as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Uncertainties add in quadrature when added. (2) An uncertainty keeps the same significant figures as the value. (3) Worst case and RSS give the same number for two equal errors. |

#### 102. `general.experimental-design` — Experimental design

| Field | Value |
|---|---|
| Subject · band · age | `general` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can design a fair test and say which variable you have not controlled. |
| Interaction | Set the variables and the repeats; the results plot with the spread; write the account of the design. |
| Model | **The sim runs the experiment and shows what the design ACTUALLY detects.** With a declared effect size and a declared noise level, a design with too few repeats, an uncontrolled variable or an unfair baseline produces data that does NOT distinguish the two hypotheses, and the sim says so with the overlap on the plot. The row's focus names 'controls, variables, repeated trials; rubric' and this is the mechanism: the design's inadequacy is visible in the data before anyone reads the writing. |
| Answer | `{ effectVisible: boolean, controlled: boolean, repeatsRecommended: number, account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `true_false` for the effect visibility · `single_choice` for the uncontrolled variable · `numeric` for the repeats needed · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A scatter plot of results under two designs, one with the effect distinguishable and one with the points overlapping, and a table of the variables with one left uncontrolled. The task is to say whether the design can detect the effect and to account for the controls. The alternative gives both conditions' data as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) One trial per condition is enough if the effect is large. (2) Changing a second variable alongside the independent one improves the experiment. (3) Repeated trials of only one condition improve the comparison. |

#### 103. `general.scientific-writing` — Writing a lab report

| Field | Value |
|---|---|
| Subject · band · age | `general` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can write a claim, the evidence for it and the reasoning that connects them. |
| Interaction | Write the report in the sections; the sim checks the STRUCTURE it can check; submit for marking. |
| Model | **The sim checks structure and the marker checks argument.** It verifies that each declared section is present, that the numbers quoted in the claim appear in the results, and that the conclusion is not longer than the evidence — three things that are mechanically checkable and three of the commonest faults. Whether the reasoning is SOUND is the rubric's business and the shipped precedent for a rubric sim is `physics.free-body-diagram`. |
| Answer | `{ sections: Record<string, string>, numbersConsistent: boolean, claimSupported: boolean, reasoning: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `true_false` for the two structural checks · `free_response` for the reasoning, carrying the banded rubric · `multi_select` for the faults present. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A report form with sections for aim, method, results, discussion and conclusion, with the results section pre-filled with a table of numbers. The task is to write the claim and the reasoning that connects it to the evidence. The alternative gives the results table so every number quoted can be checked. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A conclusion is a restatement of the aim. (2) Numbers quoted in the discussion need not appear in the results. (3) An unsupported claim is still a conclusion. |

#### 104. `general.critical-thinking` — Evaluating a claim

| Field | Value |
|---|---|
| Subject · band · age | `general` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can judge a claim by the quality of its evidence and name a fallacy in it. |
| Interaction | Read a claim and its supporting evidence; identify the evidence quality and any fallacy; submit. |
| Model | **The sim presents the evidence in full and refuses to rule on the claim.** The row's focus names 'evidence quality, bias, fallacies; rubric' and whether an argument is persuasive is a judgement; what the sim contributes is the EVIDENCE PACK — the base rates, the sample sizes and the provenance of each claim — laid out so the marker is arguing about the same thing the student saw. The fallacy list is enumerated, which is what lets a set of them be graded at all. |
| Answer | `{ fallacy: string\|null, evidenceQuality: string, strength: string, reasoning: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `single_choice` for the fallacy · `single_choice` for the evidence quality · `free_response` for the reasoning, carrying the rubric · `true_false` for the base-rate claim. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A claim stated at the top with the evidence listed beneath it, each item showing its source, sample size and whether it is base-rate-correct. The task is to identify the fallacy and judge the evidence quality. The alternative gives the same evidence as a table so the judgement can be made from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) An argument with no fallacy is sound. (2) Evidence quality is independent of the sample size. (3) A claim's plausibility is evidence for it. |

#### 105. `general.estimation` — Fermi estimation

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can break a quantity into an estimate and a stated factor, and say why order of magnitude is the claim. |
| Interaction | Build an estimate as a chain of factors; the running product updates; type the estimate and the order of magnitude. |
| Model | **The chain is a product of declared factors each with its own declared uncertainty**, and the running product and its PROPAGATED uncertainty are both shown — the row's focus is 'order-of-magnitude reasoning' and a Fermi estimate's honest answer is a magnitude with a factor-of-ten band, not a point. The sim therefore grades the order of magnitude and the band, not the digits. |
| Answer | `{ estimate: number, orderOfMagnitude: number, band: [number, number] }` |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the order of magnitude · `multi_select` for which factors were misestimated · `true_false` for the 'exact answer' claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | **This is the card where a relative tolerance is the only honest instrument and a tight one is dishonest.** A Fermi estimate is worth a factor of two to five; `rel: 2.5` (a factor of 2.5 either way) with NO absolute floor (T-C), and the card states that this band is the definition of the task and not slack. A card with `rel: 0.05` here would be grading arithmetic the task explicitly does not ask for. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A chain of factors each in a box with the running product below and the propagated range shown. The task is to give the estimate, its order of magnitude and the range within which it is defensible. The alternative gives the quantities to estimate as text with a worked first factor. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A Fermi estimate should be precise to one per cent. (2) The estimate's quality depends on the precision of the factors. (3) Rounding each factor before multiplying improves the estimate. |

#### 106. `general.dimensional-analysis` — Dimensional analysis

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can check a formula's dimensions and say which combination is dimensionally possible. |
| Interaction | Enter a formula; its dimensions reduce symbolically; enter the dimension of each quantity and which candidate formula survives. |
| Model | **The dimension reduction is a real symbolic pass over the declared base dimensions** (M, L, T, I, Θ, N, J), not a lookup — and a formula whose dimensions do not match is REFUSED with the mismatch printed, because the row's focus is 'unit algebra as a check on a formula' and the check is the mechanism. A formula that passes the dimensional check is NOT thereby correct, and the card says so. |
| Answer | `{ dimensions: Record<string, string>, valid: string[], invalid: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the dimensionally valid candidates · `short_text` with `EXACT` for the reduced dimensions · `single_choice` for the mismatch · `true_false` for 'dimensionally valid implies correct'. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **No numeric answer on this card: the gradeable quantities are strings, so it is T-G/T-F.** The plan's `E` for this row is correct and the card keeps EXACT. A tolerance is not available for a dimension string and a card that adds one is inventing an instrument. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A formula written in symbols with a row beneath it showing each quantity's dimensions in base units, and a set of candidate formulas listed. The task is to say which candidates are dimensionally possible. The alternative gives each quantity's dimensions as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A dimensionally valid formula is correct. (2) Dimensional analysis can prove a formula's coefficient. (3) Angles have no dimension rather than being dimensionless. |

#### 107. `general.scale-similarity` — Scale and similarity

| Field | Value |
|---|---|
| Subject · band · age | `general` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which quantity scales with length, with area and with volume, and predict a model's behaviour. |
| Interaction | Change the scale factor; the model and the full-size object draw; type the mass ratio, the strength ratio and the predicted behaviour. |
| Model | **The three scaling laws are computed SEPARATELY and reported separately** — mass `∝ L³`, cross-section `∝ L²`, strength-to-weight `∝ L⁻¹` — because the row's focus is 'scaling laws, model/prototype reasoning' and the collapse of the first two into one intuition is the misconception. The sim shows a full-size object beside the model so the comparison is visual as well as numerical. |
| Answer | `{ massRatio: number, areaRatio: number, strengthToWeightRatio: number, prediction: string }` — exact where integer, else `rel: 0.01`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the prediction · `true_false` for the scaling claim · `multi_select` for which quantities scale with length. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The ratios are exact POWERS of the scale factor, so they are exactly gradeable when the scale factor is a declared rational (T-A/F) — `rel: 0.005` only where the factor is drawn from a measurement. **The card requires the scale factor to be a declared number, not a slider reading**, because a card whose scale factor is read off a canvas cannot be graded exactly at all. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A shape drawn twice, once small and once at full size, with the lengths, cross-sectional areas and masses labelled for each. The task is to report the ratios of mass, area and strength-to-weight between the two. The alternative gives the full size's dimensions and mass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Halving the length halves the mass. (2) A smaller model is relatively stronger. (3) Doubling a bridge's length doubles its load capacity. |

#### 108. `general.chess-endgames` — Chess endgames

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can search for mate in N and say what an evaluation function misses. |
| Interaction | Load a position; the search tree expands; enter the mate distance, the best move in algebraic notation and the evaluation. |
| Model | **The search is exhaustive to a DECLARED depth with a named evaluation function**, and the sim reports the number of positions searched — so 'mate in 3' is a claim about a search, not an oracle, and the row's focus ('mate-in-N search, evaluation, tablebases') depends on the student seeing the depth. An evaluation without a mate is the model's opinion and the card says so. |
| Answer | `{ mateIn: number\|null, bestMove: string, evaluation: number, positionsSearched: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `short_text` with `REGEX_SET` for algebraic notation, accepting both `Nf3` and `N1f3` · `single_choice` for the best move · `ordering` for the principal variation, order-sensitive · `true_false` for the evaluation claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **Notation is the hazard.** `Nf3`, `N1f3` and `N-f3` are the same move in three spellings, and `canonicalText` folds case and whitespace and nothing else, so `N-f3` will not equal `Nf3`. **The card must enumerate the accepted spellings** (T-F) and the eval score is EXACT (T-A) because the engine's own arithmetic is the answer. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A chess position on a board with labelled squares, a move list beside it, and the evaluation shown. The task is to find the mate distance, name the best move and give the evaluation. The alternative gives the position as a FEN string and the search depth. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A mate-in-3 is forced regardless of the defence. (2) An evaluation function is an oracle. (3) Search depth does not change which move is best. |

#### 109. `general.bridge-building` — Bridge building

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can build a structure within a budget and say what the trade-off cost. |
| Interaction | Place members against a budget; the structure loads and deflects; type the cost, the deflection and whether it held. |
| Model | The load is applied and the DEFLECTION is computed by a real solve rather than a rule of thumb, so an over-budget structure visibly fails and the failure mode is named (buckle, tension, excessive deflection). The row's focus is 'structural efficiency under a budget', so the graded quantity is the cost per unit of load carried and the budget is a hard constraint the sim enforces. |
| Answer | `{ cost: number, deflection: number, held: boolean, efficiency: number }` — cost in the given units, deflection in mm. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the failure mode · `true_false` for the budget claim · `ordering` for the members by load carried, order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The cost is a sum of declared unit costs and the deflection comes from a solve — **two quantities on one card with two different instruments.** `EXACT` on the cost (T-A, a sum of integers) and `rel: 0.05` on the deflection (T-C, from a numerical solve). Mixing them is a real authoring trap and the card separates them. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A bridge drawn with its members highlighted by the load each carries and the longest deflection marked, with the total cost listed. The task is to report the cost, the maximum deflection and whether the bridge held. The alternative gives the member costs, the available budget and the load. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A stiffer material always gives a stronger bridge. (2) Triangulated and rectangular frames of the same members are equally rigid. (3) Cost is independent of the design. |

#### 110. `general.nutrition-log` — Nutrition and energy balance

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can compute an energy balance from a food record and say what the record does not tell you. |
| Interaction | Enter foods and quantities; the energy totals and the balance compute; type the daily energy, the balance and which macronutrient dominates. |
| Model | Energy is computed from the DECLARED nutrient table per 100 g with the quantity scaled, and the balance is intake minus expenditure with the expenditure computed from the declared activity factors — the row's focus is 'energy accounting, interpreting food labels' and reading the LABEL is the skill, so the card requires the student to extract values from a displayed label rather than be handed numbers. The sim reports the micronutrient gaps it can compute and refuses to judge the diet. |
| Answer | `{ energyKJ: number, balanceKJ: number, macronutrient: string, labelValues: Record<string, number> }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the dominant macronutrient · `multi_select` for the label fields that are per-serving rather than per-100g · `true_false` for the balance claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | `kJ` from `kcal` is ×4.184 and **a per-serving figure used as a per-100 g figure is a factor-of-several error that a relative tolerance cannot distinguish from a student's unit slip** — so the card grades with `rel: 0.05` on the energy AND requires the serving size to be reported as a separate field, so a student who read the wrong basis is visibly distinguishable from one who computed wrongly. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A food label shown with its per-serving and per-100 g figures, and a list of the day's foods with quantities. The task is to work out the day's energy, the energy balance and which macronutrient contributes most. The alternative gives the food labels as text tables. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A food label's energy figure is the same as its calories per 100 g. (2) Energy balance means the macronutrient ratios are correct. (3) A day's record is enough to assess a diet. |

#### 111. `general.sleep-circadian` — Sleep and circadian rhythm

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can model a 24-hour rhythm and say what a phase shift does to it. |
| Interaction | Shift the light schedule; the rhythm curve plots over several days; type the phase after the shift and the time to resynchronise. |
| Model | **The rhythm is a limit cycle of a declared oscillator and the phase shift is applied to the STIMULUS SCHEDULE**, so the model resynchronises the way a real oscillator does — with a transient and a settling time — rather than instantly. The row's focus names 'modelling a 24 h rhythm, phase shift' and an instant resynchronisation would teach nothing about circadian adaptation, which is the thing jet lag is. |
| Answer | `{ phase: number, amplitude: number, resynchronisationDays: number, sleepWindow: [number, number] }` — hours. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the phase direction · `true_false` for the amplitude claim · `ordering` for the sequence of adjustment over successive days, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The phase is a wrap angle, so `0` and `24` are the same phase and the card requires the answer in a stated half-open interval — **[0, 24) — because an EXACT comparison of `23.9` against `24` is wrong by a representation and a relative tolerance around the wrap is meaningless.** `rel: 0.02` on the phase and the resynchronisation time in DAYS as an integer or half-day (T-A for the discretised one). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plot of the alertness curve against clock time across several days, with a vertical line marking the light exposure and the phase of the curve marked. The task is to report the phase after a shift of the light schedule and how long it takes to resynchronise. The alternative gives the oscillator's period, the light schedule before and after, and the shift. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The circadian rhythm resynchronises instantly to a light shift. (2) The rhythm's amplitude is independent of the light exposure. (3) Body time and clock time are the same. |

#### 112. `general.personal-finance` — Personal finance

| Field | Value |
|---|---|
| Subject · band · age | `general` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can amortise a loan and compare two loans on the same money. |
| Interaction | Set the principal, the rate and the term; the balance and payment plots; type the monthly payment, the total interest and the cheaper option. |
| Model | Amortisation is computed by the ANNUITY FORMULA at the declared payment frequency and the balance is carried as a running sum — so the total interest is the sum of the balance BEFORE each payment and not the sum of the payments, which is the arithmetic error the row's focus names ('compound interest, amortisation, comparing loans'). Comparing two loans is done on total cost and the sim prints BOTH, because a lower monthly payment is not a cheaper loan. |
| Answer | `{ payment: number, totalInterest: number, totalPaid: number, cheaper: string }` — to the currency unit. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the cheaper loan · `true_false` for the 'lower payment is cheaper' claim · `ordering` for the balance by month, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The annuity formula involves `(1+r)^n` and is well conditioned over ordinary terms, but **the currency rounding convention matters**: a loan computed with monthly rounding of the balance and one computed without differ by pennies per month and by pounds over a term. The card must state the rounding convention, and grades `abs` at the currency's minor unit (T-B) because the two are legitimate differences of method. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A chart of the loan balance against month with the payments overlaid, and a comparison table of two loans. The task is to report the monthly payment, the total interest and which loan costs less overall. The alternative gives both loans' principal, rate and term. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The loan with the smaller monthly payment is the cheaper loan. (2) The total interest is the sum of the payments. (3) Doubling the term halves the total interest. |

#### 113. `general.map-and-scale` — Maps and scale

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can read a scale bar and a grid reference and say what a projection distorts. |
| Interaction | Measure on the map; the scale bar and the grid draw; enter the real distance, the bearing and which distortion applies. |
| Model | **The map is drawn IN a declared projection and the distortion is computed**, not asserted: a point's ground distance and its distance on the projected plane are both computed and their RATIO is the scale error at that latitude. The row's focus names 'grid references, scale bars, projections, distortion', and a distortion that is a picture of a globe rather than a number cannot be graded. |
| Answer | `{ distance: number, bearing: number, gridRef: string, scaleError: number, projection: string }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `short_text` with `EXACT` for a grid reference · `single_choice` for the projection and the distortion · `true_false` for the scale-bar claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | The scale error is a RATIO of two projected distances and is zero at the projection's standard parallels — **so a relative tolerance is wrong near zero and an absolute one in metres is right** (T-B): `abs: 1%`, stated as a percentage rather than a fraction so the rubric can read it. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A map with a scale bar, a grid and two points marked. The task is to measure the real distance between the points, give the bearing and a grid reference for one of them, and say which projection is in use. The alternative gives the scale bar's length, the grid spacing and the projection's parameters. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A scale bar applies uniformly across the whole map. (2) A projection preserves area and shape simultaneously with angles. (3) A grid reference gives a position rather than an area. |

#### 114. `general.argument-mapping` — Argument mapping

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can map a premise to a conclusion through a warrant and find the weak joint. |
| Interaction | Connect claims with supports, warrants and rebuttals; the map draws; enter the mapping and the weakest warrant. |
| Model | **The map is a directed graph over CLAIM NODES with typed edges**, and the weakest warrant is computed as the claim with the fewest supporting edges relative to its attacking edges — the row's focus names 'premises, warrants, fallacies, rebuttals' and a graph model is what makes a warrant a thing with degree rather than a label. Whether the argument is VALID is not computed, and the card says so. |
| Answer | `{ mapping: string[], warrants: string[], weakest: string, rebuttal: string\|null, fallacies: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the fallacies · `short_text` with `REGEX_SET` for a support relation · `single_choice` for the weakest warrant · `true_false` for the validity claim · `ordering` for the argument's structure, order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **No numeric answer, so T-G/T-F.** The graph's quantities are counts and degrees, which are exact (T-A), and the relations are strings (T-F). This is a card where the plan's `E` is correct. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A diagram of claims as boxes joined by labelled arrows for supports, warrants and rebuttals. The task is to state which claim supports which, identify the weakest warrant and name any fallacy present. The alternative gives the argument as a list of claims each with its stated relations. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A warrant is a premise. (2) An argument with a strong conclusion is valid. (3) A rebuttal is a premise stated more strongly. |

#### 115. `general.interview-skills` — Structured interviewing

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can design questions that get evidence and name where an interview is biased. |
| Interaction | Write the questions and the probes; the transcript records what was asked; submit for marking. |
| Model | **The sim plays the interviewee with DECLARED information held back**, so a question that invites speculation produces an invented answer and a question that asks for an example produces a real one — the row's focus is 'question design, probing, bias; rubric on transcripts' and the bias is a property of the instrument, which the sim can therefore demonstrate. The transcript is the evidence the marker reads, which is what the rubric refers to. |
| Answer | `{ questions: string[], probes: string[], transcript: string[], biasIdentified: string[], account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `multi_select` for the leading questions asked · `free_response` for the account, carrying the rubric · `numeric` ×2 for the information obtained. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A transcript of an interview with each question beside what the interviewee said. The task is to identify the leading questions and to write the account of the bias. The alternative gives the transcript as text so the questions can be identified without the interface. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) An open question always gets more than a closed one. (2) A leading question is harmless in an informal interview. (3) Probing changes the answer's meaning rather than its depth. |

#### 116. `general.safety-procedure` — Following a procedure

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can follow an ordered procedure and report a deviation honestly. |
| Interaction | Work through the procedure step by step; a deviation can be entered and its report submitted; enter the sequence and the deviation report. |
| Model | **The sim INJECTS a declared deviation at a declared step**, so the student's handling of it is a real event in a real procedure rather than a hypothetical — the row's focus names 'ordered steps, hazard checks, deviation reporting' and the hazard check only means something when the hazard occurs. The ORDER of the steps is separately auto-checked with `orderMatch`. |
| Answer | `{ sequence: string[], hazardChecks: string[], deviationDetected: boolean, report: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `ordering` for the sequence, order-sensitive and auto-checked · `true_false` for the deviation detection · `multi_select` for the required hazard checks · `free_response` for the report, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A procedure listed as numbered steps with hazard checks marked beside the relevant ones, and one step flagged as changed. The task is to put the steps in order, to say whether the change was detected and to write the deviation report. The alternative gives the steps as a list to be ordered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A procedure may be followed in any order if each step is understood. (2) A deviation need only be reported to the next person. (3) Hazard checks are a formality once the procedure has started. |

#### 117. `general.simulation-literacy` — Reading a simulation

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can say what a model assumes and omits, and predict where it stops being true. |
| Interaction | Run a simulation with one assumption disabled; the output diverges; write the account of what the model assumes. |
| Model | **The sim runs the SAME system twice with a declared assumption switched off and shows the divergence** — the row's focus is 'what a model assumes and omits; rubric' and an account written without a divergence is an opinion. The sim's own docstring convention (`simulate` pure, no DOM, no clock, declared params) is what the account is graded against, so the rubric refers to a real artefact. |
| Answer | `{ assumptions: string[], omissions: string[], breaksDownAt: string, account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `single_choice` for where the model breaks down · `multi_select` for the assumptions identified · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | The same simulation shown twice, once with an assumption on and once with it off, with the two outputs diverging visibly. The task is to name the assumptions, the omissions and the condition under which the model stops being true. The alternative gives the two outputs as tables. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A simulation predicts what will happen rather than what a model does. (2) A model's assumptions do not affect its outputs. (3) Validation on one case validates the model. |

#### 118. `general.numerical-methods` — Numerical methods

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can run an iteration to convergence and estimate its error. |
| Interaction | Choose the method and the tolerance; the iterates plot; enter the limit, the number of iterations and the error bound. |
| Model | **The iteration is run to a DECLARED tolerance and the sim reports the RESIDUAL AND THE ITERATE COUNT** — the row's focus is 'iteration, convergence, error estimation' and an iteration run to a fixed count cannot support an error claim. Two methods are separate implementations (bisection and Newton) because their convergence orders differ, which is the point of having two. |
| Answer | `{ limit: number, iterations: number, errorBound: number, order: number, converged: boolean }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the order of convergence · `true_false` for the bisection and Newton conditions · `ordering` for the iterates, which is order-sensitive and is the reasoning question. · `worked_solution` for the iteration, one step per iterate with its residual. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **The limit is a root and the answer inherits the solver's stopping criterion.** The card requires the tolerance to be stated and the returned limit to be reported at that tolerance, and grades with `abs` set to the tolerance (T-B) — grading the returned limit to more digits than the iteration was run to is grading the student's luck. The iteration COUNT is exact (T-A) for a deterministic method. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of the iterates converging to a root, with the successive brackets marked and the final residual written beside the root. The task is to report the limit, the number of iterations taken and the error bound. The alternative gives the function, the starting values and the tolerance. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Newton-Raphson works from any starting value. (2) Bisection converges faster than Newton. (3) More iterations always reduce the error below the tolerance. |

#### 119. `general.trend-analysis` — Trend analysis

| Field | Value |
|---|---|
| Subject · band · age | `general` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say when a correlation is spurious and what smoothing does to a trend. |
| Interaction | Add seasonality, a trend and noise to a series; the series and the fitted trend plot; type the trend, the seasonality and whether the correlation is spurious. |
| Model | **Spurious correlation is GENERATED, not asserted.** The sim can construct two series that share a common cause — or a shared trend — so the student SEES a high correlation with no relationship, which is the row's focus ('seasonality, smoothing, spurious correlation') and the only way to teach it. The seasonality is a declared harmonic and the trend is declared, so both are separable and the fitted model's terms are graded. |
| Answer | `{ trend: number, seasonalPeriod: number\|null, spurious: boolean, smoothedEstimate: number\|null, correlation: number }`. |
| Strategy | `ORDER` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for whether the correlation is spurious · `true_false` for the shared-trend claim · `ordering` for the series by period, order-sensitive · `multi_select` for what caused the apparent relationship. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The correlation coefficient is near ±1 in a spurious case, so a relative band is useless there and an ABSOLUTE one on the coefficient is right (T-B): `abs: 0.02` on the correlation, `rel: 0.05` on the trend slope. **A card that graded the correlation to 3 dp would be grading a number that changes with the sample's noise**, and the reviewer should read the band as sampling uncertainty. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two time series plotted against time, one trending up and the other trending up for unrelated reasons, with the fitted trend lines drawn and the seasonal component shaded. The task is to report the trend, whether a seasonality is present and whether the correlation is spurious. The alternative gives both series as tables of values. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A high correlation implies a causal relationship. (2) Smoothing removes noise rather than signal. (3) Two trending series cannot be spuriously correlated. |

#### 120. `general.units-conversion` — Units and conversion

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can carry a unit through a calculation and catch a dimensional slip. |
| Interaction | Enter a quantity with its unit and convert; the dimensional reduction shows; enter the converted value and the dimensional check. |
| Model | **The conversion is a symbolic dimensional pass, not a table lookup** — the row's focus is 'dimensional fluency, error propagation' and a lookup table teaches the conversions the author thought of. Each quantity carries its dimension vector and an expression's dimensions reduce to a scalar or are refused, which is the same mechanism as `general.dimensional-analysis` and the two sims deliberately share it. |
| Answer | `{ converted: number, unit: string, dimensions: string, propagated: number\|null }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `short_text` with `EXACT` for the unit string · `single_choice` for the dimensionally valid form · `true_false` for the conversion claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Unit factors are exact by definition but the CONVERSION is a product of them: Å to nm is `1e-1` and km to cm is `1e5`, so the answer spans decades and `rel: 0.001` is the only honest band (T-C, with no absolute floor — a student converting `1 mm` to `km` needs `1e-6` and an absolute floor in mm would accept anything above it). The card states the input's magnitude. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | An expression with each quantity's unit written beneath it and the reduced unit shown at the right. The task is to convert the result to the requested unit and to report the dimensional reduction. The alternative gives the expression with its units as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Converting a unit changes the quantity. (2) kg·m/s² and N are different dimensions. (3) A dimensional check proves a formula correct. |

#### 121. `general.academic-integrity` — Citing and attribution

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can attribute a source correctly and judge whether a use is honest. |
| Interaction | Match a claim to its source; choose the citation form and whether attribution is required; submit. |
| Model | **The sim presents the source and the use and computes the OVERLAP between them**, so whether an attribution is required is decided from the text rather than from the student's memory of the rule — the row's focus is 'source evaluation, referencing, avoiding plagiarism' and a rule the sim states as text is a rule the sim can test. Citation forms are a CLOSED SET and the card enumerates them, which is what makes EXACT the right instrument. |
| Answer | `{ attributionRequired: boolean, citation: string, sourceQuality: string, reasoning: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for whether attribution is required · `single_choice` for the source quality · `short_text` with `EXACT` for the citation · `true_false` for the honest-use claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **T-F with an enumerated citation set.** A citation style has a fixed format and a card that does not enumerate every accepted form — et al. placement, the DOI form, the date format — will mark correct attributions wrong, and `canonicalText` folds case and whitespace and nothing else. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A paragraph of text shown beside a list of possible sources, each with its author, date and a stated quality. The task is to say which source supports which claim and to write the citation in the required style. The alternative gives the sources and the required style as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Paraphrasing removes the need for attribution. (2) A source found by a search engine is therefore reliable. (3) Attribution is only required for quotations. |

#### 122. `general.exam-technique` — Exam technique

| Field | Value |
|---|---|
| Subject · band · age | `general` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can triage questions and check your own answer against the mark scheme. |
| Interaction | A paper with a time budget; questions are triaged and answered; submit for marking against the mark scheme. |
| Model | **This is a graded, low-stakes drill and the row's focus says so** — the sim marks against the declared mark scheme per question and reports the time spent per question, so the triage is evaluated on whether it produced the marks rather than on whether the order was sensible. The time-per-question distribution is the feedback the row's focus names ('timing, question triage, checking'). |
| Answer | `{ order: string[], marksPerMinute: Record<string, number>, checked: string[], missed: string[] }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for the triage order, order-sensitive and `orderMatch` is correct · `numeric` ×2 · `multi_select` for the missed marks · `true_false` for the timing claim. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **Marks per minute is a RATIO of two measured quantities and is the row's only graded number**, so `rel: 0.1` and NO absolute floor (T-C) — a student who spent 4 minutes on a 4-mark question and one who spent 3.8 are not meaningfully different and an absolute band in marks/minute would be arbitrary. The order is exact (T-F/H). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A paper listed question by question with the marks for each and a clock showing the time remaining. The task is to give the order in which the questions were attempted and the marks per minute on two named questions. The alternative gives the question list, the mark allocations and the time allowed. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Questions should be attempted in the order printed. (2) Time spent per question does not affect the marks. (3) Checking an answer cannot gain marks. |

#### 123. `maths.projectile-motion` — Projectile motion

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict how far a ball travels before it lands, and say which parameter changes that distance most. |
| Interaction | Drag two sliders (speed, angle); Space to play the flight; type the range into the answer box and submit. |
| Model | `simulate` integrates the trajectory at a fixed step rather than evaluating `R = v²sin(2θ)/g`, so the drawn arc and the graded number cannot disagree by construction. `g` is a CONSTANT, not a parameter — the shipped gold sim's spec card is explicit that a projectile sim with a settable gravity is a different simulation. |
| Answer | `{ range: number (m), time: number (s) }`, both to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` carries the range if the sim is not mounted (print, blocked origin) · `short_text` with `NUMERIC_TOLERANCE` is the fallback for a typed-in range from a printed worksheet. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A side view of a ball leaving a launch point at 25 metres per second and 45 degrees above the ground. The task is to report the horizontal distance it travels before landing and the time the flight takes. At 25 m/s and 45 degrees the ball lands about 64 m away after 3.6 seconds, peaking at 32 m. |
| Licence · provenance | `CC-BY-4.0` · `INSPIRED_BY:phet/ball-and-basket` if PhET's launch-angle data is used. See `D-24`: naming `ORIGINAL` for a port of PhET is exactly the laundering that finding describes. |
| Misconceptions | (1) Range is proportional to speed, so doubling speed doubles range — it quadruples it. (2) The ball keeps rising for the whole flight because gravity only acts once it starts falling. (3) The launch angle that maximises range is the one that maximises height. |

#### 124. `maths.quadratic-roots` — Quadratic roots and graphs

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read the two roots off a curve and say what the discriminant tells you before you solve. |
| Interaction | Set a, b and c; the curve redraws; type each root into its own box, or leave both empty if there are none. |
| Model | `roots(a,b,c)` solves `ax²+bx+c=0` and returns `null` for no real roots. Two roots are graded against the EXPECTED SET, never positionally: a student who writes `-1, 3` and one who writes `3, -1` have both found both roots (shipped gold sim, `sims/maths.quadratic-roots/src/grader.ts:31-63`). |
| Answer | `{ rootOne: number\|null, rootTwo: number\|null }`. **No real roots is an answer**: leaving both boxes empty is correct, and the shipped sim has a dedicated `CORRECT_NO_ROOTS` code for it. |
| Strategy | `NUMERIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 for the roots · `true_false` for the discriminant's prediction on a stated pair. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A parabola drawn on a pair of axes, with two boxes for the roots. The task is to work out where the curve crosses the x-axis. The text alternative deliberately does NOT state the roots: they are the answer, and a printed worksheet that prints them has printed its own solution. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. See `D-24` on the provenance register not existing yet. |
| Misconceptions | (1) The discriminant tells you the ORDER of the roots rather than whether they are real. (2) A quadratic that touches the axis has two roots rather than one repeated root. (3) `c = 0` is a special case rather than a root. |

#### 125. `maths.function-transform` — Function transformations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which single transformation turns one graph into another, and what each one does to the vertex. |
| Interaction | Drag the transform buttons; the curve and its pre-image redraw; name the transformation from a list. |
| Model | A transform is `(x, y) ↦ (a·x + h, b·y + k)` applied to a declared base function. The vertex is computed from the SAME parameters the renderer uses, so the stated vertex cannot drift from the drawn one. |
| Answer | `{ transform: 'translate'\|'reflect'\|'scale'\|'none', a: number, h: number, b: number, k: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the named transform · `multi_select` for which effects apply (stretch, shift, flip). |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | Two curves on one pair of axes: a plain curve and the same curve after a sequence of stretches, shifts and flips. The task is to name which transformation was applied and to give the stretch and shift in each direction. The alternative describes the curves and how many times each crosses the x-axis; it does not give the transformation away. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A reflection is a scale by a negative number, so `a = -1` and `a = -2` are the same idea. (2) Reflecting in the x-axis changes the y-values while reflecting in the y-axis changes the x-values — and students conflate them. (3) The scale factors are independent, so `a` and `b` cannot differ. |

#### 126. `maths.derivative-tangent` — Derivatives as tangent lines

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can explain why the secant slope becomes the tangent slope, and read a gradient off a curve. |
| Interaction | Drag a point along the curve; the secant chord and the tangent appear; type the gradient. |
| Model | `simulate` evaluates the curve at `x` and at `x + h` for a declared `h`, and the tangent slope is the LIMIT of the secant slope as `h → 0`. The displayed `h` is a PARAMETER the student can change, because watching it converge is the whole point. |
| Answer | `{ gradient: number, x: number }` — the gradient at the stated `x`, to 3 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the gradient · `true_false` for 'is the tangent above or below the curve here' (concavity). |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve with a movable point on it, a straight chord drawn to a second point, and a tangent line touching the curve at the movable point. The task is to report the gradient of the tangent at that point. Under reduced motion the moving point advances in whole steps rather than continuously. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The tangent touches the curve rather than crossing it, so it must be the curve itself nearby. (2) The derivative of a function is a number rather than another function. (3) The gradient is the same everywhere rather than varying with x. |

#### 127. `maths.statistics-explorer` — Statistics explorer

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say which measure of centre a dataset's shape demands, and what an outlier does to each one. |
| Interaction | Click to add, drag and remove points; the mean, median, mode, range and quartiles recompute live; answer boxes for each. |
| Model | Quartiles use the declared method (linear interpolation or nearest-rank) as a NAMED PARAMETER, because the two disagree on small datasets and a student's textbook picks one. Mean, median and mode are computed from the same array the box plot reads. |
| Answer | `{ mean: number, median: number, mode: number\|null, lowerQuartile: number, upperQuartile: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` per statistic · `single_choice` for 'which measure is most affected by the outlier' · `multi_select` for the shape statements that hold. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | **Large state.** The state is the array of points, and `canonicalJson` sorts its keys and **rejects non-finite numbers** (`state.ts:36-64`), so a point dragged off-canvas to `NaN` makes the sim unsaveable rather than wrong. Clamp coordinates into the viewport, or round them to a declared precision, before they enter state. *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A dot plot of a dataset with a movable set of points, and a box plot summarising the same data. The task is to report the mean, the median and the two quartiles. The alternative gives the dataset's size and range but not the centre, which is the answer. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The mean is always between the min and max, so an outlier cannot move it much. (2) The median is the mean of the middle two values for every dataset size. (3) A dataset can have more than one mode, so 'the mode' is a single number. |

#### 128. `maths.trigonometry-unit-circle` — The unit circle

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can read exact values off the unit circle and say which quadrant changes their signs. |
| Interaction | Drag the radius to an angle; the exact-value triple and the decimal pair appear; type the sine, cosine or tangent. |
| Model | Angles are stored in DEGREES in the manifest and RADIANS in the model, converted once at the boundary. Exact values are looked up from a table keyed on the quadrant and the base angle, not computed, because `Math.sin(Math.PI/6)` returns `0.49999999999999994` and a student who answers 0.5 has done nothing wrong. |
| Answer | `{ sin: number, cos: number, tan: number\|null }` — decimals to 3 dp, plus the exact value as a string where one exists. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` for the exact value (`√3/2`, `1/2`) · `numeric` for the decimal · `single_choice` for the quadrant. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **This is the sim the tolerance question is about.** The golden sim exists to stress 'precision, angle handling, keyboard-only' (`plans/10` §10). NEVER grade the decimal form with `strategy: NUMERIC`: `numeric(0.5, Math.sin(Math.PI/6), 4)` is 0 points because `Math.sin(Math.PI/6) === 0.49999999999999994`. Grade the EXACT STRING with `EXACT`, or declare `abs: 0.001`. The card requires the first. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A circle of radius 1 with a radius drawn to a point on the circumference, and the horizontal and vertical legs of a right triangle completed. The task is to report the sine, cosine and tangent of that angle. The alternative states the angle in degrees and which quadrant it is in, because the quadrant is a given, not an answer. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Sine and cosine swap at 90°, so the y-value is the cosine. (2) Tangent is defined at 90°. (3) All three are positive in the first quadrant and stay positive through the others. |

#### 129. `maths.coordinate-geometry` — Coordinate geometry

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can find where two lines meet and reflect a point in a line, and say which of the two answers you constructed. |
| Interaction | Drag points to build lines; the intersection and reflection markers snap to whole or half units; type the coordinates. |
| Model | Snap-to-grid is a PARAMETER, not a behaviour, because 'where did the student place it' is part of the answer and a free position makes every coordinate question unanswerable to a declared precision. Reflection is `(x,y) ↦ (px + ((x-px)(a²-b²))/(a²+b²), py + ((y-py)·2ab)/(a²+b²))` for the line `ax+by+c=0`. |
| Answer | `{ intersection: {x,y}, reflected: {x,y} }`, to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `ordering` for 'which construction steps did you use', which is the PATH_SENSITIVE question this sim should also be asked. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_AVAILABLE` — AVAILABLE — the construction route is the reasoning and `ENDPOINT_ONLY` hands the grader `{state: null, trace: []}` (`grading/simulation.ts:354-357`), so an endpoint surface cannot see which of two routes to the same point the student took. |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A pair of straight lines drawn on a square grid, with one point marked on the first line and its reflection marked on the other side. The task is to report where the two lines cross, and the coordinates of the reflected point. The alternative gives the two line equations, because those are the givens. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The y-intercept is read off where the line crosses the y-axis even when the line is vertical and crosses it at every point. (2) Reflecting in a line moves points the same distance from the LINE as they started, not the same distance from the origin. (3) Two lines that look parallel always are. |

#### 130. `maths.monte-carlo-pi` — Monte Carlo π

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can explain why throwing points at random estimates π, and say why the estimate gets worse as it gets bigger. |
| Interaction | Set the sample count; press Play and watch points accumulate; type your estimate. |
| Model | `sample(seed, n)` calls `createRng(seed)` (mulberry32, `@orrery/rng`) and regenerates the whole point set from the seed every time. Nothing holds mutable random state, so the same `(seed, dropped)` always produces the same picture — which is what makes the grader able to reproduce the answer. The shipped gold sim's state carries `seed` AND `seedFromHost` (`sims/maths.monte-carlo-pi/src/sim.ts:334-343`), and the conformance cell refuses a seeded sim that does not. |
| Answer | `{ estimate: number }` — π to 4 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the estimate · `true_false` for 'is the estimate guaranteed to improve with more samples' (it is not). |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A square with points scattered in it, and a circle inscribed in the square. The task is to estimate π from the proportion of points that landed inside the circle. The alternative gives the sample count and the rule for counting a point, so the method is fully specified in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. The Monte Carlo method is textbook and needs no attribution; the DRAW must be `createRng`, not `Math.random`, and `sim:validate` refuses the latter by name. |
| Misconceptions | (1) More samples always give a better estimate — the error shrinks as `1/√n`, so it is a probabilistic claim, not a monotone one. (2) Points near the circle's edge count as inside. (3) The estimate converges on π because the square's area is 1 rather than because π is somehow in the geometry. |

#### 131. `maths.matrix-transformations` — 2D linear transformations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say what a matrix does to area and direction, and predict which way a vector turns. |
| Interaction | Drag the matrix entries; the basis vectors and a test shape transform live; type the determinant. |
| Model | A 2×2 matrix acts on column vectors. The determinant is computed as `ad - bc` in that order, and it is the SIGNED area scale: the golden sim stresses that a negative determinant is a reflection, not a shrink. |
| Answer | `{ determinant: number, image: {x,y}, orientation: 'preserved'\|'reversed' }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the determinant · `single_choice` for the orientation · `true_false` for 'det = 0 preserves area'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A square grid with the two unit basis vectors drawn, and a test shape transformed by a 2 by 2 matrix. The task is to report the determinant and to say whether the transformation preserves or reverses orientation. The alternative gives the four matrix entries, which are the givens. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A negative determinant means the transformation shrinks the plane. (2) `det = 0` is a valid invertible transformation. (3) Rotating by 90° is a shear with a negative determinant. |

#### 132. `maths.probability-tree` — Probability trees

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can multiply along a branch and add across the leaves, and say when two branches are independent. |
| Interaction | Fill branch probabilities; the tree recomputes; enter the probabilities of named paths. |
| Model | A path probability is the PRODUCT along the path and the whole-event probability is the SUM over leaves, in that order — the order is the misconception, so the model names both steps. The tree's own internal consistency is checked before grading (leaves sum to 1 at each fork). |
| Answer | `{ path: { pathOne: number, pathTwo: number, total: number } }` — decimal probabilities. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for which branches are independent · `numeric` per path · `ordering` for 'which two events are independent', which is the reasoning question. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A probability tree with two levels of branches, each branch labelled with its probability. The task is to work out the probability of a named route through the tree. The alternative gives the probability on every branch, because those are the givens and the route is the answer. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Branches on the same fork are added rather than multiplied. (2) 'Independent' means mutually exclusive. (3) Branches at different forks on the same path are independent because they are in different rows. |

#### 133. `maths.set-venn` — Venn and set operations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can count a union without double-counting the overlap, and say what a complement is relative to. |
| Interaction | Drag items into the Venn regions; the counts and the set expressions update; type the cardinalities. |
| Model | Sets are held as membership bitmaps, so `\|A ∪ B\| = \|A\| + \|B\| − \|A ∩ B\|` is computed from the bitmap and not from the student's arithmetic. The universe is an explicit set rather than an assumed rectangle, because 'the complement' is meaningless without it. |
| Answer | `{ union: number, intersection: number, complement: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'which region holds item x' · `true_false` for a set identity. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | Two overlapping circles inside a labelled rectangle, with items placed in the regions. The task is to report how many items are in the union, how many in the overlap, and how many in neither. The alternative gives the universe's size and where the items were placed, so every count is checkable in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `A ∪ B` counts the overlap twice. (2) `A ∩ B` is empty unless one set contains the other. (3) The complement of `A ∪ B` is `Aᶜ ∩ Bᶜ` — students reach for `Aᶜ ∪ Bᶜ`. |

#### 134. `maths.series-convergence` — Series convergence

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say why partial sums converge or diverge, and find the limit numerically. |
| Interaction | Set the first term and ratio; partial sums plot against n; type the limit and the verdict. |
| Model | A geometric series is summed to N terms and the remainder is stated, not hidden: the limit shown is the computed partial sum plus a displayed bound. For a divergent series the sim reports 'diverges' rather than an ever-growing number that looks like an answer. |
| Answer | `{ limit: number\|null, verdict: 'converges'\|'diverges', nForTolerance: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the limit · `single_choice` for the verdict · `true_false` for a comparison-test claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plot of partial sums against the number of terms, with the term limit shown as a second line. The task is to say whether the series converges and, if it does, to give the limit to three decimal places. The alternative gives the first term and the common ratio, which determine the answer. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Partial sums always tend to zero. (2) A series whose terms tend to zero necessarily converges. (3) The limit of the partial sums is the limit of the individual terms. |

#### 135. `maths.integral-area` — Integral as accumulated area

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can explain what a Riemann sum is doing and say what happens to it as the width shrinks. |
| Interaction | Set the number of rectangles; they refine; the accumulated area and the signed area are shown; type both. |
| Model | Left, right and midpoint sums are all computed from the SAME rectangle count so the three can be compared, and the error is `exact − sum` rather than a percentage of the sum, which would blow up when the sum is near zero. Signed area integrates the function as written, so a curve below the axis subtracts. |
| Answer | `{ leftSum: number, rightSum: number, signedArea: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which sum over- and which under-estimates on a stated interval · `true_false` for the signed-area claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve with a row of rectangles drawn under it between two stated limits, and a second row drawn above. The task is to report the left sum, the right sum and the signed area. The alternative gives the function, the limits and the rectangle count, so nothing about the answer is in the picture alone. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Area under a curve is always positive. (2) Doubling the rectangle count halves the error. (3) The definite integral is the value of the antiderivative at the upper limit. |

#### 136. `maths.limit-explorer` — Limits and continuity

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can distinguish a removable discontinuity from a jump, and say which one-sided limit exists. |
| Interaction | Slide `x` towards the point; the graph and both one-sided limits redraw; name the discontinuity type. |
| Model | `x` is approached along a declared path parameter that never EQUALS the point, so the sim can never silently evaluate the discontinuity's own value. The one-sided limits are computed by substitution into the limit, not read off the drawn curve. |
| Answer | `{ leftLimit: number\|null, rightLimit: number\|null, type: 'continuous'\|'removable'\|'jump'\|'infinite' }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the type · `numeric` for each one-sided limit · `true_false` for 'the function is continuous at x₀'. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve with a break in it at one marked value of x, and two arrows approaching that point from the left and the right. The task is to report the left-hand limit, the right-hand limit and what kind of break it is. The alternative gives the formula, so the limits are computable in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A hole is a jump. (2) `f(x₀)` being undefined makes the function discontinuous there even when the limit exists. (3) The limit depends on the value of the function at the point. |

#### 137. `maths.derivative-rules` — Derivative rules drill

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can apply product, quotient and chain rules without switching between them. |
| Interaction | Type a derivative; it is marked immediately; the correct form and a worked step are shown after a submit. |
| Model | Answers are compared as NORMALISED STRINGS, not as computed derivatives, because two algebraically identical derivatives are the same answer and `canonicalText` (`grading.ts:223-236`) does not do algebra. The card therefore ENUMERATES the accepted forms (see T-F) — this is the sim where an unenumerated answer set would be a false wrong several times a week. |
| Answer | `{ expression: string }` — the derivative, in one of the enumerated forms. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` over the accepted forms · `single_choice` for 'which rule applies'. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A function and a box to type its derivative into. The task is to differentiate the function shown, choosing the rule yourself. There is no picture to describe, so the alternative is the function written out in full, in a form a screen reader reads correctly. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `(fg)' = f'g'` rather than `f'g + fg'`. (2) The chain rule is only needed for powers. (3) `(f/g)' = f'/g'`. |

#### 138. `maths.equation-solver` — Equation solver

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can solve a simultaneous pair and recognise an extraneous root your algebra produced. |
| Interaction | Choose the equations; the solver works step by step; type the solution pair. |
| Model | Each solving step is a named transformation, and the sim shows the step that INTRODUCED an extraneous root rather than discarding it — the sim's pedagogical claim is that the root survives until you check it, which is what `grading.extraneousRoots` is for. |
| Answer | `{ x: number, y: number }` plus, when the solver squares or divides, the set of candidate roots before checking. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `multi_select` for the roots that survive checking · `true_false` for 'this candidate is extraneous'. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | Two equations written out one above the other, with a list of the candidate solutions found so far. The task is to work out the solution of the pair and to say which candidates fail the original equations. The alternative gives the equations in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Every algebraic root is a solution of the original equation. (2) Dividing by an expression that might be zero loses nothing. (3) Simultaneous equations need as many equations as unknowns and no more. |

#### 139. `maths.simplify-expressions` — Expression simplifier

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can collect like terms and factor an expression, and say why a factorisation is not unique. |
| Interaction | Type a simplified or factored form; it is compared against the accepted forms. |
| Model | Comparison is over an enumerated list of equivalent forms, because there is no algebraic normaliser in the codebase: `canonicalText` folds case, NFKC and whitespace and nothing else. **A card that does not enumerate the accepted forms is a card that will mark correct students wrong**, and this is the sim where that happens most often. |
| Answer | `{ expression: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `multi_select` for 'which terms are like'. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | An algebraic expression and a box to type a simplified form into. The task is to simplify or factor the expression shown. The alternative gives the expression in full, so nothing depends on seeing it rendered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `2x + 3x = 5x²`. (2) `(x+a)(x+b) = x² + x + ab` rather than `x² + (a+b)x + ab`. (3) Factoring is reversible and therefore unique. |

#### 140. `maths.ratio-proportion` — Ratios and proportion

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can scale a recipe up and down and say whether a relationship is direct or inverse. |
| Interaction | Change one quantity; the others rescale; type the missing value and the type of proportion. |
| Model | The scale factor is the STATE and every other quantity is a pure function of it, so an inverse relationship cannot be expressed as a scaling of a scaling — the sim holds ONE factor and derives, and the inverse case derives with `k/x` rather than `k·x`. Both are the same code path with a different declaration, so a mistake in one shows up in both. |
| Answer | `{ value: number, kind: 'direct'\|'inverse' }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the value · `single_choice` for direct/inverse · `true_false` for a proportionality claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A table of quantities with one cell empty, and a rule describing how the other quantities change together. The task is to fill in the missing value and to say whether the relationship is direct or inverse. The alternative gives every quantity that is already filled in. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Doubling both quantities keeps the ratio, so the relationship is proportional. (2) An inverse relationship can be found by halving. (3) A ratio must be written with integer terms. |

#### 141. `maths.percentages` — Percentages in context

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can apply a percentage to a base and say what compound interest does to it over several periods. |
| Interaction | Set the rate and the number of periods; the value steps up; type the final and the per-period change. |
| Model | Each period's change is computed from the PREVIOUS value, not from the original — the sim holds only `(principal, rate, periods)` and derives the sequence, so the two cannot be implemented inconsistently. The percentage is stored as a fraction internally and rendered once, so a 3% rise is 1.03 and never 1.03 accumulated in floating point over N periods. |
| Answer | `{ final: number, perPeriodChange: number }`, money to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for increase vs decrease · `true_false` for the compound-vs-simple claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A starting amount, a percentage rate per period, and a number of periods, with the value after each period listed. The task is to report the value after the last period and the change in the final period. The alternative gives the starting amount and the rate, so the arithmetic is fully specified. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A 50% fall followed by a 50% rise returns to the start. (2) Compound interest is the sum of the simple interests. (3) Percentage points and percent of the new value are the same quantity. |

#### 142. `maths.fractions-decimals` — Fractions and decimals

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can order fractions and decimals of different sizes and convert between them. |
| Interaction | Type an ordering or a conversion; it is compared against the accepted forms. |
| Model | Ordering is compared as a LIST of normalised decimal strings — the sim converts each fraction to a decimal with a declared precision and compares those, so `1/2` and `0.50` compare equal without an algebraic normaliser. The precision is a declared parameter because `1/3` has no exact decimal form and a naive string compare would order it wrongly. |
| Answer | `{ ordered: string[], decimal: number, fraction: string\|null }` — an ordering answer is a LIST and is graded with `orderMatch`, and a conversion is a `numeric` with a declared precision. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `ordering` for an ordering answer · `short_text` with `NUMERIC_TOLERANCE` for a conversion · `single_choice` for 'which is largest'. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A list of fractions and decimals and a box to place them in order from smallest to largest. The task is to put the numbers in order. The alternative gives the list in text, so the ordering question needs no picture. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A longer fraction is a larger number. (4) `0.9 = 0.90` is false. (5) `1/3 + 1/3 + 1/3 = 1` is doubted. |

#### 143. `maths.number-line-labs` — Number line laboratory

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can mark an interval and read absolute value off a number line. |
| Interaction | Drag markers along the line; the interval and the absolute value update; type the interval in interval notation. |
| Model | Markers snap to a declared step, and the interval is stored as an ORDERED PAIR of endpoint values with their inclusions as flags — because `[a,b]` and `(a,b)` are different answers and a string compare of interval notation is exactly where a student is marked wrong for writing `]a,b[`. |
| Answer | `{ interval: [number, number, boolean, boolean], absoluteValue: number }` — endpoints plus inclusion flags. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` over the accepted interval spellings · `numeric` for the absolute value. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A horizontal number line with markers at two positions and a shaded band between them. The task is to report the interval the band covers, saying whether each end is included, and to give the absolute value of one stated point. The alternative gives the scale and the tick interval, so positions can be read without seeing the line. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `(a,b]` and `[a,b)` are the same interval. (2) `\|x\|` is `x`. (3) An interval has no order, so `[3,1]` is valid. |

#### 144. `maths.prime-factorisation` — Prime factorisation

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can write a number as a product of primes and read off its lowest common multiple and highest common factor. |
| Interaction | Enter a number; the factor tree draws; enter the prime factorisation as a list. |
| Model | The factor tree is built by trial division by the primes up to `√n` and the answer is stored as a canonical `[[prime, exponent], …]` list SORTED by prime — so `12 = 2·2·3` and `12 = 3·2·2` are the same answer by construction, rather than by a string comparison the card has to enumerate. |
| Answer | `{ factors: [[prime, exponent]], hcf: number, lcm: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `numeric` for HCF/LCM · `multi_select` for which numbers divide it. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A factor tree breaking a number into its prime factors, with a box to enter the factorisation as a list. The task is to write the number as a product of primes, and to give its highest common factor and lowest common multiple with one other stated number. The alternative gives the number and its partner in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `1` is prime. (2) HCF and LCM are the same operation. (3) A prime factorisation is unique. |

#### 145. `maths.indices-laws` — Index laws

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can apply the negative and fractional index laws without leaving the answer as a negative power. |
| Interaction | Type the answer; it is compared against the enumerated accepted forms for that index type. |
| Model | Accepted forms are enumerated per index type, because a fractional index may legitimately be written as a radical, as a decimal, or left as a negative power — and `canonicalText` will not equate them. |
| Answer | `{ value: number, form: 'decimal'\|'fraction'\|'radical'\|'power' }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `numeric` when the card fixes the form to a decimal. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A number raised to a power, and a box to type the value into. The task is to evaluate the index expression shown. The alternative writes the expression out in full, in a form a screen reader reads, because superscript notation alone is not reliably announced. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `a⁻¹ = -a`. (2) `a^(1/2)` is negative for a negative `a`. (3) `(aᵐ)ⁿ = a^(mn)` for `n = 0`. |

#### 146. `maths.standard-form` — Standard form

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can order numbers of very different sizes and convert units into standard form. |
| Interaction | Enter a number or a unit conversion; the magnitude and the power are shown; type the standard form answer. |
| Model | Standard form is stored as `{ mantissa, power }` rather than as one number, because the ORDER of two standard-form numbers is a comparison of powers first — and a single float loses the distinction between `1.0 × 10⁻⁴` and `9.9 × 10⁻³` at display precision. |
| Answer | `{ mantissa: number, power: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` · `short_text` with `NUMERIC_TOLERANCE` for a decimal-form answer · `ordering` for ordering magnitudes. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A number and a pair of boxes: one for the coefficient and one for the power of ten. The task is to rewrite the number in standard form, or to state which of two given standard-form numbers is larger. The alternative writes the number out in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Larger power means larger number. (2) Standard form is about the number of digits rather than the position of the decimal point. (3) Converting units changes the value. |

#### 147. `maths.sequences` — Sequences and series

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can tell an arithmetic sequence from a geometric one and write an nth term. |
| Interaction | Set the first two terms and the type; the sequence plots; type the next term and the nth term. |
| Model | The sequence is generated from `(a, d)` or `(a, r)` and the nth term is evaluated from the SAME parameters, so the plotted sequence and the graded formula cannot be two implementations that disagree. |
| Answer | `{ nextTerm: number, nthTerm: number, kind: 'arithmetic'\|'geometric' }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the type · `true_false` for 'is this sequence arithmetic'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A row of sequence terms with the later ones to be filled in, and a list of the first few differences or ratios. The task is to give the next term and the nth term, and to say whether the sequence is arithmetic or geometric. The alternative gives the first four terms in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Every sequence with a constant difference is geometric too. (2) The nth term starts at `n = 0`. (3) A sequence with a constant ratio has a constant difference. |

#### 148. `maths.binomial-theorem` — Binomial expansion

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can find a specific term in a binomial expansion without expanding the whole thing. |
| Interaction | Enter the expansion or a specific term; it is compared against the enumerated forms. |
| Model | Coefficients are computed with a recurrence rather than by factorial division, so a large power does not overflow into a wrong integer. A specific term is indexed from the CORRECT end — r = 1 is the second term — which is the indexing misconception the sim exists for. |
| Answer | `{ coefficients: number[], specificTerm: string }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `multi_select` for which coefficients are correct · `numeric` for one coefficient. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A binomial expression raised to a stated power, with a box to enter the coefficients of the expansion. The task is to give the expansion, and to write down one specified term of it. The alternative gives the expression and which term is wanted, in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The second term is indexed `r = 0`. (2) The coefficients are all 1. (3) The expansion terminates when the power is even. |

#### 149. `maths.complex-numbers` — Complex numbers

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can plot a complex number on an Argand diagram and read its modulus and argument. |
| Interaction | Drag the point on the Argand plane; the modulus and argument read out; type both and the value of a power. |
| Model | Modulus is `Math.hypot(re, im)` rather than `Math.sqrt(re*re + im*im)`, so a large real part does not overflow. The ARGUMENT is stored in radians in `[-π, π]` and rendered in degrees separately, because the two are the same quantity and storing the rendered form is how an argument comparison goes wrong at the branch cut. |
| Answer | `{ modulus: number, argument: number, power: {re: number, im: number} }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the quadrant of the argument · `single_choice` for 'which argument is equivalent modulo 2π'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | An Argand diagram with a point in one quadrant, radii drawn to the real and imaginary axes, and a circle of the modulus. The task is to report the modulus and the argument of the point, and to compute a stated power of it. The alternative gives the real and imaginary parts, so the arithmetic is fully specified. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The modulus can be negative. (2) The argument is unique. (3) `i² = -1` means `i` is a real number. |

#### 150. `maths.vectors-3d` — 3D vectors

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute a dot and a cross product and say which one gives an area. |
| Interaction | Drag the two vectors in 3D; the parallelogram or the cross-product segment draws; type the magnitude of the result. |
| Model | The cross product is computed by the determinant expansion rather than by `vector[0] × vector[1] × vector[2]` element-wise, because the element-wise product is a common and silent error. Magnitudes use `Math.hypot(a,b,c)` so a long vector does not overflow. |
| Answer | `{ dot: number, crossMagnitude: number, angle: number }` — angle in radians, rendered in degrees. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for perpendicularity · `single_choice` for 'which operation gives area'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | Two vectors drawn from a common origin in three dimensions, with the parallelogram between them shaded. The task is to report their dot product, the magnitude of their cross product, and the angle between them. The alternative gives both vectors as triples of components, so nothing about the answer depends on the 3D view. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The cross product gives a vector parallel to both inputs. (2) A zero dot product means one vector is the zero vector. (3) The angle between vectors depends on their lengths. |

#### 151. `maths.equations-of-motion` — SUVAT equations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can choose which of the five equations applies rather than substituting into all of them. |
| Interaction | Set u, a, s, v and t; only the consistent subsets stay enabled; the trajectory draws; type the missing quantity. |
| Model | The five equations are enumerated as a TABLE of which variables each contains, and the sim refuses a set of inputs that does not appear in any one equation — rather than solving and reporting a negative time. That refusal is the sim's teaching point and is why a declared parameter cannot simply be free. |
| Answer | `{ value: number, symbol: 's'\|'u'\|'v'\|'a'\|'t' }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` · `single_choice` for 'which equation applies' · `ordering` for a motion sequence, which is the PATH_SENSITIVE reading. · `worked_solution` for the four-stage symbolic route, each step graded on its own (`QuestionSpec.worked_solution`, `contracts/src/question/index.ts:221-229`). |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A straight-line motion drawn with a marked start and end and the velocity values written at each. The task is to work out the missing quantity using the correct equation, and to say which of the five you used. The alternative gives the four known quantities with their units. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) All five equations apply to any given inputs. (2) `v = u + at` is valid when there is displacement. (3) Taking `a` as positive when the object decelerates. |

#### 152. `maths.trig-solver` — Trigonometric equations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can give every solution in a stated interval and say why the general solution has a period. |
| Interaction | Choose the equation and the interval; solutions mark on the unit circle; enter the solution set. |
| Model | Solutions are SOLVED FOR rather than sampled: a root finder walks the interval at a declared step and then each candidate is checked against the ORIGINAL equation to a declared residual. This is the sim where a tolerance on the ANSWER is the wrong place to put the tolerance — the residual check belongs in the model and the answer can then be an exact value. |
| Answer | `{ solutions: string[], degrees: boolean }` — the set of solutions in the interval, in the stated unit. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the solution set · `short_text` with `REGEX_SET` for exact forms like `30° + 360k` · `true_false` for 'there are exactly n solutions'. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve with the solutions marked on it within a stated interval. The task is to find every solution in that interval. The alternative gives the equation and the interval in text, so the solution set can be produced without seeing the plot. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) There is one solution per interval per period, ignoring the two per period a sine has. (2) Dividing by `sin x` loses the solutions where `sin x = 0`. (3) Solutions outside the interval count. |

#### 153. `maths.radians-degrees` — Radians and degrees

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say when an exact trig value exists and convert between the two angle units without a calculator. |
| Interaction | Set the angle in either unit; the arc length and sector area compute; type the other unit's value and the exact value. |
| Model | Conversion is `deg × π/180` and the exact-value lookup is by QUADRANT AND BASE ANGLE, never by evaluating `Math.sin` — see `maths.trigonometry-unit-circle`. Arc length uses the radian measure by definition, so the sim holds radians internally and the degree figure is derived; a sim that stored degrees would give two arc lengths for one angle. |
| Answer | `{ radians: number, degrees: number, exact: string\|null }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `short_text` for the exact value · `single_choice` for 'does an exact value exist'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A sector of a circle with the angle marked at the centre and the radius stated. The task is to convert the angle between degrees and radians, and to give the arc length. The alternative states the angle in one unit and the radius, so both answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `π` radians is 180 degrees by definition rather than by a formula to remember. (2) An exact trig value exists for any degree measure. (3) Arc length depends on the unit the angle is in. |

#### 154. `maths.graph-sketching-lab` — Graph sketching lab

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can sketch a curve from its algebraic description and defend the features you drew. |
| Interaction | Enter a description; draw on the grid; state the intercepts, turning point and asymptotes in the answer boxes. |
| Model | The sim does not judge the drawing. It compares the FEATURES the student claims — intercepts, turning points, asymptotes — against the model's own, and hands the drawing to a marker with those features named. Grading the picture is a human judgement and pretending otherwise would produce machine-looking marks nobody should trust (see `sims/physics.free-body-diagram/sim.spec.md`, which is the shipped precedent for exactly this). |
| Answer | `{ features: { intercepts: [...], turningPoints: [...], asymptotes: [...] }, sketch: file }` — features auto-checked, sketch to a marker. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric`/`multi_select` for the features · `file_submission` for the exported sketch. **A rubric item MUST set `gradingMode: MANUAL`**: `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as a legitimate `GRADED` outcome, so an AUTO rubric item marks every student zero until a marker acts. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A blank square grid for drawing on, with boxes for the intercepts, the turning point and any asymptotes. The task is to sketch the curve described and to state those features. The alternative gives the description in full, so a student using the text alternative can draw the same curve on paper and enter the same features. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A sketch is graded by whether it looks right rather than by the features it has. (2) An asymptote can be crossed. (3) The turning point is where the curve crosses the axis. |

#### 155. `maths.conic-sections` — Conic sections

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can identify a conic from its eccentricity and write down its standard form. |
| Interaction | Change eccentricity, directrix and focus; the conic redraws; name the conic and type the standard form. |
| Model | The conic is generated from `(e, focus, directrix)` and the standard form is DERIVED from those parameters rather than authored alongside them, so the drawn curve and the typed equation cannot be two truths. Eccentricity is the classification parameter and is drawn on a number line the student can drag. |
| Answer | `{ conic: 'circle'\|'ellipse'\|'parabola'\|'hyperbola', standardForm: string, eccentricity: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the conic · `short_text` with `REGEX_SET` for the standard form · `numeric` for the eccentricity. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A conic drawn with its focus and directrix marked, and a number line showing the eccentricity. The task is to name the conic and write down its standard form. The alternative gives the focus position and the directrix equation, which determine both answers. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Every conic is a parabola with different proportions. (2) An ellipse and a hyperbola are distinguished by size rather than by `e < 1` vs `e > 1`. (3) The eccentricity of a circle is 0 rather than 1. |

#### 156. `maths.polar-coordinates` — Polar coordinates

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can convert between polar and Cartesian and find the area of a polar region. |
| Interaction | Choose a curve; the rose or cardioid draws; drag the radius; type the Cartesian coordinates and the area. |
| Model | `x = r cos θ, y = r sin θ` is the conversion, and the AREA is computed as `½∮r²dθ` by the same numerical integration the renderer uses for the sweep — so the shaded area and the typed answer are the same number by construction. |
| Answer | `{ cartesian: {x, y}, area: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `short_text` with `REGEX_SET` for the conversion · `single_choice` for the number of petals. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A polar grid with a curve drawn on it, and the radius drawn at one marked angle. The task is to convert that point to Cartesian coordinates and to give the total area enclosed by the curve. The alternative gives the curve's equation in polar form and the angle, so both answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Polar and Cartesian coordinates describe different points rather than the same points in two systems. (2) A negative `r` is a different point rather than the opposite direction. (3) `r` is measured along the curve. |

#### 157. `maths.recursion-iteration` — Recursion and iteration

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can write the recursive and the iterative form of the same computation and say why they agree. |
| Interaction | Enter both forms; the call tree or the loop trace draws; enter the value at a stated n. |
| Model | Both forms are evaluated by the sim from the student's OWN source text, not from the model's own implementation — the point is that the student's two forms produce the same value. A base case that is wrong makes the recursion non-terminating, so the sim runs it with a step budget and reports the budget rather than hanging. |
| Answer | `{ recursive: string, iterative: string, value: number, terminated: boolean }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` for the source · `numeric` for the value · `single_choice` for the trace order. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A call tree for a recursive function beside a loop trace for the iterative version of the same computation. The task is to write both forms and report the value they produce at a stated input. The alternative states the input and the base case, so the answer does not depend on the trace. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The recursive form is slower in every case. (2) A base case is optional if the recursion is decreasing. (3) The two forms produce the same sequence in the same order. |

#### 158. `maths.graph-theory` — Graphs and networks

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can test connectivity and find an Euler path, and say what makes a graph colourable with four colours. |
| Interaction | Add and remove edges on the canvas; degrees and connectivity recompute; enter the degree sequence, the Euler path and the chromatic number. |
| Model | Degrees, connectivity, Euler and Hamiltonian properties and the chromatic number are all computed by the sim's own graph code over the same edge set the drawing shows. The Euler path is stored as an ORDERED list of vertices, so it is graded by position — the ORDER concern, not the SET one. |
| Answer | `{ degrees: number[], eulerPath: string[], chromaticNumber: number, connected: boolean }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the degree sequence · `short_text` with `REGEX_SET` for the Euler path (order matters, so a set match would be wrong here) · `numeric` for the chromatic number. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A network of labelled vertices joined by edges, with each vertex's degree written beside it. The task is to give the degree sequence, to find a path that uses every edge once, and to say how many colours the graph needs. The alternative lists every edge as a pair of vertex labels, so the whole graph is available as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A connected graph has an Euler circuit. (2) The chromatic number is the maximum degree. (3) An Euler path and a Hamiltonian path are the same object. |

#### 159. `maths.logic-propositions` — Logic and propositions

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can build a truth table and apply De Morgan's laws to it. |
| Interaction | Enter the propositions; the truth table builds with live values; enter which rows make a compound statement true. |
| Model | Propositions are evaluated symbolically, not by substituting truth values into text, so `¬(p ∧ q)` is expanded by the evaluator rather than pattern-matched. The truth table is generated from the parse tree, so a malformed proposition produces a parse error rather than a wrong table. |
| Answer | `{ table: boolean[][], satisfyingRows: number[], deMorgan: string }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the satisfying rows · `short_text` with `REGEX_SET` for the De Morgan form · `true_false` per row. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A truth table with one column per proposition and a column for the compound statement, with each cell showing T or F. The task is to say which rows make the compound statement true. The alternative writes the propositions out in full, so the table can be completed without seeing it rendered. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `¬(p ∧ q) = ¬p ∧ ¬q`. (2) `p → q` is `p ∧ q`. (3) Contraposition is not a valid inference. |

#### 160. `maths.proof-techniques` — Proof techniques

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can construct a proof and criticise one by naming the step that fails. |
| Interaction | Type a proof in numbered steps; select the first invalid step; write what would repair it. |
| Model | The sim does NOT judge the proof. It marks the student's CLAIMED first-invalid-step against a marker-supplied set and hands both to a human with the claim quoted. A machine grading mathematical proof by string similarity produces marks that look decided and are not, which is the shipped precedent in `sims/physics.free-body-diagram/src/grader.ts`. |
| Answer | `{ proof: string, firstInvalidStep: number, repair: string }` — `firstInvalidStep` auto-compared when the marker has supplied the reference, otherwise all three go to a marker. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `free_response` for the proof text · `numeric` for the step index once a reference is supplied. **MANUAL is mandatory** — see `readAward` in T-I: an AUTO rubric item marks everyone zero. · `worked_solution` for the numbered proof steps, which is the closest thing the platform has to a proof. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A numbered list of proof steps, each in a box, with a control to mark one step as the first invalid one and a text box for the repair. The task is to write the proof and to identify the step that first fails. The alternative gives the theorem statement in full, so the proof can be attempted on paper. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A proof that reaches the right conclusion is a proof. (2) Checking a few cases proves a general statement. (3) Assuming the conclusion is a legitimate step. |

#### 161. `maths.measurement-error` — Measurement and error bounds

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can propagate an uncertainty and say when adding errors in quadrature beats adding them worst-case. |
| Interaction | Enter measured quantities with their uncertainties; the propagated bound computes two ways; type both. |
| Model | Both propagation rules are computed from the same inputs: worst case is the sum of the absolute contributions, RSS is the square root of the sum of the squares. Neither is offered without the other, because the sim's point is that the two disagree and the choice is a statement about what was measured. |
| Answer | `{ worstCase: number, rss: number, significantFigures: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which rule applies · `true_false` for a rounding claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A table of measured quantities with an uncertainty beside each, and two boxes: one for the propagated uncertainty added worst-case and one for the combined uncertainty in quadrature. The task is to work out the result and its uncertainty both ways. The alternative gives every measurement and its uncertainty in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Errors cancel in a subtraction. (2) The uncertainty keeps the same number of decimal places as the value. (3) RSS and worst case are the same number when the errors are equal. |

#### 162. `maths.modular-arithmetic` — Modular arithmetic

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can work with congruence and say what a clock face is modelling. |
| Interaction | Set the modulus; the residue table and the clock draw; enter the solution set and check a congruence. |
| Model | Congruence is checked as `((a - b) mod m) === 0` in exact integer arithmetic, so a large product does not lose precision through a float path. The clock is rendered from the residue classes, not as a picture of a clock face, so the arithmetic and the picture are the same object. |
| Answer | `{ residues: number[], satisfies: boolean, period: number }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the residues · `true_false` for a congruence · `ordering` for a cycle, which is the order-sensitive reading. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **case is a claim** — `grading.ts:260-263` exists because folding case marked a recessive genotype correct |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A clock face and a row of residues, with boxes for the solution set of a stated congruence and a yes-or-no check. The task is to find which residues satisfy the congruence. The alternative gives the modulus and the expression in full. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) `a ≡ b (mod m)` means `a = b`. (2) Congruence is transitive only under the same modulus. (3) A clock face is counting in base 12 rather than base 60 for the seconds. |

#### 163. `maths.growth-decay` — Exponential growth and decay

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can fit a decay constant to a half-life and say what the differential model predicts that the half-life alone does not. |
| Interaction | Set the half-life or the rate; the curve and the half-life markers move; type the rate constant and the value at a stated time. |
| Model | `y(t) = y₀ e^(−λt)` is evaluated from `λ`, and the half-life is DERIVED as `ln2/λ` rather than stored beside it — a sim storing both has two sources of truth for one number. The differential intuition is shown as `dy/dt = −λy` at a stated `t`, which is the bit a half-life does not give. |
| Answer | `{ lambda: number, halfLife: number, valueAtT: number }` — `λ` in s⁻¹, the half-life derived from it, and the value at a stated `t`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for 'is the rate constant independent of the amount'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | **The exponential is where a naive comparison misfires most.** `Math.exp(-0.6931471805599453 * 10)` is `0.9999999999999998`, so a student answering exactly `1.00` for a half-life of 10 s is 2×10⁻¹⁶ away from the computed value and must be inside an absolute tolerance. Never `strategy: NUMERIC` here. `relative: 0.01` with `absolute: 0.01` is the right declaration (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve falling towards zero with two markers one half-life apart, and the instantaneous rate shown at a marked time. The task is to report the decay constant and the value at a stated time. The alternative gives the initial amount and the half-life, so both answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The half-life is a property of the amount rather than of the substance and the rate. (2) The decay constant is negative. (3) The time to decay by half depends on the starting amount. |

#### 164. `maths.optimisation` — Optimisation

| Field | Value |
|---|---|
| Subject · band · age | `maths` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can find a maximum on an interval and check the endpoints before declaring it. |
| Interaction | Set the constraint; the feasible region draws; type the critical point and the maximum value. |
| Model | Critical points are FOUND by sampling the derivative for sign changes at a declared resolution and then BISECTED, not by evaluating the derivative at a grid point and reporting the nearest one. The endpoint values are computed and shown every time, because the missed case is a maximum at an endpoint and it is the case students lose marks on. |
| Answer | `{ criticalPoint: number, maximum: number, atEndpoint: boolean }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for 'the maximum is at an endpoint' · `single_choice` for which candidate is the maximum. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A curve over a stated closed interval, with the feasible points marked and the highest one highlighted. The task is to report the maximum value and where it occurs. The alternative gives the function and the interval in full, so the answer does not depend on the plot. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The maximum is always at a critical point. (2) A local maximum is a global maximum. (3) The second derivative being negative proves a maximum without checking the endpoints. |

#### 165. `maths.area-perimeter-challenge` — Area and perimeter challenge

| Field | Value |
|---|---|
| Subject · band · age | `maths` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can work out a missing side of a composite shape and see that rearranging changes perimeter without changing area. |
| Interaction | Drag the shapes; the composite outline redraws; type the missing length and the perimeter. |
| Model | Perimeter is the summed boundary INCLUDING the internal joins, and the sim counts each shared edge once per shape and once in the outline separately — because omitting the shared edges is the specific error this sim exists to expose. Area is summed from non-overlapping parts, with the overlap detected geometrically rather than assumed. |
| Answer | `{ missingSide: number, perimeter: number, area: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'which rearrangement has the same area'. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A composite outline built from labelled rectangles and triangles with one side length missing, and a pair of shapes to compare. The task is to find the missing length and to report the perimeter and area. The alternative gives each part's dimensions as text, so the answer does not depend on the drawing. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Rearranging a shape leaves the perimeter unchanged. (2) The perimeter of a composite shape excludes the internal joins. (3) Two shapes with the same perimeter have the same area. |

#### 166. `maths.coordinate-transformations` — Coordinate transformations

| Field | Value |
|---|---|
| Subject · band · age | `maths` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compose two transformations and name the single transformation that results. |
| Interaction | Drag the object; apply two transformations in turn; name the composition and type its matrix or rule. |
| Model | Compositions are applied to the SAME object through both matrices in the declared order, and the composite matrix is computed by multiplication so the drawn result and the typed matrix are one computation. Order matters and the sim states which order it applied. |
| Answer | `{ composite: string, matrix: number[][], order: number[] }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `REGEX_SET` · `single_choice` for the named transformation · `ordering` for the sequence of steps, which is the reasoning question. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A shape drawn on a grid, shown before and after two transformations applied in turn, with the final position highlighted. The task is to name the single transformation that results from the two, or to give its matrix. The alternative states both transformations in text, so the composition can be worked out without seeing the picture. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Transformations commute, so order never matters. (2) A rotation and its inverse compose to the identity in either order. (3) A glide reflection is a reflection followed by a translation in any order. |

#### 167. `physics.free-body-diagram` — Free-body diagrams

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can decide which forces act on a body and say how large each is, without inventing one. |
| Interaction | Tick the forces that act and choose a direction for each; type the magnitude; submit. |
| Model | **This is the shipped gold sim that does not mark its own work** (`sims/physics.free-body-diagram/src/grader.ts:138-166`). `g` is 9.81, so a 2 kg crate weighs 19.62 N and the card requires two decimals — because 19.62 is not 19.6 and the difference is the point. The grade is a `RUBRIC` decision awarding zero with a reason naming the counts a marker needs, because whether `20 N` is wrong or right under a school `g = 10` is a judgement no matcher can make. |
| Answer | `{ claims: [{ force: string, magnitude: number\|null, direction: string }] }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `multi_select` for which forces act · `numeric` per magnitude · `ordering` for the forces in size order. **MANUAL is mandatory**: `readAward` (`grading/simulation.ts:213-246`) treats `points: 0` as a legitimate `GRADED` outcome, so an AUTO rubric item reports zero for every student until a marker acts. |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` — MUST NOT be declared — the answer is the endpoint list, and reading the path would let a student who brute-forced every combination earn the same mark as one who reasoned. |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A crate resting on a horizontal floor with a rope pulling it sideways, a table of forces with a tick box each and a direction control, and a submit button. The task is to state which forces act on the crate, how large each is in newtons, and which way it points. The alternative deliberately does NOT name the forces or give the weight, because which forces act IS the question. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The force a body exerts on something is one of the forces ON it. (2) `mg` rounds to 20 N. (3) A body moving at constant speed has no net force, therefore no forces. |

#### 168. `physics.pendulum` — Simple pendulum

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict how the period changes with length, and say which quantities it does not depend on. |
| Interaction | Set length and release angle; Space to play; drag the scrubber; type the period and the time of the Nth crossing. |
| Model | **Fixed timestep, not the frame delta.** The golden sim stresses exactly this (`plans/10` §10) and the SDK's `stepper.advance` consumes whole steps and carries the remainder (`stepper.ts:20-56`) — because integrating against a frame delta makes the same student's run produce different numbers on a busy laptop and a quiet one, and then the recorded answer cannot be reproduced from the recorded state. The stepper state, including `carry`, is in the saved state for the same reason. The period is measured from the simulated crossings, not from the small-angle formula — the sim shows `2π√(L/g)` next to it precisely so the gap is visible (the shipped sim's tolerance is 0.01 s absolute / 0.002 relative, with a rationale that names both numbers). |
| Answer | `{ period: number, halfPeriod: number, energyLossFraction: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'does the period depend on mass' · `true_false` for the small-angle approximation. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A pendulum swinging between two extreme positions, with a trace of its path fading behind it and the length labelled. The task is to report the time for one full swing, the time for a half swing, and how much of the energy is lost after a stated number of swings. The alternative gives the length, the release angle and the rule for timing, so the answer does not depend on watching the animation. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A longer pendulum has a longer period. (2) The period depends on how far it was swung. (3) A heavier pendulum has a longer period. |

#### 169. `physics.wave-interference` — Two-source interference

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say why bright and dark fringes appear, and predict where the next one is. |
| Interaction | Set the two source positions and wavelength; the wavefronts animate; type the fringe spacing and the path difference at a stated point. |
| Model | Path difference is computed as a DISTANCE and compared to `λ`; the amplitude at the point is the superposition of the two. The sim animates from the same fixed-step clock as every other sim, so a paused frame and a played frame at the same `t` are identical — the golden sim's corner is 'animation loop, pause/scrub'. |
| Answer | `{ fringeSpacing: number, pathDifference: number, bright: boolean }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for constructive/destructive · `single_choice` for 'which point is brighter'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two point sources sending out circular wavefronts, which overlap and show alternating bright and dark bands. The task is to report the spacing between the bright fringes and to say whether a stated point is bright or dark. The alternative gives the wavelength and the separation of the sources, and states the rule for a bright fringe, so the answer is fully specified as text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Destructive interference happens when the path difference is zero. (2) Fringes get further apart as you move further from the sources. (3) Waves pass through each other and bounce. |

#### 170. `physics.optics-ray-tracing` — Ray tracing

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can trace a ray through a lens and say where the image forms. |
| Interaction | Move the object and the lens; the three principal rays redraw and meet at the image; type the image distance and whether it is real. |
| Model | Ray construction is analytic — the refracted ray is computed by Snell's law at the surface normal, not drawn to look right — and the three rays MEET at the image, which is the check the sim runs on every redraw. A construction that fails to converge is reported as total internal reflection rather than drawn anyway. |
| Answer | `{ imageDistance: number, magnification: number, real: boolean, inverted: boolean }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for real/virtual and upright/inverted · `true_false` for the total-internal-reflection condition. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A lens drawn on an axis with an object on one side and three rays traced through it to an image on the other. The task is to report where the image forms, how much it is magnified, and whether it is real and upright or inverted. The alternative gives the focal length, the object distance and the lens type, so the answer is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A converging lens makes a virtual image of a distant object. (2) Rays spread after passing through a converging lens rather than converging. (3) The image is on the same side of the lens as the object. |

#### 171. `physics.circuit-dc` — DC circuits

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can apply Kirchhoff's laws to a two-loop circuit and say which arrangement splits the current. |
| Interaction | Place components to build the circuit; the currents and voltages solve; type the total resistance, a branch current and the power dissipated. |
| Model | The circuit is a GRAPH solved by nodal analysis, and the solver reports the rank of the conductance matrix rather than dividing by a near-zero determinant — a series/parallel circuit is exactly the case where a naive Gaussian elimination divides by zero and a student's own valid answer returns `NaN`. **Unit handling is part of the model**: resistances carry units into the solve and the answer is rendered once, so a student entering `4.7` for `4.7 kΩ` is not silently wrong and not silently right. |
| Answer | `{ totalResistance: number, branchCurrent: number, power: number }` with declared units. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for series/parallel · `multi_select` for which Kirchhoff equation applies where · `ordering` for the steps of a solution, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A circuit diagram with a battery and a set of resistors in boxes, and current and voltage values written beside each wire. The task is to report the total resistance, the current through one named branch, and the power dissipated in one named component. The alternative gives each component's resistance and the supply voltage in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Current is used up as it goes round the circuit. (2) Potential difference is shared evenly between components in series. (3) Adding resistances in series is the same operation as adding them in parallel. |

#### 172. `physics.circuit-ac` — AC circuits

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute an RMS value and say what resonance does to the amplitude. |
| Interaction | Set frequency and component values; the phasor diagram and the amplitude-versus-frequency curve draw; type the RMS current and the resonant frequency. |
| Model | RMS is computed by integrating `i²` over a declared whole number of cycles — a whole number, because integrating over a partial cycle makes the answer depend on where you stopped, which is precisely the non-reproducibility this phase exists to prevent. Resonance is found by solving the reactance balance rather than by sampling the curve for a peak. |
| Answer | `{ rmsCurrent: number, resonantFrequency: number, impedance: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for 'RMS equals the peak' · `single_choice` for the phase at resonance. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | **A declared tolerance here is doing real work.** `I_rms = I_peak/√2` and every intermediate is irrational, so `rel` carries the model error and `abs` carries the precision asked for. With `rel` alone, an answer of `0` is inside any relative tolerance of `0` — and `withinTolerance(0.0001, 0, {rel: 0.01})` is true, so a student who submitted nothing meaningful passes. Declare `abs` as well (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An AC source with the current and voltage waveforms drawn against time, and a graph of current amplitude against frequency with a peak marked. The task is to report the RMS current, the frequency at which the current is greatest, and the impedance at that frequency. The alternative gives the component values and the supply voltage and frequency, so all three answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) RMS equals the peak for a sinusoidal supply. (2) Resonance increases the impedance. (3) Reactance depends on the frequency and the resistance depends on the frequency. |

#### 173. `physics.projectile-launch-lab` — Launch lab

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can find the launch angle that carries furthest under a ranging constraint, and say why the unconstrained optimum is 45°. |
| Interaction | Set speed and the target range; the trajectory animates; type the launch angle that reaches the target and the speed needed for a fixed angle. |
| Model | The trajectory is integrated at a fixed step and the angle that reaches the target is SOLVED FOR by bisection at a declared angular resolution, then reported to that resolution — so the answer is a stated angle to a stated precision rather than a grid-search artefact. Adding a constraint changes the model (see below), which is why the constraint is a scenario and not a boolean. |
| Answer | `{ angle: number, speedRequired: number, angleUnconstrained: number }` — degrees, to 1 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'does the constraint change the optimum' · `true_false` for the 45° claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A launcher on flat ground firing a projectile, with the ground, the target distance marker and the arc drawn. The task is to find the launch angle that just reaches the target, and the speed needed from a fixed angle. The alternative gives the launch speed, the target distance and the instruction to ignore air resistance, so the answer is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) 45° is the optimal angle whatever the constraints. (2) Doubling the speed doubles the range. (3) A launch angle is independent of the target distance. |

#### 174. `physics.newtons-laws` — Newton's laws

| Field | Value |
|---|---|
| Subject · band · age | `physics` · KS3 · 11–14 · `ageRange` `[11, 14]` |
| Objective (student's terms) | By the end you can compute an acceleration from a net force and say which of the two F=ma misconceptions you have. |
| Interaction | Drag masses onto a surface; the forces and the acceleration compute; type the acceleration and the net force. |
| Model | `a = F_net / m` with the net force computed by VECTOR SUM of the declared forces, not by adding their sizes — the two agree only when every force points the same way, and the sim's misconception list is built on exactly that collapse. Mass and weight are separate fields with separate units, because `m` in kg and `mg` in N being the same number in a student's head is the error. |
| Answer | `{ acceleration: number, netForce: number, weight: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'does doubling the mass double the acceleration' · `true_false` for 'weight and mass are the same'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `F = ma` with `g = 9.81` and masses like `0.5 kg` gives 4.905 N, which is not 4.91 and not 4.9. Round the ANSWER to the precision the box asks for and compare against a rounded expectation, or the student who typed the value on their calculator is marked wrong by 5×10⁻³. Declare `abs` in the answer's unit (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A block on a horizontal surface with the forces acting on it drawn as arrows, and the acceleration shown as a number beside the block. The task is to report the acceleration, the net force and the weight of the block. The alternative gives the mass, the applied force and the friction force in newtons. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Doubling the mass doubles the acceleration. (2) A heavier object falls faster. (3) Mass and weight are the same quantity with different units. |

#### 175. `physics.friction` — Friction

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say why static and kinetic friction are different quantities, and find the largest force that will not move a block. |
| Interaction | Increase the applied force with the mouse; the block holds then slips; type the threshold force and the acceleration once it slips. |
| Model | Static friction takes the value up to `μ_s N` and is NOT `μ_s N` before slipping — the sim models static friction as `min(applied, μ_s N)`, so the block genuinely holds and then genuinely slips at the threshold. Kinetic friction is `μ_k N` thereafter. The coefficients are separate parameters because conflating them is the misconception. |
| Answer | `{ threshold: number, friction: number, acceleration: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'is static friction always μN' · `true_false` for the direction of friction on a stationary block. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A block on a rough surface with a force arrow whose length grows as it is applied, and a marker where the block begins to slide. The task is to report the largest force the block will resist without moving, the friction force once it is sliding, and the acceleration then. The alternative gives the mass and both coefficients, so all three answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Static friction always equals `μN`. (2) Friction acts in the direction of motion. (3) A block at rest has no friction force at all. |

#### 176. `physics.energy-conservation` — Energy tracks

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can account for energy through a descent and say where the missing energy went. |
| Interaction | Control the slider down the track; the kinetic and potential bars update; type the speed at a stated height and the loss. |
| Model | Energy is conserved to within a DECLARED fraction, and the remainder is reported as dissipated rather than silently dropped. The bars are computed from the same `(height, speed)` the motion integrates, so the visual and the number cannot be two implementations. |
| Answer | `{ speed: number, kinetic: number, potential: number, dissipatedFraction: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `ordering` for the sequence of stores as the object descends, which is the PATH_SENSITIVE reading · `single_choice` for where energy goes. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An object part-way down a track with two labelled bars: one for kinetic energy and one for gravitational potential energy, and a third for energy dissipated so far. The task is to report the speed at a stated height, the two energies there, and the fraction dissipated. The alternative gives the starting height and the mass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Energy is lost, so it is not conserved. (2) Kinetic energy depends on speed rather than on speed squared. (3) The total energy bar shrinks because energy is destroyed. |

#### 177. `physics.momentum-collisions` — Collisions

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can account for momentum through a collision and say what elastic and inelastic each conserve. |
| Interaction | Set masses and speeds; the collision animates and can be scrubbed; type the momentum before and after, and the kinetic energy lost. |
| Model | Momentum is conserved by construction — the post-collision velocities are SOLVED from the momentum and restitution equations rather than animated and then measured, so the conservation the question asks about is true of the model and not merely true of the drawing. The restitution coefficient is a parameter, which is what separates elastic from inelastic. |
| Answer | `{ pBefore: number, pAfter: number, keLostFraction: number, restitution: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `true_false` for 'kinetic energy is conserved in an inelastic collision' · `single_choice` for which quantity is conserved. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two blocks on a straight track meeting and rebounding, with their masses and speeds written beside them before and after. The task is to report the total momentum before and after and the fraction of kinetic energy lost. The alternative gives both masses, both initial velocities and the coefficient of restitution, so the answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Momentum is conserved only if the collision is elastic. (2) Kinetic energy is conserved in every collision. (3) The heavier object always moves slower after a collision. |

#### 178. `physics.centre-of-mass` — Centre of mass

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can find the centre of mass of a composite body and say when it tips. |
| Interaction | Place masses at points on a shape; the centre of mass and the plumb line redraw; type the coordinates and whether it tips. |
| Model | The centre of mass is the mass-weighted mean of the placed points and is recomputed on every drag. **Tipping is a comparison of the centre of mass's horizontal position with the support's edge, not a look at the picture** — the sim states the overhang in the answer so the criterion is explicit and the drawing is decoration. |
| Answer | `{ com: {x, y}, tips: boolean, maxOverhang: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the tipping claim · `single_choice` for 'which arrangement tips'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A shape with movable masses placed at marked positions and a cross marking the centre of mass, plus a horizontal base. The task is to report the coordinates of the centre of mass, whether the body tips, and by how much it can be overhung. The alternative gives the masses and their positions as coordinates. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The centre of mass of an object is at its geometric centre. (2) Moving a heavy object further out does not affect stability. (3) A body tips when its centre of mass reaches an edge rather than passes it. |

#### 179. `physics.circular-motion` — Circular motion

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute the centripetal force and say why it points at the centre rather than along the motion. |
| Interaction | Set radius, speed and the angle; the path and the force vectors animate; type the centripetal force and the period. |
| Model | The centripetal force is a DERIVED quantity — `mv²/r` — and is displayed as a consequence of the motion rather than as an input that drives it, because a sim where the student sets the force and the sim computes the path teaches the wrong direction of causation for the thing the sim exists to teach. The banking angle is solved from the force balance rather than drawn. |
| Answer | `{ centripetalForce: number, period: number, bankAngle: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for 'centripetal force is a new force' · `single_choice` for the direction of the force. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `v²/r` compounds: with `v` in m/s and `r` in m, a two-significant-figure answer to a two-significant-figure question differs from the computed value in the third figure, and `rel`-only grading will accept `4400` for `4367`. Declare `rel` for the model and `abs` for the question's precision (T-D). |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A mass moving on a circular path with an arrow drawn from the mass towards the centre. The task is to report the centripetal force, the period of the motion, and the banking angle for a stated speed. The alternative gives the radius, the speed and the gravitational field strength. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Centripetal force is a separate force acting in addition to gravity. (2) It acts along the direction of motion. (3) It does no work. |

#### 180. `physics.gravity-orbits` — Orbits and gravity

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute an orbital speed and a period from the inverse-square law, and say where the excess energy goes. |
| Interaction | Set the central mass and the orbital radius; the orbit animates; type the circular speed, the period and the escape velocity. |
| Model | `v = √(GM/r)` and `T = 2π√(r³/GM)` are computed from `G`, `M` and `r` held as named quantities in SI units, with the conversion from AU and days being the sim's parameter editor's job. The ORBIT IS SAMPLED on an eccentric circle whose semi-major axis is `r`, so an orbit at `r` AU is genuinely not a circle and the sim says so — a sim that draws every orbit as a circle cannot then be asked about escape velocity honestly. |
| Answer | `{ circularSpeed: number, period: number, escapeVelocity: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the inverse-square claim · `single_choice` for 'what happens at exactly escape velocity'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | **Square roots of astronomical quantities are where a relative tolerance is mandatory and an absolute one is meaningless.** `√(1.327e20/1.496e11)` is 29785.2 m/s and a student typing `29.8 km/s` is correct. `rel: 0.001` with `abs: 0.5 m/s`. But a student typing nothing gets `asNumber('') === null` and is scored 0 with a reason — which is the correct outcome and is not a tolerance failure. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A planet tracing a path around a central body, with the radius of the orbit marked and the body's mass stated. The task is to report the speed for a circular orbit at that radius, the period, and the escape velocity. The alternative gives the central mass and the orbital radius in the stated units. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The inverse-square law applies to orbital forces. (2) An orbit at exactly escape velocity is circular. (3) The period depends on the mass of the orbiting body. |

#### 181. `physics.kepler-laws` — Kepler's laws

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can check Kepler's third law numerically and say what the constant is. |
| Interaction | Add planets to a system; the orbits and the T³/r³ ratio plot; type the ratio for a named pair and the value of the constant. |
| Model | The third law is checked against the SIMULATED orbits, not asserted: the sim measures `a` (the semi-major axis, from the drawn ellipse's own geometry) and `T` and forms `T³/a³`, so a student who has discovered the law is measuring the same quantity the sim is. **The plan's strategy for this row is `E` (exact) and the card overrides it to `T` with a declared relative tolerance**, because a law constant is an irrational quantity and EXACT on it would be the wrong instrument — see the plan/code disagreement register. |
| Answer | `{ ratio: number, constant: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `ordering` for the planets by period, which is the PATH_SENSITIVE reading · `true_false` for the law's claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `T³/a³` in units of years and AU is about 1.000. `rel: 0.01` is the honest band; `abs: 0.0001` alone would mark a student using `9.96×10⁻⁵` in SI units as wrong for a units disagreement that is not a mathematical one. Declare BOTH and state the expected UNIT in the answer key. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Several elliptical orbits around a central star, with the semi-major axis of each drawn as a line through its centre, and a table of periods. The task is to compute the ratio of the cube of the period to the cube of the semi-major axis for a named pair of planets. The alternative gives the semi-major axes and the periods in years and AU. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) T³/a³ is the same for every star's planets. (2) The third law says orbits are circular. (3) The constant is dimensionless. |

#### 182. `physics.rocket-equation` — Rocket equation

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute the delta-v a rocket gets from a mass ratio and say why staging helps. |
| Interaction | Set initial and final masses and the exhaust velocity; the stage animation plays; type the delta-v and the mass ratio needed. |
| Model | Tsiolkovsky `Δv = v_e ln(m₀/m_f)` is evaluated with `Math.log`, and the card requires the answer to 1 dp because `ln` is irrational and a two-figure answer is not the same as a two-figure rounding of it. Staging is modelled as SEQUENTIAL applications of the same equation with a stated payload carried through, because a single application over the whole rocket is the specific error staging exists to fix. |
| Answer | `{ deltaV: number, massRatio: number, stagesDeltaV: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'does staging change the total delta-v' · `true_false` for the staging claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `ln` compounds with the mass ratio, and the answer is often reported in km/s while the input is m/s. **A sim that returns `deltaV` in m/s and grades against a key in km/s marks every correct student wrong by a factor of 1000, and no tolerance catches it** because a relative tolerance is scale-invariant. The card requires ONE unit, declared in the answer key, and the `rationaleTemplate` to print it. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A two-stage rocket drawn in sections with the propellant mass in each stage labelled and decreasing as it fires. The task is to report the total change in velocity available, the mass ratio it comes from, and the change if the stages were combined. The alternative gives the exhaust velocity and the initial and final masses in kg. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Staging gives the same delta-v as a single stage with the same propellant. (2) The delta-v depends on how fast the propellant is expelled but not on the mass ratio. (3) A more massive rocket has more delta-v for the same engine. |

#### 183. `physics.drag-and-lift` — Drag and lift

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say why terminal velocity exists and what changes when drag is quadratic rather than linear. |
| Interaction | Set the drag law and the wing area; the descent settles to a steady speed; type the terminal velocity and the lift. |
| Model | Both drag laws are implemented and switchable (`F = kv` and `F = ½ρC_dAv²`), and the sim **integrates to a fixed timestep with a step budget** — a quadratic-drag descent from a large height takes more steps than the default budget, and the honest outcome is a reported budget exhaustion, not a silently truncated answer. Lift is `½ρC_LAv²` with the coefficients as declared parameters. |
| Answer | `{ terminalVelocity: number, lift: number, dragForce: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which drag law dominates at low speed · `true_false` for 'terminal velocity depends on the mass'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Quadratic drag is the strongest `T-D` case in the catalogue: the answer depends on `√(2mg/ρC_dA)`, so every intermediate is irrational and the relative error compounds through the square root. `rel: 0.005, abs: 0.05 m/s`, and the answer to 2 dp. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An object falling with drag arrows drawn opposite the motion, its speed rising towards a steady value and then holding. The task is to report the terminal velocity, the drag force there and the lift needed to hold the object level. The alternative gives the mass, the drag law and the coefficients. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Terminal velocity is reached when the weight equals the drag. (2) Quadratic drag dominates at low speed. (3) Lift is independent of the wing's area. |

#### 184. `physics.pressure-fluids` — Pressure and fluids

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can compute a pressure at depth and say what Archimedes' principle predicts about floating. |
| Interaction | Change depth and container shape; the pressure and the displaced volume compute; type the gauge pressure and the upthrust. |
| Model | Gauge pressure is `ρgh` with `g = 9.81`, and **container SHAPE does not enter it** — the sim draws three shapes of different volumes at the same depth with the same pressure, because 'the pressure depends on the shape' is the misconception this row exists for. Upthrust is `ρ_fluid V_displaced g` computed from the geometry the sim renders. |
| Answer | `{ gaugePressure: number, upthrust: number, floats: boolean }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for 'pressure depends on the container's shape' · `single_choice` for 'will it float'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Three containers of different shapes filled to the same depth with a liquid, and the pressure at a marked depth written on each. The task is to report the gauge pressure at that depth and the upthrust on a stated object. The alternative gives the liquid's density, the depth and the object's volume and mass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Pressure at depth depends on the container's shape. (2) An object floats when its density equals water's. (3) Pressure is the same at all points at one depth. |

#### 185. `physics.thermal-transfer` — Heat transfer

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can tell conduction, convection and radiation apart from the mechanism, not the direction. |
| Interaction | Switch between three setups; the temperature field animates to equilibrium; type the equilibrium temperature and the rate constant. |
| Model | Three SEPARATE models, not one with a flag — a single model with a mode parameter is how a sim ends up transferring energy by the same equation in all three cases and therefore teaching nothing. Each has its own state, and the equilibrium is found by integrating to a declared residual rather than by a fixed step count. |
| Answer | `{ equilibrium: number, timeConstant: number, mechanism: 'conduction'\|'convection'\|'radiation' }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the mechanism · `true_false` for 'radiation needs a medium'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A bar heating up with a temperature gradient drawn along it, a liquid heating with a circulation arrow, and two bodies radiating with arrows between them. The task is to report the equilibrium temperature for the stated setup and to name the mechanism. The alternative gives the starting temperatures, the material properties and the time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) All three need a material medium. (2) Convection and conduction are the same process. (3) Radiation transfers energy because the particles move. |

#### 186. `physics.gas-laws` — Ideal gas laws

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can apply PV = nRT and say what a microscopic model adds to it. |
| Interaction | Change P, V, T and n; the piston moves and the molecules animate; type the fourth quantity from the other three. |
| Model | `PV = nRT` with `R = 8.314` in SI, and the answer is the MISSING quantity computed from the same three the student sees. The microscopic model is a separate view over the same state — same `(P,V,T,n)`, different picture — so the two cannot disagree, and the sim asserts that on every redraw rather than drawing two independent things. |
| Answer | `{ missing: number, quantity: 'P'\|'V'\|'T'\|'n' }` with declared units. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 (value and which quantity) · `true_false` for Boyle's law at constant temperature · `single_choice` for what happens to the piston. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | **`R = 8.314` is a rounded constant and the rounding propagates.** With `n = 0.5` mol and `T = 300 K`, `nRT = 1247.1` and using `R = 8.31` gives 1246.5 — a 0.05% difference. `rel: 0.005` covers both a student using 8.314 and one using 8.31, which is the RIGHT call: the ambiguity is in the physical constant, not in the student. Record it on the card so a reviewer does not read the band as slack. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A cylinder with a movable piston containing molecules as small dots, with the pressure, volume, temperature and amount labelled. The task is to work out one of the four quantities from the other three. The alternative gives the three known quantities with their units and states the value of the gas constant to be used. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Boyle's law says pressure is proportional to volume. (2) Pressure is caused by molecules colliding with the walls only. (3) One mole of any gas occupies the same volume at all conditions. |

#### 187. `physics.kinetic-theory` — Kinetic theory

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say temperature is a statement about mean kinetic energy, and predict the speed distribution's shape. |
| Interaction | Change temperature and mass; the speed distribution redraws; type the mean speed and the most probable speed. |
| Model | The distribution is generated by DRAWING speeds from a seeded stream and binning them, then the statistics are computed from the DRAWN speeds rather than from the analytic Maxwell-Boltzmann curve — because the sim's claim is that temperature is a property of the particles, and a sim that reads the statistics off the formula it is trying to demonstrate proves nothing. The seed is in the state, so the picture is reproducible. |
| Answer | `{ meanSpeed: number, mostProbableSpeed: number, rmsSpeed: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the shape of the distribution · `true_false` for 'temperature is the mean speed'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The drawn speeds are a SAMPLE, so the mean of a finite sample is not the population mean and varies with the seed. **The card must fix the seed** and say so in the answer key, or two students on the same question get different correct answers. With `n = 200` the sample mean of speeds is about 0.5% off the analytic value — `rel: 0.02` for the sample mean, and `rel: 0.001` for the rms speed computed analytically. |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A container of molecules drawn as dots with a bar chart beside it showing how many are moving at each speed. The task is to report the mean speed, the most probable speed and the root-mean-square speed. The alternative gives the temperature, the molar mass and the number of molecules, and states the gas constant. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Temperature is the mean speed of the molecules. (2) All molecules move at the same speed at a given temperature. (3) Adding energy at constant volume raises the pressure without raising the temperature. |

#### 188. `physics.shm` — Simple harmonic motion

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can relate period to amplitude and mass, and say where the energy goes when a spring is damped. |
| Interaction | Set amplitude, mass and damping; the oscillation animates and can be scrubbed; type the period and the energy at half amplitude. |
| Model | The oscillator is integrated at a FIXED STEP with the step size as a declared parameter, and the period is MEASURED from the simulated zero crossings rather than evaluated from `2π√(m/k)` — the sim prints the formula's value beside the measured one so the small-amplitude gap is visible, which is the row's focus ('amplitude, period, energy, damping'). The amplitude is the state variable that decays, so the energy is recomputed from the state rather than carried separately. |
| Answer | `{ period: number, energyAtHalfAmplitude: number, amplitudeAfterNDamping: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for 'the period depends on the amplitude' · `single_choice` for where the energy goes. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `T = 2π√(m/k)` and `E = ½kA²` — both irrational in their inputs, and the energy term is quadratic in amplitude so an error in `A` doubles. `rel: 0.01` on the period, `abs: 0.01 J` on the energy. **Note the different classes on one card**: the period wants relative-only and the energy wants an absolute floor, because `E` can legitimately be near zero at a small amplitude. That is T-D on the period and T-D-with-abs on the energy, and the card must say which applies to which field. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A mass on a spring oscillating horizontally with an amplitude bracket marked and a damping envelope decaying around it. The task is to report the period, the energy at half the amplitude, and the amplitude after a stated number of oscillations. The alternative gives the mass, the spring constant, the initial amplitude and the damping coefficient. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The period of a spring depends on the amplitude. (2) The total energy depends on the amplitude. (3) Damping increases the period. |

#### 189. `physics.waves-on-a-string` — Waves on a string

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can add two waves and say where they reinforce and where they cancel. |
| Interaction | Flick the string or set two sources; the standing wave forms; type the wavelength, the frequency and the node positions. |
| Model | The string is a fixed-step wave equation — a discretised string with a declared node count — NOT a sum of sinusoids, because a sim built from two sinusoids cannot show a shape that is not sinusoidal, and harmonics are half the point of the row. Superposition is computed pointwise on the discretisation. |
| Answer | `{ wavelength: number, frequency: number, nodes: number, antinodes: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `ordering` for the node positions, which is order-sensitive · `single_choice` for 'where is it a node'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A string fixed at both ends carrying a standing wave, with nodes and antinodes marked along its length. The task is to report the wavelength, the frequency and the number of nodes and antinodes. The alternative gives the string length, the wave speed and the driving frequency, so all four answers are computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Waves on a string need a medium to travel in a second dimension. (2) Standing waves form by superposition of two waves travelling the same way. (3) A node is where the amplitude is greatest. |

#### 190. `physics.sound-doppler` — Sound and the Doppler effect

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say why a source approaching you raises the pitch and a source passing you does not jump. |
| Interaction | Move the source and the observer with the sliders; the wavefronts bunch; type the observed frequency at two positions. |
| Model | The observed frequency is computed as `f' = f·(v ± v_o)/(v ∓ v_s)` with the SIGN attached to which body is moving — and the card requires the model to state the sign, because the classic error is applying the numerator formula while the observer moves and the denominator formula while the source moves. The wavefronts are drawn from that formula, so a bunching that disagrees with the typed frequency is a visible bug rather than a hidden one. |
| Answer | `{ observed: number, emitted: number, shifted: boolean }` in hertz. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `true_false` for 'the pitch jumps when the source passes' · `single_choice` for 'approaching or receding'. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A source sending out sound wavefronts that bunch up in front of it and spread out behind, with a listener marked. The task is to report the frequency the listener hears and whether it is higher or lower than the emitted one. The alternative gives the emitted frequency, the speed of sound and the relative velocity. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The observed frequency shifts when the source passes the listener with a jump. (2) The shift depends only on the listener's motion. (3) A source moving at the speed of sound is heard at a frequency of zero for a stationary listener behind it. |

#### 191. `physics.electrostatics` — Electrostatics and fields

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can draw an electric field for a pair of charges and compute the force on a test charge. |
| Interaction | Place charges; the field lines and the potential grid redraw; type the force on a test charge at a stated point. |
| Model | The field is computed pointwise as the vector sum of `kQ/r²` contributions and the field LINES are traced by walking that field, not drawn by hand — a sim that draws pre-computed field lines for a handful of charge arrangements cannot be asked about a placement it has no picture for. Potential is the scalar sum and is reported on its own grid. |
| Answer | `{ force: number, potential: number, fieldDirection: number }` — direction as an angle in degrees. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the field direction · `true_false` for the field-line claim · `multi_select` for which charges attract. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | Two or three point charges marked on a sheet, with curved field lines drawn between and around them and arrows showing their direction. The task is to report the force on a test charge placed at a stated point, and the direction of the field there. The alternative gives each charge's value and sign and the test charge's position. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Field lines start and end on charges. (2) Like charges attract. (3) Potential and potential energy are the same quantity. |

#### 192. `physics.circuit-construction-lab` — Circuit construction lab

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can predict a circuit's readings before building it, and say by how much you were wrong. |
| Interaction | Place components, predict the meter readings, then build and compare. |
| Model | The PREDICTION is the answer and it is recorded BEFORE the build: the sim stores `predicted` and `measured` in the state and grades the ERROR. This is the one sim in the catalogue whose pedagogically interesting quantity is a discrepancy, and it is why the plan's focus says 'graded on prediction error'. The card must state the prediction is recorded at submit time and cannot be edited afterwards — otherwise a student predicts after measuring and the item measures nothing. |
| Answer | `{ predicted: number, measured: number, error: number, relativeError: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `true_false` for 'within tolerance' · `ordering` for the sequence build-then-measure, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `PATH_SENSITIVE_REQUIRED` — REQUIRED, not optional — the whole question is whether the student predicted BEFORE measuring, and `ENDPOINT_ONLY` hands the grader `{state: null, trace: []}` (`grading/simulation.ts:354-357`), which cannot see that. The reviewer must enforce this one. |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | An empty circuit board with component slots and a prediction panel listing the readings the student expects, beside the meter readings once the circuit is built. The task is to predict the meter readings first, then build the circuit and report the difference. The alternative gives the components available and their values. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A prediction is a guess and does not need to be recorded. (2) Current readings can be predicted after the circuit is built. (3) A prediction within tolerance is the same as a correct prediction. |

#### 193. `physics.em-induction` — Electromagnetic induction

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say why Lenz's law makes induced current oppose the change, and apply Faraday's law. |
| Interaction | Move a magnet through a coil; the induced emf and current plot against time; type the peak emf and the direction of the current. |
| Model | The induced emf is `−N dΦ/dt` with the sign convention stated, and the sim plots the emf AND the flux on one time axis so the opposition is visible rather than asserted. The direction is reported from the sign of the derivative, computed from the flux the sim itself integrates — not from a lookup of which way the magnet is pointing, which is the move the sim is trying to prevent. |
| Answer | `{ peakEmf: number, direction: 'clockwise'\|'anticlockwise'\|'none', charge: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the direction · `true_false` for Lenz's law's claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The peak emf depends on the magnet's SPEED, so the answer is not a function of the magnet's position alone and a regrade that restores only the final position cannot reproduce it. **The card requires speed to be in the state**, and the replay story is: restore `(position, speed, coilTurns)` and re-integrate. A sim whose state stores only the position cannot be regraded — which is the `P11-T9` requirement stated as a card field. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A bar magnet moving through a coil, with the magnetic flux through the coil plotted against time and the induced emf plotted beneath it. The task is to report the peak induced emf and which way the induced current flows. The alternative gives the coil's turn count, the magnet's pole strength and the speed of movement. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The induced current opposes the flux change because of energy conservation. (2) Faraday's law's sign is arbitrary. (3) A transformer works on direct current. |

#### 194. `physics.magnetic-fields` — Magnetic fields

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can use the right-hand grip rule and compute the force on a current-carrying wire. |
| Interaction | Place a wire in a field; the force arrow and the motor effect draw; type the force and its direction. |
| Model | `F = BIL sin θ` with `θ` measured between the wire and the field, and the sim draws the field as uniform lines with a declared direction so the angle is a quantity and not an impression. The right-hand rule is applied by the model to produce the direction; the card requires the student to also state the rule they used, which is the answer a marker wants. |
| Answer | `{ force: number, direction: string, torque: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the force direction · `true_false` for the motor-effect claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A straight wire carrying current placed in a magnetic field, with the field shown as parallel arrows and the force drawn perpendicular to both. The task is to report the size of the force, its direction, and the torque on a coil. The alternative gives the field strength, the current, the wire length and the angle. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The force on a current-carrying wire is along the current. (2) Magnetic field lines begin and end at magnetic poles. (3) A wire parallel to the field experiences the maximum force. |

#### 195. `physics.optics-lenses` — Lenses and imaging

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can use the thin-lens equation and say which object distance puts the image exactly at infinity. |
| Interaction | Move the object and the lens; the image and ray diagram redraw; type the image distance, the magnification and the focal length. |
| Model | `1/v = 1/f − 1/u` with SIGNED distances in metres, and the ray diagram is drawn from the signed solution rather than by choosing a case — the case table (`u < f`, `f < u < 2f`, `u = 2f`, `u > 2f`) is the student's job, and a sim that picks the case for them teaches nothing. The magnification is `v/u`, signed, so a negative value IS the statement that the image is inverted. |
| Answer | `{ v: number, magnification: number, f: number }` — signed. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for 'where is the image' · `true_false` for 'a negative magnification means the image is inverted'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | the unit: `asNumber` strips everything outside `[0-9.eE+-]`, so `2x10^-3` becomes `210` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A lens on an axis with an object at one side, its image at the other, and three rays traced between them. The task is to report the image distance, the magnification and the focal length of the lens. The alternative gives the object distance, the lens type and the magnification, or the other two, so the third is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) An object at 2f produces an image at 2f for any lens. (2) A negative magnification means the image is smaller. (3) The focal length depends on the object distance. |

#### 196. `physics.polarisation` — Polarisation

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can apply Malus's law and say why polarised sunglasses reduce glare. |
| Interaction | Rotate a polariser; the transmitted intensity and the view through it change; type the transmitted fraction and the extinction ratio. |
| Model | `I = I₀ cos²θ` is evaluated for the polariser angle and the result is compared against the exact values `0`, `½` and `1` at 0°, 45° and 90° by the model itself — the card grades the exact value where one exists and a declared tolerance elsewhere, because `cos²(45°) = 0.5000000000000001`. **The plan's strategy for this row is `E` (exact) and it is correct here, for the aligned and crossed cases only.** |
| Answer | `{ fraction: number, exact: '0'\|'1/2'\|'1'\|null, extinction: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the exact value at a stated angle · `numeric` for an arbitrary angle · `true_false` for the sunglasses claim. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | `cos²(π/4)` is `0.5000000000000001` and a student answering `1/2` or `0.5` is right. `EXACT` on the string `1/2` passes and `NUMERIC` on the float FAILS. This row is the clearest case in the catalogue for the card's rule: **grade the symbolic form when one exists, and the tolerance is not the answer**. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A light source, a polarising filter drawn as a grid of parallel lines, and the transmitted beam shown brightening and dimming as the filter is rotated through marked angles. The task is to report the fraction of light transmitted at a stated angle and the extinction ratio between the best and worst orientations. The alternative states the angles in degrees and the law to apply. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Polarised sunglasses work by reducing the light's intensity rather than by removing one polarisation. (2) Unpolarised light becomes polarised on reflection at any angle. (3) Malus's law applies to two polarisers with a relative angle. |

#### 197. `physics.atomic-models` — Atomic models

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can say what Rutherford's scattering result ruled out, and read a line spectrum as discrete energies. |
| Interaction | Fire alpha particles at a nucleus; the scatter plot builds; type the conclusion and the energy of a named line. |
| Model | The scattering is a MONTE CARLO draw from a seeded stream with the classical large-angle probability, not an animation — and the histogram is what the student reads, so the sim's claim ('large angles are rare but they happen') is a property of the drawn sample. The energy levels are drawn from the same Rydberg formula the answer is graded against. |
| Answer | `{ conclusion: 'nucleus'\|'nucleus-charge'\|'plum-pudding', energy: number }`. |
| Strategy | `EXACT` · `partialCredit: false` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `single_choice` for the conclusion · `numeric` for a line energy · `multi_select` for which conclusions the evidence supports. |
| Tolerance class | `F` — T-F · closed vocabulary. |
| Float hazard | **highest.** any second legal spelling a student may write is a false wrong; `short_text`+`REGEX_SET` instead |
| Seed strategy | **S-1 · seeded content.** `randomised: true`, `PER_STUDENT/ATTEMPT_ID`. State MUST carry `seed` and `seedFromHost: true`** — the only place a cross-origin harness can see which seed ran; the cell refuses a seeded sim without it (`scripts/sim-conformance.mjs:978-995`). |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* every draw is `createRng(seed)` (mulberry32, `@orrery/rng`); never `Math.random`, which `sim:validate` refuses by name (`scripts/sim-validate.mjs:210-215`). |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A scatter plot of alpha-particle deflections with most tracks passing straight through and a few bouncing back, beside a set of horizontal energy levels with arrows between them. The task is to say which atomic model the evidence supports and to work out the energy of one named transition. The alternative states the element and the transition, so the energy is computable from text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Rutherford's experiment showed the electron's mass. (2) A large-angle scatter is impossible in the plum-pudding model. (3) Atomic spectra are continuous. |

#### 198. `physics.nuclear-decay` — Radioactive decay

| Field | Value |
|---|---|
| Subject · band · age | `physics` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work out an activity from a half-life and say how a decay chain's equilibrium differs from a single decay. |
| Interaction | Set the half-life and the starting amount; the decay curve plots on a log scale; type the activity at a stated time and the amount after a stated number of half-lives. |
| Model | `A = λN` with `λ = ln2 / t_half`, and the card requires 1 dp on the half-life-derived answer because `ln2/10` is `0.0693` and a student who computed the constant from `0.693/10` has `0.0693` too, but one who wrote `2^−0.1` per second has a different third figure. The plot is on a LOG axis and the axis is labelled as such, because a linear plot of exponential decay is the reason students think the rate is constant. |
| Answer | `{ activity: number, remaining: number, halfLives: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the graph shape on a log axis · `true_false` for 'the decay rate is constant'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | A student who computes `100 × 2^(−3/10)` and a sim that computes `100 × exp(−0.0693 × 3)` differ in the fourth figure: `2^(−0.3) = 0.812252` and `exp(−0.2079) = 0.812253`. **The card must declare `rel: 0.005` and say why**, because the difference is a legitimate difference of method and a student is not wrong for it. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A decay curve on axes marked as logarithmic, with the half-life marked on the time axis, and a row of the sample decaying. The task is to report the activity at a stated time, the amount remaining after a stated number of half-lives, and how many half-lives a stated time represents. The alternative gives the starting amount, the half-life and the time. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The decay rate is proportional to the number of nuclei. (2) Half the atoms always decay in half the half-life regardless of the starting amount. (3) On a linear graph, exponential decay looks like a straight line. |

#### 199. `physics.particle-collisions-2d` — Collisions in 2D

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can use conservation of momentum as a constraint and find the possible outcomes rather than the ones you expect. |
| Interaction | Set the incoming velocities and the scattering angle; the outcome animates; type the two possible outgoing speeds. |
| Model | This row's focus is 'momentum conservation as a CONSTRAINT SOLVER': given the scattering angle, the two possible outgoing speed pairs are SOLVED from the conservation equations and then both tested against the elastic/inelastic condition, so a student who assumes a single answer gets the second one as a surprise. Both solutions are computed; neither is discarded. |
| Answer | `{ speedA: number, speedB: number, bothValid: boolean }` — the two roots, with both accepted. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the possible speed pairs · `numeric` ×2 · `true_false` for 'there is only one possible outcome'. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The quadratic has two roots and their SUM is well conditioned while their individual values are not near a double root — so the two answers swap identity under a small parameter change. **The card requires the answers graded as a SET with `partialCredit` and states that either root may occupy either slot**, which is what T-G's case-folding rule is for; `SET` is correct and `ORDER` would be wrong. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two discs on a flat table meeting at an angle, with their velocity vectors drawn before and after, and two possible outgoing vector pairs drawn faintly. The task is to work out the two possible speeds after the collision. The alternative gives both masses, the incoming velocity and the scattering angle. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A given angle and initial momentum fix one outcome. (2) Momentum conservation fixes both the angle and the speeds. (3) The elastic case and the inelastic case have the same possible outcomes. |

#### 200. `physics.doppler-radar` — Radar and Doppler

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can turn a frequency shift into a radial speed and say why it cannot tell you the tangential one. |
| Interaction | Set the target's velocity and angle; the beat frequency plots; type the radial speed and the blind direction. |
| Model | The shift is `Δf = 2v_r f/c` — the factor of 2 is the return path and omitting it is THE error this sim exists for, so the model applies it once for the outbound leg and once for the inbound leg explicitly rather than doubling a single formula. The blind direction (perpendicular to the beam) is reported, because 'Doppler gives radial speed only' is the finding the row's focus names. |
| Answer | `{ radialSpeed: number, shift: number, blindDirection: string }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the blind direction · `true_false` for 'Doppler measures total speed'. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | `c = 3×10⁸` and `f` in GHz give a shift in Hz that is about 10⁻⁶ of `f`. **The card requires the shift to be graded as a RELATIVE quantity**, `rel: 0.01`, with `abs` in Hz at the precision the question asks for; an absolute tolerance in Hz wide enough to matter would accept a target moving at 100 m/s when it is moving at 30. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A radar beam drawn from a transmitter to a moving target and back, with the outgoing and returned waveforms drawn one above the other and the difference between them marked. The task is to report the radial speed of the target and the beat frequency. The alternative gives the transmitted frequency, the target's velocity and the angle between the velocity and the beam. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The shift is doubled by the round trip. (2) Doppler measures the target's total speed. (3) A target moving perpendicular to the beam produces no shift, so it cannot be detected at all. |

#### 201. `physics.rocket-staging` — Multi-stage rockets

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can show that staging beats a single stage for the same propellant, and find the split that maximises delta-v. |
| Interaction | Set the stage masses; the staging animation plays; type the total delta-v and the best split. |
| Model | Staging is modelled as SEQUENTIAL applications of Tsiolkovsky with a stated payload retained through both stages, and the single-stage comparison is the SAME rocket with the interstage tank filled — otherwise the comparison is rigged, and a sim whose staging is rigged will show a smaller gain than reality. The optimiser over the split is a bisection at a declared mass resolution, so the reported best split is a function of the resolution and the card says so. |
| Answer | `{ stagedDeltaV: number, singleDeltaV: number, bestSplitFraction: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the staging claim · `ordering` for the burn sequence, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Three `ln` applications compound: with `rel: 0.005` on each stage the total is within about 0.8% — but the card grades the TOTAL against one `rel`, and a student who rounded each stage's delta-v to 1 dp has an error of about 0.5 percentage points. `rel: 0.01, abs: 1 m/s`, and the rationale prints the per-stage values so a marker can see where a student's total came from. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A rocket shown in two stages with the propellant mass in each labelled, a marker showing where the first stage separates, and a plot of delta-v against stage mass ratio. The task is to report the total change in velocity from staging, the same figure without staging, and the mass split that gives the best result. The alternative gives the exhaust velocity, the payload mass and the total propellant mass. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Staging adds no delta-v over a single stage of the same total mass. (2) The optimal split is equal propellant in each stage. (3) The payload is discarded with the first stage. |

#### 202. `physics.rolling-friction` — Rolling and slipping

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say when a rolling body starts to slip, and which moment of inertia you need for the answer. |
| Interaction | Set the friction and the radius; the body rolls or slips and animates; type the threshold friction and the acceleration. |
| Model | **Rolling uses `I = ½mr²` for a solid sphere and `I = mr²` for a hoop, and these are SEPARATE scenarios rather than a shape parameter** — because a sim with a continuous `shapeFactor` cannot be asked 'which is it', and 'which moment of inertia' is the row's focus. The slip condition is `f ≤ μ_s mg` with the required friction being `⅓mg` for a solid sphere, which is the number the sim is built to make surprising. |
| Answer | `{ threshold: number, acceleration: number, slip: boolean }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the moment of inertia · `true_false` for the 'friction does no work while rolling' claim. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `a = g/(1 + I/mr²)` gives `⅔g` for a sphere and `½g` for a hoop. `g = 9.81` so these are `6.54` and `4.905` — and a student using `g = 10` gets `6.67` and `5.0`. **The card requires the card to state `g` explicitly**, as `maths.projectile-motion`'s spec card does for `g = 9.81`, and `rel: 0.01` covers the `g` disagreement, which is a convention difference and not a student error. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A body on a rough surface with an arrow showing its linear velocity and another showing its rolling angular velocity, and a marker where slipping begins. The task is to report the largest friction that allows pure rolling, the acceleration while rolling, and whether the body slips. The alternative gives the shape, the mass, the radius and the coefficient of static friction. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A rolling body needs friction equal to μN. (2) A hoop and a solid sphere of the same mass and radius roll with the same acceleration. (3) Friction does no work while rolling. |

#### 203. `physics.phase-transitions` — Phase transitions

| Field | Value |
|---|---|
| Subject · band · age | `physics` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can read a phase diagram and say what happens past the critical point. |
| Interaction | Move the pressure and temperature; the phase diagram and the state indicator redraw; type the boiling point at a stated pressure and whether the critical point is reachable. |
| Model | The coexistence curves are the Clausius-Clapeyron integration rather than a fitted polynomial, so a point just BELOW the critical point and one just above give different-looking behaviour rather than a smoothed-over one — the row's focus names 'real anomalies' and a polynomial fit cannot produce them. Superheating is a separate mode because it is metastable and the equilibrium model cannot represent it. |
| Answer | `{ boilingPoint: number, superheated: boolean, pastCritical: boolean }` — kelvin. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` for the boiling point · `true_false` for the superheating and critical claims · `single_choice` for the phase at a stated point. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The Clausius-Clapeyron exponent is `−ΔHvap/(R·T)`, so the answer is exponentially sensitive to the temperature: a 1 K error near the critical point moves the boiling point by tens of kelvin. **A relative tolerance is wrong here** — it would accept a 30 K error as 5%. The card requires `abs` in kelvin sized to the question's precision and states that `rel` must be omitted, which makes this a T-B card in a catalogue of mostly T-D ones. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A phase diagram with pressure on one axis and temperature on the other, showing the solid, liquid and gas regions separated by curves meeting at a critical point. The task is to report the boiling temperature at a stated pressure and to say whether a stated state is superheated or past the critical point. The alternative gives the substance and the two curves' behaviour in text. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Above the critical point the liquid and the gas are the same substance. (2) Superheating is the normal behaviour of a liquid. (3) The boiling point rises with pressure for every substance. |

#### 204. `modern-photons` — Photons and the photoelectric effect

| Field | Value |
|---|---|
| Subject · band · age | `modern-photons` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say why the photoelectric effect rules out the wave model, and work out a threshold frequency. |
| Interaction | Change the metal, the frequency and the intensity; the graph of stopping potential against frequency draws; type the threshold frequency and the work function. |
| Model | `eV_s = hf − φ` is evaluated from the DECLARED work function and Planck constant, and the sim draws the straight line from those two numbers rather than from a fitted set of experimental points — so a student testing `V_s` at a stated frequency is evaluating the same model the graph shows. The intensity changes the CURRENT and not the stopping potential, and the sim shows both, because 'brighter light raises the stopping potential' is the misconception the row exists for. |
| Answer | `{ thresholdFrequency: number, workFunction: number, stoppingPotential: number, photocurrent: number }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for 'does intensity change the stopping potential' · `true_false` for the wave-model claim · `ordering` for the evidence that discriminated the two models, the PATH_SENSITIVE reading. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `h = 6.626×10⁻³⁴` is itself a rounded constant and the answer is linear in it, so a student using `6.63×10⁻³⁴` differs by 0.06%. `rel: 0.01`, and the card states the constant to be used so a marker can tell a rounding difference from a wrong one. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A graph of stopping potential against frequency for two metals, showing a threshold frequency where each line crosses the horizontal axis, and a circuit with a photocell. The task is to report the threshold frequency for the stated metal, its work function, and the stopping potential at a stated frequency. The alternative gives the two metals and the frequency to evaluate at. |
| Licence · provenance | **THE ID IN `plans/11` IS INVALID AND MUST BE RENAMED BEFORE IT CAN BE SCAFFOLDED.** `plans/11-SIM-CATALOGUE.md:94` writes `` `modern-photons` `` with no subject segment; `simIdSchema` (`packages/contracts/src/sim-manifest/index.ts:32-43`) requires at least one dot and REFUSES it (verified). `D-24` recorded this as `FIXED` — "the id renamed" — and the rename landed in `docs/10-SIM-CATALOGUE.md` as `physics.modern-photons`, but **`plans/11` still carries the broken id**, and `plans/README.md:3` says `plans/` supersedes `docs/`. The id this card requires is **`physics.modern-photons`**. |
| Misconceptions | (1) Brighter light raises the stopping potential. (2) The threshold frequency depends on the intensity. (3) Light's energy depends on its brightness rather than its frequency. |

#### 205. `tech.bridge-truss` — Truss design

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can find the force in each member and say which member carries the load to the ground. |
| Interaction | Add members and joints; the force in each member colour-codes by tension or compression; type a member's force and the factor of safety. |
| Model | **The forces are solved, not read off a picture.** The stiffness matrix is assembled from the members' areas and Young's moduli and solved as a linear system, with each member's force computed from the solved nodal displacements — so a truss the student has made unstable REFUSES to solve and says which member is the problem, rather than returning a plausible set of numbers. The row's focus names 'stress, member forces, load paths, factor of safety', and an unsolvable truss is the teaching case. |
| Answer | `{ memberForce: number, factorOfSafety: number, loadPath: string[], unstable: boolean, criticalMember: string\|null }` — newtons to 1 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `ordering` for the load path from the load to the support, order-sensitive and the reasoning question · `single_choice` for which member is in tension · `true_false` for the stability claim. · `worked_solution` for the load path, one step per joint with that member's force. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The solve is a linear system in double precision and the force in a near-singular member is the ill-conditioned quantity — and it is usually the one the student is asked about. `rel: 0.01` on a force and `rel: 0.05` on a factor of safety (T-C — the factor of safety is a RATIO of two computed quantities and a relative band is the honest one). **The card requires the solver's residual to be reported and refuses to grade a truss whose residual exceeds it**, because a near-singular truss has a large force and a meaningless one. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A bridge drawn as a set of members joined at labelled joints, with a load marked at the deck and the supports marked. The task is to report the force in one named member, the factor of safety and which members are in tension. The alternative gives the member areas, the Young's moduli and the load. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Every member of a truss carries the same force. (2) A diagonal member always increases strength. (3) A truss with a force member of zero is stable. |

#### 206. `tech.lever-lab` — Levers and moments

| Field | Value |
|---|---|
| Subject · band · age | `tech` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can balance a beam and say what the mechanical advantage does to the effort curve. |
| Interaction | Move the pivot, the load and the effort; the moment arms draw; type the effort required and the mechanical advantage. |
| Model | `E·d_e = L·d_l` and the sim DRAWS the moment arms as perpendicular distances rather than as along-the-beam distances, because a student who measures along the beam for a sloped effort has measured the wrong quantity and the diagram is what shows them. The effort curve against effort position is computed from the geometry rather than tabulated. |
| Answer | `{ effort: number, mechanicalAdvantage: number, effortPosition: number\|null }` — newtons to 2 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×2 · `single_choice` for the class of lever · `ordering` for the effort positions by decreasing mechanical advantage, order-sensitive · `true_false` for the work-conservation claim. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | The mechanical advantage is `d_l/d_e`, a pure ratio of two measured distances, so `rel: 0.01` with NO absolute floor (T-C) — a beam with a 1 mm arm and a 200 mm arm has a mechanical advantage of 200 and an absolute band would be meaningless. **The card requires the arm lengths to 3 sf**, since `d_e` is in the denominator and a 1 mm error in a 5 mm arm is 20%. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through every handle in DOM order — the SVG is not focusable, so each draggable point is a `<button>` positioned over it and moved with ArrowLeft/ArrowRight/Up/Down. |
| Announced | A polite announcement naming the element and its new position ("Midpoint, 2 of 5") — the pattern `packages/contracts/src/a11y/questionInteraction.ts:171-177` sets for `ordering`, and the same rule applies to a diagram handle. |
| Non-visual alternative | The diagram is decorative (`aria-hidden`) and the same information is in a real data table with `<caption>` and `<th scope>`. |
| Text alternative (`P13-T4`) | A beam on a pivot with a load at one end and an effort force at an angle at the other, with the two moment arms drawn as perpendicular dashed lines. The task is to report the effort needed for balance and the mechanical advantage. The alternative gives the load, both arm lengths and the angle. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The effort needed is independent of where it is applied. (2) A longer lever arm for the load reduces the effort. (3) Levers conserve force. |

#### 207. `tech.gear-train` — Gear trains

| Field | Value |
|---|---|
| Subject · band · age | `tech` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can work out a gear ratio and say which way the last wheel turns. |
| Interaction | Change the tooth counts; the gears mesh and turn; type the overall ratio, the output torque and the direction. |
| Model | **Tooth counts are integers and the ratio is a product of integer ratios** — `N_out/N_in = Π(N_d/N_n)` — so it is rational, and the gradeable answer is the simplified FRACTION rather than a decimal. The card requires the fraction because a decimal loses the exactness and a student who reports `2/3` is right where `0.667` is a rounding. Direction is derived from the parity of the number of meshes. |
| Answer | `{ ratio: string, torqueMultiplier: number, direction: 'same'\|'opposite', teethTurned: number }` — the ratio as a reduced fraction string. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `short_text` with `EXACT` for the reduced fraction · `numeric` ×2 · `single_choice` for the direction · `true_false` for the work-conservation claim · `ordering` for the gears by angular speed, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `EXACT` on the reduced fraction, and `NUMERIC` on the torque multiplier with `rel: 0.005`. **A card that graded the ratio as a decimal would mark `2/3` against `0.6666667` wrong**, and a card that graded the fraction as a decimal-formatted string would mark `2/3` wrong against `0.667`. The card fixes the form; this is the T-F hazard in its purest form. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A train of meshing gears drawn with their tooth counts labelled and the rotation direction shown by an arrow on each. The task is to report the overall gear ratio as a fraction, the torque at the output and which way the last wheel turns. The alternative gives every tooth count as an integer. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Gear ratio is the product of the tooth counts rather than the ratio. (2) Two meshed gears turn the same way. (3) A gear train multiplies torque and power together. |

#### 208. `tech.materials-selection` — Materials selection

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can choose a material from a property chart and justify it against the constraint that binds. |
| Interaction | Place candidate materials on a chart; the indices plot; write the justification for your choice. |
| Model | **The chart PLOTS the declared data and the sim refuses to choose.** Ashby-style indices are computed from density, modulus, strength and cost, and the indices are the deliverable; which material wins depends on the constraint and on what is being optimised for, and a machine that picked would produce a choice that looks derived and was not. The rubric is in the card. |
| Answer | `{ choice: string, indices: Record<string, number>, constraint: string, justification: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 for two indices · `multi_select` for the candidates that satisfy the constraint · `free_response` for the justification, carrying the rubric · `true_false` for the 'highest strength is best' claim. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two scatter plots of material indices, with candidate materials plotted as labelled points and the required region shaded. The task is to report two indices for a named material and to justify a choice for a stated constraint. The alternative gives the property table for every candidate as numbers. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The material with the best single property is the right choice. (2) Material indices are properties of the material alone. (3) Cost does not enter an engineering decision. |

#### 209. `tech.heat-exchanger` — Heat exchangers

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute an LMTD and say why counterflow beats parallel flow. |
| Interaction | Change the flow arrangement and the mass flows; the temperature profiles along the exchanger draw; type the LMTD and the effectiveness. |
| Model | **The LMTD is computed from the profile endpoints, not from the arithmetic mean of the terminal differences** — `ΔT_lm = (ΔT₁−ΔT₂)/ln(ΔT₁/ΔT₂)` — and the sim uses the correction factor `F` for a finite-length exchanger and REPORTS it, because omitting `F` is the standard engineering error and the row's focus names 'LMTD, effectiveness, counter vs parallel flow'. The effectiveness is `ε = Q/Q_max` from the same solve. |
| Answer | `{ lmtd: number, effectiveness: number, q: number, correctionFactor: number }` — kelvin and watts to 3 sf. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for which arrangement gives the higher effectiveness · `true_false` for the 'arithmetic mean is close enough' claim · `ordering` for the four terminal differences, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `ln(ΔT₁/ΔT₂)` is a difference of logs and goes to `−∞` as the two differences converge — so **the LMTD has a removable singularity at `ΔT₁ = ΔT₂`, where the correct limit is `ΔT₁` itself**. A sim that divides by `ln(ratio)` returns `Infinity` or `NaN` on exactly the well-behaved case a student will construct. The card requires the limit case to be handled and states it, and grades with `rel: 0.01`. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | Two pipes drawn side by side with the temperature of each fluid plotted along the length, with the four terminal temperatures labelled. The task is to report the log-mean temperature difference, the effectiveness and the heat transfer rate. The alternative gives the four terminal temperatures, the mass flow rates and the specific heats. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The LMTD is the arithmetic mean of the terminal differences. (2) Parallel flow always outperforms counterflow. (3) Effectiveness can exceed 1. |

#### 210. `tech.fluid-network` — Pipe networks

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can read a pump curve against a system curve and say where the operating point is. |
| Interaction | Build the network and set the pump; the pump and system curves plot with the intersection marked; type the operating flow and head. |
| Model | `Q²` losses and `H` gains are solved as a NETWORK so the operating point is the intersection of two curves the sim computes, and a network with a loop the solver cannot close is reported as such — the row's focus names 'pressure drop, series/parallel, pump curves' and an operating point read off a plot by eye is the plotting resolution, not the answer. |
| Answer | `{ flow: number, head: number, pressureDrop: number, seriesParallel: string }` — m³/s, m. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for series or parallel · `single_choice` for the operating point · `true_false` for the pump-curve claim · `ordering` for the nodes by pressure, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The operating point is an INTERSECTION of two curves, so the error is set by whichever curve is flatter there — near a flat tangent that is the pump curve's, and the answer becomes ill-conditioned. `rel: 0.01` with `abs: 0.01 m` on the head, and the card requires the solver's convergence criterion to be reported. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A pipe network drawn with a pump and branches, with the pressure labelled at each node, and a plot of the pump curve against the system curve. The task is to report the operating flow rate, the head and the total pressure drop. The alternative gives the pipe lengths, diameters, friction factors and the pump curve as a table. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Pressure drop is proportional to flow rate. (2) The operating point is where the system curve crosses the flow axis. (3) Pipes in series share the flow rather than the head loss. |

#### 211. `tech.electrical-wiring` — Wiring a circuit

| Field | Value |
|---|---|
| Subject · band · age | `tech` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can wire a circuit safely and say what earthing does. |
| Interaction | Place components and wire them; the circuit validates against the declared rules; enter the connections as a set of pairs. |
| Model | **The wiring is validated against a declared rule set and an invalid wiring is REFUSED with the offending connection named** — the row's focus names 'series/parallel construction, earthing, safety' and safety is a constraint the sim can check even though it cannot assess competence. The graded answer is the SET of connections, which is why it is `SET` and not `ORDER`: the order in which the student made them is not part of the claim. |
| Answer | `{ connections: string[], earthingPresent: boolean, safe: boolean, violation: string\|null }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the connections · `true_false` for the earthing and the series/parallel claims · `single_choice` for the violated rule · `ordering` for the safe testing sequence, order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | **No numeric answer on this card, so it is T-G exactly.** The row's plan strategy is `E` and the card keeps EXACT on the connection set. A tolerance is not available for a set of wire names and any card that introduces one is inventing an instrument. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab through the parts in the order a reader would name them; each part is a toggle button with `aria-pressed`, and the assembly itself is never reached by dragging. |
| Announced | The part that changed and what it is attached to; one announcement per completed edit, not one per keypress. |
| Non-visual alternative | The assembly is a `<table>` of connections (from → to → property). A sighted student sees a drawing; a non-visual student sees the same graph as edges, which is what the grader reads too. |
| Text alternative (`P13-T4`) | A circuit board drawn with components in sockets and wires between them, with the live, neutral and earth terminals colour-marked and the rule violations highlighted. The task is to state which components are connected to which and to say whether the circuit is safe. The alternative gives the components and the terminals as a list. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A circuit works as long as every lamp lights. (2) The live wire is the one going to the switch. (3) Earthing protects the user rather than the appliance. |

#### 212. `tech.solar-array` — Solar array design

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute an array's output after shading losses and say what tilt does. |
| Interaction | Change the tilt, the shading and the irradiance; the power curve and the daily output plot; type the daily energy and the optimal tilt. |
| Model | The output is computed from the DECLARED irradiance, the cosine of the incidence angle and the shading factor applied PER MODULE, so a string with one shaded module loses one module's output and not a fraction of the array — the row's focus names 'shading losses' and the partial-string behaviour is the point. The daily energy is a numerical integration over the day at a declared step. |
| Answer | `{ power: number, dailyEnergy: number, optimalTilt: number, losses: Record<string, number> }` — W, kWh, degrees. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for the loss mechanism · `multi_select` for which losses are present · `true_false` for the tilt claim · `ordering` for the losses by size, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | The daily energy is a numerical integration, so it carries the step's error. `rel: 0.02` with `abs: 0.1 kWh` and the card requires the integration step to be declared — **an integration with no declared step has an answer that changes with the machine's load**, which is exactly the non-reproducibility this phase exists to prevent. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | An array of panels drawn at a stated tilt with the sun's path across the sky and the shadow of one panel falling on its neighbour. The task is to report the array's power, the daily energy and the tilt that maximises it. The alternative gives the panel ratings, the location's latitude and the shading pattern. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The optimal tilt is always 45° from vertical. (2) Shading one module in a string costs the array that module's share of output rather than the string's. (3) Irradiance does not vary through the day. |

#### 213. `tech.wind-turbine` — Wind turbine

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can compute the power of a turbine and say why capacity factor is not power. |
| Interaction | Change the wind speed and the rotor; the power curve plots with the operating point marked; type the power, the cut-in and the capacity factor. |
| Model | `P = ½ρAv³Cp(λ,β)` with the tip-speed ratio λ and the power coefficient as a DECLARED function — so the Betz limit is a consequence of `Cp ≤ 16/27` rather than a caption, and the row's focus names 'power curve, cut-in/rated/cut-out, capacity factor'. The capacity factor is an INTEGRAL of the power curve against the DECLARED wind distribution, so it is a property of the site as well as the turbine and the card requires the distribution to be stated. |
| Answer | `{ power: number, capacityFactor: number, cutIn: number, cutOut: number }` — kW to 3 sf, fraction to 3 dp. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×4 · `single_choice` for the operating region · `true_false` for the Betz claim · `multi_select` for the reasons capacity factor is below 1 · `ordering` for the operating regions, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | `v³` triples the relative error, and the capacity factor is an integral over a distribution so it adds the errors in a weighted way. `rel: 0.01` on the power, `rel: 0.02` on the capacity factor (T-C — the factor is a ratio of two integrated quantities and an absolute band near 0.4 would be arbitrary), and the card requires the wind distribution's parameters. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A turbine drawn with its rotor turning and the power curve plotted against wind speed, with the cut-in, rated and cut-out speeds marked and the operating point shown. The task is to report the power at a stated wind speed, the capacity factor and the cut-in and cut-out speeds. The alternative gives the rotor diameter, the rated power, the wind distribution and the site. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Power is proportional to wind speed. (2) The capacity factor equals the rated power. (3) A turbine can extract all the wind's kinetic energy. |

#### 214. `tech.battery-management` — Battery management

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can work out what a C-rating does to the state of charge and what a thermal limit protects. |
| Interaction | Set the discharge current and the temperature; the voltage, current and state-of-charge traces plot; type the runtime, the temperature rise and whether the limit is hit. |
| Model | The C-rating is `capacity/current` and the sim runs a DISCHARGED capacity that falls with temperature by a declared function, so the runtime is an integration against a capacity that is itself changing — the row's focus names 'C-rating, state of charge, thermal limits' and the three interact. The thermal limit is a declared trip and the sim reports the trip rather than clipping the trace. |
| Answer | `{ runtime: number, stateOfCharge: number, temperatureRise: number, limitHit: boolean }` — minutes, fraction, kelvin. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `true_false` for the C-rating claim · `single_choice` for which limit binds first · `ordering` for the sequence of protections as the cell degrades, order-sensitive. |
| Tolerance class | `C` — T-C · relative only. |
| Float hazard | Runtime is an integral of `1/C(T(t))` and therefore badly conditioned — a small change in the capacity function changes the answer by a lot. `rel: 0.05` with `abs: 1 min` and the card requires the capacity-versus-temperature function to be declared and printed in the answer key, because a student using a different curve is not wrong. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A battery cell drawn with the current flowing and a plot of state of charge, voltage and temperature against time, with a limit line drawn across the temperature trace. The task is to report the runtime, the state of charge at a stated time and the temperature rise. The alternative gives the capacity, the discharge current and the ambient temperature. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) A higher C-rating gives more capacity. (2) Capacity does not depend on temperature. (3) A C-rating is a voltage. |

#### 215. `tech.additive-manufacturing` — Additive manufacturing

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can say why a part will not print and choose an infill that meets the load. |
| Interaction | Place the part and adjust infill, wall count and orientation; the slice layers draw; write the printability account. |
| Model | **The slicer is real and the sim refuses to declare a part printable when it is not.** Overhang angle, minimum wall thickness and support requirements are computed from the geometry, and a part with an overhang steeper than the declared limit is REPORTED with the offending face named. The rubric grades the choice and the reasoning; the shipped precedent for a rubric sim is `physics.free-body-diagram`. |
| Answer | `{ printable: boolean, overhangViolation: string\|null, layerCount: number, infillChoice: string, account: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `multi_select` for the violations · `numeric` for the layer count · `single_choice` for the infill · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | A part shown in layers, with one face's overhang angle marked and a support structure drawn beneath it, and a slice cross-section showing the wall and infill pattern. The task is to say whether the part will print, name any violation and choose an infill. The alternative gives the part's geometry, the layer thickness and the material. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Infill does not affect strength. (2) A higher layer resolution always improves the part. (3) Orientation does not affect printability. |

#### 216. `tech.cad-assembly` — CAD assembly

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can place parts without interference and read the bill of materials. |
| Interaction | Drag parts into position; the assembly snaps to constraints and the interference check runs; enter the constrained positions and the BOM. |
| Model | Constraint solving runs on the declared DOFs and the INTERFERENCE CHECK is a real test of the parts' declared volumes, so a placed assembly that clashes is reported as clashing rather than drawn as though it fitted — the row's focus names 'constraint satisfaction, interference, BOM'. The BOM is DERIVED from the assembly tree and the quantities, so a part added to the model changes the BOM without anyone editing it. |
| Answer | `{ positions: Record<string, {x,y,z}>, interference: string[], bom: string[], constrained: boolean }`. |
| Strategy | `SET` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `multi_select` for the interfering pairs · `short_text` for a part's coordinates · `numeric` for the BOM quantity · `true_false` for the constraint claim · `ordering` for the assembly build order, order-sensitive. |
| Tolerance class | `G` — T-G · set of labels. |
| Float hazard | The constrained positions are SNAP values (multiples of a declared pitch) so they are exactly gradeable (T-A) — **but only if the card declares the pitch**, because a student who snaps to 1 mm where the sim snaps to 0.5 mm has built a different assembly and both are internally consistent. This is the row where the what-counts-as-correct-and-every-equivalent-form question of `plans/10` §7.5 is hardest. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the viewport, then ArrowLeft/ArrowRight to advance sim time, and every control the mouse can reach also has a Tab-reachable counterpart. |
| Announced | Sim time is announced on each deliberate advance only (`t = 3.2 s`), never per frame. |
| Non-visual alternative | The scene is mirrored by a table of the same quantities the render reads, so the non-visual path is the same data, not a description of it. |
| Text alternative (`P13-T4`) | An assembly of parts drawn in three dimensions with each part labelled, and a bill of materials listed beside it. The task is to report the position of one part, any interfering pairs and the quantity of a named item. The alternative gives the parts' dimensions, the constraint types and the declared pitch. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Parts can be placed anywhere and still satisfy the constraints. (2) The bill of materials is written independently of the assembly tree. (3) Interference is only a visual problem. |

#### 217. `tech.control-loop` — Control loops

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can tune a P/I/D controller and say what steady-state error remains. |
| Interaction | Change the gains; the set-point tracking and the error plot; type the steady-state error, the settling time and whether it oscillates. |
| Model | The loop is a real plant model with a declared transfer function and the three controllers are three separate implementations, because the row's focus is 'P/I/D tuning, steady-state error, oscillation' and each term removes a different error: P leaves offset, I removes it and adds overshoot, D adds stability. The sim computes the step response by integrating the closed loop, so the settling time is a measured property of the response rather than a number in a table. |
| Answer | `{ steadyStateError: number, settlingTime: number, overshoot: number, oscillating: boolean, stable: boolean }`. |
| Strategy | `TOLERANCE` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, AUTO) · `numeric` ×3 · `single_choice` for which term removes the offset · `true_false` for the oscillation claim · `multi_select` for the effects of each gain · `ordering` for the effects of raising each gain, order-sensitive. |
| Tolerance class | `D` — T-D · both, and both mean something. |
| Float hazard | Settling time is defined at a declared band — 2% or 5% — and the two differ by a factor of about 1.6, so **the card MUST state the band and a card that omits it will grade a correct answer wrong.** The settling time is then a threshold crossing of a numerical response, so it inherits the integration step: `rel: 0.05, abs: 0.1 s` with the step declared. |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab to the canvas (`data-sim-entry`), then Space to play/pause, ArrowLeft/ArrowRight to step one whole step, Home/End to the ends of the scrubber. |
| Announced | A polite live region, driven by `announce()` (SDK `a11y.ts:41`) and **never** by a per-frame `aria-label` write; `ctx.announce(...)` fires only on a step boundary, a parameter commit or a submit. |
| Non-visual alternative | Every drawn quantity is mirrored in a real `<table>` beside the canvas, and the control that produced it is a focusable `<input>`/`<button>` rather than a hit-test. |
| Text alternative (`P13-T4`) | A plot of the system's output against time for a step input, with the set point as a horizontal line, the error between them shaded, and the settling band drawn. The task is to report the steady-state error, the settling time and the overshoot. The alternative gives the plant's transfer function, the three gains and the set point. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Proportional control removes steady-state offset. (2) Integral control reduces overshoot. (3) Higher gain is always an improvement. |

#### 218. `tech.safety-risk-matrix` — Risk assessment

| Field | Value |
|---|---|
| Subject · band · age | `tech` · GCSE/KS4 · 14–16 (A-level entry) · `ageRange` `[13, 16]` |
| Objective (student's terms) | By the end you can place a hazard on a risk matrix and justify a control. |
| Interaction | Place hazards by likelihood and severity; the matrix plots them; write the justification for a chosen control. |
| Model | **The matrix placement is computed and the judgement is not.** Likelihood × severity gives the score and the band, and the sim plots the hazard on the matrix — arithmetic it can do. Whether a control is ALARP and whether it addresses the right hazard is a judgement, and the row's focus says 'rubric', so the rubric bands are in the card and the sim supplies the placement. |
| Answer | `{ score: number, band: string, controls: string[], justification: string }`. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` for the score · `single_choice` for the band · `multi_select` for the applicable controls · `free_response` for the justification, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A five-by-five grid with likelihood on one axis and severity on the other, and each named hazard plotted in a cell. The task is to report a hazard's score and band and to justify a control. The alternative gives each hazard's likelihood and severity as two numbers. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) Severity alone determines the risk. (2) Reducing likelihood eliminates the risk. (3) A control is adequate because it exists. |

#### 219. `tech.lifecycle-assessment` — Product lifecycle

| Field | Value |
|---|---|
| Subject · band · age | `tech` · A-level/KS5 · 16–18 · `ageRange` `[14, 18]` |
| Objective (student's terms) | By the end you can account for embodied energy and say where the trade-offs in a lifecycle decision lie. |
| Interaction | Set the production route, the transport mode and the end-of-life route; the stage contributions plot; write the account. |
| Model | **Every stage is computed separately and NO TOTAL IS OFFERED.** Embodied energy per stage, transport and end-of-life are each reported, because a single total hides exactly the trade-off the row's focus names ('embodied energy, end-of-life; rubric on trade-offs') and a machine that summed them would pick a winner on arithmetic. The rubric is in the card. |
| Answer | `{ stages: Record<string, number>, endOfLifeRecovery: number, account: string, tradeOff: string }` — MJ per functional unit. |
| Strategy | `RUBRIC` · `partialCredit: true` · `maxPoints: 4` |
| Question types | `simulation` (primary, **MANUAL**) · `numeric` ×2 · `multi_select` for the stages with the largest contribution · `ordering` for the stages by contribution, order-sensitive and the reasoning question · `free_response` for the account, carrying the rubric. **MANUAL is mandatory** — `readAward` (`grading/simulation.ts:213-246`). |
| Tolerance class | `I` — T-I · rubric. |
| Float hazard | **the auto path is a zero, not a hold** — `readAward` (`grading/simulation.ts:213-246`) accepts `points: 0` as `GRADED`, so a rubric item MUST be `gradingMode: MANUAL` |
| Seed strategy | **S-0 · deterministic.** `randomised: false`, `seedPolicy: FIXED`. The seed still arrives in `sim:init` and is stored; no draw depends on it. |
| Determinism | `simulate` and `grade` are pure functions of `(params, state)` — no DOM, no clock, no unseeded randomness. `sim:validate` runs the grader three times on one probe state and refuses three different answers (`scripts/sim-validate.mjs:288-330`). *Also:* the state must round-trip `canonicalJson`, which **rejects non-finite numbers and non-plain objects** (`state.ts:36-64`) — a sim holding a `Map`, a `Set` or a `NaN` cannot be saved at all. |
| Replay | `sim:requestState('replay')` returns the canonicalised, checksummed state; `gradeStoredState(grader, { state, params, answer })` (`define.ts:223-240`) re-grades it in bare Node and reproduces the mark exactly. |
| Scoring surface (`Question.scoringSurface`) | `ENDPOINT_ONLY` |
| Keyboard path | Tab reaches the number/choice inputs in reading order, then Submit. Every input has a visible `<label>`; the unit is inside the label, not a suffix after the box. |
| Announced | On submit, the value read back and the comparison verdict; nothing is spoken while the student is still typing. |
| Non-visual alternative | The form is the whole interaction — there is no canvas to mirror. |
| Text alternative (`P13-T4`) | A bar chart of the lifecycle stages each contributing to the total environmental impact of one functional unit of the product. The task is to report two stage contributions and the end-of-life recovery fraction, and to write the trade-off. The alternative gives each stage's contribution as a number and the functional unit. |
| Licence · provenance | `CC-BY-4.0` · `ORIGINAL`. `licence` and `provenance` are **mandatory manifest fields** (`sim-manifest/index.ts:60-72`) and are validated, not reviewed. `INSPIRED_BY:<ref>` must name a work that resolves in a provenance register — **which does not exist yet** (`D-24` specified it; `schemas/sim.manifest.schema.json:199-201` only checks the string's shape). Until it does, `ORIGINAL` passes for a port of somebody else's simulation, which is exactly the laundering `D-24` describes. |
| Misconceptions | (1) The stage with the largest contribution is always the one to improve. (2) Recycled content reduces end-of-life impact and increases production impact by the same amount. (3) A lifecycle comparison needs only the embodied energy. |
