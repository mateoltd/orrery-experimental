# `computing.search-algorithms` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 70 (P12-T1).

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | computing |
| Topic | Linear and binary search — comparison counts and the sortedness precondition |
| Level | GCSE/KS4 (A-level entry) |
| Age range | 13–16 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can trace a binary search and say why it needs a sorted array.

## 3. Interaction model

> Choose the search, the list length, the target and whether the list is in order; press **Compare one more
> element** to step the search; type the comparison count, whether it found the target, the position, and
> the worst case.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`. Both searches are instrumented on the loop the animation follows, so the reported count is
the count the student watched — which is the shipped `computing.binary-search`'s stated purpose and the
assumption this card exists to break.

```
linearSearch: compare each element in turn; count INCLUDES the comparison that ends a failure
binarySearch: mid = low + floor((high − low) / 2)          ← MIDPOINT = 'lower', declared
              value < target → low = mid + 1 ; value > target → high = mid − 1
              an unsuccessful search ends with ONE further comparison, at min(low, n − 1)
precondition: isAscending(list) must hold, or the search is REFUSED with a reason
worstCase:    linear → n ; binary → ⌈log₂(n + 1)⌉
```

**The midpoint convention is the whole question on an even-length range.** `Math.floor` and `Math.ceil` are
both defensible and give different counts; the shipped `computing.binary-search` takes the lower middle, so
this simulation declares the same convention and the grader uses the same one.

### `ascending: false` SWAPS THE FIRST AND LAST VALUE

Not reverses the list. A reversed list fails a binary search in an obvious way at the first comparison; a
swap of the extremes is the ordinary student error of typing the values in without ordering them — and the
list still **contains every value from 1 upwards**, which is what makes misconception (3) tempting. The
search is then REFUSED, not answered: a plausible count on an unsorted list is how a student learns that
binary search finds a present value.

## 5. Answer semantics

`{ comparisons: integer, found: boolean, index: integer, worstCase: integer }`.

`index` is **`-1` when the target is not there**, a declared sentinel. `null` would be the natural answer and
it is ungradable: `asNumber(null)` is `null`, so a grader asked to compare a student's `null` with an
expected `null` reports UNPARSEABLE — which says the comparison could not be made, when it could.

## 6. Grading strategy

`NUMERIC` · `partialCredit: true` · `maxPoints: 4` — 1 mark per field, every one of them **exact**.

### TOLERANCE CLASS T-A, `abs: 0, rel: 0`, AND THE CARD'S REASON FOR IT

"a relative band on it would accept a linear search that happened to get lucky, which is precisely the
misconception the row targets." The two searches differ by about one comparison on most targets, so
`rel: 0.02` on a count of 12 accepts 11.76 to 12.24 — which is a mark for the wrong algorithm. The test
asserts that a count one out costs **exactly one mark**, not a fraction of one.

### TWO SDK BEHAVIOURS THIS GRADER HAD TO WORK AROUND, BOTH RECORDED

1. **`numeric()` reports an unparseable answer as `INCORRECT`** (`packages/sim-sdk/src/grading.ts:311-316`
   omits the `'UNPARSEABLE'` override that `tolerance()` supplies at `grading.ts:206`). So field readability
   is decided in this grader with `asNumber`, not read back out of the sub-grade — otherwise an item every
   student leaves blank is reported identically to an item everybody mis-conceives.
2. **`asNumber` returns `null` for a boolean**, so `numeric(true, …)` would report UNPARSEABLE for a student
   who answered `true`. `asBoolean()` in `model.ts` reads `true/yes/1` and `false/no/0`, which are the three
   spellings a select, a checkbox and a text box produce.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `algorithm` | `binary` \| `linear` | `binary` | — | no |
| `size` | 4 … 64 | 16 | elements | no |
| `target` | −999 … 999 | 9 | — | no |
| `ascending` | `true` \| `false` | `true` | — | no |

**Seed strategy S-0 · deterministic.** No draw anywhere; the marking key is a function of the four declared
parameters, so the generator is invertible without a seed.

## 8. Misconceptions targeted

1. A binary search needs a sorted array. *(the `ascending: false` refusal)*
2. A linear search is always slower. *(target 1 in a list of 16: linear 1 comparison, binary 4)*
3. Binary search finds a value in an unsorted array if it is present. *(the list contains every value)*

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab to the canvas (`data-sim-entry`), then **Compare one more element** / **Start the search again**, then the four number inputs, then Submit. |
| Announced | One announcement per STEP ("Comparison 3: position 4, outcome less"), never per frame. |
| Text alternative | `describeSearch()` — derived, and it states the refusal when there is one. |

Modality is `canvas`, so every drawn quantity is mirrored in a real `<table>`: one row per comparison, with
the position, the value, the outcome and the running count. The stepper is a **step** control, not a timer:
a search has a count, not a duration, and nothing here reads a clock (`INV-TIME-1`).

## 10. Fallback

The comparison table and the text alternative are DOM, so a student on a blocked network still gets the
question and the evidence for it.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`.

## 12. Conformance script and expected grade

```jsonc
"type":   { "comparisons": "4", "found": "1", "index": "8", "worst-case": "5" }
"expect": { "answer": { "comparisons": 4, "found": true, "index": 8, "worstCase": 5 }, "grade": 4 }
```

`"found": "1"` rather than `"yes"`: the submitted value is `1`, and the declared expectation has to be the
value the simulation reports rather than a reading of it. The script sets `ascending: true`, so the refused
combination — which the grader reports as `UNSORTED_PRECONDITION` at zero — is never on a paper.