# `chemistry.solution-concentration` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 48 (P12-T1).

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | chemistry |
| Topic | Molarity, ppm and dilution |
| Level | GCSE/KS4 (A-level entry) |
| Age range | 13–16 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can work out a dilution's concentration and convert between molarity and ppm.

## 3. Interaction model

> Choose **add water** or **make up to a volume**, and set the starting molarity, the starting volume, the
> water added, the total volume and the molar mass; the two beaker tables redraw; type the diluted molarity,
> the ppm and the amount in moles.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`:

```
moles            = molarity × volume / 1000                    (dm³, not cm³)
finalVolume      = volume + water                 when method = 'add'
                 = finalVolume                     when method = 'make-up'
dilutedMolarity  = molarity × volume / finalVolume
ppm              = (moles × molarMass) / (finalVolume / 1000) × 1e6
```

**The two methods never share an arithmetic step.** That is the card's focus: "the sim distinguishes 'add 100 cm³
of water' from 'make up to 100 cm³' as two DIFFERENT scenarios — that distinction is the row's focus and a sim
with a single 'dilute' action cannot ask it."

`finalVolume` is **floored at the starting volume**, so "make up to 50 cm³" from 200 cm³ is clamped rather than
silently removing solute — a dilution that quietly removed solution is a different experiment.

## 5. Answer semantics

`{ molarity: number, ppm: number, moles: number }` — all three strictly positive for every legal parameter set.

## 6. Grading strategy

`TOLERANCE` · `partialCredit: true` · `maxPoints: 4` — 2 marks for the molarity, 1 for the ppm, 1 for the moles.

### TOLERANCE CLASS T-C: `rel: 0.005` AND **NO `absolute` KEY AT ALL**

T-C means "relative only", and `withinTolerance` takes `max(abs, rel × max(|given|,|expected|))`
(`grading.ts:190`) — so an absolute bound declared *beside* a relative one **widens** the band rather than
narrowing it, and an absolute bound *alone* accepts everything near zero. `abs` is therefore absent from the
`ToleranceSpec` object rather than set to a small number. `test/grader.test.ts` asserts
`'abs' in TOLERANCE === false`, because the absence **is** the declaration.

### AND T-C IS ONLY CORRECT BECAUSE NO LEGAL PARAMETER SET MAKES AN ANSWER ZERO

Its named trap is "wrong when the answer can legitimately be 0 for a whole parameter range — then it is T-D".
Here the amount of solute cannot change, so `moles ≥ 0.01 × 0.010 = 1e-4`, and both concentrations scale with
it. A sweep over the ends of every declared range × both methods × four molar masses asserts all three
answers are `> 0` and finite. That sweep is the evidence for T-C over T-D.

### WHY 0.5% IS THE RIGHT WIDTH

It is a **data-ambiguity** band, not slack: molar masses are tabulated to varying precision, a student's table
will differ, and the ppm answer inherits that difference directly. The tests assert that a 0.4% difference in
the molar mass earns full marks and a 2% one does not.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `molarity` | 0.01 … 2 | 0.1 | mol/L | no |
| `volume` | 10 … 500 | 50 | cm³ | no |
| `water` | 0 … 500 | 50 | cm³ | no |
| `finalVolume` | 10 … 500 | 100 | cm³ | no |
| `method` | `add` \| `make-up` | `make-up` | — | no |
| `molarMass` | 1 … 200 | 58.44 (NaCl) | g/mol | no |

**Seed strategy S-0 · deterministic.** No draw anywhere; the key is a function of six declared parameters, so
the generator is invertible without a seed.

## 8. Misconceptions targeted

1. **The card's misconception (1) is arithmetically TRUE as written and cannot be targeted.** "Adding 100 cm³
   of water to 100 cm³ of solution halves the concentration" is correct: `c₂ = c₁ × 100/200 = c₁/2`. It is at
   `docs/11-SIM-CARDS.md:487`. The misconception this simulation *can* target, and does, is **reading "make up
   to 100 cm³" as "add 100 cm³"** — from 50 cm³ those give 100 cm³ and 150 cm³, and a student who conflates
   them is out by a factor of 1.5. §2 of `src/model.ts` records the discrepancy.
2. Molarity and ppm are interchangeable. *(two declared units, both reported, with a conversion that needs
   the molar mass)*
3. Dilution changes the amount of solute. *(`moles` is a function of the STARTING volume only, and the test
   asserts it is unchanged by a four-hundred-fold addition of water)*

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab through the parameters, then the three labelled inputs in reading order, then Submit. |
| Announced | Nothing is spoken while the student is typing; the verdict is spoken on submit. |
| Text alternative | `describeSolution()` — derived, and it names the verb. |

Modality is `form`, and the card says "the form is the whole interaction — there is no canvas to mirror". There
is deliberately **no beaker drawing**: a diagram would be the one thing on the page a screen-reader user could
not read while adding nothing a labelled number does not already say. Two `<table>`s carry the before and after
states, each with a caption whose second column names the VERB in words.

## 10. Fallback

Both state tables and the text alternative are DOM, so a blocked network costs the student nothing.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`.

## 12. Conformance script and expected grade

```jsonc
"type":   { "molarity": "0.05", "ppm": "2922", "moles": "0.005" }
"expect": { "answer": { "molarity": { "min": 0.0497, "max": 0.0503 }, … }, "grade": 4 }
```

The script sets `method: "make-up"` explicitly, so the cell is testing the harder of the two paths and the
declared grade is `4` rather than a vacuous pass.

**No `absolute` appears in `grading.tolerance`.** `checkManifestRules` only demands a bound for
`strategy: "TOLERANCE"` and accepts one of either kind
(`packages/contracts/src/sim-manifest/index.ts:320-334`), so a relative-only declaration is legal — and the
`Expectation` values are all **ranges**, because `matches` in `scripts/sim-conformance.mjs:381` returns
`false` for a numeric expectation against a non-numeric answer.