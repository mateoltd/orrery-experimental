# Security, Privacy & Abuse

---

## 1. Threat model summary

| Actor | Capability | Primary threats |
|---|---|---|
| Anonymous visitor | Nothing | Registration abuse, enumeration, scraping, DoS |
| Authenticated student | Own account | Answer sharing, cross-classroom access, exam circumvention, harassment |
| Authenticated student (hostile client) | Own account + custom HTTP | Forged telemetry, replayed saves, privilege escalation via IDOR, key extraction |
| Teacher | One classroom | Overreach into other classrooms, mass-grading abuse, roster data exfiltration |
| Resource author | Own resources | Stored XSS via content, malicious simulation upload, licence infringement |
| Simulation author | Code execution in sandbox | Sandbox escape, exfiltration, resource exhaustion, browser exploitation |
| Compromised dependency | Build/runtime | Supply-chain, token theft, prototype pollution |
| Insider | Broad access | Bulk data access, grading manipulation |

---

## 2. Authentication and sessions
- Argon2id password hashing (via Better Auth), breached-password list check, generic auth failure copy.
- Sessions in Postgres with `revokedAt`. Revocation takes effect on the next request — this is a hard requirement for mid-exam removals and suspensions.
- Email verification required before creating a classroom or publishing a public resource. Verification is rate-limited and cooldown-gated.
- Magic links are single-use, 15-minute TTL, and invalidate the session family on use.
- MFA (TOTP) is supported and **required** for teachers before they can grade an exam. If a teacher loses their second factor, a recovery flow exists; losing it must never mean losing access to an in-flight grading session.
- No session token in any URL. `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix.

---

## 3. Authorisation
- One entry point: `can(actor, action, subject, context)` in `@orrery/auth`. Every router procedure and every data-access function requires a decision. No ad-hoc ownership checks anywhere (ESLint cannot fully enforce this, but the review checklist can).
- **Default deny.** An unrecognised `(action, resourceType)` pair throws in development and denies in production. Adding a resource type without adding its rules is a runtime failure, not a silent allow.
- **IDOR tests are mandatory.** Every task touching student data adds a test proving a second user, a second classroom, and an anonymous caller are all refused. This is in the Definition of Done, not optional.
- **Classroom scoping** is applied in the query, not filtered afterwards. Every student-scoped query includes `classroomId` in its `WHERE`; cross-classroom leakage is a query bug we can test for by asserting the generated SQL contains the scope.
- **Impersonation** is a first-class, audited, read-only, time-boxed (15 min) admin action with a persistent banner in the UI, and it is logged to the audit stream and to the impersonated user's notification inbox.

---

## 4. Injection and content
- **No SQL string interpolation anywhere.** Prisma parameterises; raw SQL in `packages/db/src/queries/` is parameterised and reviewed.
- **Blocks are a closed union**, not free HTML. The renderer emits HTML from typed data; user-supplied HTML is not accepted. Rich text is ProseMirror JSON validated against the block schema on every write.
- **KaTeX** with `trust: false`, `strict: 'error'`. No `\href`, no `\htmlClass`, no user-controlled macros.
- **Markdown** is not rendered as HTML. Where markdown is accepted (comments, feedback), it is a strict subset with no raw HTML, rendered through an allowlist.
- **File uploads:** content-type allowlist, magic-byte verification, size cap, image re-encode (stripping EXIF and any embedded payload), SVG **not** accepted as an image (SVG is script), and an async scan status.
- **CSV injection:** exports prefix any cell beginning with `= + - @` with a `'`. Roster import is parsed with a real CSV parser, never `split(',')`.

---

## 5. Simulation sandbox
Detailed in `03-SIMULATIONS.md` §2. The controls, restated as a checklist:
- [x] `sandbox="allow-scripts"` with **no** `allow-same-origin`, **no** `allow-forms`, **no** `allow-popups`, **no** `allow-top-navigation`
- [x] dedicated static origin with a strict CSP (`default-src 'none'`, no `connect-src` except `'none'`)
- [x] nonce-verified `postMessage` in both directions; unknown frames ignored
- [x] no network access from the frame at all
- [x] no storage, no cookies, no clipboard, no `window.opener`
- [x] frame size capped and controlled by the host; a sim cannot resize the page
- [x] protocol and version validated before any payload is trusted
- [x] CI test asserts the frame genuinely cannot reach the host (cookie, storage, `fetch`)
- [x] registry entries are built by CI, never uploaded by users
- [x] per-sim byte budget, so a sim cannot be a zip bomb
- [x] a sim crash degrades to a static fallback and never loses a student's answer

**Residual risk, stated honestly:** a browser engine vulnerability reachable from a sim would be a platform-level problem. Mitigations: no user-uploaded code (decision D5), a build allowlist, prompt dependency patching, and sims on a separate origin so a compromised frame still has no credentials to steal.

---

