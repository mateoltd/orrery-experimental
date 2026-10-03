# Forces on a crate — free-body diagram

**Simulation `physics.free-body-diagram` v1.0.0** — P6-T11, gold simulation 18 of 24.

## The task

A crate rests on a rough floor with a rope pulling it, moving at constant speed. Decide which forces act on
it, how large each is in newtons, and which way it points. Three rows: weight, normal force, friction.

## Why this simulation exists

### It is the first one the machine does not grade

Every other gold simulation decides its own marks: a number, a set, a sequence, an ordered pair. A free-body
diagram is none of those. Whether a student who wrote `20 N` for the weight of a 2 kg crate is *wrong*, or
*right and using their school's `g = 10`, is a judgement — and no matcher can make it.

So `grade()` returns a `RUBRIC` decision that awards **zero**, with a reason saying the work has not been
marked yet and naming the bands a marker should apply. The SDK enforces the part that matters:
`rubric()` refuses a decision with no reason, because *a mark nobody can explain cannot be appealed*.

A grader that quietly scored 4 for a textbook answer would have been worse than no grader at all. It would
produce marks that look machine-decided, and a teacher who trusts them will not read the work.

### It counts, which is not the same as scoring

The reason string always carries the counts a marker needs: how many forces were named, how many the
scenario has, and — the ones whose absence makes a review worthless — how many were named that **do not
act**, and how many act but were **misaimed**.

"3 of 3 right" on a diagram with four arrows is a lie by omission, and the omission is exactly what a
reviewer most needs shown.

### `g` is 9.81, and that is the first misconception

A 2 kg crate weighs 19.62 N, not 20. Two decimals, because 19.62 is not 19.6 and the difference *is* the
point. The text alternative gives the mass and the friction — the question's own inputs — and never the
weight.

## The honest part

Every claim carries `correct: null`, never `false`. `false` would be the simulation reporting a judgement it
never made, and a report that says a student's force is wrong is a report a student will be shown.

## Accessibility

- `textAlternative` describes the situation and asks the same question. It names neither the forces nor the
  weight, because which forces act **is** the question.
- Ticking a force and choosing a direction are both keyboard reachable, and the diagram is a table rather
  than a drawing a screen reader has to guess at.
- Arrow length is explicitly *not* to scale, and says so on the drawing itself. A student comparing arrow
  lengths would be comparing something the simulation never encoded.