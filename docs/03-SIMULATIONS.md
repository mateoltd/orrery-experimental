# Simulation Platform

How hundreds of simulations get built, embedded, graded and kept working. This is the document that makes "hundreds" an engineering problem instead of a content problem.

---

## 1. Why a separate substrate

A simulation is a small interactive program. It must:

- run inside somebody else's page without being able to touch it;
- be embeddable in a resource **and** usable as a graded exam question;
- be auto-gradable **on the server**, without a browser;
- be authorable by someone who will never read this repository;
- still work in five years when its dependencies have moved on.

That rules out "just make it a React component". It mandates a **versioned, sandboxed, dual-target contract**.

---

## 2. `sim-host@1` — the protocol

### 2.1 Transport and trust
- The sim runs in `<iframe sandbox="allow-scripts">`. Deliberately **no `allow-same-origin`**: the frame is treated as a unique opaque origin, so it cannot read our DOM, our cookies, our `localStorage`, or our `IndexedDB`, and it cannot `fetch()` our endpoints with our credentials.
- The frame is served from a **dedicated static origin** (`sims.<domain>`) with a strict CSP of its own, so a sim's own bugs cannot reach the app origin.
- All communication is `postMessage` with a **per-mount nonce**. Every inbound frame must carry the nonce; frames without it are dropped and counted. Because the frame is cross-origin we must use `'*'` as the target origin, so the nonce plus `event.source` identity is the real check.
- Because the frame is opaque-origin, it cannot use `localStorage`. Persistence is **host-mediated**: the sim asks the host to save state, and the host decides where that lives (resource draft, student attempt response, or nowhere).

### 2.2 Frames

Host → sim:
| Frame | Payload | When |
|---|---|---|
| `sim:init` | `{ protocol, nonce, simId, simVersion, params, seed, mode, initialState?, grading }` | once, on mount |
| `sim:setParams` | `{ params, seed? }` | host-driven param change (authoring preview, "reset with new numbers") |
| `sim:command` | `{ name, args }` | host-driven imperative command (`reset`, `play`, `pause`, `step`, `loadScenario`, `focus`) |
| `sim:requestState` | `{ reason }` | host needs a state snapshot (save, submit, resize, teacher replay) |
| `sim:visibility` | `{ visible }` | tab shown/hidden, so sims can pause rAF loops |
| `sim:teardown` | `{ }` | unmount |

Sim → host:
| Frame | Payload | When |
|---|---|---|
| `sim:ready` | `{ protocol, simId, simVersion, capabilities, exports }` | after `sim:init` |
| `sim:error` | `{ code, message, recoverable, stack? }` | any failure; host shows fallback UI |
| `sim:resize` | `{ width, height }` | content resize, to size the frame |
| `sim:state` | `{ state, checksum }` | unsolicited checkpoint, debounced by the sim |
| `sim:answer` | `{ answer, confidence?, explanation? }` | the sim produced a gradable answer |
| `sim:gradePreview` | `{ points, correct, rationale }` | optional; **never** shown to students, teacher-facing only |
| `sim:telemetry` | `{ name, value }` | allowlisted usage metrics (no PII, no free text) |
| `sim:readyForInput` | `{ }` | signals the student can act; used for a11y focus management |

### 2.3 Rules
1. **The host never trusts a sim.** A sim can claim any state or answer. If the answer is graded automatically, the sim's `grader(state)` runs **server-side in Node** and is the authority. The `sim:gradePreview` frame is decorative and teacher-only.
2. **Unknown frames are ignored**, not fatal. A newer sim running against an older host degrades.
3. **Protocol version mismatch degrades, never crashes.** The host shows a clear "this simulation needs a newer version of Orrery" panel and the surrounding lesson remains usable.
4. **One answer per question, last write wins** at the response level (revisioned), but the host keeps a per-sim checkpoint history so a teacher replaying a disputed answer can see how the student got there.
5. **The sim cannot navigate, open windows, or read the clipboard.** Any attempt is an `sim:error` and a registry-level conformance failure.

---