## 6. Exam integrity
See `05-EXAM-INTEGRITY.md`. The security-relevant summary:
- All grading inputs are server-held; client-supplied scores are never read.
- Deadlines are server-computed; client clocks are irrelevant.
- Telemetry is re-stamped and reclassified server-side and cannot affect any score.
- Release is a single transaction; a partial release is structurally impossible.
- No automated punitive consequence is ever applied to a student without a human decision.

---

## 7. Data protection

### 7.1 What we collect
Account (email, name, avatar, locale, timezone), authored content, classroom membership, assessment responses, integrity telemetry, and operational logs. **We do not collect** camera, microphone, screen content, keystrokes, clipboard contents, or third-party analytics.

### 7.2 Retention
| Data | Retention |
|---|---|
| Integrity telemetry | 400 days, then aggregate to counts and delete |
| Exam attempts, responses, grades | Life of the classroom + 24 months, then archived or deleted per the owner's instruction |
| Session rows | 30 days after expiry |
| Password reset / verification tokens | 24 hours |
| Invitations | 90 days after expiry |
| Audit events | 7 years (defensible record of grading decisions) |
| Soft-deleted accounts | 30-day grace, then anonymised |
| Exports | 7 days |
| Backups | 35 days, then destroyed |

Retention sweeps are a real cron job with a dry-run mode and a report, not a promise.

### 7.3 Rights
- **Export:** self-serve, machine-readable JSON + CSV of everything, generated by a background job, delivered by a signed expiring link.
- **Erase:** 30-day grace, then: auth rows deleted, profile anonymised, authored content deleted *unless* referenced by a graded submission, in which case it is anonymised so historical grades remain coherent. A tombstone keeps referential integrity. Every cascade is dry-run first and reported.
- **Rectify:** profile fields are self-serve; grade corrections go through the regrade path with an audit record, because a student's request to change a grade is a teacher's decision, not a data-subject one.
- **Consent:** consent to terms and privacy policy versioned; consent to *proctoring* is a separate, granular, per-assignment consent for students (and for a guardian where the student is a minor). Refusing proctoring is always an option and is never penalised.

### 7.4 Minors
Orrery is usable by schools, so the posture is explicit: age-declared at registration, no public profile for accounts flagged as under-18, no public commenting without teacher approval for under-18 accounts, guardian visibility configurable per classroom, no behavioural advertising, no data sold, and guardian access to a student's own records on request.

---

## 8. Infrastructure
- Secrets in a managed secret store; images contain no secrets; `.env` is git-ignored and CI scans for accidental commits.
- CSP on the app origin: `default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, no `unsafe-eval` in production, `frame-ancestors` locked to self plus an allowlist for embedding (if we ever support that, it is per-resource and opt-in).
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/microphone/geolocation by default (an exam never needs them).
- TLS everywhere; internal traffic encrypted; database connections require TLS.
- Admin surface behind a separate hostname with IP allowlisting and mandatory MFA.
- Dependency policy: `osv-scanner` in CI, high/critical blocks merge, weekly scheduled scan with an SLA, and a documented exception process.
- Backups encrypted, access-logged, and **restore-tested** (see `09-OPS.md`).

---

## 9. Abuse and safety
- **Registration:** IP and device rate limits, disposable-domain blocklist (configurable, community-maintained), CAPTCHA (Turnstile) after a risk threshold rather than always — friction hurts legitimate classrooms more than bots hurt us.
- **Content moderation:** resources can be flagged; public resources are queued for review; a `DMCA`/takedown path is documented and honoured within a fixed SLA.
- **Harassment:** students can block and report within a classroom; reports go to the classroom's teachers, not to the platform by default.
- **Academic-integrity policy:** published plainly to teachers and students, describing exactly what is recorded, what the platform can and cannot detect, and what happens after a report. A policy students can read and predict is both fairer and more defensible than an opaque one.
- **Self-harm / crisis content:** free-response content is not monitored at scale in v1 (we do not read student answers). A teacher-facing reporting affordance exists, and the policy states this limitation honestly. If monitoring is later added, it is opt-in per classroom with explicit consent and a human review queue — never automated intervention on student writing.

---

## 10. Security review checklist (run at P13-T5 and before GA)
- [ ] IDOR tests exist for every student-scoped endpoint
- [ ] `can()` has no unhandled `(action, type)` pair; default-deny verified
- [ ] No client payload, log, trace, error or analytics event contains answer keys, PII or credentials (automated scanner)
- [ ] Sandbox escape test green against the real host component
- [ ] CSP report-only reviewed, then enforced
- [ ] Rate limits verified by test on every auth and exam route
- [ ] Dependency scan clean; exceptions documented with expiry
- [ ] Backup restore rehearsed; retention sweeps run in dry-run and reviewed
- [ ] Admin actions audited; impersonation banner present
- [ ] Threat model document reviewed with someone who did not write it
