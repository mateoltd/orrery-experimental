# P12-T1 — The simulation catalogue, its spec cards, the review rubric and the conformance manifest

**Status:** plan. `P12-T1` in `plans/20-PHASE-PACKETS.md:290`. Depends on `P2-T1` and, in practice, on
the SDK and the manifest schema, both of which have landed.

**What this document is.** The audit of `plans/11-SIM-CATALOGUE.md` that `P12-T1` asks for, a spec card
for every simulation in it, the rubric `P12-T3`'s reviewers will use, and the manifest schema
`P12-T6`'s CI and `P13-T4`'s enforcement will read. It is written to be handed to an authoring agent
lane by lane.

**What this document is not.** It is not a claim that any of these simulations conforms. **Twenty-four
exist, not 219**, and §3 records where their interfaces have drifted from the code that is supposed to
grade them. A catalogue that claims conformance it has not checked is the precise failure this phase
exists to prevent, so nothing here claims conformance.

---

## 1. The count, and every mismatch in it

`plans/11-SIM-CATALOGUE.md` is titled "Simulation Catalogue (220)" and its per-section headings carry
counts. I counted the table rows. **The real number is 219**, and the mismatch is in the Mathematics
heading.

| Section | Heading says | Rows present | Verdict |
|---|---|---|---|
| Mathematics | 45 | **44** | **MISMATCH** |
| Physics | 38 | 38 | ok |
| Chemistry | 28 | 28 | ok |
| Biology | 28 | 28 | ok |
| Earth & Environment | 14 | 14 | ok |
| Astronomy & Space | 12 | 12 | ok |
| Computing | 16 | 16 | ok |
| Technology & Engineering | 15 | 15 | ok |
| Cross-curricular & Professional Skills | 24 | 24 | ok |
| **Total** | **220** | **219** | |

Counting method: one row per Markdown table line of the form `| \`<id>\` | … |`, per section, which is
the only row shape the document uses. No duplicate ids across the whole catalogue.

### 1.1 The other numbers in `plans/11` that do not survive their own table

**The `G` column has four values and the platform has six.** `plans/11:5` defines `G` as
`E`xact, `T`olerance, `SE`t, `R`ubric. The manifest's `grading.strategy` enum is
`EXACT | TOLERANCE | SET | ORDER | NUMERIC | RUBRIC`
(`schemas/sim.manifest.schema.json:379`, `packages/contracts/src/sim-manifest/index.ts:133`) and the
SDK's `GradingStrategy` is the same six
(`packages/sim-sdk/src/grading.ts:19`). **`ORDER` and `NUMERIC` have no letter in `plans/11`, and 9 of
the 24 already-built simulations use one of them** — `biology.mitosis-order` is `ORDER` and eight are
`NUMERIC`. A catalogue that cannot name half the instruments in use cannot be reviewed against them.

**The plan's own coverage check fails on its own table.** `plans/11:283` requires "Per grading strategy
≥ 12". Its `G` column tallies `T` 111, `E` 78, `R` 21 and **`SE` 9**. The set strategy is exercised
nine times against a floor of twelve. `plans/11:7` restates it — "every grading strategy is exercised at
least a dozen times" — and the document that says it does not meet it.

**Fifty-four of the 219 ids have a subject segment that is not a subject.** `subjectSchema` is a
nine-value enum: `maths`, `physics`, `chemistry`, `biology`, `computing`, `astronomy`, `geography`,
`computing-science`, `general-science` (`sim-manifest/index.ts:48-58`). `plans/11` uses ten prefixes, and
three of them are not in it:

| prefix | rows | in `subjectSchema`? |
|---|---|---|
| `earth.` | 14 | **no** |
| `tech.` | 15 | **no** |
| `general.` | 24 | **no** |
| `modern-photons` | 1 | **no subject segment at all** |

Verified against the shipped validator rather than by reading the enum: an `earth.water-cycle`
manifest with `subjects: ["earth"]` is **refused**
(`subjects.0 Invalid option: expected one of "maths"|"physics"|…`), and the same manifest with
`subjects: ["geography"]` is **accepted**. So all 53 `earth`/`tech`/`general` rows can only be built by
declaring a subject the id does not name. Worse, `simIdSchema` (`sim-manifest/index.ts:32-43`) does not
check the subject segment against the enum at all — its comment says the first segment *is* the subject
and its error message says the subject "is one of the declared subjects", but `zzz.wat` is accepted with
`subjects: ["chemistry"]`. **The id and the subject are two declarations of one fact and nothing checks
that they agree.** I have not fixed this; it is code work and is in §8.

**`modern-photons` cannot be scaffolded.** `plans/11-SIM-CATALOGUE.md:94` writes `` `modern-photons` ``
with no dot. `simIdSchema`'s regex requires at least one dot, and the shipped validator **refuses it**.
`D-24` (`plans/23-REVIEW-ACTIONS.md:194`) records this exact defect as `FIXED` — "The id renamed" — and
the rename landed in `docs/10-SIM-CATALOGUE.md` as `physics.modern-photons` while **`plans/11` still
carries the broken id**. `plans/README.md:3` says `plans/` supersedes `docs/`, so the authoritative copy
is the broken one. The card is written against `physics.modern-photons`.

### 1.2 There is a second, different catalogue in the repository

`docs/10-SIM-CATALOGUE.md` is not a copy of `plans/11`. It has **213 rows**, not 219. **Thirty-one ids
exist only in `plans/11`** and twenty-five only in `docs/` — including `chemistry.pH-scale` versus
`chemistry.ph-scale`, `physics.particle-collisions` versus `physics.particle-collisions-2d`,
`computing.linked-lists` versus `computing.linked-structures`, `biology.homoeostasis` versus
`biology.homeostasis`. It also uses a `G` value, **`EXPLICIT`**, on two rows
(`docs/10-SIM-CATALOGUE.md:207-208`) which is in no enum anywhere in the repository.

`plans/README.md:3` settles which one wins, so this is not a decision to make. It is a finding: **an
authoring lane that reads `docs/` and one that reads `plans/` will build different simulations**, and
nothing in CI compares the two files.

### 1.3 The catalogue's own coverage checks, re-run against the mapping in §2

| `plans/11` check | target | against this mapping | verdict |
|---|---|---|---|
| Total registered | ≥ 200 | 219 planned, **24 built** | not met, and not meant to be until `P12-T2` |
| Per target subject | ≥ 12 | 9 real subjects; 44, 37, 28, 28, 16, 14, 12, 12, 1 | **`computing-science`, `general-science` and `geography` have no rows at all** — they are in the enum and in the built set and absent from the catalogue |
| Per grading strategy | ≥ 12 | `TOLERANCE` 113, `SET` 32, `EXACT` 30, `RUBRIC` 21, `ORDER` 19, `NUMERIC` 4 | **`NUMERIC` fails**; the four-letter version of the check fails on `SE` |
| Keyboard accessible | 100% | 219/219 by card | met by card |
| Text alternative for visual output | 100% | 219/219 by card | met by card |
| `reducedMotion` | 100% | **not a field on either the manifest or the SDK** | see §3.6 |
| Declared `stateSchema` | ≥ 60% | `stateSchema` is REQUIRED in the JSON Schema (`schemas/sim.manifest.schema.json:24`) and is `plainObjectSchema` — it carries no properties | the check is vacuous; see §3.5 |
| Auto-gradable | ≥ 70% | 198/219 = **90.4%** | met |
| Full spec card + licence + provenance | 100% | 219/219 cards here; licence and provenance are validated fields | met by card |
| Passing the conformance matrix | 100% | 24/24 pass | met for the 24 |
| Auto-captured catalogue screenshot | 100% | 24 in `.tmp/conformance/` | met for the 24 |

---
## 2. The catalogue: every simulation, with its card's decisions

One row per simulation. `plan G` is `plans/11`'s own letter; `strategy` is the six-value enum the code actually implements (`schemas/sim.manifest.schema.json:379`), so where the two disagree the disagreement is visible in the row. `tol` is the tolerance class from `docs/11-SIM-CARDS.md` §0.2 and `surface` is `Question.scoringSurface`, which `simPublishRefusal` refuses a simulation question for not declaring (`grading/simulation.ts:49-63`).

**Focus is quoted verbatim from `plans/11`.** Everything else in the row is this plan's decision, and the reasoning for each decision is on that sim's card.


