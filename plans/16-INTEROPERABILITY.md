# 16 — Interoperability

Import and export of content, rosters and grades. This is what stops a school from being locked in, and it is also the cheapest possible route to our first 200 simulations.

---

## 1. Standards, and what each is actually for

| Standard | Purpose | v1 scope |
|---|---|---|
| **QTI** (Question and Test Interoperability) | The only mature standard for authoring and delivering tests. QTI 2.2 for broad tool support; QTI 3.0 (released May 2022) is the current version and consolidates APIP. `RN-13` | **Export + import** of items and tests. Export first. |
| **xAPI** (Tin Can, 2.0) | Learning activity statements for a learning record store. Verb IDs from the ADL vocabulary | **Emit** statements for key events. No LRS built |
| **LTI 1.3 Advantage** | Launch our content inside another LMS, and receive grades back. Core + Deep Linking 2.0 + Names and Role 2.0 + Assignment and Grade Services 2.0. Platform certification requires **all** services. `RN-13` | **Launch as a Tool** (we are the external tool in someone else's LMS) |
| **OneRoster** 1.2 | Roster and gradebook sync between an LMS and a SIS | **Roster sync** (LMS → us) |
| **SCORM** | Older e-learning content packages | **Out of scope.** A simulation host is not a SCORM player, and the value is low for our content model |
| **H5P** | Community content packages | Deferred import, if demand appears. See `RN-07` for why the format is awkward |

### 1.1 Sequencing, and why
**Export before import. Launch before full parity.** `R14` is real: interoperability is the classic scope sink. A documented subset that works beats a stalled standard.

```
P16-T1  QTI 2.2 export of a single assessment          → usable immediately
P16-T2  QTI 3.0 export, superset where clean
P16-T3  QTI import (items) with a mapping report
P16-T4  xAPI statement emission
P16-T5  LTI 1.3 launch as a Tool: OIDC login, deep linking, AGS grade passback
P16-T6  OneRoster 1.2 roster sync
P16-T7  NRPS where a platform needs it
```

---

## 2. QTI

### 2.1 Export mapping

| Ours | QTI 2.2 / 3.0 |
|---|---|
| `Resource` (QUIZ/EXAM) | `assessmentTest` |
| `QuestionBank` | `assessmentItem` collection / `test` of items |
| `Question` | `assessmentItem` with a `responseDeclaration` and `itemBody` |
| `single_choice`, `true_false` | `choice` / `choice` with a single correct `responseValue` |
| `multi_select` | `choice` with `multiple` + `partialCredit`, and a `responseProcessing` template carrying our partial-credit method as a custom `qti-variable` |
| `numeric` | `numericalResponse` with `minValue`/`maxValue` derived from the tolerance |
| `short_text` | `textEntryInteraction` with `patternMask` for `REGEX_SET`; a custom extension otherwise |
| `ordering` | `orderInteraction` |
| `free_response` | `extendedTextInteraction`, `manuallyScored="true"` |
| `file_submission` | `fileUploadInteraction` (QTI 3.0) |
| `simulation` | **No standard equivalent.** Exported as an `extendedTextInteraction` carrying the sim id, version and a link to a live embed. Honest and documented |
| Blocks (lessons) | `passage` / `textBlock` / `figure` / `mediaObject` |
| Our partial-credit method | `qti:responseProcessing` template + a custom `qti:ext` for the method name |
| Our policy (time limits) | Not in QTI. Documented as a non-portable feature in the export manifest |

### 2.2 Import
- Round-trip is the test: **export → import → export must be byte-identical** for the supported subset. A golden-file test per question type.
- Every import produces a **mapping report**: what was imported, what was approximated, what was dropped and why. No silent loss.
- Unknown QTI elements are ignored with a report entry, never a crash.
- A `manifest.json` alongside the package declares our provenance, version and supported subset, so another Orrery instance can round-trip confidently.

### 2.3 What we will not claim
Simulations, integrity policy, release batching, accommodations and item analysis are **ours** and do not travel in QTI. The export manifest says so explicitly. A school importing our maths quiz into their LMS gets the questions and the marks, not our exam conditions — and we would rather say that plainly than ship a lossy conversion that pretends otherwise.

---

## 3. xAPI

Statements emitted (verb → object), with **no answer content** in any payload, so xAPI never becomes a side channel around `INV-Q-1`:

| Verb | Object | Notes |
|---|---|---|
| `experienced` | the simulation, the resource | launch, scroll depth, time on task |
| `answered` | the assessment item | duration, attempt number, **outcome omitted pre-release** |
| `scored` | the assessment item | score, only **after release** |
| `completed` / `passed` / `failed` | the assessment | after release |
| `experienced` | the course / classroom | optional |

- Statement ids are idempotent (the attempt's ULID + event type) so a consumer can dedupe.
- Emitted through a queue, batched, with a dead-letter path. xAPI delivery must never affect an exam.
- Configurable verb and activity-type IRIs. ADL vocabulary where a term exists; our own namespace otherwise.
- No LRS is built or operated.

---

## 4. LTI 1.3 Advantage

We are the **Tool**. A teacher's existing LMS launches our resource or assessment; we run it inside their course; we pass grades back.

| Service | Use | Notes |
|---|---|---|
| OIDC login | Auth | Standard LTI 1.3 third-party-initiated login. We map LTI roles onto our roles; we do **not** create accounts by default — configurable, and off by default because auto-provisioning from an LMS is a spam vector |
| Deep Linking 2.0 | Teacher picks our resource in their course editor | Returns a deep link back to us |
| Assignment and Grade Services 2.0 | **Grade passback** | One score per attempt, returned as a line item score. The score is only ever the **released** score — we never pass back a sealed score, so `INV-RELEASE-2` holds across the boundary |
| Names and Role 2.0 | Optional | Only if a platform requires it for a cohort view |

### 4.1 The release rule, restated
AGS grade passback sends `finalScore` **only when `releasedAt IS NOT NULL`**. Before release, no line item score is posted at all — not a zero, not a placeholder. A partial passback would break the product's central promise in someone else's LMS, where we would not even be able to see the leak.

### 4.2 Roles
`RN-13`: a Learning **Platform** must implement all services to be certified; a Tool needs Core plus one or two. We implement Core + Deep Linking + AGS, which is Tool-certified territory, and document the choice.

---

## 5. OneRoster 1.2

- **Roster sync: LMS → us.** Source of truth for class membership, which is how schools actually work.
- Direction: `getStudents`, `getCourses`, `getEnrollments` from the LMS; we map `course → Classroom`, `user → User` (matched on `sourcedId`, not email, because email addresses change).
- Dry run first, with a diff report. Never a destructive sync by default.
- Conflicts: **the LMS wins for membership.** Our classrooms are authoritative only for content and grades.
- Gradebook export via OneRoster grades is a v1.1 nice-to-have; CSV covers the immediate need.

---

## 6. Impact on the core design

Interoperability is not a bolt-on; three things in the core exist because of it:

1. **`Question.spec` is a documented, versioned, discriminated union** that can be serialised to QTI. A loose blob would make export guesswork.
2. **`QuestionBank` is a first-class object**, not a view over a resource — because QTI and OneRoster both model reusable item collections that way.
3. **The `graderVersion` field on every auto-graded response** — because a grade received from an LTI consumer months later must be explicable against the logic that produced it.

---

## 7. Testing

| Test | Property |
|---|---|
| Golden file | Export → import → export is byte-identical for the supported subset, per question type |
| Report completeness | Every dropped or approximated element appears in the mapping report |
| Robustness | Malformed and hostile QTI never crash an import; unknown elements are reported |
| xAPI idempotency | Re-emitting a statement produces the same statement id |
| **Leak audit** | No xAPI statement contains answer content, and no AGS score is posted before `releasedAt` — asserted in CI, because this is the boundary where `INV-RELEASE-2` is hardest to see |
| LTI | Launch, deep link, and grade passback against the 1EdTech conformance suite where available; otherwise a local reference harness |
| OneRoster | Dry run produces a correct diff; re-running is idempotent |

---

## 8. Phase deliverables (P16)

| ID | Deliverable |
|---|---|
| P16-T1 | `interop` package skeleton, `ExternalBinding` model, codec registry |
| P16-T2 | QTI 2.2 export: items, tests, partial-credit response processing, export manifest |
| P16-T3 | QTI 3.0 export superset |
| P16-T4 | QTI import with a mapping report; round-trip golden tests |
| P16-T5 | xAPI statement emission, queued, batched, idempotent, dead-lettered |
| P16-T6 | LTI 1.3: OIDC login, tool launch, Deep Linking |
| P16-T7 | LTI AGS grade passback with the release rule enforced and tested |
| P16-T8 | OneRoster 1.2 roster sync with dry run and diff |
| P16-T9 | Documentation: the supported subset, the honest gaps, and import/export guides |

**Exit criteria:** round-trip identical for the supported subset; every dropped element reported; a full LTI launch-and-gradeback works against a reference harness; and a CI test proves no score crosses the LTI or xAPI boundary before release.
