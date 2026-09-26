# Simulation Catalogue Plan (220)

The coverage plan for P12. Each row is a **spec card stub**: the author fills in the full card (`03-SIMULATIONS.md` §7) before writing code. `G` = auto-gradable strategy, `M` = manual/rubric.

Coverage is deliberate: every subject gets foundational, intermediate and advanced sims, and every grading strategy is exercised at least a dozen times so the grader's edge cases surface in content, not just in fixtures.

---

## Mathematics (45)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `maths.projectile-motion` | Projectile motion | TOLERANCE | Range/height vs speed and angle; quadratic reasoning |
| `maths.quadratic-roots` | Quadratic roots and graphs | EXACT | Discriminant, sign of roots, completing the square |
| `maths.function-transform` | Function transformations | EXACT | Translate, reflect, scale a function and read the effect |
| `maths.derivative-tangent` | Derivatives as tangent lines | TOLERANCE | Secant → tangent; rate of change intuition |
| `maths.statistics-explorer` | Statistics explorer | TOLERANCE | Mean/median/mode, spread, outliers, box plots |
| `maths.trigonometry-unit-circle` | The unit circle | EXACT | Radians, degrees, exact values, quadrants |
| `maths.coordinate-geometry` | Coordinate geometry | EXACT | Slopes, intersections, reflections, constructions |
| `maths.monte-carlo-pi` | Monte Carlo π | TOLERANCE | Convergence, sampling error, why approximations work |
| `maths.matrix-transformations` | 2D linear transformations | EXACT | Matrices as maps; determinants as area scale |
| `maths.probability-tree` | Probability trees | SET | Branching probabilities, independence, conditional paths |
| `maths.set-venn` | Venn and set operations | SET | Union, intersection, complements; counting overlaps |
| `maths.series-convergence` | Series convergence | TOLERANCE | Partial sums, comparison tests, divergence |
| `maths.integral-area` | Integral as accumulated area | TOLERANCE | Riemann sums → integral; signed area |
| `maths.limit-explorer` | Limits and continuity | EXACT | One-sided limits, holes vs jumps, removable discontinuities |
| `maths.derivative-rules` | Derivative rules drill | EXACT | Product, quotient, chain; power rule fluency |
| `maths.equation-solver` | Equation solver | EXACT | Linear, quadratic, simultaneous; extraneous roots |
| `maths.simplify-expressions` | Expression simplifier | EXACT | Order of operations, collecting like terms, factoring |
| `maths.ratio-proportion` | Ratios and proportion | NUMERIC | Scale recipes, maps, direct/inverse proportion |
| `maths.percentages` | Percentages in context | NUMERIC | Percent change, increase/decrease, compound |
| `maths.fractions-decimals` | Fractions and decimals | EXACT | Place value, ordering, operations, recurring decimals |
| `maths.number-line-labs` | Number line laboratory | EXACT | Ordering, absolute value, intervals, inequalities |
| `maths.prime-factorisation` | Prime factorisation | EXACT | Divisibility, LCM/HCF, prime decomposition |
| `maths.indices-laws` | Index laws | EXACT | Negative and fractional indices, index equations |
| `maths.standard-form` | Standard form | NUMERIC | Order of magnitude, unit conversion, error bounds |
| `maths.sequences` | Sequences and series | EXACT | Arithmetic vs geometric, nth term, summation notation |
| `maths.binomial-theorem` | Binomial expansion | EXACT | Coefficients, specific terms, applications |
| `maths.complex-numbers` | Complex numbers | EXACT | Argand plane, modulus, argument, powers |
| `maths.vectors-3d` | 3D vectors | TOLERANCE | Components, dot and cross products, projections |
| `maths.equations-of-motion` | SUVAT equations | TOLERANCE | Choosing the right equation; symbolic verification |
| `maths.trig-solver` | Trigonometric equations | EXACT | General solutions, domain restrictions, ambiguity |
| `maths.radians-degrees` | Radians and degrees | EXACT | Exact vs approximate, arc length, sector area |
| `maths.graph-transformations-lab` | Graph sketching lab | M | Sketching from algebraic description; rubric on the sketch |
| `maths.conic-sections` | Conic sections | EXACT | Eccentricity, focus/directrix, standard forms |
| `maths.polar-coordinates` | Polar coordinates | EXACT | Conversion, rose and cardioid curves, area |
| `maths.recursion-and-iteration` | Recursion and iteration | EXACT | Bases, recursive vs iterative equivalence, trees |
| `maths.graph-theory` | Graphs and networks | SET | Degree, connectivity, Euler/Hamilton paths, colourings |
| `maths.logic-propositions` | Logic and propositions | EXACT | Truth tables, De Morgan, inference |
| `maths.proof-techniques` | Proof techniques | M | Students construct and critique a proof; rubric |
| `maths.measurement-error` | Measurement and error bounds | NUMERIC | Absolute vs relative error, significant figures |
| `maths.modular-arithmetic` | Modular arithmetic | EXACT | Congruence, clocks, cryptography basics |
| `maths.growth-decay` | Exponential growth and decay | TOLERANCE | Modelling, half-life, differential intuition |
| `maths.optimisation` | Optimisation | TOLERANCE | Critical points, endpoints, real-world interpretation |
| `maths.area-perimeter-challenge` | Area and perimeter challenge | TOLERANCE | Composite shapes, rearrangements, missing-side puzzles |
| `maths.coordinate-transformations` | Coordinate transformations | EXACT | Rotations, reflections, glide reflections; tessellations |

