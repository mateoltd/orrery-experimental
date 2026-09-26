# 10 — Simulation Platform

How hundreds of simulations get built, embedded, graded, and kept working. This document turns "hundreds of simulations" from a content problem into an engineering problem.

---

## 1. Why a separate substrate

A simulation is a small interactive program that must:
- run inside somebody else's page without being able to touch it;
- be embeddable in a lesson **and** usable as a graded exam question;
- be auto-gradable **on the server, with no browser**;
- be authorable by someone who will never read this repository;
- still work in five years, when its dependencies have moved on.

That rules out "just make it a React component".

### 1.1 What prior art teaches us
`RN-07` — H5P is the closest existing thing to our sim host, and its history is a useful map of the traps:
- **Fullscreen inside an iframe does not work** without a bespoke `postMessage` resizer protocol. H5P shipped `h5p-resizer-script.js` precisely because of this. So do we, and we treat fullscreen as a host capability, never a sim capability.
- **Putting an editor inside an iframe caused years of CSS and focus breakage.** So: all editors stay out of iframes. Only runtime code is sandboxed.
- **A decade-old bundled `jQuery 1.9.1` became a strategic liability.** So: `@orrery/sim-sdk` ships with **zero runtime dependencies**, and a sim may depend only on the SDK and a small allowlist. No per-sim `npm install`, ever.
- **Content is a shareable, versioned package with a JSON descriptor.** So is ours.

---

## 2. `sim-host@1` — the protocol

### 2.1 Transport and trust
- The sim runs in `<iframe sandbox="allow-scripts">`. Deliberately **no `allow-same-origin`**: the frame is a unique opaque origin, so it cannot read our DOM, our cookies, our `localStorage` or our `IndexedDB`, and cannot `fetch()` our endpoints with our credentials. Also no `allow-forms`, `allow-popups` or `allow-top-navigation`.
- The frame is served from a **dedicated static origin** (`sims.<domain>`) with its own strict CSP, so a sim's bugs cannot reach the app origin.
- Communication is `postMessage` with a **per-mount nonce**. Every inbound frame must carry it; frames without it are dropped and counted. Because the frame is cross-origin we must use `'*'` as the target origin, so the nonce plus `event.source` identity is the real check.
- Opaque-origin means the frame has **no `localStorage`**. Persistence is host-mediated: the sim asks the host to save state and the host decides where it lives (resource draft, attempt response, or nowhere).

### 2.2 Frames

Host → sim:

| Frame | Payload | When |
|---|---|---|
| `sim:init` | `{ protocol, nonce, simId, simVersion, params, seed, mode, initialState?, grading }` | once, on mount |
| `sim:setParams` | `{ params, seed? }` | host-driven parameter change (author preview, "new numbers") |
| `sim:command` | `{ name, args }` | `reset`, `play`, `pause`, `step`, `loadScenario`, `focus`, `setTheme` |
| `sim:requestState` | `{ reason }` | host needs a snapshot (save, submit, resize, teacher replay) |
| `sim:visibility` | `{ visible }` | tab shown/hidden, so rAF loops pause |
| `sim:teardown` | `{}` | unmount |

Sim → host:

| Frame | Payload | When |
|---|---|---|
| `sim:ready` | `{ protocol, simId, simVersion, capabilities, exports }` | after `sim:init` |
| `sim:error` | `{ code, message, recoverable, stack? }` | any failure; host shows fallback UI |
| `sim:resize` | `{ width, height }` | debounced by the sim |
| `sim:state` | `{ state, checksum }` | unsolicited checkpoint, debounced by the sim |
| `sim:answer` | `{ answer, confidence?, explanation? }` | a gradable answer exists |
| `sim:gradePreview` | `{ points, correct, rationale }` | teacher-facing only; **never** shown to a student |
| `sim:telemetry` | `{ name, value }` | allowlisted metrics; no PII, no free text |
| `sim:readyForInput` | `{}` | signals the student can act; drives focus management |

