# 11 — Simulation Catalogue (220)

The coverage plan for P12. Each row is a **spec-card stub** (`10-SIMULATIONS.md` §7); the author fills in the full card before writing code.

`G` = grading strategy: **E**xact, **T**olerance/numeric, **SE**t match, **R**ubric (manual).

Coverage is deliberate: every subject gets foundational, intermediate and advanced sims, and every grading strategy is exercised at least a dozen times, so the grader's edge cases surface in real content rather than only in fixtures.

---

## Mathematics (45)

| id | Title | G | Focus |
|---|---|---|---|
| `maths.projectile-motion` | Projectile motion | T | Range/height vs speed and angle; quadratic reasoning |
| `maths.quadratic-roots` | Quadratic roots and graphs | E | Discriminant, sign of roots, completing the square |
| `maths.function-transform` | Function transformations | E | Translate, reflect, scale; read the effect |
| `maths.derivative-tangent` | Derivatives as tangent lines | T | Secant → tangent; rate-of-change intuition |
| `maths.statistics-explorer` | Statistics explorer | T | Mean/median/mode, spread, outliers, box plots |
| `maths.trigonometry-unit-circle` | The unit circle | E | Radians, exact values, quadrants |
| `maths.coordinate-geometry` | Coordinate geometry | E | Slopes, intersections, reflections, constructions |
| `maths.monte-carlo-pi` | Monte Carlo π | T | Convergence, sampling error, why approximation works |
| `maths.matrix-transformations` | 2D linear transformations | E | Matrices as maps; determinants as area scale |
| `maths.probability-tree` | Probability trees | SE | Branching, independence, conditional paths |
| `maths.set-venn` | Venn and set operations | SE | Union, intersection, complements |
| `maths.series-convergence` | Series convergence | T | Partial sums, comparison tests, divergence |
| `maths.integral-area` | Integral as accumulated area | T | Riemann sums; signed area |
| `maths.limit-explorer` | Limits and continuity | E | One-sided limits, holes vs jumps |
| `maths.derivative-rules` | Derivative rules drill | E | Product, quotient, chain; fluency |
| `maths.equation-solver` | Equation solver | E | Linear, quadratic, simultaneous; extraneous roots |
| `maths.simplify-expressions` | Expression simplifier | E | Order of operations, collecting like terms, factoring |
| `maths.ratio-proportion` | Ratios and proportion | T | Scale recipes, maps, direct/inverse proportion |
| `maths.percentages` | Percentages in context | T | Percent change, compound interest |
| `maths.fractions-decimals` | Fractions and decimals | E | Place value, ordering, recurring decimals |
| `maths.number-line-labs` | Number line laboratory | E | Absolute value, intervals, inequalities |
| `maths.prime-factorisation` | Prime factorisation | E | Divisibility, LCM/HCF, prime decomposition |
| `maths.indices-laws` | Index laws | E | Negative and fractional indices, index equations |
| `maths.standard-form` | Standard form | T | Order of magnitude, unit conversion, error bounds |
| `maths.sequences` | Sequences and series | E | Arithmetic vs geometric, nth term, Σ notation |
| `maths.binomial-theorem` | Binomial expansion | E | Coefficients, specific terms, applications |
| `maths.complex-numbers` | Complex numbers | E | Argand plane, modulus, argument, powers |
| `maths.vectors-3d` | 3D vectors | T | Components, dot and cross products, projections |
| `maths.equations-of-motion` | SUVAT equations | T | Choosing the right equation; symbolic verification |
| `maths.trig-solver` | Trigonometric equations | E | General solutions, domain restrictions, ambiguity |
| `maths.radians-degrees` | Radians and degrees | E | Exact vs approximate, arc length, sector area |
| `maths.graph-sketching-lab` | Graph sketching lab | R | Sketch from an algebraic description; rubric on the sketch |
| `maths.conic-sections` | Conic sections | E | Eccentricity, focus/directrix, standard forms |
| `maths.polar-coordinates` | Polar coordinates | E | Conversion, rose and cardioid curves, area |
| `maths.recursion-iteration` | Recursion and iteration | E | Bases, recursive ≡ iterative, trees |
| `maths.graph-theory` | Graphs and networks | SE | Degree, connectivity, Euler/Hamilton, colourings |
| `maths.logic-propositions` | Logic and propositions | E | Truth tables, De Morgan, inference |
| `maths.proof-techniques` | Proof techniques | R | Construct and critique a proof; rubric |
| `maths.measurement-error` | Measurement and error bounds | T | Absolute vs relative error, significant figures |
| `maths.modular-arithmetic` | Modular arithmetic | E | Congruence, clocks, cryptography basics |
| `maths.growth-decay` | Exponential growth and decay | T | Modelling, half-life, differential intuition |
| `maths.optimisation` | Optimisation | T | Critical points, endpoints, real-world reading |
| `maths.area-perimeter-challenge` | Area and perimeter challenge | T | Composite shapes, rearrangements, missing-side puzzles |
| `maths.coordinate-transformations` | Coordinate transformations | E | Rotations, reflections, glide reflections, tessellations |

