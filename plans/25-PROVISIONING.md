# Orrery — day-0 provisioning specification  (P0-T12)
#
# ## Why this file exists
#
# Review finding R18 / D-36: **no task in the plan created a single third-party account or
# any infrastructure.** Four later tasks (`P15-T6` migration rehearsal from staging,
# `P15-T7` restore drill, `P15` load testing in a production-shaped environment, `P17-T7`
# the GA checklist) all assume a deployed staging environment and a working email domain.
# Both would have been discovered missing at roughly week 9, when the pilot needs to email
# an invitation.
#
# Provisioning is a lead-time activity. An email domain with SPF, DKIM and DMARC takes days
# to propagate. A managed Postgres with PITR takes a week to configure correctly and be
# trusted. A real LTI platform for `P16` takes an institutional conversation. None of that
# can be done in the week it is needed.
#
# **This file is the checklist. It is not optional, and it is the first thing that should
# happen after P0.**
#
# ─────────────────────────────────────────────────────────────────────────────
#
# ## Provisioning ledger
#
# Status is a real value, not a wish. `NO_INFRA` blocks a phase; the named phase is where
# the absence is allowed to become a problem, and the answer is which one.
#
# | # | Resource | Why we need it | Needed by | Status | Owner | If absent |
# |---|---|---|---|---|---|---|
# | 1 | **Domain + DNS** | All URLs, cookies, CORS, and the sim origin | P0 | TODO | — | Localhost only; sim origin is a second localhost with a port, which is fine for P0–P15 |
# | 2 | **Transactional email with SPF/DKIM/DMARC** | Invitations, released results, password reset. The single most student-visible dependency. | P4 | TODO | — | **Mailpit.** Invitations are an equal path via join codes (12 §2), so P4 is not blocked — but onboarding degrades and R12 becomes real |
| 3 | **Managed Postgres 16 with PITR** | Grades, receipts, and the release gate | P4 | TODO | — | Docker Compose. Blocks `P15-T7` only |
| 4 | **Managed Redis** | Rate limits, session cache | P4 | TODO | — | Docker Compose |
| 5 | **S3-compatible object storage** | Assets, sim bundles, exports | P2 | TODO | — | MinIO. Blocks `P6` bundle distribution and `P11` exports |
| 6 | **CDN + WAF + TLS** | Static, sim origin, rate limiting | P6 | TODO | — | None. Sim origin can be a subdomain served directly |
| 7 | **Error tracking (Sentry)** | Exam-path failures are the ones that matter | P0 | TODO | — | Structured logs only |
| 8 | **Trace/metrics backend** | The `attemptId` spine (`18` §4.2) | P0 | TODO | — | Local collector. **The spine is worth far more than the backend** |
| 9 | **Staging environment + deploy pipeline** | 4 tasks assume it | P0 | TODO | — | **Blocks `P15-T6`, `P15-T7`, `P15` and `P17-T7`.** `infra/docker/web.Dockerfile` is written; the environment is not |
| 10 | **A real LTI 1.3 platform account** | `P16` conformance | P16 | TODO | — | A self-authored harness tests our harness, not LTI. `16` §7 says so. If cut, the interop scope is already reduced to export + launch |
| 11 | **An actual pilot school** | `P17-T4` | P0 (recruit!) | TODO | — | **Calendar-bound (R17).** A school term does not compress, and this is the most likely thing to make GA slip by a term, not a sprint |
| 12 | **CAPTCHA keys** | Registration risk-triggering | P1 | TODO | — | Risk threshold set to "never", so the control is inert until keys exist |
| 13 | **Repository remote + branch protection** | Required status checks are the only real gate enforcement (D-35, R23) | P0 | TODO | — | Gates run in CI but are **locally bypassable** |
| 14 | **Secret store** | `AUTH_SECRET`, DB URL, S3 keys, HMAC key for the receipt | P4 | TODO | — | `.env` locally. The HMAC key matters: the submission receipt's strength depends on it (C5) |

# ─────────────────────────────────────────────────────────────────────────────
#
# ## Two of these are not "infrastructure" and are the real risks
#
# ### 13 — branch protection is the only unbypassable gate we have
#
# `D-35` and `R23` are blunt about this: every gate in this repository is local, and a local
# gate is bypassable by editing the gate. The `gate-integrity` CI job makes that *loud*, and
# `GATE-CHANGE:` makes it a deliberate act. That is the best that software can do.
#
# The one thing it cannot do is refuse a merge. That is branch protection, owned by a bot
# principal, requiring: `lint`, `schema`, `test`, `integration`, `gate-integrity`, and
# `policy`. **Configure it before P1, not before GA.** It is a five-minute setting whose
# absence makes every gate in this plan advisory.
#
# ### 11 — the pilot is calendar-bound
#
# `P17-T4` needs 3 classrooms, 30 students, 2 full exam cycles, plus the minors and guardian
# consent posture in `P14-T8`. Every one of those depends on humans outside the team, and
# `D1` specifies a secondary-school pilot — which means term dates, not sprint velocity.
#
# Recruiting in P0 costs a conversation. Recruiting in P17 costs a term.
#
# ─────────────────────────────────────────────────────────────────────────────
#
# ## Definition of done for this task
#
# - [ ] Every row above has a real status, or an explicit `CUT` with a consequence recorded
# - [ ] Branch protection is on, with the required checks listed above
# - [ ] The email domain has SPF, DKIM **and** DMARC, and a test inbox receives mail
# - [ ] Managed Postgres has PITR verified by a **restore**, not by a dashboard tick
# - [ ] Staging exists, deploys from `infra/docker/web.Dockerfile`, and has `/healthz` and
      `/readyz` answering from more than one replica
# - [ ] A pilot school has said yes, with a term date
# - [ ] Anything still `NO_INFRA` names the phase it blocks and the workaround

# ─────────────────────────────────────────────────────────────────────────────
#
# ## Posture, decided up front so it is not argued under pressure
#
# **Data region.** EU, by default. `D3` is GDPR-shaped and this is the decision that is
# expensive to reverse. A student record that leaves the region is a different product.
#
# **Sub-processors.** Every third party above is a sub-processor and goes on the public
# register, with a link from the privacy policy. Written in P0, not assembled in P14 from
# whatever happens to be running.
#
# **Retention is a product decision, not a legal one.** The schedules in `14` §7.2 are
# engineering defaults chosen to be defensible. A school may demand longer. The schema has to
# be able to hold that, which it can, because retention is a sweep job and not a cascade.
#
# **No behavioural analytics, no advertising, no data sale.** Not a setting — an absence.
# `14` §7.1 lists what we do not collect, and the honest test is whether the schema can
# express it. It cannot.