## 3. `sim.manifest.json`

The contract between a simulation and the platform. JSON Schema is the source of truth; Zod mirrors it; `sim:validate` enforces both plus the extra runtime rules.

```jsonc
{
  "id": "maths.projectile-motion",
  "version": "2.1.0",
  "title": "Projectile motion",
  "summary": "Explore how launch speed and angle change range and flight time.",
  "authors": ["..."],
  "licence": "CC-BY-4.0",
  "provenance": "ORIGINAL",              // ORIGINAL | INSPIRED_BY:<ref> | PORTED
  "protocol": 1,
  "subjects": ["maths", "physics"],
  "tags": ["kinematics", "vectors", "quadratics"],
  "ageRange": [13, 18],
  "accessibility": { "keyboard": true, "screenReaderSummary": "…", "reducedMotion": true },

  "entry": "./browser.js",               // ESM, browser target
  "grader": "./grader.js",               // ESM, Node target — pure, no DOM
  "styles": "./style.css",
  "assets": { "maxBytes": 350000 },

  "params": {                            // JSON Schema, drives the host's param editor
    "type": "object",
    "properties": {
      "speed":   { "type": "number", "minimum": 5, "maximum": 60, "default": 25, "unit": "m/s", "label": "Launch speed" },
      "angle":   { "type": "number", "minimum": 5, "maximum": 85, "default": 45, "unit": "°", "label": "Launch angle" },
      "gravity": { "type": "number", "minimum": 1.6, "maximum": 24.8, "default": 9.81, "unit": "m/s²", "label": "Gravity" }
    },
    "required": ["speed", "angle"]
  },

  "capabilities": {
    "state": true,          // serialisable state, required if it can be a graded question
    "grading": true,        // exposes a pure grader
    "randomised": true,     // honours the host seed for per-student variants
    "audio": false,
    "webgl": false,
    "stepper": true,        // supports deterministic stepping (pause/step/scrub)
    "scenarios": ["no-air", "drag-linear", "drag-quadratic"]
  },

  "stateSchema": { "type": "object" },  // JSON Schema for the serialised state
  "answerSchema": { "type": "object" }, // JSON Schema for the answer the sim reports

  "grading": {                           // required when capabilities.grading is true
    "strategy": "TOLERANCE",             // EXACT | TOLERANCE | SET | NUMERIC | RUBRIC
    "maxPoints": 4,
    "tolerance": { "absolute": 0.5, "relative": 0.02 },
    "partialCredit": true,
    "rationaleTemplate": "Range is {answer.range}m; the correct range for {params.speed} m/s at {params.angle}° is {expected.range}m."
  },

  "lifecycle": { "autoPlay": false, "defaultHeight": 420, "minHeight": 240, "aspectRatio": "16/10" },

  "conformance": {                       // consumed by the automated suite
    "script": [                          // deterministic interaction, replayed in CI
      { "command": "setParams", "args": { "speed": 25, "angle": 45 } },
      { "command": "step", "args": { "steps": 600 } }
    ],
    "expect": { "answer": { "range": { "min": 55, "max": 65 } }, "grade": 1 }
  }
}
```

### 3.1 Manifest validation rules (`sim:validate`)
Beyond schema conformance:
- `entry` and `grader` must both exist and must not import the DOM in the grader target (checked by running the grader in a DOM-free Node environment).
- The grader must be **deterministic**: running it twice on the same state must produce identical output; the validator runs it 3×.
- The grader must not perform I/O, read `Date.now()`, or use unseeded randomness.
- `byteSize` must be within the declared budget; CI fails on a 15% regression against the last published build.
- `accessibility.keyboard` must be `true` for any sim with `ageRange` below 16 (policy, enforced).
- `licence` and `provenance` must be present and non-empty. No exceptions — this is how we avoid shipping something we cannot license.
- Screenshots are auto-captured by the conformance run into `capturesPath`; the catalogue page uses them.

---

## 4. `@orrery/sim-sdk`

What a simulation author imports. Deliberately tiny — a sim author should read the whole SDK in ten minutes.

