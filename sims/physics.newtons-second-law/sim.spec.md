# physics.newtons-second-law

Choose a net force, a mass and an acceleration, say which quantity you want, and calculate it from
`F = ma`.

## Three parameters, one of which is ignored

| name | label | unit | min | max | default |
|---|---|---|---|---|---|
| `force` | Net force | N | 0 | 60 | 12 |
| `mass` | Mass | kg | 0.5 | 20 | 3 |
| `accel` | Acceleration | m/s² | 0.5 | 20 | 4 |
| `solveFor` | Find the | — | — | — | `acceleration` |
| `showArrow` | Show the force arrow | — | — | — | `true` |

The parameter being solved for is **ignored**, and the panel says which two are the givens. "Find the mass"
uses force and acceleration, not mass — because `m = F/a` with `a` itself computed as `F/m` is circular,
and it hands back the mass it was given.

## The answer names its quantity

`{ quantity, value }`. Answering the right *number* for the wrong *quantity* is **0**, with feedback saying
which quantity was asked for. A grader that assumed one answer shape would award full marks for a
correctly-computed acceleration when the question was about mass — the kind of mistake that reads as
generosity.

## There are two ways there is no mass, and both are graded

- `a = 0` is indeterminate: any mass gives zero net force, so `F` says nothing.
- `F = 0` at a non-zero acceleration gives a mass of **zero**, which is not a mass.

The second was missed by the first version, which returned `0` and told a student who had correctly said
"there is none" that *"the mass is 0 kg"*.

## Three defects this sim found, and the argument for the manifest's own expectations

**THE GRADER'S SIGNATURE WAS WRONG IN THREE SIMS.** `defineSim`'s grader half is
`grade(state, params, answer)` — three positional arguments and no context object. Three of my gold sims
were written as `grade(answer, context)`, so the SDK handed them the *parameters* as the answer and the
*answer* as the parameters: `parseAnswer` failed, every answer scored 0, and the conformance cell that
grades in bare Node printed a confident number derived from the wrong things. It passed for the projectile
sim because that one had it right, and passed for the other two because neither declared
`expect.grade` — so the broken path was never compared against a claim.

**THE TOLERANCE IS THE SIM'S, NOT THE CALLER'S.** `grade(state, params, answer)` has no tolerance
argument, because the tolerance belongs to the simulation; the per-item tolerance a teacher sets in P7 is
applied by the grading service. All three sims now declare `TOLERANCE` once, matching the manifest.

**THE MODEL WAS CIRCULAR**, above. The declared `expect.grade` caught it on the first run, and the
`conformance.type` field that lets a scripted host enter a student's answer is what made it checkable.

## What the runner learned from this sim

- **`conformance.type`** — what a *student* would enter, kept separate from `conformance.expect` because
  they answer different questions. Typing `expect.answer` into the field and then asserting the sim reports
  it would be a test that cannot fail for the reason anyone would write it.
- **`expect.answer.quantity: { in: ['mass'] }`** — a set membership form, needed for enum-valued answers.
- **Params are a RECORD for the grader.** `gradeStoredState` runs them through `clampParams`, which reads
  by name; given the registry's array of `{name, default}`, every value came back `undefined`.
