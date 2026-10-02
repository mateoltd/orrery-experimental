# SUBJECT.slug — the spec card

**Cards are reviewed before the code.** One page. `plans/10` §7. An agent can be handed this card, the
template, and produce a reviewable simulation — which is what makes six parallel author lanes
tractable rather than a hope.

Anything left as `REPLACE:` below is unfinished work, and the reviewer's job is to find it.

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | maths |
| Topic | REPLACE |
| Level | REPLACE |
| Age range | 13–18 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> REPLACE: "By the end you can …"

If we cannot write this, we do not build the sim. A sim with no objective is a toy, and a toy in a
gradebook is a fairness problem rather than a wasted afternoon.

## 3. Interaction model — what the student does, in verbs

> REPLACE: drags / clicks / types / steps …

## 4. Model — the maths, stated precisely enough to be CHECKED

```
REPLACE: the actual equations, with the symbols defined
```

This is `src/model.ts` in prose. It must be pure: no DOM, no clock, no unseeded randomness — because
the same function draws the canvas and answers the server's grading request.

## 5. Answer semantics — what counts as correct, and every equivalent form

> REPLACE: "the horizontal range, in metres, to the nearest 0.5 m"

Every equivalent form matters. If a student can legitimately answer `v²sin(2θ)/g`, then that is a
correct answer, and a sim that only accepts a decimal teaches them to avoid the formula.

## 6. Grading strategy

`EXACT | TOLERANCE | SET | NUMERIC | RUBRIC` — **REPLACE**, with the partial-credit rule.

Partial credit is OFF unless the manifest says `partialCredit: true`. A four-mark item should not
silently hand out two marks for half an answer.

## 7. Parameters and variants — which vary per student, and the sensible ranges

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| REPLACE | | | | |

**If the item is parameterised, the generator MUST be invertible** (`06` §5.1). "What was the right
answer for THIS student?" has to be re-derivable from the stored seed three years later.

## 8. Misconceptions targeted — the three specific wrong ideas this sim exists to expose

1. REPLACE
2. REPLACE
3. REPLACE

This is the pedagogical heart. **A sim targeting no misconception is a toy.** The three are what the
reviewer judges against.

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | REPLACE: what reaches the sim, in order |
| Text alternative | REPLACE — and it QUOTES the numbers on screen |
| Reduced motion | REPLACE: what moves, and what is still reachable without movement |

`accessibility.keyboard` must be `true` below age 16, and it is a REFUSAL rather than a warning: in
graded mode the sim is the question surface, so a student who cannot operate it has been excluded from
the assessment rather than given an accommodation.

## 10. Fallback — what a student sees with no JavaScript, or on a blocked network

The text alternative, plus a static poster. A lesson is never broken by a registry problem or a school
firewall, and we never show a silently broken frame.

## 11. Licence and provenance

`REPLACE` · `ORIGINAL | PORTED | INSPIRED_BY:<ref>`

`INSPIRED_BY` is respected and recorded, not laundered.

## 12. Conformance script and expected grade

```jsonc
REPLACE: the exact `conformance` block from sim.manifest.json
```

Every one of the gold sims exists to break a specific assumption in the conformance suite. Write the
script expecting to fail the first time.