```ts
import { defineSim, num, range, set, tolerance, rubric } from '@orrery/sim-sdk'

export default defineSim({
  id: 'maths.projectile-motion',
  params: {
    speed:   num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    angle:   num({ min: 5, max: 85, default: 45, unit: '°' }),
    gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s²' })
  },

  // Pure physics. Runs identically in the browser and in Node, which is what makes
  // server-side grading and deterministic conformance testing possible.
  simulate(params, state, t) {
    const v = params.speed, a = params.angle * Math.PI / 180
    return { x: v * Math.cos(a) * t, y: v * Math.sin(a) * t - 0.5 * params.gravity * t * t, vy: v * Math.sin(a) - params.gravity * t }
  },

  // Pure state → grade. No DOM, no I/O, no clock, no unseeded randomness.
  grade(state, params, answer) {
    return tolerance(answer.range, expectedRange(params), { abs: 0.5, rel: 0.02 })
  },

  render(canvas, ctx) { /* draw using the same simulate() */ },
  controls: { stepper: true, scenarios: ['no-air', 'drag-linear'] }
})
```

SDK guarantees the author gets for free:
- `rng` seeded from the host seed, so every student sees different numbers but the run is reproducible;
- a `stepper` (play/pause/step/scrub) implemented once, with keyboard support and reduced-motion awareness;
- state serialisation, checksum and restore, so a sim resumes after a reload mid-question;
- an accessibility baseline: focus management, live-region announcements, focusable controls, a text alternative for the visual, and a `prefers-reduced-motion` path;
- size and dependency budgets enforced at build time;
- a **conformance harness** so the author can run the CI check locally with one command.

### 4.1 Dual-target rule (INV-SIM-2)
`simulate`, `grade` and any pure model function must be importable in **both** targets with no DOM access. The build produces:
- `browser.js` — ESM bundle with the render layer, loaded into the sandboxed frame;
- `grader.js` — ESM bundle with no DOM references, imported by the worker to grade stored state.

CI proves it by importing `grader.js` in a bare Node context and grading fixture states. This is the single most important design decision in the whole simulation platform: **it is what allows a simulation to be an exam question that is graded by a server with no browser involved.**

---

## 5. Embedding in a resource

The `embedSimulation` block carries `simId`, `simVersion`, `params` and a `seedPolicy`:

```ts
type SeedPolicy =
  | { kind: 'FIXED'; seed: string }              // lesson: everyone sees the same thing
  | { kind: 'PER_STUDENT'; derivation: 'ATTEMPT_ID' | 'USER_ID' | 'ASSIGNMENT_ID' }
  | { kind: 'PER_VIEW' }                          // fresh every load — discourage sharing screenshots
```

Behaviour:
- The frame is **lazy**: mounted on intersection, with a static poster and a caption as the pre-load state. A lesson with 12 sims does not download 12 sims.
- Resize is driven by `sim:resize` with a debounce and a `ResizeObserver` fallback for sims that misbehave; the frame never traps layout.
- If `simId@simVersion` is not in the registry, the block renders a **static fallback** (poster + description + the parameters as text) and authoring shows a blocking warning. A lesson must never be broken by a registry problem.
- Print/PDF: the poster plus a text summary, because a printed worksheet should still teach something.
- A student working offline (or when the sim origin is blocked by a school firewall) gets the fallback plus an explicit message. We do **not** silently show a broken frame.
- The sim's state is captured on unmount, on `pagehide`, and on every `sim:state` checkpoint so a refresh never loses a student's exploration.

---

## 6. Registration pipeline

```
sims/<subject>.<slug>/
├─ sim.manifest.json
├─ sim.spec.md            # the spec card: see §7
├─ src/{index.ts, model.ts, render.ts, controls.ts}
├─ test/{grader.test.ts, conformance.spec.ts, states/*.json}
└─ LICENCE
```

