# Academic integrity policy

**P14-T10.** Read this document if you are a student sitting an assessment on Orrery, or a teacher deciding
whether to use the platform for one.

**This policy is published before you start, not after.** You should be able to read exactly what is recorded,
what is worked out from it, who sees it, how long it is kept, and what happens if a decision goes against you —
before you commit an afternoon to the paper. A policy you can read in advance is fairer than one you meet in
an appeal, and it is the only kind that can be trusted.

---

## 1. The honest summary, first

**We can reliably enforce *when* you take the paper and *which questions* you were given. We cannot reliably
detect *whether you cheated*, and any system that tells you otherwise is reporting its false-positive rate as
a success rate.**

That sentence is not modesty. It is arithmetic.

Suppose we had an excellent detector — 99% accurate at saying "this student is fine", 30% sensitive at catching
a cheater — and apply it to a class where 10% cheat. Of every hundred students it flags, about 77 would have
genuinely cheated. In a class where 2% cheat — which is much closer to most real classrooms — the same detector
gives **about 6%**: roughly **17 of every 18 students it flags would be innocent.**

Real systems are worse than that hypothetical. In a controlled trial with six staged cheaters, automated
detection caught **none** of them; a human reviewer caught one. Proctored students in that research completed in
half the time and **scored significantly lower** on the same exam — which tells you the controls themselves
change performance, and that any before/after score comparison cannot tell "less cheating happened" apart from
"students performed worse under the extra load."

So we do the arithmetic out loud rather than quoting a vendor. **This document will not promise you detection
we do not perform.** We would rather be trusted than appear to be controlling.

---

## 2. What the platform actually enforces

These are server-side. Your browser cannot talk our way around them, and this is not a promise about your
browser — it is a statement about where the decision is made.

| Enforced by the server | What that means for you |
|---|---|
| **The deadline.** The clock that decides whether your paper is in time is the server's, read from your attempt record. Changing your device's clock changes nothing. | If your clock is three days wrong, you are treated exactly like a correct one. Your screen may disagree with us; we are the authority. |
| **Which questions you get.** Your draw from the question pool, your option order, and any parameter values are decided server-side, stored, and logged. | A leaked answer key is worth very little, because your paper was not the same paper. |
| **Grading.** Marks are computed from the answers held on the server. Nothing your browser sends about your own score is read. | Editing the page, the network traffic, or the developer tools cannot change a mark. |
| **When results are released.** A result is released for a whole group of students at once, in a single transaction. | Nobody sees a mark early, and a partial release cannot happen. |
| **What you are shown.** Correct answers appear only after release, and only if the policy for that paper allows it. | You are not told you were right before you are told you were wrong. |
| **Late answers.** An answer written after the deadline is **rejected, and the answer you gave before it is kept.** | Late is not silently zeroed and late is not silently accepted. If you were on time, a retry cannot destroy it. |

---

## 3. What is recorded while you work

Recorded by your browser during the attempt, sent to us, and kept for **400 days**:

- entering and leaving fullscreen
- the window losing and regaining focus
- switching away to another tab, and switching back
- copy, cut, paste, right-click and print attempts
- a second tab or window detected running the same attempt
- pointer-lock entering and leaving
- network loss and recovery
- the results of a device check taken before you start
- a clock-skew notice, and queueing of unsaved work

**Recorded about content: our software is built so that it cannot be.** A telemetry record has no field for an
answer or a score, and its free-text area only accepts short primitive values.

**And here is the honest limit of that sentence.** We do not yet run the automated check that would confirm it
for every event, and the software that is supposed to raise the check has not been written. So today the
guarantee is a *design* rather than a *verified property*, and a future change to the platform could quietly
break it. We would rather tell you that than let you read this section as a promise we have tested. It is
tracked as P14-T14 and P14-T16, and it appears in Annex A.

**Never recorded, at all:**

- your keystrokes
- what is on your screen
- your camera or microphone
- your clipboard contents
- your location
- any third-party analytics

**We do not monitor what you type in free-response answers.** In this version we do not read student writing at
scale at all. That is a deliberate choice, not a missing feature we intend to add quietly. If written-answer
review is ever introduced it will be opt-in per classroom, will require explicit consent, and will go to a
human queue — never to an automated decision about your writing.

