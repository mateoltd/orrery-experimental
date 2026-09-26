# 05 — Content Authoring

The block model, the editor, versioning, media, and the authoring experience. Everything else renders through this.

---

## 1. Design stance

Author-supplied content is a **closed union**, never free HTML. This is the single most important security and maintainability decision in the content layer: there is no sanitiser to keep patched, because there is nothing to sanitise. A user cannot inject a script, a style, an iframe or an event handler, because the renderer only emits HTML it generates itself from typed data.

Rejected alternatives and why (`RN-12`):
- **MDX** — executes author-supplied JSX. Disqualifying for multi-tenant content.
- **Raw Markdown with an HTML sanitiser** — sanitiser drift is a standing liability; every bypass is an XSS.
- **Raw HTML passthrough** — same, plus it destroys the structural diff we need for versioning.

---

## 2. Block schema (16 types)

Defined in `@orrery/contracts` as a Zod discriminated union discriminated on `type`. Every block carries a stable `id` (uuid) so diffs and analytics survive versions.

| # | Block | Purpose | Notable fields |
|---|---|---|---|
| 1 | `paragraph` | Body text | inline marks: bold, italic, strike, code, link, math |
| 2 | `heading` | Section break | `level: 1..4`, `anchor` |
| 3 | `list` | Ordered / unordered / task list | `style`, `items[]` |
| 4 | `blockquote` | Quotation | `cite?` |
| 5 | `callout` | Admonition | `variant: note/tip/warning/danger/insight`, optional title |
| 6 | `code` | Code sample | `language`, `filename`, line highlights |
| 7 | `equation` | Display maths | `latex`, `display: block\|inline`, `number?` |
| 8 | `image` | Picture | `assetId`, `alt` (**required**), `caption?`, `width?` |
| 9 | `video` | Embedded video | provider allowlist (`youtube`, `vimeo`, `upload`), `assetId?`, `captions?`, `transcript?` |
| 10 | `table` | Data table | header row, alignment, `caption` (**required** for a11y) |
| 11 | `embedSimulation` | Interactive simulation | `simId`, `simVersion`, `params`, `seedPolicy`, `mode: explore\|practice\|graded` |
| 12 | `practiceCheck` | Inline low-stakes check | embedded **question snapshot**, `feedbackPolicy` |
| 13 | `keyValue` | Definition / fact box | definition-list semantics |
| 14 | `divider` | Visual break | `variant` |
| 15 | `columns` | Layout | `columns: 2\|3`, responsive collapse |
| 16 | `embedExternal` | Sanctioned third-party embed | provider allowlist only, no arbitrary URL |

### 2.1 KaTeX
Rendered with `trust: false` and `strict: 'error'`. No `\href`, no `\htmlClass`, no user-controlled macros. **MathML is emitted alongside the visual output** so screen readers get real mathematics — this is a WCAG requirement, not a nicety (`15-A11Y-I18N.md`).

### 2.2 `embedExternal` is an allowlist, not a URL field
A small set of vetted providers, each with a fixed URL template and a strict CSP for the frame. No user-supplied origins. This closes an entire class of embedding abuse and clickjacking.

---

## 3. Editor

TipTap v3 / ProseMirror JSON as the canonical format. Custom nodes for all 16 blocks.

| Concern | Approach |
|---|---|
| Insertion | Slash-command palette (`/`), filtered by block type; also drag-and-drop from a block palette |
| Structure | Block-level drag handle; keyboard `Ctrl+Shift+↑/↓` to move a block; indent/outdent for list depth |
| Blocks that are not inline-editable | `embedSimulation`, `embedExternal`, `table` are **atomic nodes** rendered as React components inside the editor via node views |
| Simulation params | Editing a simulation's parameters opens a **side panel driven by the manifest's JSON Schema**, not an inline form — this keeps the editor free of sim-specific code |
| Autosave | Debounced 800 ms, with a save-state indicator (`Saving…` / `Saved` / `Couldn't save — retrying`) |
| Conflict | Optimistic concurrency on the version. A `409` shows a **three-way panel**: *your version* / *saved version* / *both* (block-level merge where blocks are independent, otherwise a manual pick) |
| Focus & a11y | Every block handle is a real focusable control with an accessible name; keyboard-only block movement; the editor is one large `role="application"`-ish region with a documented key map; no keyboard trap |
| Performance | Virtualise long documents; a 500-block lesson must stay responsive |

