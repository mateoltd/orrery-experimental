# maths.sequence-next

Read a sequence of numbers, find the rule, and type the term that comes next.

## Why this simulation exists at all

It is the first gold simulation whose content **depends on the seed**. Two students with different seeds
see different sequences; the same student sees the same one on every re-sit. Nothing else in the gold set
exercises the path from the host's seed policy through `deriveSeed` into a simulation's own randomness,
and that path is the thing that makes a randomised question safe to retry.

The randomness lives in **one function** in `model.ts`, taking a seed. Nothing calls `Math.random`, and
the grader reconstructs the sequence from the seed it was given rather than from anything the browser
remembered — so a grade can be recomputed on a server that has never seen the student's browser.

## `EXACT` grading, and why

A student's answer is a whole number. A floating-point tolerance invites an argument about whether
30.0000001 is 30, and on a "what comes next" question there is no partial credit to award for being nearly
right about a pattern.

## THE TEXT ALTERNATIVE DOES NOT CONTAIN THE ANSWER

The first version ended its alternative with *"The next term is 41"*. That means a blocked student reads
the answer instead of the question, and a printed worksheet carries its own solution. The alternative now
describes the sequence and states the rule; the answer lives in the grader, and reaches the student in the
feedback — where someone who has tried has earned it.

There is a test that asserts the absence, for every seed it tries, because this is exactly the kind of
regression that reads as a feature when someone reviews the copy.

## No declared expectations, deliberately

The answer depends on the seed, which the manifest cannot know — so `conformance.expect` is empty rather
than plausible-looking. The first version declared `expect.grade: 4` with no `expect.answer`, and that
**passed vacuously**: the grade claim is only evaluated once an answer exists, and no answer existed,
because nothing submitted one. The runner now refuses that combination outright:

```
expect.grade is declared but expect.answer is not, so there is no answer to grade and the claim is
never checked. Declare the answer, or drop the grade claim.
```

Demonstrated by running it: with the claim in place the cell fails with exactly that sentence.

## Manifest validation is strict, and correctly so

The first lifecycle heights (`defaultHeight: 200`, `minHeight: 160`) were rejected with
`#/lifecycle/defaultHeight minimum: below 240`. That is the schema doing its job: a simulation whose frame
is shorter than the minimum is clipped, and a clipped control bar is a control a student cannot reach.
