# `astronomy.tides` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 8 (P12-T1).

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | astronomy |
| Topic | Tidal harmonics — spring and neap tides, and basin resonance |
| Level | GCSE/KS4 (A-level entry) |
| Age range | 13–16 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can say why spring tides coincide with the new and full moons, and what resonance does.

## 3. Interaction model

> Set the basin's natural period, the number of hours to plot and the lunar phase day; the tide curve redraws
> with its high and low waters marked; type the range, the semidiurnal period, the amplification and whether
> the basin is near resonance.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`. Two constituents, summed:

```
M2:  T = 12.4206012 h, amplitude A_M2 = 1 m
S2:  T = 12.0000 h,   amplitude A_S2 = 0.46 m
height(t) = m2·cos(2πt/T_M2 + 2π·phase/29.530588) + s2·cos(2πt/T_S2)
envelope(t) = |m2·cos(2πt/T_M2 + φ)| + |s2·cos(2πt/T_S2)|

amplification(T) = 1 / √( (1 − (T/ω₀)²)² + (T/(Q₀ω₀))² ),  Q₀ = 30 (DECLARED, not a parameter)
m2 = A_M2 · amplification(T_M2),  s2 = A_S2 · amplification(T_S2)
beat = 1 / |1/T_M2 − 1/T_S2| = 354.37 h = 14.77 DAYS
```

**There is no rule in this file that says "spring tides happen at the new moon."** The beat is what two
closely-spaced frequencies do when they are added, and `test/grader.test.ts` proves it three ways: successive
argmaxima of the envelope are one beat apart; the envelope's extremes are exactly `m2 + s2` and `|m2 − s2|`,
which are properties of interference rather than of any calendar; and `phase` slides the envelope without
changing its peak, so a basin can have its biggest tide on any day of the cycle.

**Resonance is a THRESHOLD on a computed number** (`RESONANT_AMPLIFICATION = 10`), not a lookup. At
`natural == T_M2` the amplification is exactly `Q₀ = 30` — finite and reachable, which is what makes "nearly
resonant" a measurable band: a basin 1% off the natural period is still reported resonant, and one 25% off
is not. The card asks for a simulation that can produce a resonant tide; one that could not would teach that
tides are always small.

## 5. Answer semantics

`{ range: number, period: number, resonant: boolean, amplification: number }` — metres, hours.

`range` is sampled on a **whole-minute grid**, not found by scanning for a turning point, because a range
found that way depends on the step size — a number the marking key and the drawing would have to agree about
for no pedagogical reason.

### THE CARD'S BEAT FORMULA IS DIMENSIONALLY WRONG BY A FACTOR OF 24

The card writes "a student computing `1/(1/12.42 − 1/12.00)` from 2-dp inputs gets 14.6 days". That
expression evaluates to **354.4, and it is in HOURS**: the two reciprocals are in h⁻¹, so their difference
and its reciprocal are in hours. The card's own figure, 14.77 days, is right and the formula is missing a
division by 24. `beatPeriodHours()` and `beatPeriodDays()` are separate functions in the model so the unit is
never inferred, and §7 of this card records the discrepancy.

## 6. Grading strategy

`TOLERANCE` · `partialCredit: true` · `maxPoints: 4` — 1.5 for the range, 1 for the period, 0.5 for the
amplification, 1 for the resonance verdict.

### TOLERANCE CLASS T-C: `rel: 0.05` AND NO `absolute` KEY AT ALL

`withinTolerance` takes `max(abs, rel × max(|given|,|expected|))` (`grading.ts:190`), so an absolute bound
declared beside a relative one **widens** the band. `abs` is therefore absent, not set to a small number.
`test/grader.test.ts` asserts `'abs' in TOLERANCE === false`, because the absence is the declaration.

### AND T-C IS ONLY CORRECT BECAUSE NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO

Its trap is "wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D". The
range is bounded below by `A_S2 × amplification > 0`, the amplification is bounded below by `A_M2 ×
amplification > 0`, and the period is the constant `T_M2`. A sweep over the ends of every declared range
confirms all three, and that sweep is the evidence for choosing T-C over T-D.

### WHY 5% IS THE RIGHT WIDTH AND NOT SLACK

The card's float hazard is the beat's poor conditioning, and the same generosity is honest for a range read
off a curve to the nearest tenth. A 4% error earns full marks; a 20% error does not. Both asserted.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `natural` | 1 … 30 | 12.4206012 (M2) | h | no |
| `hours` | 1 … 720 | 168 | h | no |
| `phase` | 0 … 29.53 | 0 | d | no |

**Seed strategy S-0 · deterministic.** No draw anywhere; `Q₀` is a declared constant rather than a parameter
for the same reason `R` is not a parameter in `chem.ideal-gas-law`.

## 8. Misconceptions targeted

1. Spring tides happen at the quarter moons. *(`phase` slides the envelope without changing its peak)*
2. Tides are caused by the Sun alone. *(the envelope's peak is more than twice its trough, and that gap is S2)*
3. The Moon's phase changes the tide's period. *(the semidiurnal period is `T_M2` at every phase; only the
   envelope's position moves)*

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab through the parameters, then the four labelled inputs, then Submit. |
| Announced | One announcement per change, never per frame. |
| Text alternative | `describeTides()` — derived, and it states the beat rather than expecting the student to derive it. |

Modality is `canvas`, and the canvas is `aria-hidden`. The last four high waters and the last four low waters
are a real `<table>` with a caption, and the range quoted in the caption is `tidalRange(params)` from the
model — the same number the grader reads, not a measurement off the drawing.

## 10. Fallback

The extremes table and the text alternative are DOM, so a blocked network costs the student the curve and
nothing else.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`.

## 12. Conformance script and expected grade

```jsonc
"type":   { "range": "72.41", "period": "12.4206", "amplification": "30", "resonant": "yes" }
"expect": { "answer": { "range": { "min": 71.4, "max": 73.4 }, …, "resonant": { "in": [true] } }, "grade": 4 }
```

The default `natural` is M2 itself, so the default item is a resonant basin and its amplification is exactly
30 — the largest the declared ranges allow, and the clearest demonstration that a resonant tide exists.

`resonant` is declared `{"in": [true]}` rather than a bare `true`, because `$defs/expectation` in
`schemas/sim.manifest.schema.json` is `number | object` and **refuses a boolean**; `{"in": [...]}` is the
schema's own vocabulary for "the answer is one of these" and compares with `JSON.stringify`.