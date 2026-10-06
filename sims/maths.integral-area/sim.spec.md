# `maths.integral-area` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 135 (P12-T1).

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | maths |
| Topic | Definite integration as the limit of Riemann sums |
| Level | A-level/KS5 |
| Age range | 14–18 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can explain what a Riemann sum is doing and say what happens to it as the width shrinks.

## 3. Interaction model

> Press **Double the number of rectangles** or set the count; the rectangles redraw from the zero line and
> fill inwards; type the left sum, the right sum and the signed area.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`, with `f(x) = x² − 2` over `[0, 2]` and `n` rectangles of width `(2 − 0)/n`:

```
leftSum(n)     = Σ(i = 0 … n−1)  f(0 + i·Δ)·Δ
rightSum(n)    = Σ(i = 1 … n)    f(0 + i·Δ)·Δ
midpointSum(n) = Σ(i = 0 … n−1)  f(0 + (i+½)·Δ)·Δ
exactIntegral  = [x³/3 − 2x]₀² = 8/3 − 4 = −4/3
truncationError(n, sum) = exactIntegral − sum
```

**The integrand is `x² − 2` and not something with a comfortable positive area, on purpose.** The curve is
below the axis for most of the interval, so the signed area is **−1.333…** and misconception (1) — "area
under a curve is always positive" — is contradicted by the arithmetic rather than by a sentence. The
conformance script therefore types `-1.33`, and the grading key is negative.

**Both endpoint sums use the SAME `n`**, by construction. Two independent rectangle counts would make their
difference a comparison of two different questions.

### `truncationError` IS A DIFFERENCE, NEVER A RATIO

The card is explicit that a percentage of the sum "would blow up when the sum is near zero", and the left sum
does pass through zero as `n` changes. The error is reported in the function's own units.

## 5. Answer semantics

`{ leftSum: number, rightSum: number, signedArea: number }`, all three **negative** at the declared
parameters.

## 6. Grading strategy

`TOLERANCE` · `partialCredit: true` · `maxPoints: 4` — 1.5 for each sum, 1 for the exact signed area.

### TOLERANCE CLASS T-D, `abs: 0.005` AND `rel: 0.005`, AND WHICH ONE BINDS

`withinTolerance` takes the LARGER of `abs` and `rel × max(|given|,|expected|)` (`grading.ts:190`), so a
declared band is the wider of the two and a card that declares both must say which is in force. At
`rectangles: 8`:

| field | value | `rel: 0.005` gives | `abs: 0.005` gives | in force |
|---|---|---|---|---|
| `leftSum` | −1.8125 | 0.0091 | 0.005 | **`rel`** |
| `rightSum` | −0.8125 | 0.0041 | 0.005 | **`abs`** |
| `signedArea` | −1.33333 | 0.0067 | 0.005 | **`rel`** |

Both are asserted in the tests at a magnitude where each is the binding bound: a 0.0045 error on `rightSum`
is inside the band only because `abs` is in force, and a 0.008 error on `leftSum` is inside it only because
`rel` is. Declaring `rel: 0.002` would have been narrower than `abs` on every field — a tolerance a reviewer
reads as a guarantee the arithmetic never exercises.

### THE FALSE-WRONG ANSWER THIS SIMULATION IS BUILT TO AVOID

`asNumber` strips everything outside `[0-9.eE+-]` (`grading.ts:155`), so a student who types the **true
minus sign U+2212** — which is what a word processor produces — has it *removed* rather than translated, and
a correct `−1.8125` arrives as `1.8125`. `normaliseNumber()` (`src/model.ts:98`) repairs the sign, the
en-dash and a Unicode thousands separator, and **nothing else**: a student who writes `2x10^-3` still gets
the `210` the card names as the trap, because that is a different mistake and the function is not here to
hide it.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `rectangles` | 2 … 64 | 8 | — | no |

**Seed strategy S-0 · deterministic.** No draw anywhere. The key is a function of one declared integer, so
the generator is invertible without a seed.

## 8. Misconceptions targeted

1. Area under a curve is always positive. *(the answer is −1.33)*
2. Doubling the rectangle count halves the error. *(first order for the endpoints; the midpoint sum is a quarter, and the test asserts both rates)*
3. The definite integral is the value of the antiderivative at the upper limit. *(it is `F(2) − F(0)`, and `F(0) = 0` here, so the answer is `8/3 − 4` rather than `8/3`)*

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab to **Double the number of rectangles**, then the three labelled inputs, then Submit. |
| Announced | One announcement per refinement, not per frame. |
| Text alternative | `describeSums()` — derived, quoting the three sums it is describing. |

Modality is `canvas`, and the canvas is `aria-hidden`: **every drawn rectangle is a row of a real
`<table>`** — number, both ends, the height at the left end, and the signed area — with a `<tfoot>` carrying
the running left sum. The control that produced each row is a button, not a hit-test.

**Nothing here reads a clock.** The drawing refines by a declared integer, so the canvas and the grading
request are the same picture (`INV-SIM-2`, `INV-TIME-1`).

## 10. Fallback

The rectangle table and the text alternative are DOM, so a blocked network costs the student the drawing and
nothing else.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`.

## 12. Conformance script and expected grade

```jsonc
"type":   { "left-sum": "-1.81", "right-sum": "-0.81", "signed-area": "-1.33" }
"expect": { "answer": { "leftSum": { "min": -1.815, "max": -1.81 }, … }, "grade": 4 }
```

The fields are reported as **numbers**, so a range can be declared: `matches` in
`scripts/sim-conformance.mjs:381` returns `false` for a numeric expectation against a string answer, which
would otherwise have made a checked expectation impossible for this simulation. The submitted values are the
two-decimal rounding the item asks for, and the ranges contain them exactly.