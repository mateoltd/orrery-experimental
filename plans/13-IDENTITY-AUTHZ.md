# 13 — Identity, Sessions & the Authorisation Kernel

Everything downstream trusts this layer, so it gets the most scrutiny and the strictest tests.

---

## 1. Accounts

| Method | Notes |
|---|---|
| Email + password | Argon2id. Breached-password list check. Generic failure copy. |
| Magic link | Single use, 15-minute TTL, invalidates the session family on use |
| Email verification | **Required** before creating a classroom, publishing a public resource, or grading an exam |
| TOTP MFA | Supported; **required for teachers before their first grade submission** (`D6`, and a compromised teacher account is the highest-value attack in the product) |
| OAuth | Deferred; the schema supports it, and adding a provider must not change the authorisation model |
| Passkeys | Deferred, WebAuthn-ready schema |

### 1.1 Minors
`isMinor` and `guardianEmail` are collected at registration and drive: no public profile, no public commenting without teacher approval, guardian visibility configurable per classroom, and guardian access to the student's own records on request. The posture is documented rather than inferred (`14-SECURITY-PRIVACY.md` §7.4).

### 1.2 Account lifecycle
```
ACTIVE ──► SUSPENDED      (admin; revokes all sessions in the same transaction)
ACTIVE ──► DELETING ──► DELETED   (30-day grace, then anonymise)
```
Deletion, with a dry run first:
1. Delete auth rows, sessions, tokens, notification preferences.
2. Delete authored content **unless** referenced by a graded submission.
3. Content referenced by a graded submission is **anonymised**, not deleted, so historical grades stay coherent and attributable to a tombstone rather than to a person.
4. Null out PII in submissions the student authored as free text? **No** — those are the student's own academic records, and the student asked us to delete their account, not to falsify their own work. We delete the *account*; the *work* is retained per the retention schedule and is exportable until then. This is stated plainly in the deletion confirmation.
5. Write a terminal `AuditEvent` recording what was removed and what was retained, with counts.

---

## 2. Sessions — INV-AUTH-1

Sessions live in Postgres. This is a hard requirement, not a preference: a teacher suspending a student, or removing them from a classroom, must take effect on the **next request**, including mid-exam.

