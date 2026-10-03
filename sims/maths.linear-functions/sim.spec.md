# maths.linear-functions

Change the gradient and the intercept of a straight line, walk points along it, and report where it
crosses the x-axis.

## The model

`y = mx + c`. Two parameters, one question: `x = -c / m`.

## Parameters

| name | label | min | max | default |
|---|---|---|---|---|
| `m` | Gradient | -5 | 5 | 2 |
| `c` | y-intercept | -5 | 5 | 1 |
| `span` | Axis range | 2 | 10 | 5 |
| `showGrid` | Show grid | — | — | `true` |

## Answer

`{ xIntercept }`, where **`null` is a real answer**. With `m = 0` the line is flat and never crosses, so
"there is no crossing" is graded as 4/4 — a student who correctly declines to type a number should not be
marked wrong for it. A number where the answer is "none" scores 0, with feedback that says why.

Graded with `TOLERANCE`, absolute 0.1, max 4 points, partial credit that shrinks with the error.

## What building it caught

Three defects, all of them the same shape: **a value silently arriving as `NaN` or as nothing.**

- `Number(value, fallback)` does not exist. `Number` takes one argument, so the first version graded every
  answer against `NaN` and awarded 0 points to everyone — including a student who was exactly right. The
  feedback even said "the line crosses at x = 2" about an answer of 2.
- `tolerance(given, expected, spec)` wants `abs` and `rel`. The manifest spells the same idea
  `absolute` and `relative`, and passing the long names produced a spec with no tolerance in it. Same
  cause, different spelling: a tolerance of zero that reads as "mark everything wrong".
- `num(spec)` is a spec BUILDER, not a coercion helper. Calling `num(raw.m, 2)` returns `{type: 0}`. This
  is the third time in this phase — the projectile sim's `paramsFrom` made the same mistake, and both
  symptoms were "the maths is wrong for no visible reason".

None of them would have been caught by a manifest check or a type check. Each one graded a real student's
answer wrongly, and each was found by a test that asserted a *specific mark* rather than a shape.

## The test root, and why `sims/` is still not a workspace

`sims/vitest.config.ts` adds a test runner and nothing else. `RN-07` says a simulation resolves the SDK
and the RNG and nothing more — no per-sim `npm install`, no upgrade to reason about, a decade-old bundled
jQuery impossible rather than discouraged. Adding `sims/` to `pnpm-workspace.yaml` to get a runner would
have undone exactly that, so the aliases are declared here instead, pointing at the SDK's source for the
same reason `sim:build` does: a grader tested against a stale `dist` is a grader tested against something
that does not ship.

`_template` and `_fixtures` are excluded. They are scaffolding, not simulations, and the template's grader
test is placeholder text that cannot pass — a permanently red test in a suite is how the real ones stop
being read too.