### 2.3 Rules
1. **The host never trusts a sim.** A sim can claim any state. If the answer is auto-graded, the sim's `grader(state)` runs **server-side in Node** and is the authority. `sim:gradePreview` is decorative and teacher-only.
2. **Unknown frames are ignored, not fatal.** A newer sim against an older host degrades.
3. **Version mismatch degrades with a clear panel**, never a crash. The surrounding lesson stays usable.
4. **One answer per question**, last write wins at the response level (revisioned), while the host keeps a per-sim checkpoint history so a teacher replaying a disputed answer can see how the student got there.
5. **A sim cannot navigate, open windows, or read the clipboard.** Any attempt is a `sim:error` and a registry-level conformance failure.

---

## 3. `sim.manifest.json`

JSON Schema is the source of truth; Zod mirrors it; `sim:validate` enforces both plus the runtime rules.

```jsonc
{
  "id": "maths.projectile-motion",
  "version": "2.1.0",
  "title": "Projectile motion",
  "summary": "Explore how launch speed and angle change range and flight time.",
  "authors": ["…"],
  "licence": "CC-BY-4.0",
  "provenance": "ORIGINAL",              // ORIGINAL | INSPIRED_BY:<ref> | PORTED
  "protocol": 1,
  "subjects": ["maths", "physics"],
  "tags": ["kinematics", "vectors", "quadratics"],
  "ageRange": [13, 18],
  "accessibility": {
    "keyboard": true,
    "screenReaderSummary": "A graph of height against time for a thrown ball…",
    "reducedMotion": true,
    "textAlternative": "Height falls to 0 at t = 3.2 s when speed is 25 m/s at 45°."
  },

  "entry": "./browser.js",              // ESM, browser target
  "grader": "./grader.js",              // ESM, Node target — pure, no DOM
  "styles": "./style.css",
  "budget": { "maxBytes": 350000 },

  "params": {                            // JSON Schema → drives the host param editor
    "type": "object",
    "properties": {
      "speed":   { "type": "number", "minimum": 5, "maximum": 60, "default": 25, "unit": "m/s", "label": "Launch speed" },
      "angle":   { "type": "number", "minimum": 5, "maximum": 85, "default": 45, "unit": "°",   "label": "Launch angle" },
      "gravity": { "type": "number", "minimum": 1.6, "maximum": 24.8, "default": 9.81, "unit": "m/s²", "label": "Gravity" }
    },
    "required": ["speed", "angle"]
  },

  "capabilities": {
    "state": true, "grading": true, "randomised": true,
    "audio": false, "webgl": false, "stepper": true,
    "scenarios": ["no-air", "drag-linear", "drag-quadratic"]
  },

  "stateSchema":  { "type": "object" },
  "answerSchema": { "type": "object" },

  "grading": {                           // required when capabilities.grading is true
    "strategy": "TOLERANCE",             // EXACT | TOLERANCE | SET | NUMERIC | RUBRIC
    "maxPoints": 4,
    "tolerance": { "absolute": 0.5, "relative": 0.02 },
    "partialCredit": true,
    "rationaleTemplate": "Range is {answer.range} m; correct is {expected.range} m."
  },

  "lifecycle": { "autoPlay": false, "defaultHeight": 420, "minHeight": 240, "aspectRatio": "16/10" },

  "conformance": {                       // consumed by the automated suite
    "script": [
      { "command": "setParams", "args": { "speed": 25, "angle": 45 } },
      { "command": "step", "args": { "steps": 600 } }
    ],
    "expect": { "answer": { "range": { "min": 55, "max": 65 } }, "grade": 1 }
  }
}
```

### 3.1 `sim:validate` rules
Beyond schema conformance:
- `entry` and `grader` both exist; the grader must import cleanly in a **DOM-free Node** environment.
- The grader is **deterministic**: run 3× on identical state, identical output.
- The grader performs no I/O, reads no clock, uses no unseeded randomness.
- `byteSize` within budget; CI fails on a 15% regression against the last published build.
- `accessibility.keyboard` must be `true` for any sim with `ageRange` below 16.
- `licence` and `provenance` non-empty. No exceptions — this is how we avoid shipping something we cannot license.
- Screenshots are auto-captured by the conformance run into `capturesPath`.

---

## 4. `@orrery/sim-sdk`

What a simulation author imports. Deliberately tiny and **dependency-free** — an author should read the whole SDK in ten minutes.