## Physics (38)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `physics.free-body-diagram` | Free-body diagrams | RUBRIC | Vector decomposition; rubric on reasoning, not just the number |
| `physics.pendulum` | Simple pendulum | TOLERANCE | Period, amplitude dependence, energy decay with drag |
| `physics.wave-interference` | Two-source interference | TOLERANCE | Path difference, constructive/destructive, fringe spacing |
| `physics.optics-ray-tracing` | Ray tracing | EXACT | Image formation, focal length, total internal reflection |
| `physics.circuit-dc` | DC circuits | NUMERIC | Kirchhoff, series/parallel, power dissipation |
| `physics.circuit-ac` | AC circuits | NUMERIC | RMS, phase, resonance in RLC |
| `physics.projectile-launch-lab` | Launch lab | TOLERANCE | Angle optimisation under constraints (ranging a target) |
| `physics.newtons-laws` | Newton's laws | TOLERANCE | F=ma intuition, mass vs weight, net force |
| `physics.friction` | Friction | TOLERANCE | Static vs kinetic, coefficient effects, inclines |
| `physics.energy-conservation` | Energy tracks | TOLERANCE | Kinetic/potential transfer, dissipated energy |
| `physics.momentum-collisions` | Collisions | TOLERANCE | Elastic vs inelastic, momentum and energy accounting |
| `physics.centre-of-mass` | Centre of mass | TOLERANCE | Composite bodies, tipping, stability |
| `physics.circular-motion` | Circular motion | TOLERANCE | Centripetal force, banking, conical pendulum |
| `physics.gravity-orbits` | Orbits and gravity | TOLERANCE | Inverse square law, orbital speed/period, escape velocity |
| `physics.kepler-laws` | Kepler's laws | EXACT | Ellipse geometry, third law numerically |
| `physics.rocket-equation` | Rocket equation | TOLERANCE | Tsiolkovsky, mass ratio, staging intuition |
| `physics.projectile-fluid-lift` | Drag and lift | TOLERANCE | Quadratic vs linear drag, terminal velocity, lift coefficient |
| `physics.pressure-fluids` | Pressure and fluids | NUMERIC | Pascal, Archimedes, floating, pressure variation |
| `physics.thermal-conduction` | Heat transfer | TOLERANCE | Conduction, convection, radiation, equilibrium |
| `physics.gas-laws` | Ideal gas laws | TOLERANCE | PV=nRT, microscopic model, isotherms |
| `physics.kinetic-theory` | Kinetic theory | TOLERANCE | Temperature as mean kinetic energy, speed distributions |
| `physics.shm` | Simple harmonic motion | TOLERANCE | Amplitude, period, energy, damping |
| `physics.waves-on-a-string` | Waves on a string | TOLERANCE | Superposition, reflection, standing waves, harmonics |
| `physics.sound-doppler` | Sound and the Doppler effect | TOLERANCE | Frequency shift, Mach cone, moving sources |
| `physics.lightning` | Electrostatics and fields | TOLERANCE | Field lines, potential, charge accumulation |
| `physics.circuits-ac-dc-lab` | Circuit construction lab | TOLERANCE | Build, measure, predict; grading on prediction error |
| `physics.electromagnetic-induction` | Electromagnetic induction | TOLERANCE | Faraday, Lenz's law, generators, transformers |
| `physics.magnetic-fields` | Magnetic fields | TOLERANCE | Field patterns, force on a current, motor effect |
| `physics.optics-lenses` | Lenses and imaging | NUMERIC | Thin-lens equation, magnification, ray diagrams |
| `physics.polarisation` | Polarisation | EXACT | Malus's law, why polarised sunglasses help |
| `physics.modern-photons` | Photons and the photoelectric effect | TOLERANCE | Quantisation, work function, threshold frequency |
| `physics.atomic-models` | Atomic models | EXACT | Rutherford scattering, energy levels, emission spectra |
| `physics.nuclear-decay` | Radioactive decay | TOLERANCE | Half-life, activity, decay chains, dating |
| `physics.particle-collisions` | Collisions in 2D | TOLERANCE | Momentum conservation as a constraint solver |
| `physics.doppler-radar` | Radar and Doppler | TOLERANCE | Speed from frequency shift; applied measurement |
| `physics.rocket-staging` | Multi-stage rockets | TOLERANCE | Optimisation under mass and delta-v constraints |
| `physics.rolling-friction` | Rolling and slipping | TOLERANCE | Static friction in rolling, moments of inertia |
| `physics.supercritical` | Phase transitions | TOLERANCE | Critical point, superheating, real anomalies |

