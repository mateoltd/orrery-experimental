# maths.quadratic-roots

Read the coefficients of a quadratic, look at its curve, and type the roots it has.

## Why this simulation exists

It is the first gold simulation with **more than one graded quantity**, so it is the first to exercise
partial credit *across parts*. `plans/20` needs that in P7 for every multi-part question, and building it
here means the multi-part path is exercised by a simulation rather than only by the grading service's own
tests — a grading service whose first multi-part question is a production incident is a grading service
that was tested only on single-value answers.

## Three shapes of answer from one question

- **Two distinct roots** — `x² - 4x + 3` crosses twice.
- **One repeated root** — `x² - 4x + 4` touches once, and `2` is the complete answer.
- **No real roots** — `x² + 4` never crosses, and **leaving both boxes empty is the only correct answer.**

## The order the roots are written in is not part of the answer

`1, 3` and `3, 1` are the same answer. Matching is done against the *set* of expected roots, each given
root against the nearest **unused** expected root — so one correct root cannot be "found" twice, and any
maximal matching gives the same total because every root is worth the same. A positional comparison would
mark a correct pair wrong half the time.

## Two defects this simulation found

**A REPEATED ROOT SCORED HALF.** The first version awarded a fixed price per root, so `(x - 2)²` — one
root, typed correctly as `2` — earned 2 of 4. The award is now **proportional to what was asked for**:
`matched / expected.length`, so a single root is the whole question when there is only one.

**THE TEXT-ALTERNATIVE TEST WAS WRONG BEFORE THE CODE WAS.** It asserted the alternative does not contain
`"3"` — which fails on the *constant term* of the equation `x² - 4x + 3`. The equation is the question and
belongs there. What must not appear is a statement *of the answer*, so the test now asserts the text
never says "roots are" while still requiring the shape claim.

## A note the schema enforced

`expect.answer.roots` is declared as `{set: [-1, 3]}` in the first version, for `(x + 1)(x - 3)` — which is
`x² - 2x - 3`. The declared expectation was wrong, the simulation was right, and the cell said so plainly:
*"the sim answered [1, 3]"*. A declared expectation that is checked is worth more than one that is
trusted; this is the argument for the whole mechanism.
