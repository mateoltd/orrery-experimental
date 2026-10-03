# maths.pythagoras

Look at a triangle drawn to scale and name its longest side.

## Why set grading

"Which side is the longest?" has three answers, and with sides 6, 6 and 5 it has **two** correct ones.
This is the first gold simulation to need set grading, and `plans/20` requires it in P7 for multi-select
question types — so building it here means the SDK's set helpers are exercised by a simulation rather
than only by their own tests.

The rule, stated precisely: **the student must name a non-empty subset of the longest sides.** Naming one
of two tied longest sides is a complete answer. Naming all three sides is not a better answer than naming
one; it is not an answer.

## Every name for a side is accepted

`12`, `c`, `hyp` and `hypotenuse` all answer the same question, and refusing two of them would be
pedantry dressed as rigour. Answers are split on commas *and* spaces, so `a or b`, `a, b` and `a b` are
the same two answers.

## Drawn to scale, because a diagram that is not teaches the opposite of the truth

## Three defects this sim found, all in the GRADER rather than the model

**SLICING THE EXPECTED SET TO THE STUDENT'S SET SIZE COMPARED "b" AGAINST "a".** The first attempt at
"a non-empty subset" expressed it by shortening the expected set and calling `setMatch` — so with sides
6, 6, 5, answering "a" scored 4 and answering "b" scored 0. Both are correct answers. The rule is now
plain containment, and `setMatch` is kept only for what it is actually good at: making the comparison
order-independent.

**THE TEST'S PREMISE WAS WRONG BEFORE THE CODE WAS.** It used 5, 5, 7.07 — an isosceles *right* triangle,
where the hypotenuse is longest on its own and the tie does not exist. The cases that did not check the
tie passed for the wrong reason, and the one that did failed. A test written about a case you have not
checked is not a test.

**AN ARRAY-VALUED `name` PARSED AS AN EMPTY SET.** The simulation sends `{name: ['a','b']}` when a
student typed more than one side, and the parser read only a string — so a correct two-answer reply scored
0 with "Name a side" as its feedback.

## The manifest needed a new field, so it got one properly

`conformance.type` — what a *student* would enter — is now in the Zod mirror and the JSON Schema, with a
comment saying why it is not `expect`. Both schemas are strict by design (`additionalProperties: false`),
so a field the runner needs must be declared in both or the manifest is rejected for the right reason.