## Chemistry (28)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `chemistry.particle-view` | Particle view of matter | EXACT | States, diffusion, particle arrangement |
| `chemistry.stoichiometry-balance` | Balancing equations | SET | Conservation of atoms; unlimited partial credit |
| `chemistry.titration-curve` | Titration curves | TOLERANCE | Equivalence point, indicators, strong vs weak |
| `chemistry.reaction-rate` | Reaction rates | TOLERANCE | Concentration/temperature effects, collision theory |
| `chemistry.equilibrium` | Dynamic equilibrium | TOLERANCE | Le Chatelier, equilibrium constant, industrial conditions |
| `chemistry.mole-conversions` | The mole | TOLERANCE | Stoichiometric conversion chains, limiting reagent |
| `chemistry.gas-laws-applied` | Gas laws applied | TOLERANCE | Combined gas law, molar volume, mixtures |
| `chemistry.solution-concentration` | Solutions and concentration | NUMERIC | Molarity, dilution, ppm, serial dilution |
| `chemistry.pH-scale` | pH and indicators | NUMERIC | Log scale intuition, strong vs weak acids, buffers |
| `chemistry.buffers` | Buffer solutions | TOLERANCE | Henderson–Hasselbalch, capacity, preparation |
| `chemistry.precipitation` | Precipitation reactions | EXACT | Solubility rules, net ionic equations, limiting reagent |
| `chemistry.redox-balancing` | Redox balancing | EXACT | Oxidation numbers, half-reactions, disproportionation |
| `chemistry.electrochemistry` | Electrochemistry | TOLERANCE | Electrolysis, Faraday's law, cell potentials |
| `chemistry.acid-base-strength` | Comparing acid strength | TOLERANCE | Ka/pKa, conjugate pairs, structural reasoning |
| `chemistry.organic-structures` | Organic structures | EXACT | Naming, functional groups, isomer counting |
| `chemistry.polymer-build` | Polymers | EXACT | Monomer chains, addition vs condensation |
| `chemistry.orbital-shapes` | Atomic orbitals | EXACT | s/p/d shapes, nodes, electron capacity |
| `chemistry.periodic-trends` | Periodic trends | TOLERANCE | Electronegativity, ionisation energy, radius, with exceptions |
| `chemistry.bonding-models` | Bonding models | EXACT | Ionic vs covalent vs metallic, dot-and-cross |
| `chemistry.structure-determination` | Structure determination | SET | Deduce a structure from IR/NMR/mass data |
| `chemistry.thermochemistry` | Thermochemistry | TOLERANCE | Hess's law, enthalpy, calorimetry |
| `chemistry.entropy` | Entropy and spontaneity | EXACT | Disorder, ΔG, direction of change |
| `chemistry.rates-equilibrium` | Kinetics vs equilibrium | TOLERANCE | The distinction students most often conflate |
| `chemistry.electrolysis-lab` | Electrolysis lab | TOLERANCE | Products, moles of electrons, Faraday |
| `chemistry.qualitative-analysis` | Qualitative analysis | SET | Tests, precipitates, flame colours, deduction chains |
| `chemistry.crystal-structures` | Crystal structures | EXACT | Unit cells, packing, density from dimensions |
| `chemistry.green-chemistry` | Green chemistry metrics | M | Atom economy, E-factor, energy; rubric on trade-offs |
| `chemistry.food-chemistry` | Food chemistry | TOLERANCE | Maillard reaction, caramelisation, protein denaturation |