```ts
import { defineSim, num, tolerance, setMatch, seeded } from '@orrery/sim-sdk'

export default defineSim({
  id: 'maths.projectile-motion',
  params: {
    speed:   num({ min: 5, max: 60, default: 25, unit: 'm/s' }),
    angle:   num({ min: 5, max: 85, default: 45, unit: '°' }),
    gravity: num({ min: 1.6, max: 24.8, default: 9.81, unit: 'm/s²' })
  },

  // Pure physics. Runs identically in the browser and in Node — this is what makes
  // server-side grading and deterministic conformance testing possible.
  simulate(params, state, t) {
    const v = params.speed, a = params.angle * Math.PI / 180
    return { x: v * Math.cos(a) * t,
             y: v * Math.sin(a) * t - 0.5 * params.gravity * t * t,
             vy: v * Math.sin(a) - params.gravity * t }
  },

  // Pure state → grade. No DOM, no I/O, no clock, no unseeded randomness.
  grade(state, params, answer) {
    return tolerance(answer.range, expectedRange(params), { abs: 0.5, rel: 0.02 })
  },

  render(ctx) { /* draws from the same simulate() */ },
  controls: { stepper: true, scenarios: ['no-air', 'drag-linear'] }
})
```

What the author gets for free:
- a seeded `rng` (so every student sees different numbers but the run is reproducible);
- a `stepper` (play / pause / step / scrub) implemented once, keyboard-accessible and reduced-motion aware;
- state serialisation, checksumming and restore, so a sim resumes after a reload mid-question;
- an accessibility baseline: focus management, live-region announcements, focusable controls, a text alternative, a `prefers-reduced-motion` path;
- size and dependency budgets enforced at build time;
- a **conformance harness** runnable locally with one command.

### 4.1 INV-SIM-2 — the dual-target rule
`simulate`, `grade` and every pure model function must be importable in **both** targets with no DOM access. The build produces:
- `browser.js` — ESM bundle with the render layer, loaded into the sandboxed frame;
- `grader.js` — ESM bundle with no DOM references, imported by the worker to grade stored state.

CI proves it by importing `grader.js` in a bare Node context and grading fixture states. **This is the single most important decision in the simulation platform**: it is what allows a simulation to be an exam question graded by a server with no browser involved.

---

## 5. Embedding

The `embedSimulation` block carries `simId`, `simVersion`, `params` and a `seedPolicy`:

```ts
type SeedPolicy =
  | { kind: 'FIXED'; seed: string }              // lesson: everyone sees the same thing
  | { kind: 'PER_STUDENT'; derivation: 'ATTEMPT_ID' | 'USER_ID' | 'ASSIGNMENT_ID' }
  | { kind: 'PER_VIEW' }                          // fresh every load — discourages screenshot sharing
```

Behaviour:
- **Lazy**: mounted on intersection, with a static poster and caption as the pre-load state. A lesson with 12 sims does not download 12 sims.
- Resize driven by `sim:resize`, debounced, with a `ResizeObserver` fallback for sims that misbehave. The frame never traps layout.
- Unknown `simId@simVersion` → **static fallback** (poster, description, parameters as text) plus a blocking authoring warning. A lesson is never broken by a registry problem.
- Print/PDF: poster plus text summary, so a printed worksheet still teaches something.
- Sim origin blocked by a school firewall → fallback plus an explicit message. We never show a silently broken frame.
- State captured on unmount, on `pagehide`, and on every checkpoint, so a refresh never loses a student's exploration.

### 5.1 Graded mode
`mode: 'graded'` inside an assessment: the sim becomes the question surface. Additional requirements:
- `params` come from the resolved variant, not the block.
- The frame is `pointer-events` managed so exam focus order is not stolen; `sim:readyForInput` drives focus management so a screen-reader user lands in the right place.
- Sim state is captured at `sim:requestState(reason='save'|'submit'|'blur'|'unload')` and at a 3 s debounce.
- The **host** computes the deadline display; the sim never displays a timer (it cannot be trusted and must not pretend to be).

---

## 6. Registration pipeline