### Mathematics

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `maths.projectile-motion` | maths · GCSE 14–16 | Range/height vs speed and angle; quadratic reasoning | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.quadratic-roots` | maths · GCSE 14–16 | Discriminant, sign of roots, completing the square | E | `NUMERIC` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.function-transform` | maths · GCSE 14–16 | Translate, reflect, scale; read the effect | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.derivative-tangent` | maths · A-level 16–18 | Secant → tangent; rate-of-change intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.statistics-explorer` | maths · GCSE 14–16 | Mean/median/mode, spread, outliers, box plots | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.trigonometry-unit-circle` | maths · GCSE 14–16 | Radians, exact values, quadrants | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.coordinate-geometry` | maths · GCSE 14–16 | Slopes, intersections, reflections, constructions | E | `TOLERANCE` | `simulation` | `D` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `maths.monte-carlo-pi` | maths · A-level 16–18 | Convergence, sampling error, why approximation works | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `maths.matrix-transformations` | maths · A-level 16–18 | Matrices as maps; determinants as area scale | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.probability-tree` | maths · GCSE 14–16 | Branching, independence, conditional paths | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.set-venn` | maths · GCSE 14–16 | Union, intersection, complements | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.series-convergence` | maths · A-level 16–18 | Partial sums, comparison tests, divergence | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.integral-area` | maths · A-level 16–18 | Riemann sums; signed area | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.limit-explorer` | maths · A-level 16–18 | One-sided limits, holes vs jumps | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.derivative-rules` | maths · A-level 16–18 | Product, quotient, chain; fluency | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.equation-solver` | maths · GCSE 14–16 | Linear, quadratic, simultaneous; extraneous roots | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.simplify-expressions` | maths · GCSE 14–16 | Order of operations, collecting like terms, factoring | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.ratio-proportion` | maths · KS3 11–14 | Scale recipes, maps, direct/inverse proportion | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.percentages` | maths · KS3 11–14 | Percent change, compound interest | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.fractions-decimals` | maths · KS3 11–14 | Place value, ordering, recurring decimals | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.number-line-labs` | maths · KS3 11–14 | Absolute value, intervals, inequalities | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.prime-factorisation` | maths · KS3 11–14 | Divisibility, LCM/HCF, prime decomposition | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.indices-laws` | maths · GCSE 14–16 | Negative and fractional indices, index equations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.standard-form` | maths · GCSE 14–16 | Order of magnitude, unit conversion, error bounds | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.sequences` | maths · GCSE 14–16 | Arithmetic vs geometric, nth term, Σ notation | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.binomial-theorem` | maths · A-level 16–18 | Coefficients, specific terms, applications | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.complex-numbers` | maths · A-level 16–18 | Argand plane, modulus, argument, powers | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.vectors-3d` | maths · A-level 16–18 | Components, dot and cross products, projections | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.equations-of-motion` | maths · A-level 16–18 | Choosing the right equation; symbolic verification | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.trig-solver` | maths · A-level 16–18 | General solutions, domain restrictions, ambiguity | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.radians-degrees` | maths · A-level 16–18 | Exact vs approximate, arc length, sector area | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.graph-sketching-lab` | maths · A-level 16–18 | Sketch from an algebraic description; rubric on the sketch | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `maths.conic-sections` | maths · A-level 16–18 | Eccentricity, focus/directrix, standard forms | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.polar-coordinates` | maths · A-level 16–18 | Conversion, rose and cardioid curves, area | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.recursion-iteration` | maths · A-level 16–18 | Bases, recursive ≡ iterative, trees | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.graph-theory` | maths · A-level 16–18 | Degree, connectivity, Euler/Hamilton, colourings | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.logic-propositions` | maths · A-level 16–18 | Truth tables, De Morgan, inference | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.proof-techniques` | maths · A-level 16–18 | Construct and critique a proof; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `maths.measurement-error` | maths · A-level 16–18 | Absolute vs relative error, significant figures | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.modular-arithmetic` | maths · A-level 16–18 | Congruence, clocks, cryptography basics | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.growth-decay` | maths · A-level 16–18 | Modelling, half-life, differential intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.optimisation` | maths · A-level 16–18 | Critical points, endpoints, real-world reading | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.area-perimeter-challenge` | maths · KS3 11–14 | Composite shapes, rearrangements, missing-side puzzles | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.coordinate-transformations` | maths · GCSE 14–16 | Rotations, reflections, glide reflections, tessellations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |

### Physics

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `physics.free-body-diagram` | physics · GCSE 14–16 | Vector decomposition; rubric on reasoning, not the number | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `physics.pendulum` | physics · GCSE 14–16 | Period, amplitude independence, decay with drag | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.wave-interference` | physics · GCSE 14–16 | Path difference, fringes | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.optics-ray-tracing` | physics · GCSE 14–16 | Image formation, focal length, TIR | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-dc` | physics · GCSE 14–16 | Kirchhoff, series/parallel, power | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-ac` | physics · A-level 16–18 | RMS, phase, RLC resonance | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.projectile-launch-lab` | physics · GCSE 14–16 | Angle optimisation under a ranging constraint | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.newtons-laws` | physics · KS3 11–14 | F=ma intuition, mass vs weight, net force | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.friction` | physics · GCSE 14–16 | Static vs kinetic, coefficients, inclines | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.energy-conservation` | physics · GCSE 14–16 | Kinetic/potential transfer, dissipation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.momentum-collisions` | physics · GCSE 14–16 | Elastic vs inelastic, momentum accounting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.centre-of-mass` | physics · GCSE 14–16 | Composite bodies, tipping, stability | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circular-motion` | physics · A-level 16–18 | Centripetal force, banking, conical pendulum | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.gravity-orbits` | physics · A-level 16–18 | Inverse square, orbital speed/period, escape velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.kepler-laws` | physics · A-level 16–18 | Ellipse geometry, third law numerically | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.rocket-equation` | physics · A-level 16–18 | Tsiolkovsky, mass ratio, staging intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.drag-and-lift` | physics · A-level 16–18 | Quadratic vs linear drag, terminal velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.pressure-fluids` | physics · GCSE 14–16 | Pascal, Archimedes, floating, pressure variation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.thermal-transfer` | physics · GCSE 14–16 | Conduction, convection, radiation, equilibrium | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.gas-laws` | physics · GCSE 14–16 | PV=nRT, microscopic model, isotherms | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.kinetic-theory` | physics · GCSE 14–16 | Temperature as mean KE, speed distributions | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `physics.shm` | physics · A-level 16–18 | Amplitude, period, energy, damping | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.waves-on-a-string` | physics · GCSE 14–16 | Superposition, standing waves, harmonics | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.sound-doppler` | physics · GCSE 14–16 | Frequency shift, Mach cone | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `physics.electrostatics` | physics · GCSE 14–16 | Field lines, potential, charge accumulation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-construction-lab` | physics · GCSE 14–16 | Build, measure, predict; graded on prediction error | T | `TOLERANCE` | `simulation` | `D` | S-0 | PATH_SENSITIVE_REQUIRED |
| `physics.em-induction` | physics · A-level 16–18 | Faraday, Lenz, generators, transformers | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.magnetic-fields` | physics · GCSE 14–16 | Field patterns, force on a current, motor effect | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.optics-lenses` | physics · GCSE 14–16 | Thin-lens equation, magnification, ray diagrams | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.polarisation` | physics · A-level 16–18 | Malus's law; why polarised sunglasses help | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `modern-photons` | **NONE** · A-level 16–18 | Quantisation, work function, threshold frequency | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.atomic-models` | physics · GCSE 14–16 | Rutherford scattering, energy levels, spectra | E | `EXACT` | `simulation` | `F` | S-1 | ENDPOINT_ONLY |
| `physics.nuclear-decay` | physics · GCSE 14–16 | Half-life, activity, chains, dating | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.particle-collisions-2d` | physics · A-level 16–18 | Momentum conservation as a constraint solver | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.doppler-radar` | physics · A-level 16–18 | Speed from frequency shift; applied measurement | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `physics.rocket-staging` | physics · A-level 16–18 | Optimisation under mass and delta-v constraints | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.rolling-friction` | physics · A-level 16–18 | Static friction in rolling, moments of inertia | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.phase-transitions` | physics · A-level 16–18 | Critical point, superheating, real anomalies | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Chemistry

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `chemistry.particle-view` | chemistry · GCSE 14–16 | States, diffusion, arrangement | E | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `chemistry.stoichiometry-balance` | chemistry · GCSE 14–16 | Conservation of atoms; unlimited partial credit | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.titration-curve` | chemistry · GCSE 14–16 | Equivalence point, indicators, strong vs weak | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.reaction-rate` | chemistry · GCSE 14–16 | Concentration/temperature, collision theory | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.equilibrium` | chemistry · GCSE 14–16 | Le Chatelier, K, industrial conditions | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.mole-conversions` | chemistry · GCSE 14–16 | Conversion chains, limiting reagent | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.gas-laws-applied` | chemistry · GCSE 14–16 | Combined gas law, molar volume, mixtures | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.solution-concentration` | chemistry · GCSE 14–16 | Molarity, dilution, ppm, serial dilution | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.ph-scale` | chemistry · KS3 11–14 | Log-scale intuition, strong vs weak, buffers | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.buffers` | chemistry · A-level 16–18 | Henderson–Hasselbalch, capacity, preparation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.precipitation` | chemistry · GCSE 14–16 | Solubility rules, net ionic equations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.redox-balancing` | chemistry · GCSE 14–16 | Oxidation numbers, half-reactions, disproportionation | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.electrochemistry` | chemistry · A-level 16–18 | Electrolysis, Faraday's law, cell potentials | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.acid-base-strength` | chemistry · A-level 16–18 | Ka/pKa, conjugate pairs, structural reasoning | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.organic-structures` | chemistry · GCSE 14–16 | Naming, functional groups, isomer counting | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.polymer-build` | chemistry · GCSE 14–16 | Monomer chains, addition vs condensation | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.orbital-shapes` | chemistry · A-level 16–18 | s/p/d shapes, nodes, capacity | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.periodic-trends` | chemistry · GCSE 14–16 | Electronegativity, ionisation energy, radius + exceptions | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.bonding-models` | chemistry · GCSE 14–16 | Ionic / covalent / metallic, dot-and-cross | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.structure-determination` | chemistry · A-level 16–18 | Deduce structure from IR/NMR/mass data | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.thermochemistry` | chemistry · GCSE 14–16 | Hess's law, enthalpy, calorimetry | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.entropy` | chemistry · A-level 16–18 | Disorder, ΔG, direction of change | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.kinetics-vs-equilibrium` | chemistry · GCSE 14–16 | The distinction students most often conflate | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.electrolysis-lab` | chemistry · GCSE 14–16 | Products, moles of electrons, Faraday | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.qualitative-analysis` | chemistry · GCSE 14–16 | Tests, precipitates, flame colours, deduction chains | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.crystal-structures` | chemistry · A-level 16–18 | Unit cells, packing, density from dimensions | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.green-chemistry` | chemistry · A-level 16–18 | Atom economy, E-factor, energy; rubric on trade-offs | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `chemistry.food-chemistry` | chemistry · GCSE 14–16 | Maillard, caramelisation, protein denaturation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Biology

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `biology.cell-division` | biology · GCSE 14–16 | Stage identification, chromosome behaviour, ploidy | SE | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.genetics-punnett` | biology · GCSE 14–16 | Monohybrid, dihybrid, codominance, probability | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.ecosystem-flow` | biology · GCSE 14–16 | Trophic transfers, cycles, disruption cascades | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `biology.cell-membrane` | biology · GCSE 14–16 | Diffusion, osmosis, active transport, ATP cost | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.enzyme-kinetics` | biology · A-level 16–18 | Substrate concentration, inhibition, temperature, pH | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.photosynthesis` | biology · GCSE 14–16 | Light vs limiting factors, ATP/NADPH, compensation points | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.respiration` | biology · GCSE 14–16 | Glycolysis → Krebs → ETC, aerobic vs anaerobic | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.population-dynamics` | biology · A-level 16–18 | Exponential vs logistic, carrying capacity, harvesting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.natural-selection` | biology · GCSE 14–16 | Variation, selection, drift, speciation; rubric on reasoning | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `biology.evolution-trees` | biology · GCSE 14–16 | Cladistics, shared derived characters, reading trees | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.human-circulation` | biology · GCSE 14–16 | Pressure, heart rate, vessel radius, exercise response | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.breathing` | biology · GCSE 14–16 | Lung volumes, pressure changes, partial pressures | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.action-potential` | biology · A-level 16–18 | Threshold, refractory period, conduction, synapses | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.kidney-filter` | biology · GCSE 14–16 | Glomerular filtration, reabsorption, concentration | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.digestion` | biology · KS3 11–14 | Enzymes, villi, products, energy from food | T | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `biology.plant-transport` | biology · GCSE 14–16 | Transpiration, cohesion-tension, phloem loading | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.photosynthesis-limits` | biology · GCSE 14–16 | The classic three-limiting-factors experiment | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.immunology` | biology · GCSE 14–16 | Innate vs adaptive, clonal selection, memory cells | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.microbiology` | biology · GCSE 14–16 | Exponential growth, stationary phase, serial dilution | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `biology.classification` | biology · KS3 11–14 | Taxonomy hierarchy, binomial nomenclature, keys | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `biology.ecology-sampling` | biology · GCSE 14–16 | Quadrats, transects, mark-recapture, error bars | T | `TOLERANCE` | `simulation` | `C` | S-1 | ENDPOINT_ONLY |
| `biology.inheritance-linkage` | biology · GCSE 14–16 | Recombination, gene maps, crosses | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.molecular-dna` | biology · GCSE 14–16 | Base pairing, semiconservative replication, mutations | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.gene-expression` | biology · A-level 16–18 | Transcription, translation, regulation, mutations | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.homeostasis` | biology · GCSE 14–16 | Negative feedback, set points, disruption | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.biomes` | biology · KS3 11–14 | Climate graphs → biome identification | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `biology.organ-systems` | biology · KS3 11–14 | Systems mapping, function matching, interactions | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.succession` | biology · GCSE 14–16 | Primary vs secondary, climax community, timelines | SE | `ORDER` | `simulation` | `H` | S-1 | ENDPOINT_ONLY |

### Earth & Environment

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `earth.water-cycle` | earth · GCSE 14–16 | Fluxes, reservoirs, residence times | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.carbon-cycle` | earth · GCSE 14–16 | Fast vs slow cycles; human perturbation | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `earth.nitrogen-cycle` | earth · GCSE 14–16 | Fixation, nitrification, denitrification | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.rock-cycle` | earth · GCSE 14–16 | Igneous/sedimentary/metamorphic pathways, timescale | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.plate-tectonics` | earth · GCSE 14–16 | Boundary types, seafloor spreading, subduction | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.earthquake-waves` | earth · GCSE 14–16 | P and S waves, travel time, locating an epicentre | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.weather-fronts` | earth · GCSE 14–16 | Isobars, fronts, pressure systems, forecasting | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.climate-zones` | earth · GCSE 14–16 | Latitude, insolation, Köppen classification | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `earth.ocean-circulation` | earth · A-level 16–18 | Thermohaline, upwelling, heat transport | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.soil-profile` | earth · GCSE 14–16 | Horizons, formation rates, drainage and texture | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.atmosphere-layers` | earth · GCSE 14–16 | Layers, temperature profile, the ozone layer | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.energy-balance` | earth · A-level 16–18 | Albedo, absorbed vs emitted, equilibrium temperature | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.glaciers` | earth · GCSE 14–16 | Accumulation vs ablation, sea-level contribution | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.hazards` | earth · GCSE 14–16 | Hazard × exposure × vulnerability; rubric on mitigation | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Astronomy & Space

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `astronomy.orrery` | astronomy · GCSE 14–16 | Relative periods and distances; scale realisation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.orbital-mechanics` | astronomy · A-level 16–18 | Vis-viva, transfer orbits, escape velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.stellar-evolution` | astronomy · GCSE 14–16 | HR diagram, fusion stages, lifetimes | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.light-distance` | astronomy · GCSE 14–16 | Parallax distance, redshift, magnitude | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.black-holes` | astronomy · A-level 16–18 | Schwarzschild radius, tidal effects, accretion | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.exoplanets` | astronomy · A-level 16–18 | Transit depth, radial velocity, both methods | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.lunar-phases` | astronomy · GCSE 14–16 | Geometry of phases, eclipse conditions, node angles | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.tides` | astronomy · GCSE 14–16 | Spring/neap tides, resonance, basin shape | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `astronomy.moon-craters` | astronomy · GCSE 14–16 | Counting → relative age; cratering rate | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `astronomy.solar-activity` | astronomy · GCSE 14–16 | Sunspot cycle, prominences, solar wind | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `astronomy.coordinates` | astronomy · A-level 16–18 | RA/Dec, celestial sphere, finding by hand | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.signal-in-noise` | astronomy · A-level 16–18 | SNR, false positives, why SETI is hard | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Computing

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `computing.sorting-visualiser` | computing · GCSE 14–16 | Comparison/swap counts, stability, complexity classes | E | `NUMERIC` | `simulation` | `C` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.search-algorithms` | computing · GCSE 14–16 | Linear vs binary, worst case, big-O reasoning | E | `NUMERIC` | `simulation` | `A` | S-0 | ENDPOINT_ONLY |
| `computing.linked-structures` | computing · A-level 16–18 | Pointer manipulation; rubric on correctness | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `computing.binary-trees` | computing · GCSE 14–16 | BST invariants, in/pre/post-order, recursion | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.graph-algorithms` | computing · A-level 16–18 | BFS/DFS, Dijkstra, topological order | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.hash-tables` | computing · A-level 16–18 | Collisions, load factor, probing strategies | E | `NUMERIC` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.big-o-lab` | computing · A-level 16–18 | Predicting growth empirically, then proving it | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.automata` | computing · A-level 16–18 | DFA construction, NFA→DFA, state equivalence | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.regex-builder` | computing · A-level 16–18 | Matching, capturing, greediness | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.stack-machine` | computing · GCSE 14–16 | Postfix evaluation, VM tracing | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.quantum-circuits` | computing · A-level 16–18 | Gate composition, measurement outcomes, superposition | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.neural-network` | computing · A-level 16–18 | Weights, learning by hand, overfitting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `computing.data-compression` | computing · GCSE 14–16 | Compression ratio vs quality, bitrate budgeting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `computing.packet-routing` | computing · GCSE 14–16 | Route tables, hops, congestion, latency | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.error-detection` | computing · GCSE 14–16 | Parity, Hamming codes, checksums | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `computing.state-machines` | computing · GCSE 14–16 | Design a controller; rubric on completeness | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Technology & Engineering

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `tech.bridge-truss` | tech · A-level 16–18 | Stress, member forces, load paths, factor of safety | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.lever-lab` | tech · GCSE 14–16 | Moment balance, mechanical advantage, effort curves | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `tech.gear-train` | tech · GCSE 14–16 | Ratios, torque multiplication, direction, backlash | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.materials-selection` | tech · A-level 16–18 | Ashby-style charts; rubric on justifying a choice | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.heat-exchanger` | tech · A-level 16–18 | LMTD, effectiveness, counter vs parallel flow | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.fluid-network` | tech · A-level 16–18 | Pressure drop, series/parallel, pump curves | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.electrical-wiring` | tech · GCSE 14–16 | Series/parallel construction, earthing, safety | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `tech.solar-array` | tech · A-level 16–18 | Irradiance, tilt, shading losses, payback framing | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.wind-turbine` | tech · A-level 16–18 | Power curve, cut-in/rated/cut-out, capacity factor | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.battery-management` | tech · A-level 16–18 | C-rating, state of charge, thermal limits | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `tech.additive-manufacturing` | tech · A-level 16–18 | Layer slicing, supports, infill; rubric on printability | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.cad-assembly` | tech · A-level 16–18 | Constraint satisfaction, interference, BOM | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `tech.control-loop` | tech · A-level 16–18 | P/I/D tuning, steady-state error, oscillation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.safety-risk-matrix` | tech · GCSE 14–16 | Likelihood × severity, mitigation; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.lifecycle-assessment` | tech · A-level 16–18 | Embodied energy, end-of-life; rubric on trade-offs | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Cross-curricular & Professional Skills

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `general.data-literacy` | general · KS3 11–14 | Axis honesty, scale, misleading charts | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `general.spreadsheet-modelling` | general · KS3 11–14 | Build a model; rubric on structure and assumptions | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.uncertainty` | general · A-level 16–18 | Propagation, significant figures, worst case vs RSS | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.experimental-design` | general · GCSE 14–16 | Controls, variables, repeated trials; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.scientific-writing` | general · GCSE 14–16 | Structure, claim/evidence/reasoning; banded rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.critical-thinking` | general · GCSE 14–16 | Evidence quality, bias, fallacies; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.estimation` | general · KS3 11–14 | Order-of-magnitude reasoning | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.dimensional-analysis` | general · A-level 16–18 | Unit algebra as a check on a formula | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.scale-similarity` | general · GCSE 14–16 | Scaling laws, model/prototype reasoning | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.chess-endgames` | general · A-level 16–18 | Mate-in-N search, evaluation, tablebases | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.bridge-building` | general · KS3 11–14 | Structural efficiency under a budget | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.nutrition-log` | general · KS3 11–14 | Energy accounting, interpreting food labels | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.sleep-circadian` | general · A-level 16–18 | Modelling a 24 h rhythm, phase shift | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.personal-finance` | general · GCSE 14–16 | Compound interest, amortisation, comparing loans | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.map-and-scale` | general · KS3 11–14 | Grid references, scale bars, projections, distortion | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.argument-mapping` | general · A-level 16–18 | Premises, warrants, fallacies, rebuttals | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.interview-skills` | general · KS3 11–14 | Question design, probing, bias; rubric on transcripts | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.safety-procedure` | general · KS3 11–14 | Ordered steps, hazard checks, deviation reporting | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.simulation-literacy` | general · KS3 11–14 | What a model assumes and omits; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.numerical-methods` | general · A-level 16–18 | Iteration, convergence, error estimation | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.trend-analysis` | general · A-level 16–18 | Seasonality, smoothing, spurious correlation | T | `ORDER` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.units-conversion` | general · KS3 11–14 | Dimensional fluency, error propagation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.academic-integrity` | general · KS3 11–14 | Source evaluation, referencing, avoiding plagiarism | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `general.exam-technique` | general · KS3 11–14 | Timing, question triage, checking — a graded, low-stakes drill | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |


### Mathematics

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `maths.projectile-motion` | maths · GCSE 14–16 | Range/height vs speed and angle; quadratic reasoning | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.quadratic-roots` | maths · GCSE 14–16 | Discriminant, sign of roots, completing the square | E | `NUMERIC` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.function-transform` | maths · GCSE 14–16 | Translate, reflect, scale; read the effect | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.derivative-tangent` | maths · A-level 16–18 | Secant → tangent; rate-of-change intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.statistics-explorer` | maths · GCSE 14–16 | Mean/median/mode, spread, outliers, box plots | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.trigonometry-unit-circle` | maths · GCSE 14–16 | Radians, exact values, quadrants | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.coordinate-geometry` | maths · GCSE 14–16 | Slopes, intersections, reflections, constructions | E | `TOLERANCE` | `simulation` | `D` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `maths.monte-carlo-pi` | maths · A-level 16–18 | Convergence, sampling error, why approximation works | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `maths.matrix-transformations` | maths · A-level 16–18 | Matrices as maps; determinants as area scale | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.probability-tree` | maths · GCSE 14–16 | Branching, independence, conditional paths | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.set-venn` | maths · GCSE 14–16 | Union, intersection, complements | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.series-convergence` | maths · A-level 16–18 | Partial sums, comparison tests, divergence | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.integral-area` | maths · A-level 16–18 | Riemann sums; signed area | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.limit-explorer` | maths · A-level 16–18 | One-sided limits, holes vs jumps | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.derivative-rules` | maths · A-level 16–18 | Product, quotient, chain; fluency | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.equation-solver` | maths · GCSE 14–16 | Linear, quadratic, simultaneous; extraneous roots | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.simplify-expressions` | maths · GCSE 14–16 | Order of operations, collecting like terms, factoring | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.ratio-proportion` | maths · KS3 11–14 | Scale recipes, maps, direct/inverse proportion | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.percentages` | maths · KS3 11–14 | Percent change, compound interest | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.fractions-decimals` | maths · KS3 11–14 | Place value, ordering, recurring decimals | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.number-line-labs` | maths · KS3 11–14 | Absolute value, intervals, inequalities | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.prime-factorisation` | maths · KS3 11–14 | Divisibility, LCM/HCF, prime decomposition | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.indices-laws` | maths · GCSE 14–16 | Negative and fractional indices, index equations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.standard-form` | maths · GCSE 14–16 | Order of magnitude, unit conversion, error bounds | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.sequences` | maths · GCSE 14–16 | Arithmetic vs geometric, nth term, Σ notation | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.binomial-theorem` | maths · A-level 16–18 | Coefficients, specific terms, applications | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.complex-numbers` | maths · A-level 16–18 | Argand plane, modulus, argument, powers | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.vectors-3d` | maths · A-level 16–18 | Components, dot and cross products, projections | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.equations-of-motion` | maths · A-level 16–18 | Choosing the right equation; symbolic verification | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.trig-solver` | maths · A-level 16–18 | General solutions, domain restrictions, ambiguity | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.radians-degrees` | maths · A-level 16–18 | Exact vs approximate, arc length, sector area | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.graph-sketching-lab` | maths · A-level 16–18 | Sketch from an algebraic description; rubric on the sketch | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `maths.conic-sections` | maths · A-level 16–18 | Eccentricity, focus/directrix, standard forms | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.polar-coordinates` | maths · A-level 16–18 | Conversion, rose and cardioid curves, area | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.recursion-iteration` | maths · A-level 16–18 | Bases, recursive ≡ iterative, trees | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `maths.graph-theory` | maths · A-level 16–18 | Degree, connectivity, Euler/Hamilton, colourings | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.logic-propositions` | maths · A-level 16–18 | Truth tables, De Morgan, inference | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.proof-techniques` | maths · A-level 16–18 | Construct and critique a proof; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `maths.measurement-error` | maths · A-level 16–18 | Absolute vs relative error, significant figures | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.modular-arithmetic` | maths · A-level 16–18 | Congruence, clocks, cryptography basics | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `maths.growth-decay` | maths · A-level 16–18 | Modelling, half-life, differential intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.optimisation` | maths · A-level 16–18 | Critical points, endpoints, real-world reading | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `maths.area-perimeter-challenge` | maths · KS3 11–14 | Composite shapes, rearrangements, missing-side puzzles | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `maths.coordinate-transformations` | maths · GCSE 14–16 | Rotations, reflections, glide reflections, tessellations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |

### Physics

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `physics.free-body-diagram` | physics · GCSE 14–16 | Vector decomposition; rubric on reasoning, not the number | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `physics.pendulum` | physics · GCSE 14–16 | Period, amplitude independence, decay with drag | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.wave-interference` | physics · GCSE 14–16 | Path difference, fringes | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.optics-ray-tracing` | physics · GCSE 14–16 | Image formation, focal length, TIR | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-dc` | physics · GCSE 14–16 | Kirchhoff, series/parallel, power | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-ac` | physics · A-level 16–18 | RMS, phase, RLC resonance | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.projectile-launch-lab` | physics · GCSE 14–16 | Angle optimisation under a ranging constraint | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.newtons-laws` | physics · KS3 11–14 | F=ma intuition, mass vs weight, net force | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.friction` | physics · GCSE 14–16 | Static vs kinetic, coefficients, inclines | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.energy-conservation` | physics · GCSE 14–16 | Kinetic/potential transfer, dissipation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.momentum-collisions` | physics · GCSE 14–16 | Elastic vs inelastic, momentum accounting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.centre-of-mass` | physics · GCSE 14–16 | Composite bodies, tipping, stability | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circular-motion` | physics · A-level 16–18 | Centripetal force, banking, conical pendulum | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.gravity-orbits` | physics · A-level 16–18 | Inverse square, orbital speed/period, escape velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.kepler-laws` | physics · A-level 16–18 | Ellipse geometry, third law numerically | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.rocket-equation` | physics · A-level 16–18 | Tsiolkovsky, mass ratio, staging intuition | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.drag-and-lift` | physics · A-level 16–18 | Quadratic vs linear drag, terminal velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.pressure-fluids` | physics · GCSE 14–16 | Pascal, Archimedes, floating, pressure variation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.thermal-transfer` | physics · GCSE 14–16 | Conduction, convection, radiation, equilibrium | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.gas-laws` | physics · GCSE 14–16 | PV=nRT, microscopic model, isotherms | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.kinetic-theory` | physics · GCSE 14–16 | Temperature as mean KE, speed distributions | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `physics.shm` | physics · A-level 16–18 | Amplitude, period, energy, damping | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.waves-on-a-string` | physics · GCSE 14–16 | Superposition, standing waves, harmonics | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.sound-doppler` | physics · GCSE 14–16 | Frequency shift, Mach cone | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `physics.electrostatics` | physics · GCSE 14–16 | Field lines, potential, charge accumulation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.circuit-construction-lab` | physics · GCSE 14–16 | Build, measure, predict; graded on prediction error | T | `TOLERANCE` | `simulation` | `D` | S-0 | PATH_SENSITIVE_REQUIRED |
| `physics.em-induction` | physics · A-level 16–18 | Faraday, Lenz, generators, transformers | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.magnetic-fields` | physics · GCSE 14–16 | Field patterns, force on a current, motor effect | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.optics-lenses` | physics · GCSE 14–16 | Thin-lens equation, magnification, ray diagrams | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.polarisation` | physics · A-level 16–18 | Malus's law; why polarised sunglasses help | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `modern-photons` | **NONE** · A-level 16–18 | Quantisation, work function, threshold frequency | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.atomic-models` | physics · GCSE 14–16 | Rutherford scattering, energy levels, spectra | E | `EXACT` | `simulation` | `F` | S-1 | ENDPOINT_ONLY |
| `physics.nuclear-decay` | physics · GCSE 14–16 | Half-life, activity, chains, dating | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.particle-collisions-2d` | physics · A-level 16–18 | Momentum conservation as a constraint solver | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.doppler-radar` | physics · A-level 16–18 | Speed from frequency shift; applied measurement | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `physics.rocket-staging` | physics · A-level 16–18 | Optimisation under mass and delta-v constraints | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.rolling-friction` | physics · A-level 16–18 | Static friction in rolling, moments of inertia | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `physics.phase-transitions` | physics · A-level 16–18 | Critical point, superheating, real anomalies | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Chemistry

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `chemistry.particle-view` | chemistry · GCSE 14–16 | States, diffusion, arrangement | E | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `chemistry.stoichiometry-balance` | chemistry · GCSE 14–16 | Conservation of atoms; unlimited partial credit | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.titration-curve` | chemistry · GCSE 14–16 | Equivalence point, indicators, strong vs weak | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.reaction-rate` | chemistry · GCSE 14–16 | Concentration/temperature, collision theory | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.equilibrium` | chemistry · GCSE 14–16 | Le Chatelier, K, industrial conditions | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.mole-conversions` | chemistry · GCSE 14–16 | Conversion chains, limiting reagent | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.gas-laws-applied` | chemistry · GCSE 14–16 | Combined gas law, molar volume, mixtures | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.solution-concentration` | chemistry · GCSE 14–16 | Molarity, dilution, ppm, serial dilution | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.ph-scale` | chemistry · KS3 11–14 | Log-scale intuition, strong vs weak, buffers | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.buffers` | chemistry · A-level 16–18 | Henderson–Hasselbalch, capacity, preparation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.precipitation` | chemistry · GCSE 14–16 | Solubility rules, net ionic equations | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.redox-balancing` | chemistry · GCSE 14–16 | Oxidation numbers, half-reactions, disproportionation | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.electrochemistry` | chemistry · A-level 16–18 | Electrolysis, Faraday's law, cell potentials | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.acid-base-strength` | chemistry · A-level 16–18 | Ka/pKa, conjugate pairs, structural reasoning | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.organic-structures` | chemistry · GCSE 14–16 | Naming, functional groups, isomer counting | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.polymer-build` | chemistry · GCSE 14–16 | Monomer chains, addition vs condensation | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.orbital-shapes` | chemistry · A-level 16–18 | s/p/d shapes, nodes, capacity | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.periodic-trends` | chemistry · GCSE 14–16 | Electronegativity, ionisation energy, radius + exceptions | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.bonding-models` | chemistry · GCSE 14–16 | Ionic / covalent / metallic, dot-and-cross | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `chemistry.structure-determination` | chemistry · A-level 16–18 | Deduce structure from IR/NMR/mass data | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.thermochemistry` | chemistry · GCSE 14–16 | Hess's law, enthalpy, calorimetry | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.entropy` | chemistry · A-level 16–18 | Disorder, ΔG, direction of change | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.kinetics-vs-equilibrium` | chemistry · GCSE 14–16 | The distinction students most often conflate | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `chemistry.electrolysis-lab` | chemistry · GCSE 14–16 | Products, moles of electrons, Faraday | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.qualitative-analysis` | chemistry · GCSE 14–16 | Tests, precipitates, flame colours, deduction chains | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `chemistry.crystal-structures` | chemistry · A-level 16–18 | Unit cells, packing, density from dimensions | E | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `chemistry.green-chemistry` | chemistry · A-level 16–18 | Atom economy, E-factor, energy; rubric on trade-offs | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `chemistry.food-chemistry` | chemistry · GCSE 14–16 | Maillard, caramelisation, protein denaturation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Biology

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `biology.cell-division` | biology · GCSE 14–16 | Stage identification, chromosome behaviour, ploidy | SE | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.genetics-punnett` | biology · GCSE 14–16 | Monohybrid, dihybrid, codominance, probability | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.ecosystem-flow` | biology · GCSE 14–16 | Trophic transfers, cycles, disruption cascades | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `biology.cell-membrane` | biology · GCSE 14–16 | Diffusion, osmosis, active transport, ATP cost | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.enzyme-kinetics` | biology · A-level 16–18 | Substrate concentration, inhibition, temperature, pH | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.photosynthesis` | biology · GCSE 14–16 | Light vs limiting factors, ATP/NADPH, compensation points | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.respiration` | biology · GCSE 14–16 | Glycolysis → Krebs → ETC, aerobic vs anaerobic | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.population-dynamics` | biology · A-level 16–18 | Exponential vs logistic, carrying capacity, harvesting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.natural-selection` | biology · GCSE 14–16 | Variation, selection, drift, speciation; rubric on reasoning | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `biology.evolution-trees` | biology · GCSE 14–16 | Cladistics, shared derived characters, reading trees | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.human-circulation` | biology · GCSE 14–16 | Pressure, heart rate, vessel radius, exercise response | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.breathing` | biology · GCSE 14–16 | Lung volumes, pressure changes, partial pressures | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.action-potential` | biology · A-level 16–18 | Threshold, refractory period, conduction, synapses | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.kidney-filter` | biology · GCSE 14–16 | Glomerular filtration, reabsorption, concentration | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.digestion` | biology · KS3 11–14 | Enzymes, villi, products, energy from food | T | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `biology.plant-transport` | biology · GCSE 14–16 | Transpiration, cohesion-tension, phloem loading | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `biology.photosynthesis-limits` | biology · GCSE 14–16 | The classic three-limiting-factors experiment | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `biology.immunology` | biology · GCSE 14–16 | Innate vs adaptive, clonal selection, memory cells | SE | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.microbiology` | biology · GCSE 14–16 | Exponential growth, stationary phase, serial dilution | T | `TOLERANCE` | `simulation` | `D` | S-1 | ENDPOINT_ONLY |
| `biology.classification` | biology · KS3 11–14 | Taxonomy hierarchy, binomial nomenclature, keys | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `biology.ecology-sampling` | biology · GCSE 14–16 | Quadrats, transects, mark-recapture, error bars | T | `TOLERANCE` | `simulation` | `C` | S-1 | ENDPOINT_ONLY |
| `biology.inheritance-linkage` | biology · GCSE 14–16 | Recombination, gene maps, crosses | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.molecular-dna` | biology · GCSE 14–16 | Base pairing, semiconservative replication, mutations | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.gene-expression` | biology · A-level 16–18 | Transcription, translation, regulation, mutations | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.homeostasis` | biology · GCSE 14–16 | Negative feedback, set points, disruption | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `biology.biomes` | biology · KS3 11–14 | Climate graphs → biome identification | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `biology.organ-systems` | biology · KS3 11–14 | Systems mapping, function matching, interactions | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `biology.succession` | biology · GCSE 14–16 | Primary vs secondary, climax community, timelines | SE | `ORDER` | `simulation` | `H` | S-1 | ENDPOINT_ONLY |

### Earth & Environment

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `earth.water-cycle` | earth · GCSE 14–16 | Fluxes, reservoirs, residence times | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.carbon-cycle` | earth · GCSE 14–16 | Fast vs slow cycles; human perturbation | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `earth.nitrogen-cycle` | earth · GCSE 14–16 | Fixation, nitrification, denitrification | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.rock-cycle` | earth · GCSE 14–16 | Igneous/sedimentary/metamorphic pathways, timescale | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.plate-tectonics` | earth · GCSE 14–16 | Boundary types, seafloor spreading, subduction | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.earthquake-waves` | earth · GCSE 14–16 | P and S waves, travel time, locating an epicentre | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.weather-fronts` | earth · GCSE 14–16 | Isobars, fronts, pressure systems, forecasting | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `earth.climate-zones` | earth · GCSE 14–16 | Latitude, insolation, Köppen classification | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `earth.ocean-circulation` | earth · A-level 16–18 | Thermohaline, upwelling, heat transport | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.soil-profile` | earth · GCSE 14–16 | Horizons, formation rates, drainage and texture | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.atmosphere-layers` | earth · GCSE 14–16 | Layers, temperature profile, the ozone layer | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `earth.energy-balance` | earth · A-level 16–18 | Albedo, absorbed vs emitted, equilibrium temperature | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.glaciers` | earth · GCSE 14–16 | Accumulation vs ablation, sea-level contribution | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `earth.hazards` | earth · GCSE 14–16 | Hazard × exposure × vulnerability; rubric on mitigation | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Astronomy & Space

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `astronomy.orrery` | astronomy · GCSE 14–16 | Relative periods and distances; scale realisation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.orbital-mechanics` | astronomy · A-level 16–18 | Vis-viva, transfer orbits, escape velocity | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.stellar-evolution` | astronomy · GCSE 14–16 | HR diagram, fusion stages, lifetimes | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.light-distance` | astronomy · GCSE 14–16 | Parallax distance, redshift, magnitude | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.black-holes` | astronomy · A-level 16–18 | Schwarzschild radius, tidal effects, accretion | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.exoplanets` | astronomy · A-level 16–18 | Transit depth, radial velocity, both methods | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `astronomy.lunar-phases` | astronomy · GCSE 14–16 | Geometry of phases, eclipse conditions, node angles | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.tides` | astronomy · GCSE 14–16 | Spring/neap tides, resonance, basin shape | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `astronomy.moon-craters` | astronomy · GCSE 14–16 | Counting → relative age; cratering rate | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `astronomy.solar-activity` | astronomy · GCSE 14–16 | Sunspot cycle, prominences, solar wind | T | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `astronomy.coordinates` | astronomy · A-level 16–18 | RA/Dec, celestial sphere, finding by hand | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `astronomy.signal-in-noise` | astronomy · A-level 16–18 | SNR, false positives, why SETI is hard | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |

### Computing

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `computing.sorting-visualiser` | computing · GCSE 14–16 | Comparison/swap counts, stability, complexity classes | E | `NUMERIC` | `simulation` | `C` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.search-algorithms` | computing · GCSE 14–16 | Linear vs binary, worst case, big-O reasoning | E | `NUMERIC` | `simulation` | `A` | S-0 | ENDPOINT_ONLY |
| `computing.linked-structures` | computing · A-level 16–18 | Pointer manipulation; rubric on correctness | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `computing.binary-trees` | computing · GCSE 14–16 | BST invariants, in/pre/post-order, recursion | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.graph-algorithms` | computing · A-level 16–18 | BFS/DFS, Dijkstra, topological order | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.hash-tables` | computing · A-level 16–18 | Collisions, load factor, probing strategies | E | `NUMERIC` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.big-o-lab` | computing · A-level 16–18 | Predicting growth empirically, then proving it | E | `ORDER` | `simulation` | `H` | S-0 | PATH_SENSITIVE_AVAILABLE |
| `computing.automata` | computing · A-level 16–18 | DFA construction, NFA→DFA, state equivalence | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.regex-builder` | computing · A-level 16–18 | Matching, capturing, greediness | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.stack-machine` | computing · GCSE 14–16 | Postfix evaluation, VM tracing | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.quantum-circuits` | computing · A-level 16–18 | Gate composition, measurement outcomes, superposition | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `computing.neural-network` | computing · A-level 16–18 | Weights, learning by hand, overfitting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `computing.data-compression` | computing · GCSE 14–16 | Compression ratio vs quality, bitrate budgeting | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `computing.packet-routing` | computing · GCSE 14–16 | Route tables, hops, congestion, latency | E | `ORDER` | `simulation` | `H` | S-0 | ENDPOINT_ONLY |
| `computing.error-detection` | computing · GCSE 14–16 | Parity, Hamming codes, checksums | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `computing.state-machines` | computing · GCSE 14–16 | Design a controller; rubric on completeness | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Technology & Engineering

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `tech.bridge-truss` | tech · A-level 16–18 | Stress, member forces, load paths, factor of safety | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.lever-lab` | tech · GCSE 14–16 | Moment balance, mechanical advantage, effort curves | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `tech.gear-train` | tech · GCSE 14–16 | Ratios, torque multiplication, direction, backlash | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.materials-selection` | tech · A-level 16–18 | Ashby-style charts; rubric on justifying a choice | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.heat-exchanger` | tech · A-level 16–18 | LMTD, effectiveness, counter vs parallel flow | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.fluid-network` | tech · A-level 16–18 | Pressure drop, series/parallel, pump curves | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.electrical-wiring` | tech · GCSE 14–16 | Series/parallel construction, earthing, safety | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `tech.solar-array` | tech · A-level 16–18 | Irradiance, tilt, shading losses, payback framing | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.wind-turbine` | tech · A-level 16–18 | Power curve, cut-in/rated/cut-out, capacity factor | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.battery-management` | tech · A-level 16–18 | C-rating, state of charge, thermal limits | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `tech.additive-manufacturing` | tech · A-level 16–18 | Layer slicing, supports, infill; rubric on printability | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.cad-assembly` | tech · A-level 16–18 | Constraint satisfaction, interference, BOM | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `tech.control-loop` | tech · A-level 16–18 | P/I/D tuning, steady-state error, oscillation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `tech.safety-risk-matrix` | tech · GCSE 14–16 | Likelihood × severity, mitigation; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `tech.lifecycle-assessment` | tech · A-level 16–18 | Embodied energy, end-of-life; rubric on trade-offs | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |

### Cross-curricular & Professional Skills

| id | subject · band | focus (`plans/11`) | plan G | strategy | primary type | tol | seed | surface |
|---|---|---|---|---|---|---|---|---|
| `general.data-literacy` | general · KS3 11–14 | Axis honesty, scale, misleading charts | E | `EXACT` | `single_choice` | `F` | S-0 | ENDPOINT_ONLY |
| `general.spreadsheet-modelling` | general · KS3 11–14 | Build a model; rubric on structure and assumptions | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.uncertainty` | general · A-level 16–18 | Propagation, significant figures, worst case vs RSS | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.experimental-design` | general · GCSE 14–16 | Controls, variables, repeated trials; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.scientific-writing` | general · GCSE 14–16 | Structure, claim/evidence/reasoning; banded rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.critical-thinking` | general · GCSE 14–16 | Evidence quality, bias, fallacies; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.estimation` | general · KS3 11–14 | Order-of-magnitude reasoning | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.dimensional-analysis` | general · A-level 16–18 | Unit algebra as a check on a formula | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.scale-similarity` | general · GCSE 14–16 | Scaling laws, model/prototype reasoning | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.chess-endgames` | general · A-level 16–18 | Mate-in-N search, evaluation, tablebases | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.bridge-building` | general · KS3 11–14 | Structural efficiency under a budget | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.nutrition-log` | general · KS3 11–14 | Energy accounting, interpreting food labels | T | `TOLERANCE` | `simulation` | `C` | S-0 | ENDPOINT_ONLY |
| `general.sleep-circadian` | general · A-level 16–18 | Modelling a 24 h rhythm, phase shift | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.personal-finance` | general · GCSE 14–16 | Compound interest, amortisation, comparing loans | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.map-and-scale` | general · KS3 11–14 | Grid references, scale bars, projections, distortion | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.argument-mapping` | general · A-level 16–18 | Premises, warrants, fallacies, rebuttals | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.interview-skills` | general · KS3 11–14 | Question design, probing, bias; rubric on transcripts | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.safety-procedure` | general · KS3 11–14 | Ordered steps, hazard checks, deviation reporting | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.simulation-literacy` | general · KS3 11–14 | What a model assumes and omits; rubric | R | `RUBRIC` | `simulation` | `I` | S-0 | ENDPOINT_ONLY |
| `general.numerical-methods` | general · A-level 16–18 | Iteration, convergence, error estimation | T | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
| `general.trend-analysis` | general · A-level 16–18 | Seasonality, smoothing, spurious correlation | T | `ORDER` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.units-conversion` | general · KS3 11–14 | Dimensional fluency, error propagation | T | `TOLERANCE` | `simulation` | `D` | S-0 | ENDPOINT_ONLY |
| `general.academic-integrity` | general · KS3 11–14 | Source evaluation, referencing, avoiding plagiarism | E | `EXACT` | `simulation` | `F` | S-0 | ENDPOINT_ONLY |
| `general.exam-technique` | general · KS3 11–14 | Timing, question triage, checking — a graded, low-stakes drill | E | `SET` | `simulation` | `G` | S-0 | ENDPOINT_ONLY |
## 3. Plan-versus-code disagreements, and one plan-versus-plan

Every claim below is a measurement or a `file:line`, not a reading. Where I could run the shipped code
I did, and say so.

### 3.1 The catalogue cannot be validated as written

| # | Finding | Evidence |
|---|---|---|
| D-1 | `modern-photons` is refused by the shipped validator. | Ran `simManifestSchema.safeParse({...base, id: 'modern-photons'})`: `id must be subject.slug, where the subject is one of the declared subjects`. `plans/11-SIM-CATALOGUE.md:94`; regex at `packages/contracts/src/sim-manifest/index.ts:32-43`. |
| D-2 | `D-24` records this defect as `FIXED` and it is not fixed in the authoritative file. | `plans/23-REVIEW-ACTIONS.md:194`; `plans/README.md:3` says `plans/` supersedes `docs/`; the fix is visible only in `docs/10-SIM-CATALOGUE.md` as `physics.modern-photons`. |
| D-3 | 53 more ids declare a subject prefix that is not in `subjectSchema`. | `subjects: ["earth"]` refused with `Invalid option: expected one of "maths"\|"physics"\|…`; `subjects: ["geography"]` on the same `earth.*` manifest accepted. `sim-manifest/index.ts:48-58`. |
| D-4 | **Nothing checks that an id's subject segment agrees with its `subjects` array.** | `zzz.wat` with `subjects: ["chemistry"]` is ACCEPTED. The schema's own `simId` description says "subject.slug" and its regex permits any lowercase word (`schemas/sim.manifest.schema.json:130-135`). |
| D-5 | Two built sims already depend on that hole. | `sims/chem.ideal-gas-law` and `sims/chem.mole-concentration` have id prefix `chem` and `subjects: ["chemistry"]`. |
| D-6 | `plans/11`'s `G` column cannot express two of the six strategies the code implements. | `schemas/sim.manifest.schema.json:379`, `packages/sim-sdk/src/grading.ts:19`; `biology.mitosis-order` is `ORDER` and eight built sims are `NUMERIC`. |
| D-7 | `plans/11`'s own ≥12-per-strategy check fails on its own table. | `SE` tallies 9 (`plans/11:283`). |

### 3.2 The contract has moved and 23 of the 24 gold sims did not move with it

**Measured, not inferred.** I aliased the SDK's *sources* onto `@orrery/sim-sdk/grader` and ran `tsc`
over every `sims/*/src/grader.ts`: **175 type errors across 25 files — and every one of the 24 graders
fails, without exception.** `maths.projectile-motion` misses by two (a params-variance error and the same
`rationale` key the template has), which is why it reads as current and is not. `sims/_template`, which is
what `pnpm sim:new` scaffolds from, misses by three. Three `model.ts` files contribute eight of the 175.

| What the code now declares | What 23 graders still write | Where |
|---|---|---|
| `SimMeta` = `{ id, title, version, subjects }` | plus `license` (misspelled), `provenance`, `protocol` | `define.ts:49-54` |
| `SimControls` = `{ stepper, stepSize?, scenarios, maxTime? }` | `{ params: true, state: true, scenarios: [] }` | `define.ts:29-38` |
| `SimAccessibility` = `{ textAlternative, summary, readyAnnouncement? }` | `keyboard`, `screenReaderSummary`, `reducedMotion`, `textAlternative`, `summary` | `define.ts:40-47` |
| `num({ min, max, default, unit })` | `num({ name, label, unit, min, max, default })` — `name` does not exist | `params.ts:87` |
| `Grade` = `{ points, maxPoints, correct, rationale, strategy }` | `{ points, max, code, feedback }` | `grading.ts:21-30` |
| `ToleranceSpec` = `{ abs?, rel?, maxPoints, partialCredit?, partialCreditBand? }` | a `rationale` key | `grading.ts:32-41` |

**Not one of the 24 matches the current SDK**, and `maths.projectile-motion` is closest rather than
correct: its two errors are `grade`'s `params` variance and a `rationale` key. The other 22 graders are
written against a materially earlier revision, and the counts are not marginal — `chemistry.particle-view`
has 15 and `astronomy.parallax-distance` 9.

**And nothing reports it.** `sims/` is deliberately not a pnpm workspace (`pnpm-workspace.yaml`), so
`turbo run typecheck` never sees a simulation. `pnpm sim:validate --all` passes 24/24 because it
validates the *manifest* and runs the *built bundle*, never the source's types. `pnpm test:sims` passes
367/367 because Vitest transpiles without type-checking. `sim:build` strips types with esbuild. **The
drift is invisible to every gate in `package.json`.**

The shipped template is the sharpest instance: `sims/_template/src/grader.ts:65` passes `rationale` to
`tolerance()`, which does not accept it, and `:57-59` casts `params` in a way `strict` rejects.
**`pnpm sim:new <id>` scaffolds a simulation that does not typecheck**, and `P12-T2` is six lanes about
to run exactly that command 195 times.

### 3.3 A declared grading strategy is metadata, and it is frequently a lie

| what | count |
|---|---|
| built manifests whose `grading.strategy` is the strategy their grader actually uses | **9 of 24** |
| built manifests whose declared strategy the grader does not use | **14 of 24** |
| of those, declaring `NUMERIC` while grading with `tolerance()` | **8** |

`checkManifestRules` (`sim-manifest/index.ts:300-432`) checks that the strategy is in the enum, that
`TOLERANCE` declares at least one bound, and that `maxPoints` is in range. It never looks at the grader.
`Grade.strategy` exists precisely so the real strategy is reported (`grading.ts:29`), and
`dispatchToSim` **ignores it** — `readAward` reads only `points`, `maxPoints` and `code`
(`grading/simulation.ts:213-246`). So `maths.quadratic-roots` reports `strategy: 'TOLERANCE'` from a
manifest that says `NUMERIC`, and no consumer can tell.

### 3.4 The auto-grading path disagrees with the built sims in two ways

**Eight of 24 graders cannot be read by the real dispatch.** `biology.mitosis-order`,
`chemistry.equation-balancing`, `chemistry.particle-view`, `computing.sorting-visualiser`,
`maths.coordinate-geometry`, `maths.monte-carlo-pi`, `maths.pythagoras` and `maths.sequence-next` return
`{ points, max, code, feedback }` with no `maxPoints`. `readAward` refuses a return whose `maxPoints` is
not a finite number, and routes it to `NEEDS_HUMAN` / `GRADER_UNREADABLE`
(`grading/simulation.ts:227-233`).

This is **latent, not live**: `dispatchToSim` has no production caller. Its only callers are its own test
file and `packages/exam-engine/src/adversarial/malformed-sim-state.test.ts`. It becomes live the moment
`P7`'s sim dispatch is wired into the worker's grading loop, and it will route every answer from those
eight sims to a marker.

**The rubric path reports a graded zero.** `physics.free-body-diagram` awards `points: 0` with a reason
naming the bands (`sims/physics.free-body-diagram/src/grader.ts:138-166`), which is the right behaviour
for a sim that does not mark its own work. But `readAward` accepts `points: 0` as a legitimate
in-range `GRADED` outcome, so the release batch sees a mark rather than a `NEEDS_HUMAN`. A `NEEDS_HUMAN`
counts in `maxTotal` and not in `rawTotal` and flags the score provisional (`.tmp/TRACKER.md`, `P10-T3`);
a `GRADED: 0` does neither. **21 of the 219 catalogue rows are RUBRIC**, and every item built on one of
them reports zero to every student until a marker acts.

### 3.5 Three manifest fields that cannot fail, because nothing reads them

| field | declared | read by | consequence |
|---|---|---|---|
| `accessibility.focusOrder` | `sim-manifest/index.ts:96`, `schemas/sim.manifest.schema.json:236-242` | **nobody** — the only occurrence in the repository is the declaration | the one field that could make "what a screen reader announces" checkable is inert |
| `accessibility.reducedMotion` | required, `schemas/sim.manifest.schema.json:216`; 23 of 24 sims declare it `true` | **nobody** — `apps/web/src` never mentions it; the real policy is `Stepper.allowMotion`, which **defaults to `true`** (`stepper.ts:246-266`) | `plans/11:287`'s "`reducedMotion` support 100%" is currently unfalsifiable: every sim declares it and nothing tests it |
| `stateSchema` | required; type `plainObjectSchema` = `{ type: "object" }` and **no properties** (`sim-manifest/index.ts:130`, `schemas/sim.manifest.schema.json:362-364`) | `dispatchToSim` takes a `validateState` **callback** as an input (`grading/simulation.ts:116`) and accepts only `verdict === true` (`:301`) | `plans/11:288`'s "Declared `stateSchema` ≥ 60%" is satisfied by an empty object and measures nothing; the field that could reject a malformed state carries no properties |

### 3.6 `P13-T4` and `P12-T6` cannot be enforced by the thing they name

**`conformance` is optional.** `schemas/sim.manifest.schema.json:8-27` lists eighteen required fields
and `conformance` is not among them; `sim-manifest/index.ts:245` marks it `.optional()`. `P13-T4`
("Simulation text alternatives enforced in the conformance manifest", `plans/15-A11Y-I18N.md:117`)
therefore names a block that a manifest may simply omit.

**The one cell that checks a text alternative does not read one.** `scripts/sim-conformance.mjs:1644`
builds the harness's `textAlternative` as `` `${entry.title}: ${entry.screenReaderSummary ?? entry.title}` ``
— the catalogue's `screenReaderSummary`, prefixed with the title. The cell at
`scripts/sim-conformance.mjs:704-710` then asserts that string is in the DOM. **A simulation with a
perfect `screenReaderSummary` and a missing or worthless `accessibility.textAlternative` passes the cell
named for the text alternative.** `defineSim` refuses a text alternative shorter than 20 characters
(`define.ts:163-169`), which is a length check and not a content check.

### 3.7 The authoring type cannot express a field whose absence blocks publication

`SimulationSpec` is `{ type, simId, simVersion, params? }` (`contracts/src/question/index.ts:207-213`).
`simPublishRefusal` **refuses** a simulation question that declares no `scoringSurface`
(`grading/simulation.ts:49-63`), and the column is nullable (`packages/db/prisma/schema.prisma:568`).
So the field that decides whether an item may be published is absent from the type an author writes,
and the compile error that would have caught it does not exist. Every one of the 219 cards in
`docs/11-SIM-CARDS.md` therefore states the surface explicitly.

### 3.8 `plans/10` §7's card fields are missing four things the code requires

`plans/10-SIMULATIONS.md:265-282` lists twelve card fields. It has no field for:

- **`scoringSurface`** — see D-8 above.
- **the seed strategy** — and `P11-T9`'s variant audit ("prove seeds and draws were applied and
  logged", `plans/20-PHASE-PACKETS.md:277`) cannot be satisfied by a card that does not specify one. The
  reason is structural: **`grade(state, params, answer)` receives no seed at all**, which is why
  `scripts/sim-conformance.mjs:911-925` reads the seed out of the *state* and why `:978-995` refuses a
  `randomised: true` sim whose state does not carry `seed` and `seedFromHost: true`.
- **`maxTime`** — `defineSim` **throws** `STEP_WITHOUT_TIME` when `controls.stepper` is set without it
  (`define.ts:188-193`), so a card that omits it produces a sim that cannot even be loaded.
- **`focusOrder`** — see the table in §3.5.

### 3.9 Four plan-versus-plan disagreements, none of which I have amended

`plans/**` is the authority and I was instructed not to edit it, so these are recorded.

1. **`plans/11` (219 rows) versus `docs/10-SIM-CATALOGUE.md` (213 rows).** Thirty-one ids only in the
   former, twenty-five only in the latter, and `EXPLICIT` used as a grading strategy on two rows of the
   latter (`docs/10-SIM-CATALOGUE.md:207-208`) which is in no enum in the repository.
2. **`plans/20:18` cut the simulation target from 220 to 60.** `plans/11`'s title, its section headings
   and its coverage table all still say 220. Nothing in `plans/11` acknowledges the cut. **The cards in
   `docs/11-SIM-CARDS.md` cover all 219 rows, not the 60**; see §9.2.
3. **`plans/20:169` deferred Sim Studio (`P6-T12`) to v2, and `plans/10:288-298` still specifies it**
   as a live subsystem with fifteen declarative `kind`s.
4. **`plans/10:266` says the catalogue fetches "a metadata index, never code"** and
   `plans/10:307` says the app bundle must not grow with the registry. `scripts/check-bundle-budget.mjs`
   measures `apps/web`'s gzipped JS against `exam: 250 KB` and `shared first load: 120 KB` and nothing
   else; it does not compare the baseline against a 24-sim registry, which is `P12-T6`'s actual
   deliverable.

### 3.10 The catalogue does not describe what has been built

`sims/` holds 24 registered simulations (24 entries in `sims/registry/registry.json`, 24 in
`sims/registry/index.json`). **Only 9 of them appear in `plans/11`.** The other 15 have ids the
catalogue has never heard of:

`astronomy.parallax-distance`, `biology.mitosis-order`, `chem.ideal-gas-law`, `chem.mole-concentration`,
`chemistry.equation-balancing`, `computing.binary-search`, `computing-science.download-time`,
`general-science.energy-budget`, `geography.map-scale-distance`, `maths.linear-functions`,
`maths.midpoint-of-segment`, `maths.pythagoras`, `maths.sequence-next`, `physics.kinematics`,
`physics.newtons-second-law`.

And fifteen of `plans/11`'s 24 gold sims have **not** been built, including
`maths.derivative-tangent`, `maths.function-transform`, `maths.statistics-explorer`,
`maths.trigonometry-unit-circle`, `maths.matrix-transformations`, `maths.probability-tree`,
`biology.cell-division`, `biology.genetics-punnett`, `biology.ecosystem-flow`,
`chemistry.stoichiometry-balance`, `chemistry.titration-curve`, `chemistry.reaction-rate`,
`physics.wave-interference`, `physics.optics-ray-tracing` and `physics.circuit-dc`
(`plans/10-SIMULATIONS.md:322-347`).

Also: `sims/pythagoras.sim.ts.tmp` is a zero-byte stray. `sim:build` excludes `_template`, `_fixtures`
and `registry` (`scripts/sim-build.mjs:126`) and nothing else; this file survives because it is not a
directory with a manifest. It is litter, not a defect, and it is noted so the next lane does not
rediscover it as one.

---
## 4. Question types: the mapping rule, and the three sims that have nowhere to go

### 4.1 The enum, and what is actually auto-graded

`QUESTION_TYPES` is a closed ten-value list (`packages/contracts/src/question/index.ts:50-61`) and
`assertExhaustiveTypes` throws at module load if the union and the list disagree (`:497-528`).
`assertInteractionContracts` then checks all ten against the keyboard and assistive-technology contract
(`packages/contracts/src/a11y/questionInteraction.ts:257-325`) — including, for `simulation`, that it
carries a text alternative at all.

Only **six** are auto-gradable in the synchronous grader: `HANDLED = ['single_choice', 'multi_select',
'true_false', 'numeric', 'short_text', 'ordering']` (`grading/index.ts:421-428`). `simulation` is
deliberately excluded and graded through `dispatchToSim` at the worker boundary; `free_response`,
`file_submission` and `worked_solution` are `MANUAL` by the plan's own table.

**Every card uses only members of that enum.** No card invents a type. The mapping a card carries is
always:

> `simulation` as the primary vehicle (AUTO for the 198 auto-gradable rows, **MANUAL** for the 21
> RUBRIC rows), plus the non-simulation types that can carry the same claim when the simulation is not
> mounted — a printed worksheet, a blocked sim origin, or a question authored without the sim at all.

That fallback is not decoration. `plans/10:216-217` requires a printed worksheet to still teach
something, and the harness measures it: the conformance cell at
`scripts/sim-conformance.mjs:704-710` reads `[data-testid="sim-alternative"]`, which is host-rendered
from the manifest, not drawn in the frame.

**Tallies across the 219 cards:** `simulation` 216 primary, `single_choice` 3 primary
(`biology.biomes`, `earth.climate-zones`, `general.data-literacy` — recognition tasks where the sim's job
is to supply the graph). As secondary or fallback types across all cards: `numeric` 185,
`true_false` 159, `single_choice` 161, `ordering` 104, `multi_select` 76, `short_text` 42,
`free_response` 20, `file_submission` 1, `worked_solution` 7.

### 4.2 The criterion, stated so it can be argued with

A simulation is **unmappable** when the artefact its `plans/11` focus names as the graded thing cannot be
carried by any member of `QUESTION_TYPES` in any gradeable form — that is, when it is not a scalar, not a
set of named labels, not an ordered sequence, and not prose a marker can read. Concretely: a **drawing**.

**Three sims. Listed rather than papered over.**

| sim | `plans/11` line | focus | why there is nowhere to put it |
|---|---|---|---|
| `maths.graph-sketching-lab` | `:46` | "Sketch from an algebraic description; rubric on the sketch" | the graded artefact named by the focus IS the sketch. `file_submission` is the only type that can carry an image, it is `MANUAL`, and **it has no `rubric` field** (`question/index.ts:200-205`), so even a human has nowhere to record the bands. The card routes around it: the **features** are auto-checked and the sketch is `file_submission` beside a `free_response`. |
| `computing.linked-structures` | `:211` | "Pointer manipulation; rubric on correctness" | the graded artefact is a pointer diagram. The card routes around it: the **operations and the traversal order** are `ordering` and auto-checked; the reasoning is `free_response` with a rubric. |
| `computing.state-machines` | `:224` | "Design a controller; rubric on completeness" | the graded artefact is a state machine. Same routing: the trace order is `ordering`, the missing transitions are `multi_select`, and the account is `free_response` with a rubric. |

**This is a narrow result and the narrowness is mine**, so the broader reading deserves a number rather
than an adjective. Searching the 219 focus strings for any of
`sketch|draw|diagram|construct|design|blueprint|layout|curve|topolog|schematic|tree|graph|map|pointer|structure`
returns **25 rows**, not 3. Of the 22 that the strict criterion excludes, **5 name an artefact with an
obvious numeric or set-shaped answer** — `maths.coordinate-geometry`'s "constructions" is an ordered list
of steps, `computing.automata`'s "DFA construction" is a transition table,
`chemistry.structure-determination`'s deduced structure is a set of assignments, `biology.evolution-trees`'
trees are a grouping and `computing.graph-algorithms`' topological order is a sequence — so each of those
cards names that quantity and the drawing is decoration.

**The other 17 are the ones a reviewer should actually look at**, and I am not going to call them mappable
or unmappable on the strength of a focus string. Four of them grade an artefact rather than a quantity
outright and are already routed through RUBRIC plus `free_response`: `maths.proof-techniques` ("construct
and critique a proof"), `general.interview-skills` ("question design"), `general.scientific-writing`
("structure, claim/evidence/reasoning") and `general.spreadsheet-modelling` ("build a model"). The
remaining 13 grade a number or a label reached *through* a picture — `maths.matrix-transformations`,
`maths.ratio-proportion`, `maths.polar-coordinates`, `maths.recursion-iteration`, `physics.optics-lenses`,
`biology.inheritance-linkage`, `biology.biomes`, `biology.organ-systems`, `astronomy.stellar-evolution`,
`tech.electrical-wiring`, `tech.lever-lab`, `tech.fluid-network`, `tech.wind-turbine` — and every one of
their cards says so, with the picture's quantity named and the picture marked `aria-hidden`.

**A reviewer who thinks a card's stated answer is the wrong reading of its focus should reject the card
under rubric point 1.** That is what point 1 is for, and it is a per-sim judgement rather than a count.

### 4.3 A larger finding that is not "unmappable": 21 rows are mappable only as MANUAL

The 21 RUBRIC rows (`biology.ecosystem-flow`, `biology.natural-selection`, `chemistry.green-chemistry`,
`computing.linked-structures`, `computing.state-machines`, `earth.carbon-cycle`, `earth.hazards`,
`general.critical-thinking`, `general.experimental-design`, `general.interview-skills`,
`general.safety-procedure`, `general.scientific-writing`, `general.simulation-literacy`,
`general.spreadsheet-modelling`, `maths.graph-sketching-lab`, `maths.proof-techniques`,
`physics.free-body-diagram`, `tech.additive-manufacturing`, `tech.lifecycle-assessment`,
`tech.materials-selection`, `tech.safety-risk-matrix`) all map — to `simulation` with
`gradingMode: MANUAL`, or to `free_response` / `worked_solution` with the sim as a tool.

**But the combination is a trap and the cards say so.** `readAward` accepts `points: 0` as a legitimate
`GRADED` outcome (`grading/simulation.ts:213-246`), so a rubric simulation built as an AUTO item reports
a **graded zero** rather than a hold. Every one of the 21 cards carries the instruction
"`gradingMode: MANUAL`" in its strategy row, and the rubric's technical-conformance dimension (§6.2,
point 3) fails a sim that omits it. The shipped precedent is
`sims/physics.free-body-diagram/sim.spec.md`, which is the right document and the reason I trust the
finding.

### 4.4 What is not claimed

I have **not** verified that any of the 219 can actually be built. `P6-T11` re-costed the 24 gold sims at
240 h against an optimistic 2 h each (`plans/20-PHASE-PACKETS.md:168`), and `D-20` re-costed P12 at
550–700 h. **A card being complete is not a sim being cheap**, and the throughput claim in `plans/10:359`
("one sim per lane per 2 hours after the first 24") should be read against those two numbers rather than
taken at face value.

---
## 5. Floating point: the hazard, measured

### 5.1 The four instruments, and what each one does to a student who did nothing wrong

All four measured by calling the shipped `packages/sim-sdk/dist/grading.js`, not by reading it.

| instrument | call | result | what a correct student hit |
|---|---|---|---|
| `numeric()` | `numeric(0.3, 0.1 + 0.2, 4)` | **0 points** | typed `0.3`; `a === b` is false (`grading.ts:213`) |
| `numeric()` | `numeric("0.30", 0.3, 4)` | 4 points | `asNumber` parses, so the written form survives |
| `numeric()` | `numeric("2x10^-3", 0.002, 4)` | **0 points** | `asNumber("2x10^-3")` is **`210`** (`grading.ts:69` strips everything outside `[0-9.eE+-]`) |
| `exact()` | `exact("0.30", "0.3", 4)` | **0 points** | `canonicalText` is NFKC + lowercase + whitespace; it does not do arithmetic (`grading.ts:223-236`) |
| `tolerance()` | `tolerance(0.3, 0.1 + 0.2, {abs: 0.001, maxPoints: 4})` | **4 points** | a 6×10⁻¹⁷ discrepancy is inside any sane band — which is the correct outcome |
| `tolerance()` | `tolerance(88, 100, {abs: 0.5, rel: 0, maxPoints: 4, partialCredit: true})` | 0 points | 12% out, and `rel: 0` means nothing to decay partial credit from (`grading.ts:155-166`) |

### 5.2 The tolerance declaration that is not the tolerance

`withinTolerance` takes `max(absolute, relative × max(|given|, |expected|))` — **the larger of the two**,
which is what makes it symmetric (`grading.ts:84-105`). `maths.projectile-motion`'s manifest declares
`absolute: 0.5, relative: 0.02` (`sims/maths.projectile-motion/sim.manifest.json`). Run through the real
helper:

| the answer | the band actually in force | the declared band |
|---|---|---|
| 8 m | 0.5000 m | 0.5 m — the absolute bound wins |
| 63.71 m | **1.2742 m** | 0.5 m — 2% wins, 2.5× the declared bound |
| 1200 m | **24.0000 m** | 0.5 m — **48× the declared bound** |

The opposite trap is quieter. `withinTolerance(0.0001, 0, {abs: 0.5})` is `true`, so an **absolute-only**
tolerance on a quantity that can legitimately be near zero accepts everything. Nine classes, stated once
in `docs/11-SIM-CARDS.md` §0.2, exist because of exactly these two traps.

### 5.3 The policy, and where each class applies

| class | declared | the sims it fits | count |
|---|---|---|---|
| **T-A** exact integer | `abs: 0, rel: 0` | a count read off the sim: search comparisons, sort comparisons, hash slots, gate counts, gear teeth | 1 |
| **T-B** absolute only | `abs` only | a quantity with a **stiff** answer — pH, PSNR, mass-change figures, angles, sea-level percentages | 0 |
| **T-C** relative only | `rel` only | a ratio or scale-free quantity whose absolute size varies with the drawn parameters | 29 |
| **T-D** both, meaning different things | `abs` **and** `rel` | an irrational quantity, a solved root, a numerical integration, a measured input — 87 sims | 87 |
| **T-F** closed vocabulary | `EXACT` on an **enumerated** list | symbolic or categorical answers with more than one legal spelling | 30 |
| **T-G** set of labels | `SET`, `caseSensitive` stated | a set of forces, genotypes, classifications, controls | 32 |
| **T-H** ordered sequence | `ORDER`, never `SET` | stages, traversal orders, construction steps, Euler paths | 19 |
| **T-I** rubric | `RUBRIC`, `gradingMode: MANUAL` | anything a marker must judge | 21 |

T-B has a count of **0** because every sim I placed there was better served by T-D once I wrote its
hazard down. **That is the right outcome and it is worth saying: the catalogue has no pure
absolute-tolerance sim.** Where I expected one — `chemistry.ph-scale`, `computing.data-compression`,
`tech.safety-risk-matrix`, `earth.glaciers`, `general.trend-analysis` — the answer turned out to need the
relative bound as well, because the quantity is either logarithmic or an integral.

### 5.4 Where the naive comparison misfires, named

These are the sims where a plausible-looking declaration marks a correct student wrong. Every one is
flagged on its own card.

**`NUMERIC` is a false-wrong machine and `plans/11` reaches for it.** `numeric()` is `a === b`. The
catalogue names NUMERIC nowhere (it has no letter for it, §3.1) and I assigned it to exactly **4** sims,
all of them exact integer counts where `===` is safe: `computing.sorting-visualiser`,
`computing.search-algorithms`, `computing.hash-tables` and `maths.quadratic-roots`. Everything else
irrational is `TOLERANCE`. Note that `maths.quadratic-roots`'s *shipped manifest already declares
`NUMERIC`* with a tolerance of `{absolute: 0.01, relative: 0.005}` that its own grader ignores, because
it calls `tolerance()` — §3.3.

**`EXACT` on anything with a second legal spelling.** 30 cards are T-F and each one enumerates the
accepted forms. The three highest-risk:

- `computing.error-detection` — `EXACT` on a **bit string**. Whitespace and case are folded, nothing
  else. A student who writes `0110 1` for `01101` is wrong.
- `computing.chess-endgames` — algebraic notation. `Nf3`, `N1f3` and `N-f3` are three spellings of one
  move and `canonicalText` will not equate them.
- `maths.simplify-expressions` and `maths.derivative-rules` — there is **no algebraic normaliser in the
  codebase**. `2(x+1)` and `2x+2` are different strings. These two cards are the ones where an
  unenumerated answer set would produce a false wrong several times a week.

**Unit bases and exponents.** `asNumber("2x10^-3")` is `210`. Any card whose answer can legitimately be
written in scientific notation must say so: `maths.standard-form`, `chemistry.mole-conversions`,
`physics.kinetic-theory`, `physics.doppler-radar`, `tech.wind-turbine`, `astronomy.black-holes` and
`general.units-conversion` are the seven affected.

**`g`, `R`, `F`, `N_A` and the molar-mass table.** Five tabs of constants are rounded and the rounding
propagates. A student using `R = 8.31` against a key of `8.314`, or `g = 10` against `9.81`, or a molar
mass from a different table, is doing the same physics. **Ten cards carry a deliberately wide band for
exactly this reason and each says on its face that the band is a data ambiguity rather than slack**:
`physics.gas-laws`, `physics.newtons-laws`, `physics.rolling-friction`, `chemistry.mole-conversions`,
`chemistry.electrochemistry`, `chemistry.crystal-structures`, `general.nutrition-log`,
`general.personal-finance`, `general.sleep-circadian`, `general.trend-analysis`. A reviewer reading one of
those bands as a loose author and tightening it would be wrong, which is why the rubric (§6.2, point 3)
asks for the band to be *labelled*, not for it to be narrow.

**Directions are not numbers and `abs` will not catch them.** Three cards are in the failure class where
a wrong sign is a wrong physics: `physics.gravity-orbits` (delta-v is positive and adding rather than
subtracting doubles it), `physics.rocket-equation` (km/s against m/s is a factor of 1000 and a relative
band is scale-invariant so it catches it, but a *unit* slip within one system is not), and
`physics.pendulum` (period in seconds against the card's milliseconds). Each says so.

**Where a relative band alone would accept a blank.** `withinTolerance(0.0001, 0, {rel: 0.01})` is
`true`, so any T-C card whose quantity can be exactly zero across its parameter range is wrong. The
card flags this where it applies — `physics.circuit-ac`, `physics.drag-and-lift`,
`maths.optimisation`, `biology.enzyme-kinetics` — and each of those carries an `abs` as well, which makes
it T-D.

---
## 6. The `P12-T3` review rubric

### 6.1 What this rubric is and is not

`plans/20-PHASE-PACKETS.md:292` says: "Per-sim review: pedagogy, technical conformance, accessibility;
licence and provenance mandatory". Three points, all required. This section is what those reviewers
actually use.

**It is a rubric, not a checklist.** Each of the three points has a stated bar at 3/2/1/0 and a named
artefact the reviewer must produce. A checklist item can be satisfied by asserting; a rubric point
cannot, because the evidence is a document or a measurement somebody else can re-derive.

**Two reviewers must score the same sim the same way.** Every point below is therefore written as
(a) a claim the reviewer makes, (b) the artefact they produce, and (c) the condition that fails it. If
two reviewers could produce the same artefact and disagree, the point is not written tightly enough and
should be fixed before the next batch, not argued about per sim.

**The machine gate is not this rubric and does not substitute for it.** `plans/10:261` is explicit: "A
human reviews pedagogy; a machine enforces everything else." So §6.2 point 2 overlaps with `sim:validate`
and `sim:conformance` deliberately — the reviewer is checking whether the machine's green means what the
card said, which is not the same question as whether the machine is green.

**Licence and provenance are a gate, not a point.** `P12-T3` calls them mandatory; `sim:validate` already
refuses a manifest with an empty one (`sim-manifest/index.ts:60-72`). A sim with `licence: "MIT"` and
`provenance: "ORIGINAL"` **passes every machine gate** and can still be a laundered port, which is the
finding `D-24` records and which no gate can currently detect (§8.3). So licence and provenance are a
**fourth, non-scored gate** reviewed under point 3's evidence requirement.

---

### 6.2 Point 1 — Pedagogical soundness against the card's misconceptions

**The bar.** `plans/10:276` calls the three misconceptions "the pedagogical heart. A sim targeting no
misconception is a toy." So the bar is not "is it educational" — it is **can a student who holds each of
this card's three named misconceptions be observed holding it, and then observed letting it go.**

| Score | Bar |
|---|---|
| **3** | All three of the card's misconceptions are **observable in the instrument**: for each, there is a state or a parameter setting in which a student who believes it produces a *distinguishable, wrong* answer, and the wrongness is visible in the sim's own output rather than only in a text alternative. The rubric bands a marker would apply exist in the card. |
| **2** | Two of the three are observable as above. The third is named but the sim cannot distinguish a student who holds it from one who is careless — and the card says which. |
| **1** | One is observable, or all three are named but none produces a distinguishable wrong answer. |
| **0** | The sim has no misconception it can expose, or its misconception list is a paraphrase of its learning objective. |

**Evidence the reviewer must produce.** One row per misconception, naming: the misconception, the
parameter or state that elicits it, the student's wrong answer, and the sim's output at that answer. A
reviewer who writes "clear misconception targeting" produces nothing and scores 0 on evidence.

**Fails precisely when** any of these holds:
- a misconception in the card cannot be elicited by any parameter setting the manifest declares — the sim
  cannot expose an idea it has no way to set up;
- the sim's wrong-answer output is identical for a student who believes the misconception and one who has
  miscalculated, so the mark cannot tell them apart;
- the sim's text alternative gives away an answer that one of the three misconceptions targets. This is
  a real and specific failure: `plans/15` requires the alternative to say what the sim shows, what to do
  and where the answer is reported
  (`a11y/questionInteraction.ts:213-227`), and a card that names the answer in its alternative has
  published the marking scheme. Two shipped sims already record this in their own spec cards —
  `sims/maths.quadratic-roots/sim.spec.md` ("NO ROOTS HERE … a printed worksheet that prints them has
  printed its own solution") and `sims/physics.free-body-diagram/sim.spec.md` ("which forces act **is**
  the question").
- the three misconceptions are three statements of the same idea.

**A 0 here is a REJECT.** There is no version of a sim that is entertaining and teaches nothing that
belongs in a catalogue.

---

### 6.3 Point 2 — Technical conformance and grading correctness

**The bar.** **A simulation is gradeable by a server with no browser involved, or it is a toy.** The bar
is therefore not conformance-with-the-manifest; it is *does the recorded state, replayed in bare Node,
reproduce the recorded mark, for a student who did nothing wrong.*

| Score | Bar |
|---|---|
| **3** | `grade(state, params, answer)` returns the correct mark for every answer shape the card declares, **including the equivalent forms the card enumerated**; the declared `grading.strategy` is the strategy the grader actually uses; the tolerance on the card is the tolerance in force; the state round-trips; and the reviewer has replayed at least one marked state through `gradeStoredState` in bare Node and seen the same mark. |
| **2** | As above, but one of the declared equivalent forms is rejected, **or** the declared strategy differs from the used one, **or** the reviewer could not replay a state because the state lacks something the answer depends on. |
| **1** | The grader returns a mark for the answer shapes the card names but the reviewer found a correct answer it marks wrong. |
| **0** | The grader cannot be read by `readAward` (a return with no finite `maxPoints`), or it throws on a state it should tolerate, or it reads anything the state does not carry. |

**Evidence the reviewer must produce.** Four artefacts, all re-derivable:
1. The **equivalence table**: one row per accepted form in the card, with the grader's points for it.
2. The **strategy match**: the manifest's `grading.strategy` and the strategy the grader actually invokes.
3. The **tolerance measurement**: the band actually in force at the answer's magnitude, computed from
   `withinTolerance`'s `max(abs, rel·max(|a|,|b|))` — *not* the declared pair, which is not the band (§5.2).
4. The **replay receipt**: the state checksum before and after, and the points from two bare-Node grades.

**Fails precisely when** any of these holds:
- **Arity.** `grade` does not take three positional arguments. `defineSim` throws on this at load
  (`define.ts:147-154`) and the conformance matrix re-checks it per sim
  (`scripts/sim-conformance.mjs:723-746`), but the reviewer must confirm it against the *source*, because
  the check runs against the built bundle and a stale `dist/` passes it.
- **Return shape.** The grader returns anything other than `{points, maxPoints, …}`. `readAward` refuses a
  return whose `maxPoints` is not a finite number and routes it to `NEEDS_HUMAN`
  (`grading/simulation.ts:227-233`). **Eight of the 24 shipped gold sims are in this class today** (§3.4),
  which is why this is the first thing the reviewer checks and not a footnote.
- **Rubric on an AUTO item.** `strategy: RUBRIC` with the item's `gradingMode` left `AUTO`. The grade
  reports `GRADED: 0`, which a release batch cannot distinguish from a wrong answer. 21 cards carry this
  trap and every one states `MANUAL`.
- **A wrong parameter source.** `params` supplied by the sim itself rather than by the resolved variant
  (`protocol.ts:41`). The regrade then silently uses the host's parameters — a different question, marked
  as the same item.
- **A tolerance narrower than the model's own convergence.** A root found to a residual of 10⁻⁶ graded to
  10⁻⁹ is a grader that fails a correct answer. Three cards name the residual in the answer key for this
  reason (`chemistry.titration-curve`, `chemistry.acid-base-strength`, `earth.glaciers`).
- **A seed the grader cannot see.** `randomised: true` and the state carries no `seed` / `seedFromHost`
  (`scripts/sim-conformance.mjs:978-995`), or the answer depends on a draw not derived from the recorded
  seed. `P11-T9`'s variant audit cannot be satisfied.
- **A quantity the state does not carry.** The canonical example is `physics.em-induction`, where the peak
  emf depends on the magnet's *speed* and a state storing only its position cannot be regraded. The card
  requires speed in the state for exactly this reason.
- **A state that cannot be saved.** `canonicalJson` rejects non-finite numbers and non-plain objects
  (`state.ts:36-64`), so a `Map`, a `Set` or a `NaN` in the state makes the sim unsaveable rather than
  wrong. `chemistry.particle-view` is the case — a particle whose position goes to `NaN` because the box
  dimension divided by zero.
- **The determinism probe.** `runDeterminism` grades the literal state `{ probe: true }` three times
  (`scripts/sim-validate.mjs:288-330`). A grader that destructures `state.mass` and gets `undefined`
  throws, and a throw is reported as `GRADER_FAILED`. **Every sim owes a `validateState` and a grader
  that survives a state it does not recognise.**
- **Equivalent forms not enumerated.** A T-F card whose accepted-spelling list is shorter than the legal
  spellings. §5.4 names the four highest-risk cases.

**A 0 here is a REJECT.** A sim whose grader cannot be read by the platform cannot be an exam question,
and `plans/10:14` is explicit that being "usable as a graded exam question" is a requirement, not a
feature.

---

### 6.4 Point 3 — Accessibility, plus the licence gate

**The bar.** `plans/15:79`: "A canvas-based sim with no text alternative passes every automated check and
is completely unusable with a screen reader. So the conformance matrix asserts that every registered sim
declares a `textAlternative` and that every control is keyboard reachable — the machine gate, not a
reviewer's memory."

**But that gate does not currently assert the text alternative's content** (§3.6): the harness
synthesises it from `screenReaderSummary` (`scripts/sim-conformance.mjs:1644`). **So the review is the only
thing standing between this catalogue and 219 canvas sims with titles as their alternatives**, and the
reviewer's job here is to read the alternative, not to check that one exists.

| Score | Bar |
|---|---|
| **3** | Every control the pointer can reach has a keyboard path **with the same outcome**, and the non-visual path reads **the same numbers the grader reads** rather than a description of them. The text alternative states what the sim shows, what to do, and where the answer is reported, and gives away none of the three misconceptions from point 1. `accessibility.focusOrder` is populated and matches the DOM order the reviewer tabbed. |
| **2** | As above, but the non-visual path is a summary of the drawing rather than the data behind it, or the text alternative omits where the answer is reported. |
| **1** | Every control is keyboard-reachable but at least one drag has no keyboard equivalent with the same outcome (`2.5.7`), or the text alternative describes the sim without the task. |
| **0** | A pointer-only interaction exists, or the text alternative is a restatement of the title, or it names the answer. |

**Evidence the reviewer must produce.**
1. **A tab transcript**: the reachable elements in order, with the outcome of each — not "all controls
   are reachable". `plans/15:42` requires "a documented and stable order".
2. **The drag-equivalence pair**: for each pointer drag, the keyboard route and the DOCUMENT it produces,
   compared. `a11y/questionInteraction.ts:274-293` refuses a `DRAG` replacement whose outcome lacks
   "move" or contains "swap", because a swap produces a different paper from the pointer path.
3. **The text alternative, read aloud, against the three misconceptions.** This is the one that fails.
4. **`focusOrder` populated** and equal to the tabbed order. Today the field is declared and read by
   nobody (§3.5); a reviewer who fills it is doing `P13-T4`'s work early.

**Fails precisely when** any of these holds:
- any drag has no keyboard equivalent with the same outcome. **This is a WCAG 2.2 AA criterion, not a
  preference** (`plans/15:17`), and `INTERACTION_CONTRACTS` already encodes the rule as data.
- the text alternative is shorter than 20 characters. `defineSim` refuses it at load
  (`define.ts:163-169`); a card whose alternative is shorter was not tested.
- the text alternative names the answer, a root, a weight, a force list, or any of the card's three
  misconceptions.
- an announcement fires per frame, or an `aria-label` is mutated on a repainting element. `a11y.ts:28-39`
  names this failure and the standard workaround: a live region with a reset-then-set delay, and
  announcements only on a deliberate transition.
- an `assertive` live region. `assertInteractionContracts` refuses it outright
  (`questionInteraction.ts:305-311`) and only `ordering`, `simulation` and `worked_solution` speak at all.
- `accessibility.keyboard` is `false` below age 16. `checkManifestRules` **refuses** the manifest
  (`sim-manifest/index.ts:342-352`), and the refusal's reasoning is the right one: in graded mode the sim
  *is* the question surface, so a student who cannot operate it has been excluded from the assessment
  rather than given an accommodation.
- a colour is the only signal on any state, feedback or severity (`plans/15:43`).
- a drag handle has no accessible name (`describeControl`, `a11y.ts:82-92` — the shipped failure was a
  play triangle with no `aria-label`, announced as "button").

**Licence and provenance — a gate, not a score. A fail here is a REJECT regardless of the other three
points.** The reviewer states, in one sentence each: the licence; the provenance; and, if the provenance
is `INSPIRED_BY`, **the specific work it names and whether the reviewer can identify it in the sim.** The
failure condition is a sim whose model, data or visual design is recognisably somebody else's and whose
`provenance` says `ORIGINAL`. `D-24` records that this is the laundering failure and that
**"the gate as specified cannot detect anything"**; the reviewer's sentence is the detection.

---

### 6.5 The verdict, and what a REJECT does

**A sim is REJECTED when any of the following is true.** There is no aggregate and no averaging: one 0 is
a reject, because each of the three points is a claim that, if false, makes the sim unfit for a
catalogue rather than merely weaker.

| # | Condition | Point |
|---|---|---|
| R-1 | The sim exposes no misconception it can elicit. | 1 |
| R-2 | The grader cannot be read by `readAward`, or it reads something the state does not carry, or the state cannot be replayed to the same mark. | 2 |
| R-3 | A correct answer in a form the card enumerated is marked wrong. | 2 |
| R-4 | A pointer-only interaction exists, or the text alternative names the answer. | 3 |
| R-5 | Licence or provenance is unstated, or `ORIGINAL` is declared for a sim whose model, data or design is recognisably a port. | gate |

**A 1 is not a reject and is not a pass.** It is a **conditional accept**: the sim ships behind a named
debt, the debt is a row with a task ID and an owner, and the row is visible in the catalogue. This is the
`D-28` precedent — "quarantined, visible, blocks the catalogue count" — applied to content rather than to
flakes. **A 1 that is not written down as a debt is a reject**, because the difference between a deferral
and an untracked piece of unfinished work is whether anybody owes it.

**What happens to a rejected sim.** It does not go back into a batch.

1. The sim's directory stays. The work is not thrown away, and a lane that has just built something real
   should not be told to start again.
2. `sim.manifest.json` is left with the defect **in place** — the failing value is not reverted and the
   gate is not weakened. A rejected sim therefore fails `sim:validate` or `sim:conformance`, and a
   failing sim in `sims/` blocks `sim:build --all` on the next build. **That is the intended pressure,
   not an accident**: `D-35` is the finding that nothing structurally stopped an agent weakening a gate,
   and a rejection that does not make something red is a rejection the next agent will quietly undo.
3. The sim is **excluded from the registry** for this batch. `sim:build` writes `sims/registry/` from
   whatever builds, so the mechanism is to keep the sim unbuildable rather than to delete the entry by
   hand — a hand edit is the "human database edit" `plans/10:248` forbids.
4. A **re-review is required**, by a reviewer who was not the first. Not because the first was wrong, but
   because a review that is overturned on appeal has found a defect in the process and re-reviewing with
   the same reader reproduces it.
5. The catalogue count drops by one. `plans/11`'s "Total registered ≥ 200" is a floor on what ships, not
   a quota on what may be attempted, and `D-20` already cut the target to 60.

**Can the six lanes proceed in parallel regardless of each other's outcome? Yes, and that is the design.**
`plans/10:356` puts the review *inside* the lane — "6 parallel author lanes, one sim in flight per lane:
card → code → conformance → review" — so a rejection is a **per-sim, within-lane** event. It consumes that
lane's next sim slot and nothing else. `plans/20`'s dependency `P12-T3 ← P12-T2` is a dispatch-order
statement about when the phase's tasks are released, not a gate on individual sims.

**Two consequences that follow, and both are uncomfortable.**

- **The batch gate is not the review.** `plans/10:360` says "a batch never lands without its machine
  gate" and names the machine gate only. A batch of thirty can therefore land with three rejects in it,
  because the rejects never built. If that is acceptable then the review is advisory and the catalogue
  grows unchecked; if it is not, the batch gate needs a **review-completion count** as well as a machine
  count, and **nothing in `plans/10` or `plans/20` provides one.** I have not added it, because adding a
  gate is `D-35` territory and belongs in a reviewed task with a `GATE-CHANGE:`, not in a plan document.
  It is in §8 as code work.
- **`D-28`'s flake budget is the model to copy, not to bypass.** `D-28` says the conformance matrix will
  get retried, sharded, narrowed and given a retry wrapper unless the flake budget makes gaming
  impossible. A review rubric with no reject path gets the same treatment within two batches — a 1
  quietly becomes a 3, and the review becomes the thing it was supposed to replace. **R-1 through R-5
  exist so that gaming them requires editing this document**, which `D-35`'s gate is set up to catch.

### 6.6 Scoring, so two reviewers converge

Each point is scored independently, **out of 3**, by two reviewers, before they compare.

- **Both 3, or 3 and 2** → the lower score stands. A 2 needs a written reason; a 1 needs a debt row.
- **3 and 1, or 1 and 1** → the sim is a REJECT under R-1 through R-5 and goes to re-review by a third
  reader. A disagreement of two points is not a disagreement of taste; it is one of the two reviewers
  having missed the artefact, and the third reader's job is to say which.
- **2 and 2** → accept, with both reasons recorded, because the debt is then visible from two directions.
- **Either reviewer cannot produce the evidence** → the score is 0 on that point. **"I could not find a
  way to check it" is a 0, not a shrug.** This is the same rule the repository already applies to the
  item-authoring review, where every fixture carries `reviewedBy: null` and a test asserts
  `REVIEW_IS_COMPLETE()` is false rather than letting the author tick it.

**A review is complete when all three points have a score, the evidence artefacts exist, and the licence
sentence exists.** Not when the reviewer has read the code.

---
## 7. The conformance manifest schema

### 7.1 What exists, and why it is not enough

`P12-T6` ("Bundle budget enforcement; prove the app bundle is unchanged from the 24-sim baseline",
`plans/20-PHASE-PACKETS.md:295`) and `P13-T4` ("Simulation text alternatives enforced in the conformance
manifest", `plans/15-A11Y-I18N.md:117`) both need a machine-readable thing to read. The `conformance`
block in `sim.manifest.json` is the obvious candidate, and it has four problems that make it unusable for
either task as it stands:

1. **It is optional.** `schemas/sim.manifest.schema.json:8-27` requires eighteen fields and `conformance`
   is not one of them; `sim-manifest/index.ts:245` marks it `.optional()`. A manifest may omit the block
   entirely, so "enforced in the conformance manifest" enforces nothing.
2. **It cannot carry the text alternative.** The only cell that reads one builds it from
   `screenReaderSummary` (§3.6), so the block a text alternative is supposed to be enforced *in* never
   mentions it.
3. **`expectation.prefix` is schema-allowed and implemented nowhere**, and the runner implements
   `step.what === 'fill' | 'select'` which `additionalProperties: false` makes unreachable.
   `scripts/conformance-vocabulary-gate.mjs:1-36` documents this as a two-directional drift and asserts
   reachability in both directions by lifting the real matcher out of the runner rather than
   transcribing it. That gate is the right pattern and this section must not undo it.
4. **There is no per-sim a11y evidence.** `plans/11:284-287` asks for keyboard 100%, text alternative
   100% and `reducedMotion` 100%; the only two of those that are fields are declared and read by nobody
   (§3.5), and the third is not a field at all.

So: **the manifest needs extending, and any extension must be made in both halves.** The source of
truth is `schemas/sim.manifest.schema.json`; `packages/contracts/src/sim-manifest/index.ts` mirrors it
in Zod; the guarantee that they agree is **behavioural** — a fixture battery run through both, every
fixture accepted by both or rejected by both (`sim-manifest/index.ts:6-13`). A new field added to one and
not the other fails that battery, which is the mechanism to rely on and the reason this section says
"both halves" every time.

### 7.2 The schema

Three layers, and the separation is load-bearing: **manifest fields are what the author declares**,
**conformance fields are what the machine asserts**, and **report fields are what the last run observed**.
Collapsing the third into the first is how a declaration becomes a claim somebody else made.

#### Layer A — `conformance` becomes REQUIRED (was optional)

```jsonc
"conformance": {
  "type": "object",
  "additionalProperties": false,
  "required": ["script", "expect", "accessibility"],
  "properties": {
    "script":  { /* UNCHANGED — see 7.3 */ },
    "type":    { /* UNCHANGED — the student's input, keyed by the sim's field name */ },
    "expect":  { /* UNCHANGED — see 7.4 */ },
    "accessibility": { "$ref": "#/$defs/conformanceAccessibility" },   // NEW, REQUIRED
    "capturesPath": { "type": "string", "pattern": "^\\./" }
  }
}
```

Making it required is the single change that turns `P13-T4` from a sentence into a gate. **It will
refuse every manifest that has none, which today is every one of the 24** — so this is a `P12-T4`-shaped
change, not a `P12-T1` one, and §8 says so.

#### Layer B — `conformance.accessibility`, the per-sim evidence

```jsonc
"conformanceAccessibility": {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "focusOrder", "keyboardReachable", "dragReplacements",
    "textAlternativeGivesAnswer", "announcementPoints"
  ],
  "properties": {
    "focusOrder": {
      "description": "Every focusable element the student meets, in DOM order, as a CSS-ish path or a stable id. P13-T4 needs the ORDER, not a count: plans/15 rule 5 says 'a documented and stable order', and nothing else in the repository records it — accessibility.focusOrder is declared at sim-manifest/index.ts:96 and read by nobody.",
      "type": "array", "minItems": 1,
      "items": { "type": "string", "minLength": 1, "maxLength": 120 },
      "uniqueItems": true
    },
    "keyboardReachable": {
      "description": "Every control the POINTER can reach is in focusOrder. A false here is a WCAG 2.2 AA failure, not a warning: in graded mode the sim is the question surface.",
      "type": "boolean"
    },
    "dragReplacements": {
      "description": "One entry per pointer drag, naming the gesture and the keyboard route that produces THE SAME DOCUMENT. a11y/questionInteraction.ts:274-293 refuses a DRAG replacement whose outcome lacks 'move' or contains 'swap', because a swap produces a different paper from the pointer path. An empty array is correct for a sim with no drag.",
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["gesture", "keys", "outcome"],
        "properties": {
          "gesture": { "type": "string", "minLength": 1, "maxLength": 80 },
          "keys":     { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
          "outcome":  {
            "description": "The DOCUMENT-level verb. Must contain 'move' and must NOT contain 'swap'.",
            "type": "string", "minLength": 1, "maxLength": 200
          }
        }
      }
    },
    "textAlternativeGivesAnswer": {
      "description": "TRUE MEANS THE SIM IS REJECTED (rubric R-4). A text alternative is not a summary: for a blind student it IS the question (plans/15 §1.2), so one that names a root, a weight or a force list has published the marking scheme. This is a boolean the AUTHOR asserts and the REVIEWER checks, and both of those are recorded — see validation rule V-7.",
      "type": "boolean"
    },
    "announcementPoints": {
      "description": "Every transition that speaks, in order. An empty array is correct only for a sim that never announces, and a per-frame announcement is a failure: a11y.ts:28-39 records that mutating aria-label on a repainting element is announced dozens of times a second.",
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["trigger", "message"],
        "properties": {
          "trigger":  { "type": "string", "minLength": 1, "maxLength": 120 },
          "message":  { "type": "string", "minLength": 1, "maxLength": 400 },
          "politeness": { "type": "string", "enum": ["polite", "assertive", "none"], "default": "polite" }
        }
      }
    },
    "reducedMotionBehaviour": {
      "description": "OPTIONAL. What is withheld and what stays reachable under prefers-reduced-motion. Defaults to null, meaning undeclared. Today accessibility.reducedMotion is required by the schema, 23 of 24 sims declare it true, apps/web never reads it, and the real policy is Stepper.allowMotion which DEFAULTS TO TRUE (stepper.ts:246-266) — so plans/11's 'reducedMotion support 100%' is currently unfalsifiable.",
      "type": ["string", "null"], "maxLength": 400, "default": null
    }
  }
}
```

#### Layer C — `sims/registry/report.json`, the observed side

**A separate document, and it must be.** Putting what a run *observed* in the same file as what an author
*declared* means a green run can rewrite a declaration, and a declaration can be a run's excuse. The
existing precedent is right: `sim:build` writes `sims/registry/registry.json` and
`sims/registry/index.json` as separate artefacts, and the registry is compared against `git show HEAD:`
rather than against the file on disk (`scripts/sim-build.mjs:490-505`).

```jsonc
{
  "$schema": "https://orrery.example/schemas/sim.conformance-report.schema.json",
  "generatedFrom": "1970-01-01T00:00:00.000Z",
  "digest": "<fnv1a over the sorted per-sim records>",
  "records": [
    {
      "simId": "maths.projectile-motion",
      "version": "2.1.0",
      "conformance": {
        "handshake":        { "status": "PASS" | "FAIL", "detail": "…" },
        "sandbox":          { "status": "PASS" | "FAIL", "cells": 12 },
        "script":           { "status": "PASS" | "FAIL", "stepsRun": 2, "firstFailingStep": null },
        "expectAnswer":     { "status": "PASS" | "FAIL", "reported": 63.71, "expected": "60..68" },
        "expectGrade":      { "status": "PASS" | "FAIL", "browser": 4, "node": 4 },
        "stateRoundTrip":   { "status": "PASS" | "FAIL", "checksumBefore": "…", "checksumAfter": "…" },
        "keyboardReach":    { "status": "PASS" | "FAIL", "declared": 7, "reached": 7, "missing": [] },
        "dragEquivalence":  { "status": "PASS" | "FAIL" | "N/A", "gestures": 0 },
        "textAlternative":  { "status": "PASS" | "FAIL", "chars": 168, "declaresAnswer": false, "readAloudBy": "reviewer-id" },
        "prohibitedApi":    { "status": "PASS" | "FAIL", "attempts": 15 },
        "determinism":      { "status": "PASS" | "FAIL", "runs": 3, "identical": true },
        "seedApplied":      { "status": "PASS" | "FAIL" | "SKIPPED", "seedFromHost": true, "twoStudentsDiffer": true, "oneStudentStable": true },
        "bundleBudget":     { "status": "PASS" | "FAIL", "bytes": 24591, "maxBytes": 350000, "growthVsBaseline": "+0.0%" },
        "screenshot":       { "status": "PASS" | "FAIL", "path": "./astronomy.orrery-1.0.0.png" }
      },
      "review": {
        "status": "ACCEPT" | "CONDITIONAL" | "REJECT",
        "pedagogy": { "score": 3, "reviewers": ["id", "id"], "evidence": "…" },
        "technical": { "score": 3, "reviewers": ["id", "id"], "evidence": "…" },
        "accessibility": { "score": 3, "reviewers": ["id", "id"], "evidence": "…" },
        "licenceGate": { "passed": true, "note": "…" },
        "debt": null
      }
    }
  ]
}
```

The thirteen `conformance` cells are the existing runner's cells, renamed to a stable vocabulary. Today
`scripts/sim-conformance.mjs` has 21 entries in its `CELLS` array (`:593` onward) with prose names ('the sandbox attribute carries exactly
one token', 'the TEXT ALTERNATIVE is in the DOM before and after mounting', 'a GRADED mount works, and a
gradePreview during one is DISCARDED'). **A cell name is not a schema**, so this is a vocabulary that has
to be introduced, and `scripts/conformance-vocabulary-gate.mjs` is where it gets checked in both
directions.

### 7.3 Validation rules

Numbered so a CI failure can name one. **V-1 to V-6 are static, on the manifest. V-7 to V-11 need a run
and belong to the report.**

| # | Rule | Enforced by | Fails when |
|---|---|---|---|
| **V-1** | `conformance` is present | schema (`required`) | a manifest omits it — **all 24 today** |
| **V-2** | `conformance.accessibility.focusOrder` is non-empty and has no duplicates | schema (`minItems: 1`, `uniqueItems`) | the order is unrecorded, which is what `accessibility.focusOrder` was for and never got |
| **V-3** | `dragReplacements[].outcome` contains `move` (case-insensitive) and does **not** contain `swap` | `checkManifestRules` — the same predicate `assertInteractionContracts` already applies to the question-type table (`questionInteraction.ts:278-293`), so the rule exists and is copied rather than invented | a keyboard route that SWAPS where the pointer MOVED — a different document, hence a different paper |
| **V-4** | `announcementPoints[].politeness` is never `assertive` | schema `enum` + `checkManifestRules` | an assertive region interrupts whatever the student was doing (`plans/15:41`) |
| **V-5** | `keyboardReachable: true` whenever `ageRange[0] < 16` | `checkManifestRules` — **already exists** (`sim-manifest/index.ts:342-352`), extended from `accessibility.keyboard` to the conformance evidence | an under-16 sim that cannot be operated |
| **V-6** | `sims/registry/report.json` contains exactly one record per `registry.json` entry, keyed `id@version` | `sim:conformance`, or a new `gate:sim-report` | the report and the registry disagree — a sim with no record has not been run, and a record with no entry is for a sim that does not ship |
| **V-7** | `textAlternativeGivesAnswer: false` | `checkManifestRules` + the conformance runner | **the sim is REJECTED** (R-4) |
| **V-8** | `expectGrade.browser === expectGrade.node`, both numeric, and within `0 ≤ points ≤ maxPoints` | the runner | a browser grade and a Node grade disagree, or an award is out of its own declared range — `readAward` refuses the latter to a human (`simulation.ts:234-237`) and this catches it before that |
| **V-9** | `determinism.identical === true` and `runs >= 3` | the runner | a sim that cannot be graded three times the same way |
| **V-10** | if `capabilities.randomised` then `seedApplied.status === 'PASS'` with `seedFromHost: true`, `twoStudentsDiffer: true` and `oneStudentStable: true` | the runner | a seeded sim that cannot show both halves of the anti-collusion claim. **This is the cell that catches a whole cohort sharing one paper, and `plans/11` does not mention it at all** |
| **V-11** | `bundleBudget.growthVsBaseline <= 0.15` | `sim:build` | a 15% regression, which `plans/10:143` makes a CI failure |
| **V-12** | `review.status` ∈ {`ACCEPT`, `CONDITIONAL`, `REJECT`}; `CONDITIONAL` requires a non-null `debt` with an owner and a task ID | `P12-T3`'s review writer | a conditional accept with no debt is an untracked piece of unfinished work, and §6.5 makes that a reject |

### 7.4 What each consumer reads, so nobody has to guess

| Consumer | Reads | Why it needs exactly this |
|---|---|---|
| `sim:validate` (`P12-T2`) | `conformance.accessibility` V-2…V-5, V-7; the manifest's `expect` V-1 | the manifest gate, before a build |
| `sim:conformance` (`P12-T7`) | every cell, writes `report.json` | the matrix, in a browser |
| `gate:sim-report` (new, `P12-T6`) | V-6, V-8…V-11, V-12; and the registry/index diff | the place a missing record is a failure |
| `P13-T4`'s a11y enforcement | V-2, V-3, V-4, V-7 and `report.textAlternative` | a text alternative that exists is not one that is adequate |
| `P12-T3`'s reviewers | `report.conformance` as the starting point, and score the three points against it | the reviewer checks what the machine's green *means*, not whether it is green |
| `P12-T6`'s bundle check | `bundleBudget` against the 24-sim baseline | "the app bundle is unchanged from the 24-sim baseline" has no field anywhere today |

### 7.5 The one thing this schema deliberately does not do

**It does not have a field for "this sim teaches the right thing".** That is point 1 of the rubric and it
is a human judgement, and a field for it would be a field an author fills in to satisfy a schema — which is
`D-31`'s pre-ticked-checklist failure wearing a different hat. The machine gates the fourteen things it
can decide; the rubric decides the rest; and §6.5's reject path is what stops the rubric from becoming
decoration.

---
## 8. Batch policy, and the code work this plan implies

### 8.1 Can the six lanes run in parallel? Yes — and that is the design

`plans/10:356` puts the review **inside** the lane: "6 parallel author lanes, one sim in flight per lane:
card → code → conformance → review". A REJECT is therefore a per-sim, within-lane event that consumes that
lane's next slot and nothing else. `plans/20`'s `P12-T3 ← P12-T2` is a dispatch-order statement about
when the phase's tasks are released, not a gate on individual sims. Six lanes proceed in parallel
regardless of each other's outcomes, and the only cross-lane constraint is the batch's machine gate.

**But the batch gate is not the review, and nothing in the plan closes that.** `plans/10:360` names the
machine gate only. A batch of thirty can land with three rejects in it, because a rejected sim does not
build and therefore is not in the registry. If that is acceptable the review is advisory and the
catalogue grows unchecked; if it is not, the batch gate needs a **review-completion count** alongside
the registry count, and neither `plans/10` nor `plans/20` provides one. I have not added it — adding a
gate is `D-35` territory and belongs in a reviewed task with a `GATE-CHANGE:` in its body, not in a plan
document.

### 8.2 Where a rejected sim should sit

**In `sims/`, unbuildable, failing its gate.** Not deleted, not reverted, not quietly fixed. The reasons
are the repository's own:

- `D-35`: "Nothing structurally stopped an agent weakening a gate… every gate is local and bypassable by
  editing the gate." A rejection that leaves nothing red is a rejection the next agent undoes, and the
  next agent may be the one whose judgement differs.
- `plans/10:248`: "Registration is a **CI job, not a human database edit**." So the mechanism for keeping
  a rejected sim out of the registry is to keep it unbuildable, not to hand-edit `sims/registry/`.
- `D-28`'s flake budget is the model: "quarantined, visible, blocks the catalogue count". Content
  defects want exactly that treatment and there is no equivalent.

### 8.3 Code work this plan implies, which I have not done

I was instructed to write documents only. Each item below is a change to code I have not made, and each
names the file and line so it can be turned into a task with a real diff in mind.

| # | Change | Where | Why it is not a document fix |
|---|---|---|---|
| C-1 | Rename `modern-photons` to `physics.modern-photons` in `plans/11`, and record `D-24`'s fix in the plan as well as in `docs/` | `plans/11:94` | `plans/` is the authority (`plans/README.md:3`) and only `docs/` was fixed. I was instructed not to edit `plans/**`. |
| C-2 | Decide what `earth.`/`tech.`/`general.` become, and reconcile the ids | `plans/11`, §3 | 53 ids. Either three new subjects enter `subjectSchema` (`sim-manifest/index.ts:48-58`) or 53 ids are renamed. Both are content decisions, not engineering. |
| C-3 | **Check an id's subject segment against `subjects`** | `sim-manifest/index.ts:32-43`, `schemas/sim.manifest.schema.json:130-135` | The schema's own description says "subject.slug" and `zzz.wat` is accepted with `subjects: ["chemistry"]`. Two shipped sims already depend on the hole. |
| C-4 | Migrate 23 gold sims to the current SDK shape, and **add a typecheck for `sims/`** | `sims/*/src/grader.ts`; `pnpm-workspace.yaml` | 175 measured type errors, invisible to every gate in `package.json`. The typecheck is the important half: it makes the drift fail rather than sit. |
| C-5 | Fix `sims/_template/src/grader.ts:57-59, 65` | the template | `pnpm sim:new` scaffolds a simulation that does not typecheck, and `P12-T2` runs that command 195 times. |
| C-6 | Make `conformance` required, and add `conformance.accessibility` | `schemas/sim.manifest.schema.json:8-27`; `sim-manifest/index.ts:245` | §7. This is `P13-T4`'s actual deliverable and it will refuse all 24 existing manifests. |
| C-7 | Make the conformance cell read `accessibility.textAlternative`, not synthesise one from `screenReaderSummary` | `scripts/sim-conformance.mjs:1644`, cell at `:704-710` | The cell named for the text alternative does not read the text alternative. |
| C-8 | Either make `stateSchema` carry properties, or replace `plans/11`'s "Declared `stateSchema` ≥ 60%" check | `sim-manifest/index.ts:130`; `plans/11:288` | `plainObjectSchema` is `{type: "object"}`. The check is satisfied by an empty object and measures nothing. |
| C-9 | Give `focusOrder` a reader, or delete it | `sim-manifest/index.ts:96` | Declared, required by nothing, read by nobody. It is the field `P13-T4` needs. |
| C-10 | Make `reducedMotion` mean something, or delete it | `sim-manifest/index.ts:94`; `stepper.ts:246-266` | Required by the schema, declared `true` by 23 sims, read by nobody, and the real policy defaults to `allowMotion: true`. `plans/11`'s "100% reducedMotion" is unfalsifiable. |
| C-11 | Add `scoringSurface` to `SimulationSpec`, and make the Prisma column non-null for sim items | `contracts/src/question/index.ts:207-213`; `packages/db/prisma/schema.prisma:568` | The field that decides publishability is absent from the type an author writes, and `simPublishRefusal` refuses its absence. |
| C-12 | Add the `V-8` check — browser grade equals Node grade | `scripts/sim-conformance.mjs` | Eight of 24 graders return a shape `readAward` cannot read. The runner grades the answer in Node but does not compare the two grades. |
| C-13 | Build the **provenance register** `D-24` specifies | new | `provenance` is validated as a *string* (`schemas/sim.manifest.schema.json:199-201`). `INSPIRED_BY:<ref>` resolves to nothing, so laundering passes the build. §6.4's licence sentence is the only detection that exists. |
| C-14 | Add `ORDER` and `NUMERIC` to `plans/11`'s `G` vocabulary, or replace the column | `plans/11:5` | Two of six instruments cannot be named, and 9 of the 24 built sims use one. |
| C-15 | A gate comparing `plans/11` against `docs/10-SIM-CATALOGUE.md` | new | 31 + 25 divergent ids and an `EXPLICIT` strategy value that is in no enum. Two lanes reading two files build two catalogues. |

---

## 9. What I could not establish

Stated plainly, because a catalogue that claims conformance it has not checked is the failure this phase
exists to prevent.

### 9.1 Not established

- **Whether any of the 219 is buildable.** The cards are specifications. `D-20` re-costed `P12` at
  550–700 h and `plans/20:168` re-costed the first 24 at 240 h; a complete card is not a cheap sim and I
  have no basis for a per-sim estimate.
- **Whether the 24 existing sims still work.** I did not run `sim:conformance` — it needs
  `playwright install chromium`, and `pnpm-workspace.yaml`/`package.json` keep it out of `pnpm gates`
  deliberately. I ran `sim:validate --all` (24/24 pass) and `test:sims` (367/367 pass) and a `tsc` sweep
  (175 errors). **All three of those are evidence about the manifest, the runtime behaviour and the
  types respectively — none of them is evidence that a sim loads in a browser.**
- **Whether the sandbox, keyboard or screenshot cells pass.** The conformance matrix exists and I read
  it; I did not execute it.
- **Whether `gradeStoredState` reproduces a real marked grade for any of the 24.** I read the code path
  (`define.ts:223-240`) and the state round-trip (`state.ts`); I did not re-grade a stored attempt,
  because no stored attempt with a sim response exists in the repository.
- **The provenance of the 24 built sims.** All 24 declare `ORIGINAL`. I have no evidence either way, and
  no register to check against (C-13). This is a **known unknown**, not a clean bill.
- **Whether the review rubric produces agreement.** §6.6's convergence rules are designed for it; no two
  reviewers have yet scored the same sim. **The claim that this rubric is reviewable is a claim, not a
  measurement.**
- **Whether the conformance manifest schema is the one `P12-T6` and `P13-T4` will want.** It is the one
  that satisfies both tasks as I have read them. Two consumers I cannot see may want fields it lacks.

### 9.2 Scope decisions I made, that a reader should overturn if they disagree

- **All 219 cards, not 60.** `plans/20:18` cut the target to 60 for v1. I wrote cards for every
  `plans/11` row because the instruction was to card the catalogue, and because a card is cheap next to a
  sim. **If the phase is scoped to 60, the priority is `plans/11:295-297`'s own build order** — thinnest
  coverage, then highest-frequency curriculum topics, then untested grading or protocol corners — and the
  first 60 by that order are computable from §2's table.
- **Grade bands are mine.** `plans/11` has **no grade-band column at all**. Every band in every card is
  my editorial judgement (KS3 11–14, GCSE 14–16, A-level 16–18) and **must be confirmed** by somebody
  who knows the curriculum. It is a judgement the reviewer should check like any other, and the one field
  in these cards with no authority behind it.
- **`ageRange` follows the band** and is written so `ageRange[0] < 16` for every KS3 and GCSE card, which
  makes `accessibility.keyboard` mandatory for 135 of the 219 and keeps the V-5 rule meaningful.
- **The unmappable count is 3, under a criterion I chose.** §4.2 states the criterion, the count, the
  25 rows a keyword search returns, and which 17 of those a reviewer should look at — so the number can
  be argued with rather than merely read.
- **The provenance register does not exist, so every card's licence row carries the same warning.** That
  is 219 copies of one sentence and it is noise by the tenth. It is here because it is the truth for every
  sim, and because the moment the register exists (C-13) every one of these rows has to be answered
  properly.

### 9.3 The honest summary

**219 rows counted, 219 cards written, 3 unmappable under a stated criterion, 5 reject conditions, 12
validation rules, and 15 pieces of code work this plan implies.** None of it is a conformance claim. The
24 simulations that exist have **175 type errors against the SDK they will be graded by — every one of
the 24, without exception** — 14 of them declare a grading strategy their grader does not use, and 8 of
them return a shape the platform's own dispatch refuses. **Those are the findings the phase most needs,
and they are all in the code rather than in `plans/`'s text.**

---