## Biology (28)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `biology.cell-division` | Mitosis and meiosis | SET | Stage identification, chromosome behaviour, ploidy |
| `biology.genetics-punnett` | Punnett squares | EXACT | Monohybrid, dihybrid, codominance, probability |
| `biology.ecosystem-flow` | Ecosystem energy and matter flow | RUBRIC | Trophic transfers, cycles, disruption cascades |
| `biology.cell-membrane` | Membrane transport | EXACT | Diffusion, osmosis, active transport, ATP cost |
| `biology.enzyme-kinetics` | Enzyme kinetics | TOLERANCE | Substrate concentration, inhibition, temperature, pH |
| `biology.photosynthesis` | Photosynthesis | TOLERANCE | Light vs limiting factors, ATP/NADPH, compensation points |
| `biology.respiration` | Cellular respiration | TOLERANCE | Glycolysis → Krebs → ETC, ATP yield, aerobic vs anaerobic |
| `biology.population-dynamics` | Population dynamics | TOLERANCE | Exponential vs logistic, carrying capacity, harvesting |
| `biology.natural-selection` | Natural selection | RUBRIC | Variation, selection, drift, speciation; rubric on reasoning |
| `biology.evolution-trees` | Phylogenetic trees | EXACT | Cladistics, shared derived characters, reading trees |
| `biology.human-circulation` | Circulatory system | TOLERANCE | Pressure, heart rate, vessel radius, exercise response |
| `biology.breathing` | Gas exchange and breathing | TOLERANCE | Lung volumes, pressure changes, partial pressures |
| `biology.neurone-action-potential` | Action potentials | TOLERANCE | Threshold, refractory period, conduction, synapses |
| `biology.kidney-filter` | Kidney filtration | NUMERIC |Glomerular filtration, reabsorption, concentration gradients |
| `biology.digestion` | Digestion and absorption | TOLERANCE | Enzymes, villi, products, energy from food |
| `biology.plant-transport` | Plant transport | TOLERANCE | Transpiration, cohesion-tension, phloem loading |
| `biology.plant-photosynthesis-limits` | Limiting factors | TOLERANCE | Classic "three limiting factors" experiment |
| `biology.immunology` | Immune response | SET | Innate vs adaptive, clonal selection, memory cells |
| `biology.microbiology` | Bacterial growth | TOLERANCE | Exponential growth, stationary phase, contamination, serial dilution |
| `biology.classification` | Classification | EXACT | Taxonomy hierarchy, binomial nomenclature, dichotomous keys |
| `biology.ecology-sampling` | Ecological sampling | NUMERIC | Quadrats, transects, mark-recapture, error bars |
| `biology.inheritance-linkage` | Linkage and sex linkage | EXACT | Recombination, gene maps, crosses |
| `biology.molecular-dna` | DNA structure and replication | EXACT | Base pairing, semiconservative replication, mutations |
| `biology.gene-expression` | Gene expression | EXACT | Transcription, translation, regulation, mutations |
| `biology.homoeostasis` | Homeostasis | TOLERANCE | Negative feedback loops, set points, disruption |
| `biology.biomes` | Biomes and distribution | EXACT | Climate graphs → biome identification |
| `biology.human-body-organs` | Organ systems | EXACT | Systems mapping, function matching, interactions |
| `biology.ecological-succession` | Succession | SET | Primary vs secondary, climax community, timelines |