## Physics (38)

| id | Title | G | Focus |
|---|---|---|---|
| `physics.free-body-diagram` | Free-body diagrams | R | Vector decomposition; rubric on reasoning, not the number |
| `physics.pendulum` | Simple pendulum | T | Period, amplitude independence, decay with drag |
| `physics.wave-interference` | Two-source interference | T | Path difference, fringes |
| `physics.optics-ray-tracing` | Ray tracing | E | Image formation, focal length, TIR |
| `physics.circuit-dc` | DC circuits | T | Kirchhoff, series/parallel, power |
| `physics.circuit-ac` | AC circuits | T | RMS, phase, RLC resonance |
| `physics.projectile-launch-lab` | Launch lab | T | Angle optimisation under a ranging constraint |
| `physics.newtons-laws` | Newton's laws | T | F=ma intuition, mass vs weight, net force |
| `physics.friction` | Friction | T | Static vs kinetic, coefficients, inclines |
| `physics.energy-conservation` | Energy tracks | T | Kinetic/potential transfer, dissipation |
| `physics.momentum-collisions` | Collisions | T | Elastic vs inelastic, momentum accounting |
| `physics.centre-of-mass` | Centre of mass | T | Composite bodies, tipping, stability |
| `physics.circular-motion` | Circular motion | T | Centripetal force, banking, conical pendulum |
| `physics.gravity-orbits` | Orbits and gravity | T | Inverse square, orbital speed/period, escape velocity |
| `physics.kepler-laws` | Kepler's laws | E | Ellipse geometry, third law numerically |
| `physics.rocket-equation` | Rocket equation | T | Tsiolkovsky, mass ratio, staging intuition |
| `physics.drag-and-lift` | Drag and lift | T | Quadratic vs linear drag, terminal velocity |
| `physics.pressure-fluids` | Pressure and fluids | T | Pascal, Archimedes, floating, pressure variation |
| `physics.thermal-transfer` | Heat transfer | T | Conduction, convection, radiation, equilibrium |
| `physics.gas-laws` | Ideal gas laws | T | PV=nRT, microscopic model, isotherms |
| `physics.kinetic-theory` | Kinetic theory | T | Temperature as mean KE, speed distributions |
| `physics.shm` | Simple harmonic motion | T | Amplitude, period, energy, damping |
| `physics.waves-on-a-string` | Waves on a string | T | Superposition, standing waves, harmonics |
| `physics.sound-doppler` | Sound and the Doppler effect | T | Frequency shift, Mach cone |
| `physics.electrostatics` | Electrostatics and fields | T | Field lines, potential, charge accumulation |
| `physics.circuit-construction-lab` | Circuit construction lab | T | Build, measure, predict; graded on prediction error |
| `physics.em-induction` | Electromagnetic induction | T | Faraday, Lenz, generators, transformers |
| `physics.magnetic-fields` | Magnetic fields | T | Field patterns, force on a current, motor effect |
| `physics.optics-lenses` | Lenses and imaging | T | Thin-lens equation, magnification, ray diagrams |
| `physics.polarisation` | Polarisation | E | Malus's law; why polarised sunglasses help |
| `modern-photons` | Photons and the photoelectric effect | T | Quantisation, work function, threshold frequency |
| `physics.atomic-models` | Atomic models | E | Rutherford scattering, energy levels, spectra |
| `physics.nuclear-decay` | Radioactive decay | T | Half-life, activity, chains, dating |
| `physics.particle-collisions-2d` | Collisions in 2D | T | Momentum conservation as a constraint solver |
| `physics.doppler-radar` | Radar and Doppler | T | Speed from frequency shift; applied measurement |
| `physics.rocket-staging` | Multi-stage rockets | T | Optimisation under mass and delta-v constraints |
| `physics.rolling-friction` | Rolling and slipping | T | Static friction in rolling, moments of inertia |
| `physics.phase-transitions` | Phase transitions | T | Critical point, superheating, real anomalies |

