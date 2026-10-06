# `biology.genetics-punnett` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 14 (P12-T1). The card in `docs/` is the specification; this file
is the reviewer's page, and it records the two places where the card under-specifies and an author had to
declare rather than guess.

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | biology |
| Topic | Mendelian inheritance — completing a Punnett square |
| Level | GCSE/KS4 |
| Age range | 13–16 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can complete a Punnett square and read the ratio a genotype maps to.

## 3. Interaction model

> Choose the two parents and which allele is dominant; the gametes appear as the square's row and column
> headings; type the four offspring genotypes and the ratio.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`. A child is a pair of gametes, one from each parent:

```
gametes(g)        = [g[0]]            if g[0] === g[1]      (one allele)
                  = [g[0], g[1]]      otherwise              (two alleles)
cell(top, side)   = normaliseGenotype(top, side, dominant)
ratio             = count(AA) : count(Aa) : count(aa)      over all three genotypes
```

`normaliseGenotype` puts the dominant allele first and does **not** change any allele's case. Swapping which
allele is written first is handwriting; swapping an allele's case is the misconception, and the two are
deliberately not treated alike.

## 5. Answer semantics

`{ offspring: string[], ratio: string }`. Four genotypes with repeats (the repetition is what makes
`1:2:1`), and a ratio written over **all three** genotypes so a zero is shown: `Aa × aa` is `0:1:1`, not
`1:1`.

## 6. Grading strategy

`SET` · `partialCredit: true` · `maxPoints: 4` — 2 marks for the genotype set (Jaccard, `grading.ts:396`),
2 for the ratio.

**Tolerance class T-G, and `caseSensitive: true` is the whole card.** `grading.ts:370` folds case by
default, which would compare the recessive answer against the dominant list and mark it CORRECT — a false
right answer for the exact misconception the simulation exists to expose.

### THE HAZARD THE CARD NAMES, AND WHAT IT COST THIS GRADER AN EXTRA STEP

`caseSensitive: true` swaps `canonicalText` for the **identity** function, so it stops folding case *and*
stops trimming whitespace. A student who types `AA, Aa, aa, aa` — which is what every keyboard's habit
produces — would then match nothing and score 0 for a correct square.

The SDK cannot be changed from inside a simulation, so `trimEntries()` (`src/model.ts:98`) and
`canonicalRatio()` (`src/model.ts:117`) put the whitespace normalisation back **by hand**: space is the
keyboard, case is the biology, and only one of them is the question. `test/grader.test.ts` asserts both
halves.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `parentA` | `AA` \| `Aa` \| `aa` | `Aa` | — | no |
| `parentB` | `AA` \| `Aa` \| `aa` | `Aa` | — | no |
| `dominant` | `A` \| `a` | `A` | — | no |

**Seed strategy S-0 · deterministic.** `randomised: false`, no draw anywhere, and the generator is
invertible without one: the marking key is a function of the three declared parameters alone.

## 8. Misconceptions targeted

1. Every cell in the square holds the same genotype.
2. A `3:1` ratio means 75% of any one family has the dominant phenotype.
3. A cross with one homozygous parent has a `1:1` ratio, with the homozygous parent named.

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab to each parent dropdown, then the two labelled text inputs in reading order, then Submit. |
| Text alternative | `describeCross()` — **derived, never hard-coded**, so it quotes the ratio it is describing. |
| Reduced motion | Nothing moves. The card's `reducedMotion: true` is a factual claim about this simulation, not a promise to honour a media query. |

Modality is `form`, so there is no canvas and nothing to mirror. The square is a real `<table>` with a
`<caption>` and `<th scope>`, which is why it is readable at all.

## 10. Fallback

The text alternative plus the table, both of which are DOM rather than canvas. Nothing here needs
JavaScript to be understood; only the *typing* does.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`. Both are mandatory manifest fields and both are validated, not reviewed
(`packages/contracts/src/sim-manifest/index.ts:60-72`).

## 12. Conformance script and expected grade

```jsonc
"type":   { "offspring": "AA, Aa, aa, Aa", "ratio": "1 : 2 : 1" }
"expect": { "answer": { "offspring": { "set": ["AA","Aa","aa","Aa"] },
                        "ratio":     { "exact": "1 : 2 : 1" } },
            "grade": 4 }
```

**The spaces in `"1 : 2 : 1"` are deliberate.** The declared expectation is the string a student types, not
the canonical form, so the conformance cell fails if the whitespace normalisation in §6 is ever removed.

`expect.offspring` is the four-entry list including the repeat, because the runner's `set` matcher compares
lengths (`scripts/sim-conformance.mjs:389-406`) and would refuse a three-entry claim about a four-cell
square.