```bash
pnpm sim:new maths.projectile-motion   # scaffold from sims/_template
pnpm sim:dev maths.projectile-motion   # playground with hot reload + protocol inspector
pnpm sim:validate --all                # manifest, determinism, size, a11y, licence
pnpm sim:conformance                   # Playwright: every registered sim, scripted, asserted
pnpm sim:build                         # hashed bundles + grader + screenshots → registry
```

Registration is a CI job, not a human database edit. A merge that adds a sim but fails conformance does not build.

### 6.1 The conformance matrix
For **every** registered `simId@version`, the Playwright suite:
1. Serves the built bundle from the isolated origin and mounts it in the real host component.
2. Asserts the handshake: protocol, id, version, capabilities all match the manifest.
3. Asserts the frame is genuinely sandboxed: `frame.evaluate(() => document.cookie)` is empty/unreachable, `localStorage` throws, and a deliberate `fetch` to the app origin is blocked by CSP.
4. Replays `conformance.script` command-by-command.
5. Asserts the reported answer matches `conformance.expect.answer` and the **Node-side** grader returns `conformance.expect.grade`.
6. Asserts keyboard-only operation reaches every control.
7. Asserts the state round-trips (serialise → reload → restore → identical checksum).
8. Captures screenshots for the catalogue.

This is what makes 200 simulations tractable. A human reviews pedagogy; a machine enforces everything else. Every one of the 24 gold sims exists to break a specific assumption in this suite.

---

## 7. The spec card (`sim.spec.md`)

Every simulation starts as a card, and the card is reviewed before the code. Fields:

1. **Subject, topic, level, age range.**
2. **Learning objective** — one sentence, in the student's terms. If we cannot write it, we do not build the sim.
3. **Interaction model** — what the student actually does, in verbs.
4. **Model** — the physics/maths/biology, stated precisely enough to be checked.
5. **Answer semantics** — what counts as a correct answer, and every equivalent form a student might produce.
6. **Grading strategy** — `EXACT | TOLERANCE | SET | NUMERIC | RUBRIC`, with partial credit rules.
7. **Parameters and variants** — which parameters vary per student, and the sensible ranges.
8. **Misconceptions targeted** — the three specific wrong ideas this sim is designed to expose. This is the pedagogical heart; a sim that targets no misconception is a toy.
9. **Accessibility plan** — keyboard path, text alternative, reduced-motion behaviour.
10. **Fallback** — what a student sees with no JavaScript or on a blocked network.
11. **Licence and provenance.**
12. **Conformance script and expected grade.**

Cards are short (one page). They are the review artefact, and they make parallel authoring tractable: an agent can be handed a card and a template and produce a reviewable simulation.

---

## 8. Sim Studio (declarative, no user code)

Code execution from users is a supply-chain and legal risk we decline (decision D5). But the long tail of "teacher wants a slider that shows *this* graph" is real, so Sim Studio generates simulations from a **closed declarative spec** — a finite set of composable primitives:

```
{ kind: 'function-plot' | 'vector-field' | 'bar-chart' | 'scatter-plot' | 'geometry-transform'
           | 'number-line' | 'phylogenetic-tree' | 'circuit-dc' | 'stoichiometry-balance'
           | 'wave-interference' | 'titration-curve', spec: {...} }
```

The compiler turns a spec into a manifest + a pure model function + a renderer, so Studio output is automatically conformant, accessible and gradable. A teacher gets a working simulation in one form; we get zero user-authored JavaScript.

---

## 9. Quality, cost and lifecycle

| Concern | Policy |
|---|---|
| Bundle budget | 350 KB uncompressed for a typical sim; 1.2 MB hard ceiling; enforced in CI with a 15% regression gate |
| Core bundle independence | The app bundle must not grow when sims are added. Sims are content-addressed and loaded on demand; the catalogue fetches a manifest index, never the sims |
| Rendering | Canvas for physics/graphs, SVG for geometry/diagrams, DOM for forms. Sim chooses; host measures |
| Deps | A sim may depend only on the SDK and a small allowlist. No per-sim npm install |
| Versioning | `id@semver`. Resources pin an exact version. Registry keeps old versions serving |
| Deprecation | Mark deprecated, set `replacedById`, show authoring warnings, keep serving. Never break a live classroom |
| Retirement | `DISABLED` only for a security incident; blocked at author time, still resolvable for pinned versions |
| Analytics | Per sim: mounts, completion rate, median time, param distributions, conformance flakiness. No answer content, no PII |
| Version policy | Semver: `PATCH` fixes, `MINOR` new params/capabilities, `MAJOR` state or answer-schema change. A `MAJOR` bump invalidates stored states → the host detects a state/manifest mismatch and offers a safe reset rather than corrupting a grade |