## Chemistry (28)

| id | Title | G | Focus |
|---|---|---|---|
| `chemistry.particle-view` | Particle view of matter | E | States, diffusion, arrangement |
| `chemistry.stoichiometry-balance` | Balancing equations | SE | Conservation of atoms; unlimited partial credit |
| `chemistry.titration-curve` | Titration curves | T | Equivalence point, indicators, strong vs weak |
| `chemistry.reaction-rate` | Reaction rates | T | Concentration/temperature, collision theory |
| `chemistry.equilibrium` | Dynamic equilibrium | T | Le Chatelier, K, industrial conditions |
| `chemistry.mole-conversions` | The mole | T | Conversion chains, limiting reagent |
| `chemistry.gas-laws-applied` | Gas laws applied | T | Combined gas law, molar volume, mixtures |
| `chemistry.solution-concentration` | Solutions and concentration | T | Molarity, dilution, ppm, serial dilution |
| `chemistry.ph-scale` | pH and indicators | T | Log-scale intuition, strong vs weak, buffers |
| `chemistry.buffers` | Buffer solutions | T | Henderson–Hasselbalch, capacity, preparation |
| `chemistry.precipitation` | Precipitation reactions | E | Solubility rules, net ionic equations |
| `chemistry.redox-balancing` | Redox balancing | E | Oxidation numbers, half-reactions, disproportionation |
| `chemistry.electrochemistry` | Electrochemistry | T | Electrolysis, Faraday's law, cell potentials |
| `chemistry.acid-base-strength` | Comparing acid strength | T | Ka/pKa, conjugate pairs, structural reasoning |
| `chemistry.organic-structures` | Organic structures | E | Naming, functional groups, isomer counting |
| `chemistry.polymer-build` | Polymers | E | Monomer chains, addition vs condensation |
| `chemistry.orbital-shapes` | Atomic orbitals | E | s/p/d shapes, nodes, capacity |
| `chemistry.periodic-trends` | Periodic trends | T | Electronegativity, ionisation energy, radius + exceptions |
| `chemistry.bonding-models` | Bonding models | E | Ionic / covalent / metallic, dot-and-cross |
| `chemistry.structure-determination` | Structure determination | SE | Deduce structure from IR/NMR/mass data |
| `chemistry.thermochemistry` | Thermochemistry | T | Hess's law, enthalpy, calorimetry |
| `chemistry.entropy` | Entropy and spontaneity | E | Disorder, ΔG, direction of change |
| `chemistry.kinetics-vs-equilibrium` | Kinetics vs equilibrium | T | The distinction students most often conflate |
| `chemistry.electrolysis-lab` | Electrolysis lab | T | Products, moles of electrons, Faraday |
| `chemistry.qualitative-analysis` | Qualitative analysis | SE | Tests, precipitates, flame colours, deduction chains |
| `chemistry.crystal-structures` | Crystal structures | E | Unit cells, packing, density from dimensions |
| `chemistry.green-chemistry` | Green chemistry metrics | R | Atom economy, E-factor, energy; rubric on trade-offs |
| `chemistry.food-chemistry` | Food chemistry | T | Maillard, caramelisation, protein denaturation |

## Biology (28)

