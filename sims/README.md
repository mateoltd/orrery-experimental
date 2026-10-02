# Simulations

`sims/` is deliberately **not** a workspace. There is no per-sim `npm install`, no `node_modules`, and
no way for a simulation to depend on anything except `@orrery/sim-sdk`. That is `RN-07` enforced by
resolution rather than by review: a decade-old bundled `jQuery 1.9.1` became a strategic liability, and
without a per-sim install there is nothing to upgrade it with.

---

## The five commands

| Command | What it does | When |
|---|---|---|
| `pnpm sim:new <subject.slug>` | Scaffold from `_template` and check the result | Once, at the start |
| `pnpm sim:build` | Hash and emit `browser.js`, `grader.js`, the CSS, and a registry entry | Every change |
| `pnpm sim:check` | Build and assert **without writing** | In CI, on a dirty tree |
| `pnpm sim:validate` | Manifest, schema, rules, determinism, no-I/O, budget | Every commit |
| `pnpm sim:conformance` | The full matrix in a real browser | Before a sim is merged |
| `pnpm sim:playground` | Mount one sim on a real second origin, with every frame both ways listed live | While writing one |
| `pnpm sim:sandbox-escape` | Attempts twelve escapes from inside the frame | In `pnpm gates`; run it if you touch the frame |

`sims/_template` and `sims/_fixtures` are excluded from every one of them: a leading underscore means
scaffolding or deliberately-broken test input, not a simulation.

---

## The shape

```
sims/<subject>.<slug>/
├─ sim.manifest.json     the contract with the host
├─ sim.spec.md           the REVIEW ARTEFACT. Write it before the code.
├─ src/
│  ├─ model.ts           pure. No DOM, no clock, no unseeded randomness.
│  ├─ grader.ts          Node half. Import from `@orrery/sim-sdk/grader`.
│  ├─ browser.ts         render layer. Import from `@orrery/sim-sdk`.
│  └─ controls.ts        keyboard-reachable, labelled controls
├─ test/grader.test.ts
└─ LICENCE
```

---

## The one rule that matters

**`model.ts` is pure, and both bundles import it.**

That is `INV-SIM-2`, and it is what lets a simulation be an exam question graded by a server with no
browser involved. Three separate mechanisms enforce it, in increasing order of how early they catch
you:

1. **`tsconfig.grader.json` in the SDK** typechecks `src/grader.ts`'s whole import graph with no `dom`
   lib and no Node types. A `document` reference is a **compile error in your editor**.
2. **`sim:validate`** reads the grader and refuses `Date.now`, `Math.random`, `fetch`, `document` and
   Node builtins, statically and by name.
3. **`sim:build`** reads esbuild's metafile — what a module *actually resolved* — and refuses a grader
   that imports a Node builtin or anything outside the SDK.

If you are about to write `document` in `model.ts`, the code belongs in `browser.ts`.

---

## Why `platform: 'neutral'` for the grader

You will not see this in your own code and should not try to change it. Building the grader for
`platform: 'node'` makes esbuild inject helpers that reference `node:fs`, so the metafile reports
builtins **you never wrote** — and a gate checking that list would either fail a correct grader or,
much worse, be relaxed until it passed.

---

## Writing order

1. **`sim.spec.md` first.** Twelve headings, one page. Section 2 is the learning objective: *if we
   cannot write it, we do not build the sim*. Section 8 is the three misconceptions — *a sim targeting
   no misconception is a toy*.
2. `model.ts`. Pure. If you find yourself needing `document`, stop.
3. `grader.ts`. The strategy in section 6 of the card, and a rationale a teacher can paste into a
   comment. Every helper is symmetric: a student 2% high and a student 2% low earn the same marks.
4. `browser.ts`. The text alternative **quotes the numbers on screen** — a generic description stops
   being true the moment a student moves a slider.
5. `sim.manifest.json` `conformance.expect`, written expecting to **fail the first time**.

---

## Things that will be refused, and why

| Refusal | The reason |
|---|---|
| `STEP_WITHOUT_TIME` | A stepper needs a RANGE. Scenarios are unrelated and may be empty. |
| `WEAK_TEXT_ALTERNATIVE` | A student on a blocked network, or reading a printed worksheet, gets nothing else. |
| `KEYBOARD_REQUIRED` | In graded mode the sim **is** the question surface. A student who cannot operate it has been excluded from the assessment, not accommodated. |
| `DEFAULT_OUT_OF_RANGE` | A sim that starts in a state the author never wrote is a support ticket. |
| `GRADING_MISSING` | An answer nothing can score is not an answer. |
| `PROHIBITED_API` in a grader | One `process.exit()` from a student-triggered grade takes the grading worker down mid-cohort. |
| `budget.maxBytes` exceeded | A student on school wifi has to be able to start the exam. |

---

## Authoring lane etiquette

- **One sim in flight per lane.** Six lanes, one sim each.
- **A batch never lands without its machine gate.** Half-finished batches are worse than small complete
  ones, because a registry with failing sims trains everyone to ignore the gate.
- **Old versions keep serving.** Deprecate, set `replacedById`, warn in authoring. Never break a live
  classroom.
