# 14 — Security, Privacy & Abuse

---

## 1. Threat model

| Actor | Capability | Primary threats |
|---|---|---|
| Anonymous visitor | Nothing | Registration abuse, enumeration, scraping, DoS |
| Authenticated student | Own account | Answer sharing, cross-classroom access, exam circumvention, harassment |
| Hostile client (student) | Own account + custom HTTP | Forged telemetry, replayed saves, IDOR, key extraction, grade tampering |
| Teacher | One classroom | Overreach into other classrooms, mass-grading abuse, roster exfiltration |
| Resource author | Own resources | Stored XSS via content, licence infringement, sim reference abuse |
| Simulation author | Code execution in a sandbox | Sandbox escape, exfiltration, resource exhaustion, browser exploitation |
| Compromised dependency | Build or runtime | Supply chain, token theft, prototype pollution |
| Insider | Broad access | Bulk data access, grading manipulation, impersonation abuse |

Full per-threat controls for the exam path are in `09-EXAM-INTEGRITY.md` §3.

---

## 2. Authentication and sessions
Covered in `13-IDENTITY-AUTHZ.md`. Security-relevant summary: Argon2id; breached-password checks; generic failure copy; **database sessions so revocation is immediate**; session-family rotation and reuse detection; MFA required for teachers before grading; `HttpOnly`/`Secure`/`SameSite=Lax`/`__Host-`; no tokens in URLs.

---

## 3. Authorisation
One kernel, `can()`, default deny, 2,000+ tested cells, obligations carried in the decision, and a CI grep that fails on ownership comparisons outside `packages/auth`. See `13` §3.

**IDOR tests are part of the Definition of Done.** Every task touching student data adds a test proving three refusals: a second user, a cross-classroom user, and an anonymous caller. This is not optional and not sampled.

---

## 4. Injection and content

| Vector | Control |
|---|---|
| SQL | Prisma parameterises. Raw SQL only in `packages/db/src/queries/`, always parameterised, always reviewed — Prisma cannot type-check it |
| XSS via content | **No user HTML, ever.** A closed block union rendered to HTML we generate. There is no sanitiser to keep patched (`05` §1) |
| XSS via maths | KaTeX `trust: false`, `strict: 'error'`. No `\href`, no `\htmlClass`, no author macros |
| Markdown | Strict subset, no raw HTML, allowlist renderer |
| Prototype pollution | No deep `Object.assign` of untrusted objects; Zod `.strict()` on every inbound schema; `Object.create(null)` maps in hot paths |
| CSV injection | Cells beginning with `= + - @` prefixed with `'` on import and export |
| File upload | Content-type allowlist, magic-byte verification, size cap, image re-encode stripping EXIF, **SVG rejected as an image**, async scan status |
| SSRF | No user-supplied URLs are ever fetched server-side. `embedExternal` is a fixed provider allowlist with fixed URL templates |
| Deserialisation | JSON only, via Zod, with depth and size limits on inbound bodies |

---

## 5. Simulation sandbox

`INV-SIM-1`. The checklist, as a release gate:

- [x] `sandbox="allow-scripts"` — **no** `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`
- [x] dedicated static origin with strict CSP (`default-src 'none'`, `connect-src 'none'`, `script-src 'self'`)
- [x] nonce-verified `postMessage` both directions; unknown frames ignored
- [x] no network access from the frame at all
- [x] no storage, no cookies, no clipboard, no `window.opener`
- [x] frame size capped and host-controlled
- [x] protocol and version validated before any payload is trusted
- [x] CI test asserts the frame cannot reach the host (cookie, storage, `fetch`)
- [x] registry built by CI only; **no user code** (`ADR-0018`)
- [x] per-sim byte budget, so a sim cannot be a zip bomb
- [x] a sim crash degrades to a static fallback and never loses an answer

**Residual risk, stated honestly:** a browser-engine vulnerability reachable from a sandboxed frame would be a platform-level problem, not a bug we can fix. Mitigations: no user code, a dependency allowlist, prompt patching, a separate origin so a compromised frame holds no credentials, and sim bundles served with `Cross-Origin-Resource-Policy: same-origin` and immutable caching.

---

## 6. Exam integrity
Server-side authority for time, items, grading and release; client evidence is never a verdict; no biometric monitoring; accommodations produce zero violations. See `09-EXAM-INTEGRITY.md` and `ADR-0017`.

---

## 7. Data protection

### 7.1 What we collect
Account data, authored content, classroom membership, assessment responses, integrity telemetry, operational logs.

**We do not collect:** camera, microphone, screen content, keystrokes, clipboard contents, location, or third-party analytics. This is not a marketing claim; each of these is an explicit omission in the schema and a line in the code review checklist. `RN-01`/`RN-02` are the reason, and the reason is also the product's strongest privacy position.

### 7.2 Retention