| id | Title | G | Focus |
|---|---|---|---|
| `biology.cell-division` | Mitosis and meiosis | SE | Stage identification, chromosome behaviour, ploidy |
| `biology.genetics-punnett` | Punnett squares | E | Monohybrid, dihybrid, codominance, probability |
| `biology.ecosystem-flow` | Ecosystem energy and matter flow | R | Trophic transfers, cycles, disruption cascades |
| `biology.cell-membrane` | Membrane transport | E | Diffusion, osmosis, active transport, ATP cost |
| `biology.enzyme-kinetics` | Enzyme kinetics | T | Substrate concentration, inhibition, temperature, pH |
| `biology.photosynthesis` | Photosynthesis | T | Light vs limiting factors, ATP/NADPH, compensation points |
| `biology.respiration` | Cellular respiration | T | Glycolysis → Krebs → ETC, aerobic vs anaerobic |
| `biology.population-dynamics` | Population dynamics | T | Exponential vs logistic, carrying capacity, harvesting |
| `biology.natural-selection` | Natural selection | R | Variation, selection, drift, speciation; rubric on reasoning |
| `biology.evolution-trees` | Phylogenetic trees | E | Cladistics, shared derived characters, reading trees |
| `biology.human-circulation` | Circulatory system | T | Pressure, heart rate, vessel radius, exercise response |
| `biology.breathing` | Gas exchange and breathing | T | Lung volumes, pressure changes, partial pressures |
| `biology.action-potential` | Action potentials | T | Threshold, refractory period, conduction, synapses |
| `biology.kidney-filter` | Kidney filtration | T | Glomerular filtration, reabsorption, concentration |
| `biology.digestion` | Digestion and absorption | T | Enzymes, villi, products, energy from food |
| `biology.plant-transport` | Plant transport | T | Transpiration, cohesion-tension, phloem loading |
| `biology.photosynthesis-limits` | Limiting factors | T | The classic three-limiting-factors experiment |
| `biology.immunology` | Immune response | SE | Innate vs adaptive, clonal selection, memory cells |
| `biology.microbiology` | Bacterial growth | T | Exponential growth, stationary phase, serial dilution |
| `biology.classification` | Classification | E | Taxonomy hierarchy, binomial nomenclature, keys |
| `biology.ecology-sampling` | Ecological sampling | T | Quadrats, transects, mark-recapture, error bars |
| `biology.inheritance-linkage` | Linkage and sex linkage | E | Recombination, gene maps, crosses |
| `biology.molecular-dna` | DNA structure and replication | E | Base pairing, semiconservative replication, mutations |
| `biology.gene-expression` | Gene expression | E | Transcription, translation, regulation, mutations |
| `biology.homeostasis` | Homeostasis | T | Negative feedback, set points, disruption |
| `biology.biomes` | Biomes and distribution | E | Climate graphs → biome identification |
| `biology.organ-systems` | Organ systems | E | Systems mapping, function matching, interactions |
| `biology.succession` | Ecological succession | SE | Primary vs secondary, climax community, timelines |

## Earth & Environment (14)

| id | Title | G | Focus |
|---|---|---|---|
| `earth.water-cycle` | The water cycle | E | Fluxes, reservoirs, residence times |
| `earth.carbon-cycle` | The carbon cycle | R | Fast vs slow cycles; human perturbation |
| `earth.nitrogen-cycle` | The nitrogen cycle | E | Fixation, nitrification, denitrification |
| `earth.rock-cycle` | The rock cycle | E | Igneous/sedimentary/metamorphic pathways, timescale |
| `earth.plate-tectonics` | Plate tectonics | E | Boundary types, seafloor spreading, subduction |
| `earth.earthquake-waves` | Seismic waves | T | P and S waves, travel time, locating an epicentre |
| `earth.weather-fronts` | Weather fronts | E | Isobars, fronts, pressure systems, forecasting |
| `earth.climate-zones` | Climate zones | E | Latitude, insolation, Köppen classification |
| `earth.ocean-circulation` | Ocean circulation | T | Thermohaline, upwelling, heat transport |
| `earth.soil-profile` | Soil profiles | E | Horizons, formation rates, drainage and texture |
| `earth.atmosphere-layers` | Atmospheric structure | E | Layers, temperature profile, the ozone layer |
| `earth.energy-balance` | Planetary energy balance | T | Albedo, absorbed vs emitted, equilibrium temperature |
| `earth.glaciers` | Glaciers and mass balance | T | Accumulation vs ablation, sea-level contribution |
| `earth.hazards` | Natural hazards | R | Hazard × exposure × vulnerability; rubric on mitigation |