```
sims/<subject>.<slug>/
├─ sim.manifest.json
├─ sim.spec.md            # the spec card (§7)
├─ src/{index.ts, model.ts, render.ts, controls.ts}
├─ test/{grader.test.ts, conformance.spec.ts, states/*.json}
└─ LICENCE
```

```bash
pnpm sim:new maths.projectile-motion   # scaffold from sims/_template
pnpm sim:dev maths.projectile-motion   # playground: hot reload + protocol inspector
pnpm sim:validate --all                # manifest, determinism, size, a11y, licence
pnpm sim:conformance                   # Playwright over every registered sim
pnpm sim:build                         # hashed bundles + grader + screenshots → registry
```

Registration is a **CI job, not a human database edit**. A merge that adds a sim but fails conformance does not build.

### 6.1 The conformance matrix
For **every** registered `simId@version`:
1. Serve the built bundle from the isolated origin; mount it in the real host component.
2. Assert the handshake: protocol, id, version, capabilities all match the manifest.
3. Assert the frame is genuinely sandboxed: `document.cookie` unreachable, `localStorage` throws, a deliberate `fetch` to the app origin is blocked by CSP.
4. Replay `conformance.script` command by command.
5. Assert the reported answer matches `conformance.expect.answer`, and that the **Node-side** grader returns `conformance.expect.grade`.
6. Assert keyboard-only operation reaches every control.
7. Assert state round-trips: serialise → reload → restore → identical checksum.
8. Capture catalogue screenshots.

This is what makes 220 simulations tractable. A human reviews pedagogy; a machine enforces everything else. **Every one of the 24 gold sims exists to break a specific assumption in this suite.**

---

## 7. The spec card (`sim.spec.md`)

Every simulation starts as a card, and the card is reviewed before the code:

1. **Subject, topic, level, age range.**
2. **Learning objective** — one sentence, in the student's terms. If we cannot write it, we do not build the sim.
3. **Interaction model** — what the student does, in verbs.
4. **Model** — the physics / maths / biology, stated precisely enough to be checked.
5. **Answer semantics** — what counts as correct, and every equivalent form a student might produce.
6. **Grading strategy** — `EXACT | TOLERANCE | SET | NUMERIC | RUBRIC`, with the partial-credit rule.
7. **Parameters and variants** — which vary per student, and the sensible ranges. If the item is parameterised, the generator **must be invertible** (`06` §5.1).
8. **Misconceptions targeted** — the three specific wrong ideas this sim exists to expose. This is the pedagogical heart; a sim targeting no misconception is a toy.
9. **Accessibility plan** — keyboard path, text alternative, reduced-motion behaviour.
10. **Fallback** — what a student sees with no JavaScript, or on a blocked network.
11. **Licence and provenance.**
12. **Conformance script and expected grade.**

Cards are one page. They are the review artefact, and they are what makes parallel authoring tractable: an agent can be handed a card and a template and produce a reviewable simulation.

---

## 8. Sim Studio (declarative, no user code)

`ADR-0018`: we do not execute user-supplied JavaScript. But the long tail of "a teacher wants a slider that shows *this* graph" is real, so Sim Studio compiles a **closed declarative spec** into a manifest + a pure model function + a renderer:

```
{ kind:
    'function-plot' | 'vector-field' | 'bar-chart' | 'scatter-plot' | 'geometry-transform'
  | 'number-line' | 'phylogenetic-tree' | 'circuit-dc' | 'stoichiometry-balance'
  | 'wave-interference' | 'titration-curve' | 'conics' | 'number-base' | 'clock',
  spec: { … } }
```

Studio output is therefore automatically conformant, accessible and gradable. A teacher gets a working simulation in one form, and we get zero user-authored code.

---

## 9. Lifecycle, cost and quality

