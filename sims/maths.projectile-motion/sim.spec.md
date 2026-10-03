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

## `conformance.expect` IS SATISFIED, AND NOT BY A PROTOCOL CHANGE

`plans/10` fixes the host command vocabulary to `reset | play | pause | step | loadScenario | focus |
setTheme`, and **none of those asks a simulation for its answer** — an answer is submitted through the
simulation's own control, which is right for a lesson and unreachable for a script.

So this manifest originally declared an empty `expect`, and its spec recorded the field as unsatisfiable.
That was true of the *runner*, not of the platform. The conformance runner now submits the way a student
does, through the simulation's own `#sim-submit` control, after driving the declared script — which closes
the gap for all twenty-four gold sims without touching a protocol the plan has already ratified.

It is clicked through Playwright's frame API rather than `contentDocument`, because the frame is a
sandboxed opaque origin and the parent document cannot see inside it. The first version reached for
`contentDocument`, reported "no #sim-submit control" for a simulation that has one, and would have
persuaded a future author that the field was again unsatisfiable.

And the cell can fail: an `expect.answer.range` of `{min: 900, max: 999}` is reported as
*"expect.answer.range was {min:900, max:999}, the sim answered 63.71"*.

## What the declared script caught

Running `conformance.script` for the first time — rather than ignoring it, which is what the runner used
to do — surfaced two defects immediately:

- `s.step is not a function`. The simulation's step button and its `step` command both called
  `stepper.step(...)`, which the SDK's `Stepper` does not have: movement is
  `dispatch({ type: 'step', direction })`. So pressing "Step forward one frame" threw in a student's face,
  and 1,495 unit tests had not noticed, because none of them clicked that button in a browser.
- The `setParams` step passed `gravity`, which is not a declared parameter, so it was correctly dropped by
  the trust boundary — and silently, which is the SDK behaving correctly and the manifest being wrong.