## Earth & Environment (14)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `earth.water-cycle` | The water cycle | EXACT | Fluxes, reservoirs, residence times |
| `earth.carbon-cycle` | The carbon cycle | RUBRIC | Fast vs slow cycles; human perturbation |
| `earth.nitrogen-cycle` | The nitrogen cycle | EXACT | Fixation, nitrification, denitrification |
| `earth.rock-cycle` | The rock cycle | EXACT | Igneous/sedimentary/metamorphic pathways, timescale |
| `earth.plate-tectonics` | Plate tectonics | EXACT | Boundary types, seafloor spreading, subduction |
| `earth.earthquake-waves` | Seismic waves | TOLERANCE | P and S waves, travel time, locating an epicentre |
| `earth.weather-fronts` | Weather fronts | EXACT | Isobars, fronts, pressure systems, forecasting |
| `earth.climate-zones` | Climate zones | EXACT | Latitude, insolation, Köppen classification |
| `earth.ocean-circulation` | Ocean circulation | TOLERANCE | Thermohaline circulation, upwelling, heat transport |
| `earth.soil-profile` | Soil profiles | EXACT | Horizons, formation rates, drainage and texture |
| `earth.atmosphere-layers` | Atmospheric structure | EXACT | Layers, temperature profile, why the ozone layer matters |
| `earth.energy-balance` | Planetary energy balance | TOLERANCE | Albedo, absorbed vs emitted, equilibrium temperature |
| `earth.glaciers` | Glaciers and mass balance | TOLERANCE | Accumulation vs ablation, sea-level contribution |
| `earth.hazards` | Natural hazards | M | Hazard × exposure × vulnerability; rubric on mitigation |

## Astronomy & Space (12)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `astronomy.orrery` | Solar system orrery | TOLERANCE | Relative periods and distances; scale realisation |
| `astronomy.kepler-orbits` | Orbital mechanics | TOLERANCE | Vis-viva, transfer orbits, escape velocity |
| `astronomy.stellar-evolution` | Stellar evolution | EXACT | HR diagram, fusion stages, lifetimes |
| `astronomy.light-distance` | Light, distance and parallax | NUMERIC | Parallax distance, redshift, magnitude |
| `astronomy.black-holes` | Black holes | TOLERANCE | Schwarzschild radius, tidal effects, accretion |
| `astronomy.exoplanets` | Exoplanet detection | NUMERIC | Transit depth, radial velocity, both methods |
| `astronomy.lunar-phases` | Lunar phases and eclipses | EXACT | Geometry of phases, eclipse conditions, node angles |
| `astronomy.tides` | Tides | TOLERANCE | Spring/neap tides, resonance, basin shape |
| `astronomy.moon-craters` | Crater counting | NUMERIC | Counting → relative age; cratering rate |
| `astronomy.solar-prominences` | Solar activity | TOLERANCE | Sunspot cycle, prominences, solar wind |
| `astronomy.constellations` | Constellations and coordinates | EXACT | RA/Dec, celestial sphere, finding by hand |
| `astronomy.seti-noise` | Signal detection in noise | NUMERIC | SNR, false positives, why SETI is hard |

## Computing & Technology (16)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `computing.sorting-visualiser` | Sorting visualiser | EXPLICIT | Comparison/swap counts, stability, complexity classes |
| `computing.search-algorithms` | Searching | EXPLICIT | Linear vs binary, worst case, big-O reasoning |
| `computing.linked-lists` | Linked structures | M | Pointer manipulation; rubric on correctness |
| `computing.binary-trees` | Trees and traversal | EXACT | BST invariants, in/pre/post-order, recursion |
| `computing.graph-algorithms` | Graph algorithms | EXACT | BFS/DFS, Dijkstra, topological order |
| `computing.hash-tables` | Hash tables | EXACT | Collisions, load factor, probing strategies |
| `computing.big-o-lab` | Complexity lab | EXACT | Predicting growth empirically then proving it |
| `computing.automata` | Finite automata | EXACT | DFA construction, NFA→DFA, state equivalence |
| `computing.regex-builder` | Regular expressions | EXACT | Matching, capturing, greediness |
| `computing.stack-machine` | Stack machine | EXACT | Postfix evaluation, VM tracing |
| `computing.quantum-circuit` | Quantum circuits | EXACT | Gate composition, measurement outcomes, superposition |
| `computing.neural-network` | A small neural network | TOLERANCE | Weights, learning by hand, overfitting |
| `computing.data-compression` | Lossy compression | NUMERIC | Compression ratio vs quality, bitrate budgeting |
| `computing.packet-routing` | Packet routing | EXACT | Route tables, hops, congestion, latency |
| `computing.error-detection` | Error detection | EXACT | Parity, Hamming codes, checksums |
| `computing.state-machines` | State machines | M | Design a controller; rubric on completeness |