---

## 10. The 24 gold-standard simulations

Chosen to break every assumption in the contract, and to be genuinely useful.

| # | Sim | Corner it stresses |
|---|---|---|
| 1 | `maths.projectile-motion` | tolerance grading, stepper, per-student seed |
| 2 | `maths.quadratic-roots` | exact grading, symbolic equivalence, multi-valid answers |
| 3 | `maths.function-transform` | SVG, parameter binding, live param editing |
| 4 | `maths.derivative-tangent` | continuous animation, reduced-motion path, text alternative |
| 5 | `maths.statistics-explorer` | data viz, large state, set-grading, percentiles |
| 6 | `maths.trigonometry-unit-circle` | precision, angle handling, keyboard-only |
| 7 | `maths.coordinate-geometry` | pointer interaction, snapping, undo/redo |
| 8 | `maths.monte-carlo-pi` | seeded randomness, convergence, grading on tolerance band |
| 9 | `maths.matrix-transformations` | 2D linear algebra, stepper, state restore |
| 10 | `maths.probability-tree` | discrete state, set grading with partial credit |
| 11 | `physics.free-body-diagram` | vector overlay, rubric grading, keyboard-draggable vectors |
| 12 | `physics.pendulum` | fixed-timestep determinism, energy plots |
| 13 | `physics.wave-interference` | two-source interference, animation loop, pause/scrub |
| 14 | `physics.optics-ray-tracing` | SVG geometry, precise construction, image export |
| 15 | `physics.circuit-dc` | graph solving, multi-valid answers, unit handling |
| 16 | `chemistry.particle-view` | large state, event-driven, animation |
| 17 | `chemistry.stoichiometry-balance` | discrete state, exact set grading, unlimited wrong attempts |
| 18 | `chemistry.titration-curve` | continuous params, numeric grading with tolerance |
| 19 | `chemistry.reaction-rate` | sliders, log plots, misconception targeting |
| 20 | `biology.cell-division` | discrete state machine, stepper, sequence grading |
| 21 | `biology.genetics-punnett` | exact set grading, combinatorial states |
| 22 | `biology.ecosystem-flow` | Sankey-style diagram, mass-balance invariants |
| 23 | `computing.sorting-visualiser` | stepper with scrub, comparison counting, WebGL-free perf |
| 24 | `astronomy.orrery` | 3D (WebGL), continuous time, offline-sized bundle, no-crash under a hostile time slider |

Between them they cover: sliders, continuous loops, event-driven state, 2D canvas, 3D WebGL, SVG, physics stepper, audio (a 25th if needed), keyboard-only interaction, randomisation, tolerance grading, multi-valid answers, a large bundle, an offline-capable sim, a deliberately failing sim (in the test fixtures), an accessible sim, graph plotting, and all six target subjects. If a sim cannot be built on this contract, the contract is wrong.

---

## 11. Scale-out mechanics (P12)

- **Catalogue matrix:** subject × topic × level → 220 sims, listed in `10-SIM-CATALOGUE.md`.
- **Lanes:** 6 parallel author lanes, one sim in flight per lane, card → code → conformance → review.
- **Review:** 3-point rubric — (a) pedagogical soundness against the card's misconceptions, (b) technical conformance and grading correctness, (c) accessibility. A sim ships only with all three.
- **Machine gate:** the conformance matrix is a release gate. A regression anywhere blocks the build.
- **Throughput target:** one sim per lane per 2 hours after the first 24, i.e. ~30 sims per working day across 6 lanes.