| Concern | Policy |
|---|---|
| Bundle budget | 350 KB typical; 1.2 MB hard ceiling; CI fails on a 15% regression |
| Core bundle independence | The app bundle must not grow as sims are added. Sims are content-addressed and lazy; the catalogue fetches a metadata index, never code |
| Rendering | Canvas for physics/graphs, SVG for geometry/diagrams, DOM for forms. The sim chooses; the host measures |
| Dependencies | SDK + a small allowlist only. No per-sim install |
| Versioning | `id@semver`. Resources pin an exact version. Old versions keep serving. `MAJOR` (state or answer-schema change) invalidates stored states → the host detects the mismatch and offers a safe reset rather than corrupting a grade |
| Deprecation | Mark deprecated, set `replacedById`, warn in authoring, keep serving. Never break a live classroom |
| Retirement | `DISABLED` only for a security incident; blocked at author time, still resolvable for pinned versions |
| Analytics | Mounts, completion, median time, parameter distributions, conformance flakiness. No answer content, no PII |
| Provenance | Every sim declares licence + provenance. `INSPIRED_BY:<ref>` is respected and recorded, not laundered |

---

## 10. The 24 gold-standard simulations

Chosen to cover every contract corner, and to be genuinely useful. Each exists to break a specific assumption.

| # | Sim | Corner it stresses |
|---|---|---|
| 1 | `maths.projectile-motion` | tolerance grading, stepper, per-student seed |
| 2 | `maths.quadratic-roots` | exact grading, symbolic equivalence, multi-valid answers |
| 3 | `maths.function-transform` | SVG, live parameter binding |
| 4 | `maths.derivative-tangent` | continuous animation, reduced-motion path, text alternative |
| 5 | `maths.statistics-explorer` | data visualisation, large state, set grading, percentiles |
| 6 | `maths.trigonometry-unit-circle` | precision, angle handling, keyboard-only |
| 7 | `maths.coordinate-geometry` | pointer interaction, snapping, undo/redo |
| 8 | `maths.monte-carlo-pi` | seeded randomness, convergence, tolerance band |
| 9 | `maths.matrix-transformations` | 2D linear algebra, stepper, state restore |
| 10 | `maths.probability-tree` | discrete state, set grading with partial credit |
| 11 | `physics.free-body-diagram` | vector overlay, **RUBRIC** grading, keyboard-draggable vectors |
| 12 | `physics.pendulum` | fixed-timestep determinism, energy plots |
| 13 | `physics.wave-interference` | two-source interference, animation loop, pause/scrub |
| 14 | `physics.optics-ray-tracing` | SVG geometry, precise construction, image export |
| 15 | `physics.circuit-dc` | graph solving, multi-valid answers, unit handling |
| 16 | `chemistry.particle-view` | large state, event-driven, animation |
| 17 | `chemistry.stoichiometry-balance` | discrete state, exact SET grading, unlimited retries |
| 18 | `chemistry.titration-curve` | continuous params, numeric tolerance |
| 19 | `chemistry.reaction-rate` | sliders, log plots, misconception targeting |
| 20 | `biology.cell-division` | discrete state machine, stepper, sequence grading |
| 21 | `biology.genetics-punnett` | exact set grading, combinatorial states |
| 22 | `biology.ecosystem-flow` | Sankey-style diagram, mass-balance invariants |
| 23 | `computing.sorting-visualiser` | stepper with scrub, comparison counting, no WebGL |
| 24 | `astronomy.orrery` | 3D (WebGL), continuous time, large-but-legal bundle, hostile time slider |

Coverage between them: sliders, continuous loops, event-driven state, 2D canvas, 3D WebGL, SVG, physics stepper, keyboard-only, randomisation, tolerance grading, multi-valid answers, a large bundle, rubric grading, and all target subjects. **If a sim cannot be built on this contract, the contract is wrong.**

---

## 11. Scale-out mechanics (P12)

- Catalogue matrix: subject × topic × level → 220 sims (`11-SIM-CATALOGUE.md`).
- 6 parallel author lanes, one sim in flight per lane: card → code → conformance → review.
- Review rubric, 3 points, all required: (a) pedagogical soundness against the card's misconceptions, (b) technical conformance and grading correctness, (c) accessibility.
- **The conformance matrix is a release gate.** A regression anywhere blocks the build.
- Throughput target: one sim per lane per 2 hours after the first 24, i.e. ~30/day across 6 lanes.
- Batch policy: a batch never lands without its machine gate. Half-finished batches are worse than small complete ones, because a registry with failing sims trains everyone to ignore the gate.
