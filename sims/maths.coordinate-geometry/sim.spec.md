# Where does the line cross the y-axis?

**Simulation `maths.coordinate-geometry` v1.0.0** — P6-T11, gold simulation 20 of 24.

## The task

A straight line is drawn through two marked points on a square grid. Drag the square marker until it sits
where the line crosses the vertical axis, then type that y-coordinate in the box.

## Why this simulation exists

### 1. The first one drawn in SVG

Nineteen simulations in, every one drew into a `<canvas>`. For an orrery or a parabola that is the right
trade — thousands of moving marks, nothing that needs semantics. **For a coordinate grid it is not**, because
a grid is *meant* to be inspected: the numbers have to be in the DOM so a student can read them, and a canvas
has no text nodes at all.

So this one draws `<line>`, `<text>` and `<rect>`, and the axis labels are real text. That is what makes the
grid printable, zoomable and legible to assistive technology without a parallel implementation.

### 2. The first one with undo

The draggable thing is **one point**, so the whole undo history is a list of points:

```ts
interface History { past: GridPoint[]; present: GridPoint; future: GridPoint[] }
```

This is only possible because it is one number pair — and it is why the history is worth storing rather than
re-deriving. **An undo stack holding rendered state cannot be replayed**; a teacher asking "what did they try
first?" gets no answer from pixels. This one holds the student's own inputs.

Three decisions in it:

| Decision | Why |
| --- | --- |
| A move that did not move is not recorded | A click without a drag must not make undo feel broken |
| A new move **clears** the redo branch | Two futures means the submission refers to an ambiguous day |
| History is capped at 64 | A held pointer would otherwise fill a checksummed state |
| Redo does not survive a reload | The branch they were about to take is not work they did |

### 3. The first one graded on what was TYPED, not where it was dragged

Two sources of truth can disagree — where the marker sits, and what the student read off it. This grades the
**second**. A student who dragged to the right place and misread the grid has made a reading error, and
grading the marker would report that as a geometry error.

The marker is still in the state and `validateState` checks it, because a restored attempt must bring back the
diagram as well as the number.

## The full-mark band is a quarter unit, not zero

The grid snaps to halves, so a marker cannot sit at `1.1`. But a student **typing** `1.2` has read the grid
correctly and mis-typed — marking that zero punishes the keyboard rather than the understanding. A quarter of
a unit is half a snap: anything inside it is indistinguishable from a correct reading in this interface.

## A vertical line has no answer, and that is not a bug

A vertical line crosses the y-axis at *every* point on it, so the question has no single answer. `clamp`
prevents the generator producing one, and `yIntercept` returns `null` for it rather than `Infinity` or a
misleading `0`. The grader refuses such a pair with `NO_INTERCEPT` instead of awarding zero — which would read
as a student being wrong.

## Accessibility

- The marker is a **`<rect>` with `tabindex`**, not a drawn square. A canvas rectangle is a pixel region with
  no identity; an SVG element takes focus, responds to arrow keys, and can carry a label.
- **Arrow keys are the primary input, not an accommodation.** A drag snaps to half a grid unit, so a pointer
  cannot reliably land on every lattice point. With arrow keys every position is exactly reachable. Hold
  Shift for whole units.
- `Ctrl+Z` / `Ctrl+Y` work, as well as the buttons.
- The text alternative describes the grid and the line and **never states the crossing** — it must not become
  "the line crosses at 1", which is the answer in the place a screen-reader user is told to look.
- The drag is converted through `getScreenCTM().inverse()`, not `offsetX`, so a student on a phone and a
  student on a 4K monitor drag identically. The SVG viewBox is fixed while the element is `width: 100%`.