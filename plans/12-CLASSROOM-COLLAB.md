# 12 — Classrooms, Membership & Collaboration

Teachers own spaces, students join them, and the permission model underneath is airtight because everything downstream trusts it.

---

## 1. The classroom

| Concept | Decision |
|---|---|
| Ownership | Exactly one `ownerId`, transferable with an audit event. Transfer is refused if the target is not already a `TEACHER`. |
| Naming | Unique slug per owner. Names are free text; the slug is derived and de-duplicated. |
| Archive | Soft. Archived classrooms are read-only: no new assignments, no new attempts, but all history, grades and student records remain accessible. |
| Deletion | Two-step: archive, then delete after a 30-day window, with a dry-run report of exactly what would go. |

### INV-CLASSROOM-1
> A user's effective role is the **maximum** of their active enrollments. A user who is both `STUDENT` and `TEACHER` is a teacher for every purpose — grading, publishing, roster management. Removing the student enrollment does not reduce their teacher access.

### INV-CLASSROOM-2
> Departure revokes *classroom* access on the next request, but permanently preserves the student's access to their own submissions, grades and released feedback. Those are their records, not the classroom's. A student who leaves mid-term can still download their transcript.

---

## 2. Invitations

Two equal paths, because email deliverability is a real failure mode (`R12`) and a student who cannot receive an email must still be able to enrol.

### 2.1 Email invitations
- One or a bulk list. Per-recipient status, resend with cooldown, revoke, expiry.
- **Generic acceptance copy** for unknown addresses (no account-enumeration oracle).
- Accepted → creates or links the `Enrollment` and marks the invitation `ACCEPTED` atomically with the enrolment, so acceptance is idempotent and a double-click cannot create two enrolments.
- An already-enrolled user accepting again is a no-op with a clear message, not an error.

### 2.2 Join codes
- 6 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no visually ambiguous glyphs: no `0/O`, `1/I/L`, `8/B`, `5/S`, `2/Z`).
- Stored **hashed**. The platform cannot reproduce a code, which means a database leak does not hand out classroom access. `codeHint` (last two characters) lets a teacher read a code off a printed sheet.
- Regenerable; regeneration revokes the previous code.
- Expiring, with a default of 14 days and a teacher-extendable window.
- Rate limited by IP and by classroom, and failures are **silent** (same response for wrong, expired and revoked) so codes cannot be enumerated.

### 2.3 Why both
A code is a bearer token for a classroom. Codes are therefore: single-classroom scoped, role-scoped, expiring, revocable, regenerable, hashed at rest, and rate limited. A teacher who needs a code for a 300-student cohort is supported by CSV import instead, which is auditable.

---

## 3. Roster import

CSV, because every school already has one.

```
name,email,role,studentId
```

| Requirement | Implementation |
|---|---|
| Dry run first, always | The import UI is two-step: preview diff → apply. A dry run never writes. |
| Per-row errors | A downloadable report: row number, column, problem, suggested fix. A malformed row never blocks the good ones. |
| Idempotent re-import | Keyed on normalised email. Existing members are reported as `unchanged`, not duplicated. |
| Role validation | Only `STUDENT` and `TEACHER`; `OWNER` is rejected with a clear message. |
| Unmatched students | Optionally create placeholder accounts pending registration, matched on first login by email. This is how real school rosters work. |
| CSV injection | Any cell beginning with `= + - @` is prefixed with `'` on both import and export. |
| Parsing | A real CSV parser. Never `split(',')`. |

---

## 4. Roles and permissions

| Capability | Owner | Teacher | Student |
|---|---|---|---|
| Rename / archive classroom | ✓ | — | — |
| Transfer ownership | ✓ | — | — |
| Manage members and roles | ✓ | ✓ (not owner) | — |
| Create / publish assignments | ✓ | ✓ | — |
| Grade and release | ✓ | ✓ | — |
| View integrity evidence | ✓ | ✓ | — |
| View student personal details | ✓ | ✓ | self only |
| Take an assignment | — | if enrolled as student | ✓ |
| See released results | ✓ | ✓ | ✓ (own) |
| See the cohort's aggregate performance | ✓ | ✓ | ✗ **never** |

Two rules that matter more than the table:
- **A student never sees cohort aggregate performance.** No class average, no percentile, no "you are below the class mean". `08-ITEM-ANALYSIS.md` §1 makes this a permanent boundary, not a setting.
- **A teacher sees only their own classrooms.** Classroom scoping is applied *in the query*, not filtered afterwards, and a test asserts the generated SQL contains the scope.

---

## 5. Roster UI

- Paginated, searchable table: name (with the display-name override shown distinctly), email, role, join date, progress, last activity.
- Per-student summary: assignments, attempts, completion state, grade (released only), accommodations on file.
- Bulk actions with a confirmation that states the count and is undoable where safe.
- Remove / change role: confirmation dialogs that name the person. A mis-click that removes 30 students is a support incident and a trust breach.
- Every membership change writes an `AuditEvent` and a `Notification` to the affected user.

---

## 6. Display names

`Enrollment.displayNameOverride` lets a teacher set the name a student appears under **in that classroom only**. It exists because real-name policies are common in schools and forcing legal-name disclosure is not. It is a classroom-scoped display concern and never touches the account.

---

## 7. Notifications

| Event | Channel | Notes |
|---|---|---|
| Invitation sent | Email + in-app | Cooldown on resend; digest after 3 invitations to the same address |
| Assignment published | In-app + optional email | Immediate for a time-boxed exam, digest otherwise |
| Results released | In-app + email | The single most-wanted notification we send |
| Grading needed | In-app only | Never emailed per-response; it would be noise |
| Deadline approaching | In-app | Student-initiated; respects the student's timezone and quiet hours |
| Membership changed | In-app | Always |
| Roster import applied | In-app | With the error report attached |

Rules:
- Every notification is deduped on `(userId, kind, refId)` via `EmailOutbox.dedupeKey`.
- All sending is queued, never inline. A slow email provider must never delay a page render or an autosave.
- Global quiet hours and a per-user digest preference.
- One-click unsubscribe on every email, and unsubscribing never disables in-app notifications a user needs for their coursework.

---

## 8. Phase deliverables (P4)

| ID | Deliverable |
|---|---|
| P4-T1 | `Classroom` model, lifecycle, ownership transfer |
| P4-T2 | Membership: roles, removal, leaving, role history |
| P4-T3 | Invitations: email, bulk, hashed join codes |
| P4-T4 | Invitation lifecycle: accept idempotently, revoke, expire, resend cooldown, recover from "already a member" |
| P4-T5 | Roster CSV: dry run, error report, idempotent apply, bulk invite via worker |
| P4-T6 | Roster UI with per-student summary and safe bulk actions |
| P4-T7 | Notification system: templates, queue, dedupe, quiet hours, unsubscribe |
| P4-T8 | Permission matrix tests: every cell of §4, plus cross-classroom and anonymous refusal for every student-scoped route |

**Exit criteria:** complete invite → accept → participate → remove flow; complete code-join → revoke → fail flow; a removed student loses access within one request while keeping their own records; 1,000-row CSV import completes with a downloadable error report; §4's table is enforced by an exhaustive test.
