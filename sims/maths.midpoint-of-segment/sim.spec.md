# Midpoint of a line segment

**Simulation `maths.midpoint-of-segment` v1.0.0** — P6-T11, gold simulation 17 of 24.

## The task

A line segment joins two labelled points. Work out the coordinates of its midpoint.

The picture draws the **segment and its endpoints**, and nothing else. The midpoint is *not* marked, because
drawing the answer on the question is not a hint.

## Why this simulation exists

Two things in the platform needed a real simulation rather than a unit test.

### 1. An ORDERED pair, graded per component

Every other simulation answers with a value, a list of values, or a sentence. A midpoint is `(x, y)`, and a
student who types the right two numbers in the wrong order has not found the midpoint.

So:

- the answer travels as an **ordered list**, and the conformance expectation is `{ sequence: [-1, 3] }`;
- marks are **per component** — 2 for each correct coordinate, out of 4.

A student who averages only the x-coordinates has produced half an answer that is not wrong so much as
incomplete, and half marks are the honest award.

### 2. The first simulation with a NEGATIVE number in the answer

Nothing else in the seventeen asks for one. A midpoint between `(-4, 7)` and `(2, -1)` is `(-1, 3)`: the
x-coordinate is negative even though one endpoint's x is negative and the other's is positive.

Averaging magnitudes gives `3`, and the picture shows why that is wrong — `(3, 3)` is nowhere near the line
through the two endpoints, while `(-1, 3)` lies exactly on it. **The midpoint lies between its endpoints AND
on the segment**, and the second half of that is invisible on a bare question. `liesBetween` is exported so
a test can assert the property rather than three example answers.

## The three ways a submission goes wrong

| Submission | Marks | Code | Why it is separate |
| --- | --- | --- | --- |
| `(-1, 3)` | 4 | `CORRECT` | — |
| `(-1, 9)` | 2 | `PARTIAL` | y is wrong; the feedback names **y**, not "wrong" |
| `(-1, …)` | 0 | `MIDPOINT_INCOMPLETE` | A coordinate needs both numbers |
| `…` | 0 | `UNPARSEABLE` | Not a pair |

The last two are kept apart because they mean different things. The first version returned `UNPARSEABLE`
for a half-filled answer, which is indistinguishable from typing "banana" and told a student who had done
half the working that they had typed it wrongly.

**A blank box is `null`, not `0`.** `Number('')` is `0`, and `0` is a plausible midpoint coordinate, so a
student who filled in one box and left the other would be recorded as having answered `(3, 0)` — and for a
segment that crosses an axis, that is within tolerance of a correct answer. A missing component has to stay
missing, or "half right" cannot mean anything.

## Accessibility

- The canvas has `aria-hidden`-equivalent text: `textAlternative` describes the segment and asks for the
  same coordinates, and **does not give the midpoint away**.
- Both boxes are keyboard reachable and individually labelled by coordinate name.
- `reducedMotion` is declared; the drawing is static.
- The visible endpoints are labelled with their own coordinates, which the question already supplies, so
  the picture carries a usable scale without carrying the answer.