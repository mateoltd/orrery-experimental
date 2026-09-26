# P1 — Identity, Sessions & the `can()` Kernel

**10 tasks · ~28 h · milestone M1 (with P2).** Generated from `plans/20-PHASE-PACKETS.md`.

These packets are one file per phase rather than one file per task, with strict delimiters. An agent should read **only its own packet**, not the whole phase.

**Carry forward from P0** (learned the hard way, do not rediscover):
- Five gates exist and are mutation-verified: `pnpm run gates`. If you change a gate file, the body needs `GATE-CHANGE:` and a rationale.
- `enforcedBy`-style claims are checked by `gate:invariants`. If you implement a mechanism for a staged invariant, flip it to `active` in `plans/invariants.json` and the file must exist.
- `prisma validate` runs in CI. A schema change without a migration fails `gate:schema`.
- The clock rule is a **hard lint error**. Use `@orrery/clock`; `isoNow()` exists for timestamps.
- No `Math.random()`. Use `@orrery/rng`.

---

## P1-T1 · Better Auth: database sessions, MFA-ready accounts

**Depends on** P0-T4 · **Blocks** P1-T2…P1-T10, P4 · **Size** M

**Read first**
- `plans/13-IDENTITY-AUTHZ.md` §1, §2
- `plans/02-DATA-MODEL.prisma` — `User`, `Account`, `Session`
- `plans/14-SECURITY-PRIVACY.md` §2

**Do**
1. Better Auth with email+password (argon2id), magic link, email verification.
2. `Session` rows with `tokenHash`, `familyId`, `revokedAt`, `revokedReason`. **No JWT-only sessions** — `INV-AUTH-1`.
3. On password reset, MFA change or email change: rotate the whole `familyId` and raise a security event on reuse of a revoked token.
4. `User.status` transitions: `SUSPENDED` revokes every session **in the same transaction**. `DELETING` starts a 30-day grace.
5. Minors fields (`isMinor`, `guardianEmail`, `guardianConsentAt`) — the posture is in `14` §7.4, not optional.
6. Login throttling: per-IP and per-identifier, with a **security event** on repeated MFA failure (possible takeover, not just a wrong code).

**Do not**
- Do not add a Redis session cache yet. `C25` found that a 60-second cache silently defeats `INV-AUTH-1`; if you add one, the key must be deleted in the same transaction as every revoke.
- Do not auto-provision users from an LMS identity. That is a spam vector (`16` §4).

**Files you own** — `apps/web/src/server/auth/**`, `packages/auth/src/session.ts`

**Done when**
- [ ] All 12 items in `plans/00` §12
- [ ] Integration: register → verify → session → suspend → **next request refused** → delete → anonymise
- [ ] Integration: reuse of a rotated-family token raises a security event and revokes the family
- [ ] `can()` has no entry for `User` yet (that is P1-T6) — do not block on it

**Verify** `pnpm lint && pnpm typecheck && pnpm --filter @orrery/auth test && pnpm run gates`

---

## P1-T2 · Profile, locale, timezone, minors

**Depends on** P1-T1, P0-T3 · **Blocks** P4-T6, P5-T2 · **Size** S

**Read first** `plans/13-IDENTITY-AUTHZ.md` §1.1 · `plans/15-A11Y-I18N.md` §5

**Do**
1. Display name, avatar (presigned upload), locale, IANA timezone, notification preferences.
2. **Timezone is not cosmetic.** Deadlines render in the student's own zone with an explicit label (`U-9`: a student must never wonder what "until Friday" means).
3. Guardian fields with a consent timestamp. Age declared at registration.

**Do not** — Do not add a public profile. Under-18 accounts have none by policy.

**Files** `apps/web/src/app/(studio)/settings/**`, `apps/web/src/server/services/profile.ts`

**Done when** profile round-trips; timezone is used in at least one rendered date; a guardian consent is timestamped.

**Verify** `pnpm lint && pnpm typecheck && pnpm --filter @orrery/web test`

---

## P1-T3 · Auth UI

**Depends on** P1-T1 · **Blocks** P1-T8 · **Size** M

**Do** sign in / sign up / verify / resend / forgot / reset, with resend cooldowns, and **generic copy that never reveals whether an account exists** (including different timings and identical status codes for "no such user" and "wrong password"). Keyboard-complete, labels associated, errors announced via `role="alert"`.

**Done when** the account-enumeration property has a test asserting identical response shape and timing for both failure kinds.

---

## P1-T4 · Session middleware, route protection, session management UI

**Depends on** P1-T1 · **Blocks** everything · **Size** M

**Do** middleware gating authentication and route groups; `getSession()` with a **60-second maximum** and cache invalidation on revoke; a sessions page listing device, last-seen, and a revoke button per row.

**Done when** revoking a session in the UI refuses the next request; a suspended user is refused despite a warm cache (`C25` regression test).

---

## P1-T5 · Account deletion, export, anonymisation

**Depends on** P1-T1 · **Size** M

**Read first** `plans/13-IDENTITY-AUTHZ.md` §1.2 · `plans/14-SECURITY-PRIVACY.md` §7.3