## Astronomy & Space (12)

| id | Title | G | Focus |
|---|---|---|---|
| `astronomy.orrery` | Solar system orrery | T | Relative periods and distances; scale realisation |
| `astronomy.orbital-mechanics` | Orbital mechanics | T | Vis-viva, transfer orbits, escape velocity |
| `astronomy.stellar-evolution` | Stellar evolution | E | HR diagram, fusion stages, lifetimes |
| `astronomy.light-distance` | Light, distance and parallax | T | Parallax distance, redshift, magnitude |
| `astronomy.black-holes` | Black holes | T | Schwarzschild radius, tidal effects, accretion |
| `astronomy.exoplanets` | Exoplanet detection | T | Transit depth, radial velocity, both methods |
| `astronomy.lunar-phases` | Lunar phases and eclipses | E | Geometry of phases, eclipse conditions, node angles |
| `astronomy.tides` | Tides | T | Spring/neap tides, resonance, basin shape |
| `astronomy.moon-craters` | Crater counting | T | Counting → relative age; cratering rate |
| `astronomy.solar-activity` | Solar activity | T | Sunspot cycle, prominences, solar wind |
| `astronomy.coordinates` | Constellations and coordinates | E | RA/Dec, celestial sphere, finding by hand |
| `astronomy.signal-in-noise` | Signal detection in noise | T | SNR, false positives, why SETI is hard |

## Computing (16)

| id | Title | G | Focus |
|---|---|---|---|
| `computing.sorting-visualiser` | Sorting visualiser | E | Comparison/swap counts, stability, complexity classes |
| `computing.search-algorithms` | Searching | E | Linear vs binary, worst case, big-O reasoning |
| `computing.linked-structures` | Linked structures | R | Pointer manipulation; rubric on correctness |
| `computing.binary-trees` | Trees and traversal | E | BST invariants, in/pre/post-order, recursion |
| `computing.graph-algorithms` | Graph algorithms | E | BFS/DFS, Dijkstra, topological order |
| `computing.hash-tables` | Hash tables | E | Collisions, load factor, probing strategies |
| `computing.big-o-lab` | Complexity lab | E | Predicting growth empirically, then proving it |
| `computing.automata` | Finite automata | E | DFA construction, NFA→DFA, state equivalence |
| `computing.regex-builder` | Regular expressions | E | Matching, capturing, greediness |
| `computing.stack-machine` | Stack machine | E | Postfix evaluation, VM tracing |
| `computing.quantum-circuits` | Quantum circuits | E | Gate composition, measurement outcomes, superposition |
| `computing.neural-network` | A small neural network | T | Weights, learning by hand, overfitting |
| `computing.data-compression` | Lossy compression | T | Compression ratio vs quality, bitrate budgeting |
| `computing.packet-routing` | Packet routing | E | Route tables, hops, congestion, latency |
| `computing.error-detection` | Error detection | E | Parity, Hamming codes, checksums |
| `computing.state-machines` | State machines | R | Design a controller; rubric on completeness |

## Technology & Engineering (15)

| id | Title | G | Focus |
|---|---|---|---|
| `tech.bridge-truss` | Truss design | T | Stress, member forces, load paths, factor of safety |
| `tech.lever-lab` | Levers and moments | T | Moment balance, mechanical advantage, effort curves |
| `tech.gear-train` | Gear trains | T | Ratios, torque multiplication, direction, backlash |
| `tech.materials-selection` | Materials selection | R | Ashby-style charts; rubric on justifying a choice |
| `tech.heat-exchanger` | Heat exchangers | T | LMTD, effectiveness, counter vs parallel flow |
| `tech.fluid-network` | Pipe networks | T | Pressure drop, series/parallel, pump curves |
| `tech.electrical-wiring` | Wiring a circuit | E | Series/parallel construction, earthing, safety |
| `tech.solar-array` | Solar array design | T | Irradiance, tilt, shading losses, payback framing |
| `tech.wind-turbine` | Wind turbine | T | Power curve, cut-in/rated/cut-out, capacity factor |
| `tech.battery-management` | Battery management | T | C-rating, state of charge, thermal limits |
| `tech.additive-manufacturing` | Additive manufacturing | R | Layer slicing, supports, infill; rubric on printability |
| `tech.cad-assembly` | CAD assembly | E | Constraint satisfaction, interference, BOM |
| `tech.control-loop` | Control loops | T | P/I/D tuning, steady-state error, oscillation |
| `tech.safety-risk-matrix` | Risk assessment | R | Likelihood × severity, mitigation; rubric |
| `tech.lifecycle-assessment` | Product lifecycle | R | Embodied energy, end-of-life; rubric on trade-offs |

