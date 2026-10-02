# maths.projectile-motion

Launch a ball at a speed and an angle; watch where it lands, and report the range.

## The model

`R = v² sin(2θ) / g`, computed by integrating the trajectory rather than by the closed form, so the
screen and the grader cannot disagree by construction. `g` is fixed at 9.81 m/s² and is **not** a
parameter: a simulation about projectiles that lets a teacher set gravity is a different simulation.

## Parameters

| name | label | unit | min | max | default |
|---|---|---|---|---|---|
| `speed` | Launch speed | m/s | 5 | 60 | 25 |
| `angle` | Launch angle | degrees | 5 | 85 | 45 |
| `showTrail` | Show trail | — | — | — | `true` |

## Answer

`{ range, time }`, both rounded to two decimal places. Graded with `TOLERANCE`, absolute 0.5 m,
max 4 points, partial credit.

## A FINDING ABOUT `conformance.expect`, NOT AN OMISSION

This manifest declares a `conformance.script` and an EMPTY `conformance.expect`, and that emptiness is a
result rather than a gap in the work.

`plans/10` fixes the host's command vocabulary to `reset | play | pause | step | loadScenario | focus |
setTheme`. None of those asks a simulation for its answer — an answer is submitted by the student through
the simulation's own control, which is correct for a lesson and unreachable for a script. So
`conformance.expect.answer` and `conformance.expect.grade`, which the schema permits, cannot be
satisfied by any declared script, and filling them in would have been a promise nothing could keep.

The conformance matrix obtains the answer the way a student does — by activating the submit control — and
grades it in bare Node, so both claims are still checked. This one is not.

**P6-T11 should close this.** Twenty-four gold sims each need a way to be *asked* for their answer, or
every one of them carries an expectation field that cannot be satisfied, and the field teaches authors to
write checks that never run.

## What the declared script caught

Running `conformance.script` for the first time — rather than ignoring it, which is what the runner used
to do — surfaced two defects immediately:

- `s.step is not a function`. The simulation's step button and its `step` command both called
  `stepper.step(...)`, which the SDK's `Stepper` does not have: movement is
  `dispatch({ type: 'step', direction })`. So pressing "Step forward one frame" threw in a student's face,
  and 1,495 unit tests had not noticed, because none of them clicked that button in a browser.
- The `setParams` step passed `gravity`, which is not a declared parameter, so it was correctly dropped by
  the trust boundary — and silently, which is the SDK behaving correctly and the manifest being wrong.