| Data | Retention |
|---|---|
| Integrity telemetry | 400 days, then aggregated to counts and deleted |
| Attempts, responses, grades | Life of the classroom + 24 months, then archived or deleted per the owner's instruction |
| Sessions | 30 days after expiry |
| Password reset / verification tokens | 24 hours |
| Invitations | 90 days after expiry |
| Audit events | 7 years — a defensible record of grading decisions |
| Soft-deleted accounts | 30-day grace, then anonymised |
| Exports | 7 days |
| Backups | 35 days, then destroyed |
| Email outbox | 90 days |

Retention sweeps are a real cron job with a dry-run mode and a report — not a promise. Every sweep's counts go to the audit stream.

### 7.3 Rights
- **Access / export:** self-serve, machine-readable JSON + CSV of everything the user holds or authored, via a background job and a signed expiring link.
- **Erasure:** the cascade in `13` §1.2, with a dry run and a terminal audit record of what was removed and retained.
- **Rectification:** profile fields self-serve. **Grade corrections are not a data-subject request** — they go through the regrade path with an audit record, because a student's request to change a grade is a teacher's decision, not a privacy one. Saying so plainly is more honest than quietly complying.
- **Portability:** QTI export (`16`) plus a full JSON export.
- **Consent:** terms and privacy policy **versioned**; consent to proctoring is separate, granular and per-assignment, with a non-penalising refusal path. `RN-02`.

### 7.4 Minors
Usable by schools, so the posture is explicit rather than inferred:
- Age declared at registration; under-18 accounts get no public profile.
- No public commenting from under-18 accounts without teacher approval.
- Guardian visibility configurable per classroom; guardian can request the student's records.
- No behavioural advertising. No data sale. No third-party analytics.
- Guardian consent recorded with a timestamp (`guardianConsentAt`).

### 7.5 Free-response content
We **do not** read or monitor students' written answers at scale in v1. That is a deliberate privacy choice, stated to teachers. If content review is ever added it is opt-in per classroom, requires explicit consent, and routes to a human queue — never automated intervention on a student's writing.

---

## 8. Infrastructure

| Control | Implementation |
|---|---|
| Secrets | Managed secret store; runtime injection; never in the image, git, or logs. `scripts/scan-secrets.sh` in CI |
| CSP | `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors` locked. No `unsafe-eval` in production |
| HSTS | Enabled, preload eligible |
| Headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` on app routes |
| Permissions-Policy | Camera, microphone, geolocation, payment all **denied by default** — an exam never needs them |
| TLS | Everywhere, including internal traffic and database connections |
| Admin surface | Separate hostname, IP allowlist, mandatory MFA, separate audit stream |
| Dependencies | `osv-scanner` in CI; high/critical blocks merge; weekly scan with an SLA; documented exception process with expiry |
| Backups | Encrypted, access-logged, **restore-tested** (`18`) |
| Rate limits | Per the table in `04` §6, with each limit test-covered |
| File scanning | ClamAV or equivalent on student uploads; status blocks a submission from being gradeable until clean |

---

## 9. Abuse and safety

| Abuse | Response |
|---|---|
| Registration flooding | IP + identifier limits, risk-triggered CAPTCHA, review queue (never auto-ban — shared school IPs) |
| Disposable email abuse | Blocklist as a **review signal**, not a hard block |
| Resource spam / plagiarism | Flag → moderation queue → takedown with a published SLA |
| Harassment between students | In-classroom block and report; reports go to the classroom's teachers, not the platform by default |
| Cheating reports | Teacher-only flow producing an `IntegrityVerdict` with a reason. Never an automated accusation |
| Credential stuffing | Rate limits, breach-list checks, MFA, session-family revocation on reuse detection |
| Scraping | Rate limits, robots policy, and CDNs for all public content |

### 9.1 The academic-integrity policy is published
Students and teachers can read, before any exam, exactly what is recorded, what the platform can and cannot detect, who sees it, and what happens after a report. `RN-01`/`RN-03` are quoted in that document.

A policy a student can read and predict is both fairer and far more defensible than an opaque one — and it is the honest response to the finding that these systems are weak at detection. We would rather be trusted than appear to be controlling.

---

## 10. Security review checklist (P14-T5, and before GA)

- [ ] IDOR tests exist for every student-scoped endpoint (three refusals each)
- [ ] `can()` matrix is mechanically complete; no unhandled `(action, type)` pair
- [ ] Zero ownership comparisons outside `packages/auth` (CI grep)
- [ ] No answer key, PII or credential in any client payload, log, trace, error, breadcrumb or analytics event (`audit:seals`, `audit:payloads`)
- [ ] Canary-value log-scrubbing test green
- [ ] Sandbox escape test green against the real host component
- [ ] CSP report-only reviewed, then enforced
- [ ] Rate limits verified by test on every auth and exam route
- [ ] Upload scanning live; `svg` rejected; CSV injection escaped on export
- [ ] Dependency scan clean; exceptions documented with expiry
- [ ] Retention sweep run in dry-run and reviewed; DSAR rehearsed end to end
- [ ] Restore drill completed and timed
- [ ] Impersonation banner present; impersonation denied all write paths
- [ ] Admin surface allowlisted and MFA-gated
- [ ] Published academic-integrity policy reviewed by someone who did not write it
- [ ] Threat model reviewed by someone who did not write it