---

## 4. What is worked out from that, and what is not

This is the distinction the whole policy turns on.

**Recorded — an event happened.** "This window lost focus at 14:03." That is a fact about your device, and it
is all the record is.

**Inferred — a person did something.** "You were cheating." That is a judgement, and **the platform never makes
it.** Nothing in the list above is evidence of misconduct on its own, and four of the entries are not even
evidence of much:

| Signal | Why it is not treated as wrongdoing |
|---|---|
| Fullscreen could not be entered | A capability failure. A locked-down school computer refuses fullscreen routinely. |
| A window size looks unusual | Window size is not evidence of anything. Normal window management produces it. |
| A simulation failed to load | **Our** bug, never yours. |
| An accommodation was in use | Never counted. An accommodation is a right, and counting it would turn a right into a way to lose marks. |

A separate category is worth naming because it is the one that sounds most like a detection: **we do not
attempt to detect whether developer tools are open.** Any such attempt is trivially defeated, produces
false positives that end real students' grades, and is indefensible on appeal. We record a passive size hint
and stop there.

**Here is the arithmetic behind "a human decides".** Your evidence is shown to your teacher with a banner
stating that it is evidence and not a determination, and the wording describes events rather than intent —
*"left fullscreen 3 times"*, never *"attempted to cheat"*. **No automated penalty can be applied to your grade
without a named teacher making a recorded decision.** If the controls fire often enough to freeze your attempt,
what happens is that your written answers are submitted, a teacher is told, and a human decides what happens
next. It does not cost you a mark by itself.

---

## 5. What your teacher sees

- your answers and the questions, in the order you received them
- the event timeline described in §3
- a note of anything dropped, so a gap is visible as a gap rather than as innocence
- where relevant, clusters of similar answers
- accommodations you were granted, if you have consented to them being shown

Your teacher does **not** see any record of your keystrokes, screen, camera, microphone or clipboard, because
none is kept. If you were granted an accommodation, you choose whether it is shown on your released result,
and it is never shown to other students.

---

## 6. How long it is kept

| Data | Kept for |
|---|---|
| Integrity signals from an attempt | 400 days, then reduced to counts and the detail deleted |
| Your attempts, answers and grades | The life of the class, plus 24 months, then archived or deleted as your teacher instructs |
| Sign-in sessions | 30 days after they expire |
| Password reset and email verification tokens | 24 hours |
| Invitations to a class | 90 days after they expire |
| Records of grading decisions | 7 years — a defensible record of why a mark was given |
| Deleted accounts | 30 days' grace, then anonymised |
| Files you export | 7 days |
| Backups | 35 days, then destroyed |

**Honest status of that table:** the retention *schedule* is a specification. The job that enforces it is
written and runs on a timer, and it currently raises `not implemented` — so today, nothing is being deleted on
this schedule, and nothing is being deleted automatically at all. We are telling you this rather than letting
you read the table as a running process. It is tracked as `P14-T6`, and this table becomes a description rather
than a specification when that job runs.

**Getting your data back, or asking for it to be deleted.** The platform is *built* so that you can export
everything you hold or wrote as machine-readable files, and so that you can ask for erasure: authored work
referenced by a graded submission is anonymised rather than deleted, so a historical grade stays coherent, and
you are told exactly what was removed and what was kept. **Neither of those is available yet** — see Annex A.
We would rather say "this is what we built and it is not switched on" than "you can export your data" on a
system where you cannot.

---

## 7. What you can see, and what you can challenge

**This section describes what the platform is built to do. None of it is switched on yet** — see Annex A, and
read §6's note as well. It is written out in full anyway, because a policy that only describes what exists
today would be a policy about a product nobody can use.

**You can see:**

- your own answers, and their revision history
- your own integrity event timeline — the same events your teacher sees about you, not a filtered version
- your own submission receipt, a fingerprint computed over your attempt, your policy and your answers in order
- what happened and why, at the moment it happened: a countdown, the per-question timer, whether your work is
  saved, and any change of policy state. No surprise modals, no unannounced rule changes.