| Property | Implementation |
|---|---|
| Storage | `Session` rows; `tokenHash` at rest |
| Rotation | On privilege change (password reset, MFA enrolment, email change) the whole `familyId` is revoked, and reuse of a revoked token revokes the family and raises a security event |
| Revocation | `revokedAt` + `revokedReason`. Checked on every mutating request |
| Expiry | Sliding, capped at an absolute maximum; idle timeout shorter for students than teachers |
| Cookie | `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix, path `/` |
| No tokens in URLs | Ever. Email links carry a single-use token that is exchanged, not a session |
| Device list | Students and teachers can see and revoke their own sessions |

> **Rejected: JWT-only sessions.** They cannot be revoked, which makes mid-exam removal impossible and account suspension a lie.

---

## 3. The authorisation kernel

One function. One entry point. Every read and every write.

```ts
can(actor, action, subject, context?) → Decision
// Decision = { allowed: true, obligations: [...] } | { allowed: false, reason: Code }
```

### 3.1 Properties
1. **Total.** Every `(action, resourceType)` pair has a rule. An unrecognised pair **throws in development and denies in production** — so adding a resource type without adding its rules is a loud runtime failure, not a silent allow.
2. **Pure.** No I/O, no clock, no database. It takes the subject (or a subject descriptor) and returns a decision. That makes the entire permission model exhaustively testable, which is the only reason we can claim it is correct.
3. **Context-aware.** `can(user, 'grade', response, { attempt, classroom })` — the same question in a different classroom is a different answer.
4. **Carries obligations**, not just a boolean: `{ allowed: true, obligations: ['requireMfa', 'sameClassroom', 'audit'] }`. Services then assert the obligations they depend on, so a permission cannot be granted in one place and relied upon in another.

### 3.2 The matrix
Actions: `create`, `read`, `update`, `delete`, `publish`, `assign`, `start`, `save`, `submit`, `grade`, `release`, `viewEvidence`, `void`, `excuse`, `regrade`, `invite`, `removeMember`, `changeRole`, `importRoster`, `export`, `impersonate`, `suspend`, `transfer`.

`transfer` is a P2-T9 addition and was not in the original list. It is the same reasoning that puts
`changeRole` in its own action rather than folding it into `update`: transferring ownership changes
who can see a subject, edit it, and answer for it, and folding it into `update` would give every
"rename this" request the power to hand over somebody's lesson. Real rules exist for `Resource`
(owner-or-admin, audited, reason required) and `Classroom` (transferable and audited, per §Classroom
— a teacher's resignation must not leave a class without a teacher). Everything else is denied.

Types: `User`, `Resource`, `ResourceVersion`, `QuestionBank`, `Question`, `QuestionPool`, `Blueprint`, `Classroom`, `Enrollment`, `Invitation`, `Assignment`, `ExamAttempt`, `QuestionResponse`, `IntegrityEvidence`, `ReviewTask`, `ReleaseBatch`, `Asset`, `AuditEvent`, `Simulation`, `SimulationDraft`, `ExternalBinding`.

**2,000+ cells.** Every one has a test. This is unglamorous and it is the highest-leverage security work in the project.

### 3.3 Hardening the kernel
- The matrix is declared as data, not as branching code, so a coverage report can prove totality mechanically.
- A test asserts every `(action, type)` pair appears in the matrix — a **completeness test**, not a spot check.
- A test asserts no cell grants both `allowed: true` and a contradictory obligation.
- A test asserts every `can()` call site in the codebase passes a non-null `actor`.
- A CI check greps for ownership comparisons outside `packages/auth` (`resource.ownerId === session.userId`) and fails the build. This is the single most common way authorisation gets bypassed in practice.

---

## 4. Route protection

| Layer | Mechanism |
|---|---|
| Middleware | Coarse gating: authentication, coarse route group, and `better-auth` session read. **Never the authorisation decision** |
| tRPC procedure | `publicProcedure` / `protectedProcedure` / `teacherProcedure` as the baseline, then `can()` for the resource decision |
| Service layer | The authoritative check. Even a correctly-gated route calls `can()`, because routers are not a security boundary against a future refactor |
| Query layer | Classroom and ownership scope is present **in the SQL**, verified by tests that assert the generated query contains it |

The rule: **a check that exists in only one of these layers is a bug waiting to happen.** Every student-scoped route is checked in at least the service and query layers.

---

## 5. Impersonation

Admin support needs it; abuse needs it guarded.

- Explicit, audited, **read-only**, hard-capped at 15 minutes.
- A persistent, unmissable banner in the UI while active.
- Recorded to the `AuditEvent` stream **and** to the impersonated user's notification inbox, so a user is never surprised by an admin in their account.
- Cannot grade, release, void, or change policy. Those are explicitly denied, because an impersonated write is indistinguishable from a compromised admin session.
- Every impersonated request carries `x-impersonating: <adminId>` and appears in traces and audit.

---

## 6. Anti-abuse at registration

| Control | Rationale |
|---|---|
| Per-IP and per-identifier rate limits | Registration is the cheapest attack surface we have |
| Disposable-domain blocklist | Configurable, community-maintained, **never a hard block on its own** — false positives lock out real students |
| Risk-triggered CAPTCHA (Turnstile) | Friction on everyone hurts legitimate classrooms more than bots hurt us. Triggered, not always-on |
| Email verification before any value-creating action | A throwaway inbox cannot own a classroom |
| Anomaly signals → review queue, not auto-ban | Auto-bans catch honest students on shared school IPs |

---

## 7. Phase deliverables (P1)

| ID | Deliverable |
|---|---|
| P1-T1 | Better Auth: email+password, magic link, verification, DB sessions, `User.status` |
| P1-T2 | Profile: name, avatar, locale, timezone, notification preferences, minors fields |
| P1-T3 | Auth UI: sign in/up/verify/reset, resend, cooldown UX, rate limiting, no enumeration |
| P1-T4 | Session middleware and `getSession()` cache; route protection |
| P1-T5 | Account deletion: grace, cascade plan, anonymisation, export-as-JSON job, dry run |
| P1-T6 | **The `can()` kernel** and its exhaustive matrix tests |
| P1-T7 | Anti-abuse: throttles, blocklist, risk-triggered CAPTCHA, audit events |
| P1-T8 | Playwright fixtures: `user()`, `teacher()`, `student()` with deterministic identities |
| P1-T9 | MFA enrolment and verification, teacher-grading gate |
| P1-T10 | Impersonation with audit and banner |

**Exit criteria:** register → verify → session → suspend → refuse → delete → anonymise; `can()` at 100% branch coverage with a mechanically-proven complete matrix; zero ownership comparisons outside `packages/auth`; no route leaks another user's data; a teacher cannot grade without MFA.