## Cross-curricular & Professional Skills (24)

| id | Title | G | Focus |
|---|---|---|---|
| `general.data-literacy` | Reading a graph | E | Axis honesty, scale, misleading charts |
| `general.spreadsheet-modelling` | Spreadsheet modelling | R | Build a model; rubric on structure and assumptions |
| `general.uncertainty` | Measurement uncertainty | T | Propagation, significant figures, worst case vs RSS |
| `general.experimental-design` | Experimental design | R | Controls, variables, repeated trials; rubric |
| `general.scientific-writing` | Writing a lab report | R | Structure, claim/evidence/reasoning; banded rubric |
| `general.critical-thinking` | Evaluating a claim | R | Evidence quality, bias, fallacies; rubric |
| `general.estimation` | Fermi estimation | T | Order-of-magnitude reasoning |
| `general.dimensional-analysis` | Dimensional analysis | E | Unit algebra as a check on a formula |
| `general.scale-similarity` | Scale and similarity | T | Scaling laws, model/prototype reasoning |
| `general.chess-endgames` | Chess endgames | E | Mate-in-N search, evaluation, tablebases |
| `general.bridge-building` | Bridge building | T | Structural efficiency under a budget |
| `general.nutrition-log` | Nutrition and energy balance | T | Energy accounting, interpreting food labels |
| `general.sleep-circadian` | Sleep and circadian rhythm | T | Modelling a 24 h rhythm, phase shift |
| `general.personal-finance` | Personal finance | T | Compound interest, amortisation, comparing loans |
| `general.map-and-scale` | Maps and scale | E | Grid references, scale bars, projections, distortion |
| `general.argument-mapping` | Argument mapping | E | Premises, warrants, fallacies, rebuttals |
| `general.interview-skills` | Structured interviewing | R | Question design, probing, bias; rubric on transcripts |
| `general.safety-procedure` | Following a procedure | R | Ordered steps, hazard checks, deviation reporting |
| `general.simulation-literacy` | Reading a simulation | R | What a model assumes and omits; rubric |
| `general.numerical-methods` | Numerical methods | T | Iteration, convergence, error estimation |
| `general.trend-analysis` | Trend analysis | T | Seasonality, smoothing, spurious correlation |
| `general.units-conversion` | Units and conversion | T | Dimensional fluency, error propagation |
| `general.academic-integrity` | Citing and attribution | E | Source evaluation, referencing, avoiding plagiarism |
| `general.exam-technique` | Exam technique | E | Timing, question triage, checking — a graded, low-stakes drill |

---

## Coverage checks (CI-verifiable)

| Check | Target |
|---|---|
| Total registered | **≥ 200** (220 planned) |
| Per target subject | ≥ 12 |
| Per grading strategy | ≥ 12 (so grader edge cases surface in real content) |
| Keyboard accessible | 100% |
| Text alternative for visual output | 100% |
| `reducedMotion` support | 100% |
| Declared `stateSchema` | ≥ 60% |
| Auto-gradable | ≥ 70% |
| Full spec card + licence + provenance | 100% |
| Passing the conformance matrix | 100% |
| Auto-captured catalogue screenshot | 100% |

A registry failing any of these does not ship.

## Build order after the 24 gold sims

Priority within each batch: (1) subjects with the thinnest coverage, (2) highest-frequency curriculum topics, (3) those exercising an untested grading strategy or protocol corner. Every batch ends with a conformance run, a review pass and a catalogue update — never a batch that lands without the machine gate.