**Do**
1. Grace period, then anonymisation. Auth rows deleted; content referenced by a graded submission is **anonymised to a tombstone, not deleted**, so historical grades stay coherent.
2. A terminal `AuditEvent` recording what was removed and what was retained, with counts.
3. Self-serve export as JSON + CSV via a background job and a signed expiring link.
4. **A dry run first**, reporting exactly what would go.

**Do not** — Do not null PII out of the student's own free-text answers. They asked to delete their *account*, not to falsify their *work*. The retention schedule governs the work. Say this plainly in the confirmation.

**Done when** deletion and export both run end to end; the dry-run report matches the real run's counts; the audit event is written.

---

## P1-T6 · The `can()` kernel and its matrix

**Depends on** P1-T1 · **Blocks** every later phase · **Size** L · **the highest-leverage security work in the project**

**Read first** `plans/13-IDENTITY-AUTHZ.md` §3 (all of it) · `plans/20` D-14

**Do**
1. `can(actor, action, subject, context?) → Decision`, where a `Decision` is `{ allowed: true, obligations: [...] }` or `{ allowed: false, reason }`. **Pure** — no I/O, no clock, no database.
2. The matrix declared as **data**, so a coverage report can prove totality mechanically. An unrecognised `(action, type)` pair **throws in development and denies in production**.
3. `can()` must return **obligations**, and services must assert the obligations they depend on. A permission granted in one place and relied on in another is the bug this prevents.
4. Only the types that exist at P1: `User`, `Asset`. `P4-T8`, `P5-T14`, `P8-T1`, `P10-T1` and `P16-T1` each **extend the matrix for their new types, and the totality test must fail before and pass after** (D-14).
5. **100% branch coverage**, plus **12–20 hand-written adversarial scenarios** naming the specific wrong outcome. The generated matrix cells prove self-consistency; the scenarios prove correctness. Those scenarios *are* the authorisation test suite (D-33).

**Do not** — Do not write `resource.ownerId === session.userId` anywhere. `eslint.config.js` bans ownership comparisons outside `packages/auth`; a CI grep enforces it. If you find one, fix it, do not suppress it.

**Files** `packages/auth/src/can.ts`, `packages/auth/src/matrix.ts`, `packages/auth/src/__tests__/**`

**Done when**
- [ ] The completeness test proves every `(action, type)` pair has a rule
- [ ] No cell grants `allowed: true` with a contradictory obligation
- [ ] 100% branch
- [ ] The adversarial scenarios are written as names a teacher could read: *"a teacher from classroom A cannot read or grade a submission in classroom B"*
- [ ] `gate:invariants` still passes (this task does not add an invariant; if you think it should, that is an ADR)

---

## P1-T7 · Registration anti-abuse

**Depends on** P1-T1 · **Size** S

**Do** per-IP and per-identifier throttles; a disposable-domain list used as a **review signal, not a hard block** (false positives lock out real students, and school IPs are shared); **risk-triggered** CAPTCHA, not always-on; anomaly signals to a review queue.

**Read first** `plans/24-P0-RISK-REVIEW.md` MISSED-1 — the same actor-keyed reasoning applies here, and `INV-ABUSE-1` is the shape.

**Done when** a shared school IP is not blocked; a disposable domain is *flagged*, not refused; sustained automated signup lands in a review queue.

---

## P1-T8 · Playwright identity fixtures

**Depends on** P1-T3 · **Blocks** every E2E spec · **Size** S

**Do** `user()`, `teacher()`, `student()` factories with deterministic identities, a `seedFactory` that builds a coherent world (classroom, enrolment, resource, version, assignment, attempt) in any shape, and a `frozenClock` binding so no E2E test sleeps on real time.

**Done when** an E2E spec can create a teacher with a classroom and a student enrolled, in two lines, with no shared mutable state.

---

## P1-T9 · MFA, and the teacher-grading gate

**Depends on** P1-T1 · **Size** M

**Do** TOTP enrolment with a QR code and a **recovery code set shown exactly once**; verification; disable. A teacher cannot perform a grade submission without MFA enrolled.

**Read first** `plans/15-A11Y-I18N.md` §1.1 — `3.3.8 Accessible Authentication` is why TOTP is permitted and why a cognitive-function-test alternative is not.

**Done when** the gate is enforced server-side; a lost second factor has a recovery path that does **not** lock a teacher out of an in-flight grading session.

---

## P1-T10 · Impersonation

**Depends on** P1-T6 · **Size** M

**Do** explicit, audited, **read-only**, hard-capped at 15 minutes, with an unmissable persistent banner, an `x-impersonating` header on every request, and notification to the impersonated user. **Every write path is denied**, because an impersonated write is indistinguishable from a compromised admin session.

**Done when** a write attempted while impersonating is refused with a clear code; the banner cannot be dismissed; the user is notified; the audit stream and the notification inbox both carry the event.

---

## Phase exit

- [ ] Register → verify → session → suspend → refuse → delete → anonymise, end to end
- [ ] `can()` at 100% branch with a mechanically-proven complete matrix and the adversarial scenarios written
- [ ] Zero ownership comparisons outside `packages/auth`
- [ ] A teacher cannot grade without MFA
- [ ] All five gates green, `next build` green
- [ ] `INV-AUTH-1` and `INV-CLASSROOM-1` implemented → flip both to `active` in `plans/invariants.json` with their real files
