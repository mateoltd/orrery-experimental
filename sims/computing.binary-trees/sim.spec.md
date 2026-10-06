# `computing.binary-trees` — the spec card

Authored from `docs/11-SIM-CARDS.md` card 72 (P12-T1).

---

## 1. Subject, topic, level, age range

| | |
|---|---|
| Subject | computing |
| Topic | Binary search trees — insertion and the three traversals |
| Level | GCSE/KS4 (A-level entry) |
| Age range | 13–16 |

## 2. Learning objective — one sentence, in the STUDENT's terms

> By the end you can insert into a binary search tree and name a traversal order.

## 3. Interaction model

> Type the values to insert, in order; the tree draws as nested lists; type the in-order, pre-order and
> post-order traversals, the height and whether the tree is balanced. Each node is a button that folds its
> subtree away.

## 4. Model — the maths, stated precisely enough to be CHECKED

`src/model.ts`. Plain BST insertion — smaller left, larger right, duplicates dropped — and three named
traversal functions over one node type:

```
insert(null, v)        = { value: v, left: null, right: null }
insert(n, v)           = n                                    if v === n.value
insert(n, v).left      = insert(n.left, v)                    if v < n.value
insert(n, v).right     = insert(n.right, v)                   otherwise
inOrder(n)             = inOrder(n.left) ++ [n.value] ++ inOrder(n.right)
preOrder(n)            = [n.value] ++ preOrder(n.left) ++ preOrder(n.right)
postOrder(n)           = postOrder(n.left) ++ postOrder(n.right) ++ [n.value]
height(null)           = -1;  height(n) = 1 + max(height(left), height(right))
balanced(n)            = |levels(left) − levels(right)| ≤ 1 at every node
```

### THE BALANCING MODE IS DECLARED ABSENT, AND THAT IS THE CARD'S FOCUS

The card says the tree "REBALANCES only if a declared balancing mode is on — … an auto-balancing tree would
hide the very thing the question is about". There is therefore **no balancing parameter in the manifest**.
Adding one with a single value would have been a parameter that cannot change the answer; adding AVL
rotations would have been a different question. The mode is declared by its absence and asserted by the
test that ascending insertion gives a chain of height 4.

### HEIGHT IS IN EDGES; BALANCE IS IN NODES

Both, deliberately named, because they differ by one and a height reported in one unit and tested in the
other makes every tree look balanced or every tree look wrong.

## 5. Answer semantics

`{ inOrder: string[], preOrder: string[], postOrder: string[], height: number, balanced: boolean }`.

**A surplus entry is WRONG, not truncated.** `orderMatch` puts the extra entry in the denominator
(`grading.ts:484`), so walking one step past the end costs the same as getting that position wrong. A
student's answer is the sequence they walked, and walking further is a different walk.

## 6. Grading strategy

`ORDER` · `partialCredit: true` · `maxPoints: 4` — 1 mark per traversal by `orderMatch` (**per position**),
0.5 for the height by `numeric` with no band, 0.5 for the balance claim.

`orderMatch` folds case, and unlike a genotype a node value has no case to claim.

**Tolerance class T-H.** The one place this card's hazard is a real grading decision is the surplus entry,
and §5 is where it is answered.

## 7. Parameters and variants

| Parameter | Range | Default | Unit | Varies per student? |
|---|---|---|---|---|
| `insertOrder` | a comma-separated list of at most 12 integers in ±999 | `50,25,75,12,37,62,87` | — | no |

**Seed strategy S-0 · deterministic.** No draw anywhere. The generator is invertible without one: the marking
key is a function of the declared insertion order alone.

## 8. Misconceptions targeted

1. All three traversals give the same order.
2. An unbalanced tree is still a valid BST.
3. In-order traversal of a BST yields the values in descending order.

## 9. Accessibility plan

| | |
|---|---|
| Keyboard path | Tab through the values in order, then Submit. Each node is a focusable `<button>` with `aria-pressed`, and the assembly is never reached by dragging. |
| Text alternative | `describeTree()` — derived, quoting the three orders it is describing. |
| Reduced motion | Nothing moves. |

Modality is `diagram`, so the non-visual path the card names is present: a `<table>` of connections
(node → parent → side) with a `<caption>` and scoped headers, beside the nested list. There is no canvas and
no SVG, because the card asks for the handle to be a `<button>` and neither is reachable by Tab.

## 10. Fallback

The nested list, the connections table and the text alternative are all DOM. A lesson is not broken by a
registry problem.

## 11. Licence and provenance

`CC-BY-4.0` · `ORIGINAL`. Both mandatory, both validated (`packages/contracts/src/sim-manifest/index.ts:60-72`).

## 12. Conformance script and expected grade

```jsonc
"type":   { "in-order": "12,25,37,50,62,75,87", "pre-order": "50,25,12,37,75,62,87",
            "post-order": "12,37,25,62,87,75,50", "height": "2", "balanced": "yes" }
"expect": { "answer": { "in-order":   { "sequence": [...] },   // ordered, not a set
                        "pre-order":  { "sequence": [...] },
                        "post-order": { "sequence": [...] },
                        "height": 2, "balanced": { "in": [true] } },
            "grade": 4 }
```

`{sequence: [...]}` rather than `{set: [...]}`, because an `ORDER`-graded simulation that declared a set
expectation would be asserting that position is not part of the answer.

`balanced` is declared `{"in": [true]}` rather than a bare `true`: `$defs/expectation` in
`schemas/sim.manifest.schema.json` is `number | object` and **refuses a boolean**, so the build fails with a
Zod `invalid_union` naming `conformance.expect.answer.balanced`. `{"in": [...]}` is the schema's own
vocabulary for "the answer is one of these".