**You can challenge:**

- **A factual error.** If the timeline says something that did not happen, say so. The teacher sees the same
  record you do, which is the point of showing you both.
- **A missing accommodation.** If a relaxation you were entitled to was not applied, say so. An accommodation is
  recorded as a right, and it produces no violation events.
- **A grade.** A request to change a mark is a **teacher's** decision, not a data request, and it is handled
  through the regrade path with an audit record — not by quietly editing a number. This is stated plainly
  because it is the fair thing to say rather than the convenient thing.
- **An integrity verdict.** See §8.

**A documented weakness in our favour, not against you:** answers written after your hard deadline may not
have been recorded, if your connection failed near the end. You are told this *before* you start, and your
client keeps unsent work and retries it. It is a real loss of work, it is disclosed in advance, and it is not
something we will pretend does not happen.

---

## 8. If a decision goes against you

**No automated accusation exists in this system.** A verdict is a teacher recording a decision and a reason.
If you are told a decision has been made against your attempt, you get:

1. **The reasoning and the record behind it** — the events, the answers, and what they were based on.
2. **A route to respond**, and a human reads it. Your response is part of the record.
3. **A route to escalate** beyond that teacher, through your school.
4. **The decision stays reversible while it is reviewed.** A frozen attempt is not a voided one; a teacher can
   reinstate or void it with a recorded reason.

**Accommodations are designed to be free of penalty.** If you need extra time, a screen-reader-compatible mode,
permission to switch tabs, or permission to paste, ask — **requesting one costs you nothing**, and the answer you
give a question is never held against you for using one. It is far better to ask before a paper than to
disclose afterwards.

---

## 9. Why we publish all of this

A policy a student can read and predict is both fairer and much easier to defend than an opaque one — and
publishing our own weakness is the honest response to the finding that these systems are weak at detection.
An institution that reads §1 and decides the platform is unsuitable for high-stakes assessment has made a
better decision than one that was told we detect cheating.

---

---

## Annex A — Implementation status

**For staff, reviewers and the person accountable for this document. Students do not need this section; it is
here because a policy whose accuracy cannot be checked is how a policy starts lying.**

Every claim above was checked against the code on `master`, not against `plans/09` and `plans/14`. This table is
the honest position.