**Editors never live inside an iframe.** `RN-07`: H5P moved its editor into an iframe and spent years fighting CSS bleed and focus bugs. Our sim host is an iframe; our editors are not.

---

## 4. Versioning

`ResourceVersion` is write-once (`INV-CONTENT-1`). Publishing a resource:

1. Deep-validates every block against the schema (Zod, `strict`).
2. Resolves every `embedSimulation` against the registry; a missing `simId@simVersion` is a **blocking publish error**.
3. Checks alt text on images and captions on tables.
4. Snapshots `Question` rows referenced by `practiceCheck` and by pooled slots into version-scoped rows (`INV-BANK-3`).
5. Runs the blueprint check if a blueprint is attached; a failing check is a **warning with an explicit override**, not a hard block, because teachers legitimately improvise.
6. Writes the version, sets `currentVersionId`, and emits `resource.published`.

### 4.1 Diff
Structural, block-level, not textual. Three-way aware: added, removed, changed, moved. Rendered as a readable side-by-side with per-block accept/reject when restoring. A teacher restoring v2 must be able to see exactly what they are about to change.

### 4.2 Restore
Restore is **restore-as-new-version**. History is never rewritten.

---

## 5. Media

| Rule | Reason |
|---|---|
| Presigned direct upload; bytes never traverse the app | Cost and bandwidth |
| Content-type allowlist + magic-byte verification | A `.png` that is really HTML is a stored-XSS vector |
| Server-side re-encode for images; strip EXIF | Privacy (location), and payload smuggling |
| **SVG rejected as an image** | SVG is script |
| Alt text required before publish | WCAG; forced at the point of authoring, not flagged later |
| Video via provider allowlist, captions required, transcript encouraged | WCAG 2.2 AA |
| Every asset has a checksum and an owner | Deletion, quota, and DSAR all need it |
| Student submissions are a separate `kind` with scan status | A student's upload must not appear in a teacher's media library |

---

## 6. Discovery

- **Subjects**: hierarchical, cycle-safe moves. Seeded with ~120 subjects across maths, physics, chemistry, biology, earth science, astronomy, computing, engineering, and general skills.
- **Search**: Postgres full-text with `tsvector` weighted `title > summary > tags > body`, plus a `pg_trgm` fallback for typo tolerance and substring matches. Facets by subject, kind, grade range, language, and "has simulation".
- **Zero-result queries are logged** with the normalised term. This is the single best signal for what content to commission next, and it feeds the simulation catalogue directly.
- **Moderation**: public resources can be flagged; a queue; a documented takedown SLA. Under-18 authors' resources are not publicly listed by default.

---

## 7. Authoring experience principles

1. **The teacher is the customer.** Every authoring interaction is measured; anything that costs more than ~3 interactions to reach a common outcome is redesigned.
2. **Publish is a checkpoint, not a trap.** `validateForPublish` returns a *checklist with fixes*, each fix being a deep link to the offending block. Not a wall of red.
3. **Grading is visible while authoring.** `bank.testGrader` runs the real production grader against a sample answer and shows the resulting points and rationale. A teacher can *see* the key working before a student ever does. This is the single highest-leverage trust feature in the authoring layer.
4. **Nothing is lost.** Autosave to a draft, a version history, and a recoverable publish failure.
5. **Copy is a first-class citizen.** Duplicating a resource duplicates its version chain pointer and its bank slots, so "reuse last year's unit" is one click.
6. **The block palette shows only blocks that make sense in context**, so a beginner is not offered an equation inside a table caption.
7. **Honest capability reporting.** If a resource references a deprecated simulation version, the author sees it, with the replacement.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Editor complexity stalls all content work | The block schema is renderer-agnostic. A plain block-list authoring UI is a **sanctioned fallback** (P2 exit criterion), and it is small because the schema and renderer already exist |
| Block schema churn breaks stored content | Blocks are versioned by a `schemaVersion` on the resource; migrations are explicit, tested against a fixture corpus, and reversible |
| A registry problem breaks published content | Degrade to a static fallback with a poster and a parameter listing; never a broken frame |
| Teachers want arbitrary HTML | `embedExternal` allowlist plus a feature request path. Not raw HTML |
| Long documents degrade | Virtualisation from day one; a 500-block fixture in the test suite |