## Technology & Engineering (15)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `tech.bridge-truss` | Truss design | NUMERIC | Stress, member forces, load paths, factor of safety |
| `tech.lever-lab` | Levers and moments | NUMERIC | Moment balance, mechanical advantage, effort curves |
| `tech.gear-train` | Gear trains | NUMERIC | Ratios, torque multiplication, direction, backlash |
| `tech.materials-selection` | Materials selection | M | Ashby-style charts; rubric on justifying a choice |
| `tech.heat-exchanger` | Heat exchangers | TOLERANCE | LMTD, effectiveness, counter vs parallel flow |
| `tech.fluid-network` | Pipe networks | TOLERANCE | Pressure drop, series/parallel pipes, pump curves |
| `tech.electrical-wiring` | Wiring a circuit | EXACT | Series/parallel construction, earthing, safety |
| `tech.solar-array` | Solar array design | NUMERIC | Irradiance, tilt, shading losses, payback framing |
| `tech.wind-turbine` | Wind turbine | TOLERANCE | Power curve, cut-in/rated/cut-out, capacity factor |
| `tech.battery-management` | Battery management | NUMERIC | C-rating, state of charge, thermal limits |
| `tech.additive-manufacturing` | Additive manufacturing | M | Layer slicing, supports, infill; rubric on printability |
| `tech.cad-assembly` | CAD assembly | EXACT | Constraint satisfaction, interference, BOM |
| `tech.control-loop` | Control loops | TOLERANCE | P/I/D tuning, steady-state error, oscillation |
| `tech.safety-risk-matrix` | Risk assessment | M | Likelihood × severity, mitigation; rubric |
| `tech.lifecycle-assessment` | Product lifecycle | M | Embodied energy, end-of-life; rubric on trade-offs |

## Cross-curricular & Professional Skills (18)

| id | Title | G | Teaching focus |
|---|---|---|---|
| `general.data-literacy` | Reading a graph | EXACT | Axis honesty, scale, misleading charts |
| `general.spreadsheet-modelling` | Spreadsheet modelling | M | Build a model; rubric on structure and assumptions |
| `general.uncertainty` | Measurement uncertainty | NUMERIC | Propagation, significant figures, worst case vs RSS |
| `general.experimental-design` | Experimental design | M | Controls, variables, repeated trials; rubric |
| `general.scientific-writing` | Writing a lab report | M | Structure, claim/evidence/reasoning; rubric with banded descriptors |
| `general.critical-thinking` | Evaluating a claim | M | Evidence quality, bias, logical fallacies; rubric |
| `general.estimation` | Fermi estimation | TOLERANCE | Order-of-magnitude reasoning |
| `general.dimensional-analysis` | Dimensional analysis | EXACT | Unit algebra as a check on a formula |
| `general.scale-and-similarity` | Scale and similarity | NUMERIC | Scaling laws, model/prototype reasoning |
| `general.chess-endgames` | Chess endgames | EXACT | Mate-in-N search, evaluation, tablebases |
| `general.bridge-building` | Bridge building | NUMERIC | Structural efficiency under a budget |
| `general.nutrition-log` | Nutrition and energy balance | NUMERIC | Energy accounting, interpreting food labels |
| `general.sleep-and-circadian` | Sleep and circadian rhythm | TOLERANCE | Modelling a 24 h rhythm, phase shift |
| `general.personal-finance` | Personal finance | NUMERIC | Compound interest, amortisation, comparing loans |
| `general.map-and-scale` | Maps and scale | EXACT | Grid references, scale bars, projections, distortion |
| `general.argument-mapping` | Argument mapping | EXACT | Premises, warrants, fallacies, rebuttals |
| `general.interview-skills` | Structured interviewing | M | Question design, probing, bias; rubric on transcripts |
| `general.safety-procedure` | Following a procedure | M | Ordered steps, hazard checks, deviation reporting |

---

## Coverage checks (CI-verifiable)

| Check | Target |
|---|---|
| Total registered | **≥ 200** (220 planned) |
| Per target subject | ≥ 12 |
| Per grading strategy | ≥ 12 (so grader edge cases surface in real content) |
| Keyboard-accessible | 100% |
| With a text alternative for the visual output | 100% |
| With `reducedMotion` support | 100% |
| With a declared `stateSchema` | ≥ 60% |
| Auto-gradable | ≥ 70% |
| With a full spec card and provenance | 100% |
| Passing the conformance matrix | 100% |
| With auto-captured catalogue screenshots | 100% |

A registry that fails any of these does not ship.

---

## Build order after the 24 gold sims

Priority within each batch: (1) subjects with the thinnest coverage, (2) the highest-frequency curriculum topics, (3) the ones that exercise an untested grading strategy or protocol corner. Every batch ends with a conformance run, a review pass, and a catalogue update — never a batch that lands without the machine gate.