| Policy claim | Status | Evidence |
|---|---|---|
| Server-enforced deadlines; late writes rejected, prior value kept | **Live.** `POST /api/exam/answers` reads the deadline from the attempt row and compares against `@orrery/clock`, not anything the request said. | `apps/web/src/app/api/exam/answers/route.ts:11-18`, `:122-145`; `packages/db/src/answer-write.ts`; `INV-LATE-1` |
| Marks computed server-side only | **Live in the library; no route exposes grading yet.** The pure grader is 100%-branch covered. | `packages/grading/src/index.ts`, `INV-ATTEMPT-1` |
| Release is atomic and total | **Live in the library; the batch release runs from the worker.** | `packages/db/src/release.ts`; `INV-RELEASE-1`, `INV-RELEASE-2` |
| Which questions you get: per-student draw, option order, parameter seeds, persisted and logged | **Live in the library; no route serves a paper.** The variant audit checks that seeds were both *applied* and *logged* — the difference between a variant that happened and one that can be proved afterwards. | `packages/analytics/src/variant-audit.ts`. Note `INV-BANK-2` names `packages/analytics/src/draw.ts`, a path that no longer exists — `THREAT-MODEL.md` TM-22 |
| Correct answers never reach a student before release | **Live and gated.** Type-level DTO, route audit and projection audit, all three. | `scripts/audit-seals.mjs`, `scripts/audit-routes.mjs`, `scripts/audit-projections.mjs`; `audit/student-routes.json`; `audit/score-projections.json`; `INV-Q-1` |
| Telemetry is recorded and sent | **NOT LIVE.** There is no telemetry ingestion endpoint. The only API route is `answers`. The client pipeline is complete and tested; there is nowhere for it to land. | `apps/web/src/app/api/` contains one file; `packages/exam-engine/src/evidence.ts`; tracked as `P14-T14` |
| Telemetry carries no content and no PII | **A design, not a verified property.** A record has no answer or score field and its `detail` values are primitives, but the `detail` **keys are unconstrained**, and the one automated check that would catch a mistake — `audit:payloads` — **does not exist**. | `packages/exam-engine/src/evidence.ts:307-313`; `INV-TELEMETRY-2` in `plans/invariants.json` — `THREAT-MODEL.md` TM-20, TM-15 |
| Evidence signatures are tamper-evident | **Signing is live; verification is not.** The HMAC is computed and transmitted, and nothing in the repository verifies it. | `packages/exam-engine/src/evidence.ts:521`; `packages/exam-engine/src/adversarial/forged-events.test.ts:17-24` writes the verifier in a *test file* |
| Accommodations produce zero violation events | **Live in the library.** Four event types carry `strike: 'never'` and a missing rule throws rather than defaulting to no strike. | `packages/exam-engine/src/evidence.ts`; `INV-ACC-1` |
| Fullscreen / focus / tab / copy signals are recorded | **Client-side only**, per the previous row. | `apps/web/src/features/exam/watchdogs/` |
| No automated penalty without a human decision | **Live by construction in the client.** `TERMINATE` is freeze-and-submit; nothing sets a score. | `plans/09` §7.2 (`V-12`); `INV-TELEMETRY-1` |
| Teacher sees an evidence timeline with an "evidence, not a determination" banner | **Built and tested as a component; no route serves it.** | `apps/web/src/features/exam/integrity/timeline.ts` |
| Retention schedule is enforced | **NOT LIVE.** The job throws `not implemented — P14-T6`. Stated plainly in §6 rather than hidden here. | `apps/worker/src/index.ts:132-140` |
| Self-serve data export and erasure | **Not live.** Erasure planning logic exists; there is no request path. | `packages/auth/src/deletion.ts`, `packages/db/src/deletion.ts` |
| Answers are recorded without EXIF | **FALSE.** The stripper is implemented and tested but is not called by the upload path, so image metadata survives. | `packages/contracts/src/media/index.ts:302`; `packages/db/src/media.ts:171` — `THREAT-MODEL.md` TM-12 |
| The student can verify their own submission receipt | **Live in the library; nothing serves it to a student.** The receipt is a hash chain over the attempt, the frozen policy and the answers in order, and there is a checker. | `packages/db/src/receipt-issue.ts`, `scripts/verify-receipt.mjs` |
| The student's identity is verified before their data is served | **NOT LIVE.** `apps/web` has no session layer; identity is a process environment variable. **This is the most serious gap in the document** and is why the retention and rights rows above are specifications rather than current facts. | `apps/web/src/app/classrooms/[classroomId]/roster/page.tsx:166-168`; `THREAT-MODEL.md` TM-01 |

**Two consequences worth stating, because they are uncomfortable:**

1. **§7's "you can see and challenge" describes an interface that does not exist yet.** When it does, it must
   show the teacher the *same* record the student sees. A student-visible timeline that is filtered is worse
   than none, because it invites the belief that the full record exists somewhere.
2. **§6's table is a specification.** It says what will be deleted and when. It does not yet say what is
   deleted, because the sweep raises `not implemented`.

**Cross-references.** `plans/09-EXAM-INTEGRITY.md` §1 (the research), §1.2 (the PPV arithmetic in §1 here), §3
(the per-threat controls), §7.1 (the event table in §3 here), §8 (accommodations in §8 here), §11 (what the
student is told — this document is the published form of it). `docs/05-EXAM-INTEGRITY.md` for the runtime.
`INV-ACC-1`, `INV-LATE-1`, `INV-TELEMETRY-1`, `INV-TELEMETRY-2`, `INV-Q-1`, `INV-RELEASE-1`, `INV-RELEASE-2`
for the properties this policy asserts. `RN-01`, `RN-02`, `RN-03` for the research findings.

**Review requirement.** `plans/14` §10 requires this policy to be *"reviewed by someone who did not write it"*,
and `plans/14` §9.1 requires the reviewer to check that `RN-01` and `RN-03` are quoted accurately. **Neither has
happened.** The reviewer should start with Annex A, because that is the table that can be wrong.