# Threat model — OWASP Top 10 review against the implemented code

**P14-T1.** This is a findings list, not a checklist. Nothing in `plans/14` §10 is ticked here, because a
tick asserts a property and the only honest way to assert one is to have watched it hold.

**Read `07-SECURITY-PRIVACY.md` alongside this.** That document is the *intended* posture. This one is
what the repository enforces today. Where the two disagree, the disagreement is the finding — and in most
cases it is `07` that is wrong.

---

## 0. Method, scope, and what "today" means

**What was examined.** `apps/web`, `apps/worker`, `packages/*`, `scripts/`, `audit/`, `.github/workflows/ci.yml`,
`docker-compose.yml`, `.env.example`, `.npmrc`, `package.json`, `pnpm-lock.yaml`, `plans/invariants.json`, and
the `plans/09` / `plans/13` / `plans/14` authorities. Targeted greps, plus full reads of every
request-reachable file — there are only five route handlers and one middleware in `apps/web`, so the request
surface was read exhaustively rather than sampled.

**What "exploitable today" means here.** The repository is a working tree on `master`, not a deployed
service. "Today" therefore means: *a request that reaches the running `apps/web` process in this repository's
current state, and nothing else.* That distinction decides the severity of the headline finding below, so it is
worth being precise about the two states that exist:

| State | What identity a caller has | Which findings are live |
|---|---|---|
| `ORRERY_DEV_USER_ID` **unset** (the state in a clean checkout; it appears in no `.env.example`, no compose file, and no CI env) | `/classrooms/:id/roster` acts as the all-zeroes UUID; `/api/exam/answers` returns 401 | TM-01 (partly), TM-02, and every "not wired" finding |
| `ORRERY_DEV_USER_ID` **set to a real user** (what local development does, and what any deployment would do to make the app function at all) | both routes act as *that one user*, for every caller, unauthenticated | all of them |

The honest headline is therefore not "the site is open". It is: **`apps/web` has no concept of a caller.** The
moment an environment sets one variable, every path that derives its identity from it is gated on an
unauthenticated caller. **No code change is required for that to happen** — and no deployment could make the
app useful without setting it.

**Two leads were checked and one did not survive.** The session-layer lead is confirmed and is TM-01. The
"No CSP is configured" lead is **refuted**: a nonce-based CSP exists and is built in `apps/web/src/middleware.ts:96-122`.
The consequence is a different and smaller finding (TM-09), and stating the refutation matters, because a
threat model that repeats an unverified rumour is the thing this document exists to prevent.

---

## 1. Findings

Severity is argued per finding, not asserted. The scale:

| Severity | Meaning here |
|---|---|
| **Critical** | An unauthenticated or low-privilege caller can reach student data or change it, and **the control that should stop them is deciding on a false premise** — not merely missing. |
| **High** | A control the security argument depends on is absent, so the argument does not hold. Not necessarily reachable today. |
| **Medium** | A stated control is implemented somewhere but not on the path that matters, or is implemented wrongly, or is a check that has quietly stopped checking. |
| **Low** | A real limitation with limited consequence, or a defect in a defence rather than in a boundary. |

The Critical definition is worded carefully because it is the one that is easy to overclaim. TM-01 is *not*
"the authorisation kernel is broken" — it is "the kernel is working correctly on an identity the caller
supplied". Every permission check in the request path fires, every one of them passes, and the conclusion is
wrong. That is worse than a missing check, and it is also harder to spot, because the logs show decisions
being made.

Finding IDs are **`TM-nn`**. This prefix is **new** — see §5 for why it is not `INV-`, `D-` or `T`.

---

### A01 — Broken access control

#### TM-01 · Critical · **Exploitable today (state 2), and partly in state 1** · New task **P14-T11**

**`apps/web` has no session layer. Caller identity is a process-wide environment variable, and the roster
page defaults to a fixed UUID when it is unset.**

The two places that consume an identity both read `process.env`:

- `apps/web/src/app/classrooms/[classroomId]/roster/page.tsx:166-168`
  ```ts
  function sessionUserId(): string {
    return process.env.ORRERY_DEV_USER_ID ?? '00000000-0000-0000-0000-000000000000';
  }
  ```
- `apps/web/src/app/api/exam/answers/route.ts:154-157` — same variable, no default.

`apps/web/src/server/auth/config.ts:77` *does* build a Better Auth instance (`createAuth`) with Argon2id,
throttling, a disabled session cache and `__Host-` cookie attributes. **It has no production caller**, and
there is no `apps/web/src/app/api/auth/**` route at all — the only file under `apps/web/src/app/api` is
`exam/answers/route.ts`. The browser client posts to `/api/auth/sign-in` and `/api/auth/forgot`
(`apps/web/src/server/auth/transport.ts:48,50`), which are 404. **Signing in cannot currently succeed**, and
no request anywhere reads a session cookie.

Why **Critical**, route by route:

| Route | Consequence |
|---|---|
| `GET /classrooms/:classroomId/roster` | `rosterPageData` (`apps/web/src/server/roster.ts:60`) resolves the actor and reads the roster with that user's real permissions. It returns student display names **and email addresses** (`apps/web/src/server/roster.ts:145-147`), plus per-assignment attempt counts. In state 2, **any unauthenticated caller** who can name a classroom the configured user belongs to reads it — no credential of any kind is required. |
| The same page's three actions | `changeRoleAction`, `removeMembersAction`, `restoreMembersAction` (`page.tsx:102-131`) call `changeMemberRole` / `endMembership` / `addMember`, each of which does its own `permit` check as the *resolved* actor. **So this is not only an unauthenticated read — it is unauthenticated write**: changing a student's role, ending a membership, or restoring one, performed with the privileges of one shared user. (The *classroom scoping* inside those functions is correct: `changeMemberRole` looks the membership up with `classroomId_userId` against the classroom named in the request — `packages/db/src/classrooms.ts:758-761` — so a mismatched enrollment id yields a 404 rather than a cross-classroom write. **I checked that hypothesis and it is refuted.**) |
| `POST /api/exam/answers` | Fails closed while the variable is unset (`route.ts:58-60`, 401). The moment it is set, `isSameActor(userId, attempt.studentId)` at `route.ts:116` becomes the **only** ownership gate on the exam's one write path — and both sides of that comparison are the same fixed string for every caller. |

**The source comment is wrong in a way that matters.** `page.tsx:11` says *"actorUserId(request) reads a
header"* and `page.tsx:158-165` says *"A caller who forges the header gets to be themselves … but it does mean
the page is readable by anyone who knows a user id."* Both describe a per-request header. The code reads a
process environment variable, which no caller can forge — so the forgery risk is nil and the actual risk is
worse: **the page is identical for every caller, including anonymous ones.** A reader trusting the comment
would conclude the page is safe in development and would not look again.

**Why this is not a `can()` problem.** The authorisation kernel is genuinely good and genuinely present:
`packages/auth/src/can.ts:49`, a 1,753-line matrix (`packages/auth/src/matrix.ts`), default-deny, and a CI
grep for ownership comparisons outside `packages/auth` (`scripts/authz-ownership-gate.mjs`). `packages/db`
calls `can()` from `library.ts:26`, `moderation.ts:64`, `classrooms.ts:48`, `attempt-exceptions.ts:1`. **The
kernel is not the weak point. The identity handed to it is.** `can()` cannot distinguish "this caller is a
teacher in that classroom" from "this caller is the environment variable", because both arrive as the same
`userId` string.

**Fix.** `P14-T11` (**new**): mount Better Auth, replace both `sessionUserId()` placeholders with the real
session lookup, and — *independently of the rest* — make the roster page refuse to render while
`sessionUserId()` is not backed by a session, rather than defaulting to the all-zeroes UUID. The default is
the worst line in this finding: it converts "unconfigured" into "serves somebody's roster".

#### TM-02 · High · **Latent; becomes live the moment TM-01 is fixed** · New task **P14-T11**

**The route-protection table is not wired to any request path.** `packages/auth/src/routes.ts:69-89` declares
a table whose documented rule is that *"an unrecognised path is `signIn`, not `allow`"* (`:13-16`), enforced
by `requirementFor` (`:92-101`) and `decideRoute` (`:126-170`). `decideRoute` and `requirementFor` are
imported by exactly one file: `packages/auth/src/__tests__/guard.test.ts`. `apps/web/src/middleware.ts` calls
only `guardRequest` for impersonation (`:75`) and then builds the CSP.

So `docs/07-SECURITY-PRIVACY.md:31-33` describes a deny-by-default route gate that does not run. Today this is
masked by TM-01: with no session, a deny-by-default table would redirect the whole site to sign-in. **Fixing
TM-01 without fixing TM-02 turns on every page at once**, and each page's protection then depends on that
page's author remembering to check something.

Severity **High** rather than Critical because the gate being absent is currently the *conservative*
direction. It is listed as High because the sequencing matters: **TM-02 is a prerequisite of TM-01's fix,
not a follow-up to it**, and a fix that lands in the other order opens the application.

#### TM-03 · Medium · **Latent / currently fail-safe** · New task **P14-T12**

**The impersonation write-denial gate is inert, and the cookie it would read is unsigned.** `readImpersonation`
(`apps/web/src/middleware.ts:38-45`) returns `null` unconditionally, with `TODO(signed-cookie)` at `:41`. So
`guardRequest` — which denies every non-safe method while an impersonation is live
(`packages/auth/src/impersonation.ts:157-170`) — is called with `state: null` on every request and always
returns `{ allowed: true }`.

This is the **right direction to fail**. A tampered or unsigned cookie cannot *grant* an impersonation, and
the code says so. But the consequence is that `plans/14` §10:171 (*"Impersonation denied all write paths"*) is
not a property that has been verified — it is a property with **no state in which it could be observed**. An
untestable property is not a passing one.

#### TM-04 · Medium · **Latent** · New task **P14-T12**

**The impersonation window is measured against a clock the client supplies.** `apps/web/src/middleware.ts:78`
reads `now` from the `x-now` request header:
```ts
now: Date.parse(req.headers.get('x-now') ?? '') || 0,
```
That value is what `checkImpersonation` compares against `expiresAt`
(`packages/auth/src/impersonation.ts:137-138`). Today `state` is always `null`, so the value is discarded and
the defect is dormant. **Once TM-03 is fixed, a client could send `x-now: 0` and hold an impersonation open
indefinitely**, defeating the 15-minute hard cap that `impersonation.ts:15-19` argues for at length. The file
correctly insists the *identity* must come from a server-signed cookie and not a client header
(`middleware.ts:70-72`) — and then takes the *time* from a client header. Same file, opposite conclusions.

#### TM-05 · Medium · **Latent** · Fix within **P14-T11**; verification in **P14-T2**

**There is no rate limiting anywhere in the codebase.** `grep -r rateLimit|RATE_LIMIT|rate-limit` across
`packages/auth/src` and `apps/*/src` returns one comment (`apps/web/src/features/auth/flow.ts:128`). More
tellingly, `plans/invariants.json:202-207` declares `INV-ABUSE-1` — *"Aggregate abuse limits are keyed on the
actor, never the container"* — with `files: ["packages/auth/src/rate-limits.ts"]`. **That file does not exist.**
`plans/14` §8:132 claims *"Rate limits | Per the table in `04` §6, with each limit test-covered"*, and
`P14-T4` exists to verify limits that do not exist yet.

This matters more than its severity suggests, because the sign-in throttle *is* the control against
credential stuffing and it already exists as pure logic (`packages/auth/src/throttle.ts`, used at
`apps/web/src/server/auth/config.ts:39`) — it is simply never on a path. `plans/14` §9:146 lists
"credential stuffing" as an abuse case whose response includes rate limits.

---

### A02 — Cryptographic failures

#### TM-06 · Medium · **Latent** · Fix within **P14-T11**

**Three password defences are implemented and unreachable.** Each is genuinely well-built, which is what makes
the gap worth naming rather than filing as "TODO":

| Defence | Where | Reachable? |
|---|---|---|
| Equal-work verify against a dummy hash, so "no such user" and "wrong password" cost the same | `packages/auth/src/password.ts:173-187` (`verifyLogin`) | **No production caller.** Referenced only in a comment at `apps/web/src/features/auth/flow.ts:21`. |
| Breached-password check, k-anonymous prefix lookup | `packages/auth/src/password.ts:223-237` (`checkPasswordPolicy`) | **No production caller.** No `breachedLookup` implementation exists anywhere in the repository. |
| TOTP, with the repeated-failure takeover classifier wired to a security event | `packages/auth/src/totp.ts` (362 lines) | **No production caller.** Imported only by `packages/auth/vitest.config.ts:31`. |

`docs/07-SECURITY-PRIVACY.md:21-22` describes all three as present. They are present as *modules*. The
generic-failure-copy defence does hold at the client (`apps/web/src/server/auth/transport.ts:34-43` returns
`GENERIC_AUTH_FAILURE` for anything non-200), so the user-enumeration surface is genuinely small — but it is
small because sign-in does not work, not because the password layer is doing its job.

#### TM-07 · Medium · **Latent** · Fix within **P14-T11**

**`requirePepper()` does not exist.** `packages/auth/src/password.ts:44-46` states:

> *"This module does not apply one: a pepper that is silently absent is a pepper that is believed present.
> `requirePepper()` is called at boot so its absence is a startup failure, not a gradual weakening."*

`grep -rn requirePepper` across `packages` and `apps` returns that comment and its build output. **There is no
such function and no boot-time check.** A deployment with no pepper configured will hash passwords with no
pepper, and nothing will fail — which is precisely the failure the comment says it prevents. This is a
documentation-vs-code contradiction inside a package that is otherwise exemplary, and it is the kind that
survives because the comment is reassuring.

#### TM-08 · Medium · **Exploitable as a maintenance hazard today** · **P14-T5**

**The password-hashing primitive is resolved at two different versions.** From `pnpm-lock.yaml`:

| Package | `@node-rs/argon2` | Evidence |
|---|---|---|
| root (`orrery`) | **2.2.1** | `pnpm-lock.yaml:11-13` |
| `packages/auth` | **2.0.2** | `pnpm-lock.yaml:173-176` |
| `packages/db` | **2.0.2** (devDependency) + peer `^2` | `pnpm-lock.yaml:243-245` |

`packages/auth/src/password.ts:29` is what imports it, and `packages/auth` is the workspace that gets
**2.0.2**. So "we patch Argon2" is not one fact in this repository — it is two, and the one that does the
hashing is the older. `packages/db` declares the dependency it never imports, as both a devDependency and a
peerDependency, which adds a third declaration with no consumer. Full treatment in `DEPENDENCIES.md`.

---

### A03 — Injection

**No finding from this review. The evidence is worth recording so the next reviewer does not re-audit it from
scratch — and so that "clean" is read as "nothing found by reading", which is all a source review can claim.**

- No SQL string interpolation. Every `$queryRaw`/`$executeRaw` site uses the tagged template or
  `Prisma.sql`; the two `$queryRawUnsafe` sites (`packages/db/src/answer-write.ts:600-603`,
  `packages/db/src/run-exclusive.ts:86-88` and `:106`) pass their values as positional bind parameters, not
  concatenation. `packages/db/src/search.ts:27` states the discipline and the statement matches every site.
- **No user HTML.** `packages/contracts/src/blocks/index.ts` is a closed union; `embedExternal` has *no URL
  field*, only a provider allowlist (`:362-364`, and `packages/contracts/src/blocks/providers.ts:6`). There is
  no sanitiser to keep patched, exactly as `plans/14` §4:39 argues. **Caveat: the claim that there is exactly
  one place in the application that mounts generated markup rests on a lint ban that does not exist — see
  TM-21.**
- **KaTeX is configured defensively, in code.** `packages/contracts/src/render/index.ts:35-38` passes
  `trust: false`, `strict: 'error'`, `output: 'htmlAndMathml'` and `throwOnError: true`, and
  `packages/contracts/src/render/render.test.ts:17,27-47` mocks KaTeX specifically so the *options* can be
  asserted rather than just the output — which is the right way to test a security-relevant configuration.
  This is a genuine control, and it is also how I established which of the two KaTeX versions is live (§4.2
  below).
- **CSV formula injection is escaped in both export paths**, and tested: `packages/contracts/src/csv/index.ts:236-256`
  (`escapeCsvCell`/`renderCsvCell`) with cases at `packages/contracts/src/csv/index.test.ts:114-131`, and
  independently in the hand-rolled roster error report at `packages/db/src/roster.ts:330-336`. The reporting
  export adds a leading-whitespace strip before the formula check (`apps/web/src/features/reporting/exports.ts:23-29`),
  which is the part people usually forget. **This is the one item in `P14-T9` that is already done** — though
  no test asserts the escaping *inside* `renderRosterErrorReport` itself, only that it is called
  (`packages/db/src/roster.integration.test.ts:32`).
- **SVG is rejected, not sanitised** (`packages/contracts/src/media/index.ts:111-122`, `:206`), with a
  dedicated sniff at `:160-166` so the refusal has a real explanation to give. Magic-byte verification is real
  (`ACCEPTED` at `:64-108`).
- Prototype pollution: every inbound schema is a Zod `strictObject`, and `packages/db/src/search.ts:27` states
  the raw-query discipline explicitly.

---

### A04 — Insecure design

#### TM-09 · High · **Not exploitable; the control does not exist to be bypassed** · **P14-T2** (route/projection layer), new task **P14-T13** (CSP)

**The CSP reads the wrong environment variable, so its sandbox hardening names an origin nobody deploys.**
The lead that "no CSP is configured" is **wrong**: `apps/web/src/middleware.ts:91-122` generates a per-request
nonce and emits `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; …; frame-ancestors 'none'`,
and `apps/web/next.config.ts:23-27` explains why the header is *not* set statically. That is a correct design,
and `next.config.ts:9-22` sets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, a genuinely strict
`Permissions-Policy` and HSTS with preload.

The defect is at `middleware.ts:93`:
```ts
const simsOrigin = process.env.SIMS_ORIGIN ?? 'http://localhost:4400';
```
The validated variable is **`SIM_ORIGIN`** — `.env.example:32`, `packages/config/src/env.ts:79`, and
`env.ts:120-135` goes further and *refuses* a sim origin that shares a host with `APP_URL` or is localhost in
production. **`SIMS_ORIGIN` appears in exactly one place in the repository.** So `frame-src` and `connect-src`
list `http://localhost:4400`, which is not the sim origin, and the comment at `middleware.ts:105-106` —
*"The sim origin, and ONLY the sim origin. This is what stops a sandboxed sim frame — or an injected script —
from calling our API with a student's cookies"* — is describing a control that is not in effect.

Consequences, both directions: the sim frame is blocked in every environment (**fail-closed**, so this is a
breakage rather than a hole), and the guarantee that the frame cannot reach the app origin rests on config
validation this header never consults. Fix `SIMS_ORIGIN` → `loadEnv().SIM_ORIGIN` so the header is derived
from the validated value, and add a test asserting the CSP names the configured origin.

Secondary, **Low**: the CSP is attached only to document requests — `middleware.ts:87` returns
`NextResponse.next()` for everything else. JSON responses need no CSP, but it means
`plans/14` §8:124's *"CSP report-only reviewed, then enforced"* can only ever see document responses.

#### TM-10 · High · **Not exploitable; the feature is absent** · new task **P14-T14**

**There is no telemetry ingestion endpoint, so the integrity evidence pipeline has nowhere to land.**
`plans/09` §7 specifies `POST /api/exam/v1/telemetry`. The only file under `apps/web/src/app/api` is
`exam/answers/route.ts`. `grep telemetry` across `packages/db/src` returns nothing but a comment at
`apps/worker/src/index.ts:78` and the retention job's purpose string at `:135`.

`INV-TELEMETRY-1` (*"Telemetry is evidence, never truth"*) is a real and well-designed property — it is
enforced client-side by `packages/exam-engine/src/evidence.ts`, where four event types carry
`strike: 'never'` precisely so a capability failure cannot become an accusation. **None of it is reachable.**
`packages/exam-engine/src/adversarial/forged-events.test.ts:426-431` says so itself, and it deserves quoting:
`countsAsStrike`'s throw is *"the only thing between an invented event type and a strike decision"* in a
system where no server validates the event type.

#### TM-11 · High · **Not exploitable; the control is a stub** · **P14-T6**

**Retention is not implemented, and two documents say it is.** `apps/worker/src/index.ts:132-140`:
```ts
{
  name: 'retention.sweep',
  everySeconds: 86_400,
  purpose: 'Delete expired telemetry, sessions, invitations and exports. Dry-run mode reports …',
  run: async () => {
    throw new Error('not implemented — P14-T6');
  },
},
```
`plans/14` §7.2:97 and `docs/07-SECURITY-PRIVACY.md:95` both say *"Retention sweeps are a real cron job with a
dry-run mode and a report — not a promise."* **It is a promise.** The retention *table* in `plans/14` §7.2 is
a specification of intent, not a schedule that runs.

Severity **High** rather than Medium because retention is a commitment made to people about their data, and a
document that says a promise is a mechanism is worse than one that admits the mechanism is missing — a student
or a school reading `07` will believe telemetry is deleted after 400 days. `apps/worker/src/index.ts:92-101`
shows `grade.auto` is a stub for the same reason (`not implemented — P7-T9`), so the worker is not yet the
place where these guarantees live.

#### TM-12 · Medium · **Not reachable: there is no upload route yet; the control is nonetheless absent** · **P14-T9**

**Image metadata is not stripped on the upload path.** `stripImageMetadata`
(`packages/contracts/src/media/index.ts:302`) is a careful hand-written PNG/JPEG stripper with
`hasImageMetadata` and byte-level tests at `packages/contracts/src/media/index.ts:403,408,433` and
`packages/contracts/src/media/media.test.ts:147-211`. **Its only non-definition references are in that test
file.** The storage path (`packages/db/src/media.ts:171`) calls `validateUpload` and never the stripper.

So the moment any upload route exists, EXIF survives it: GPS coordinates from a phone camera, device serial,
and a thumbnail of the image content. `plans/14` §4:44 and `docs/07-SECURITY-PRIVACY.md:44` both claim
*"image re-encode stripping EXIF"*.

Scored **Medium** and not higher because there is no HTTP route that accepts an upload — `apps/web/src/app/api`
contains one file — so nothing is exposed *today*. It is listed because the control will be assumed present
the day the route lands, and the failure mode is a photograph of a student's whiteboard retained by a platform
that documented removing it. A photograph of a whiteboard is not a metadata field; it is the student's work.

#### TM-13 · Medium · **Maintenance hazard, live today** · **P14-T5**

**Two versions each of `katex`, `zod`, `@node-rs/argon2`, `jsdom`, `jest-axe`, `globals` and `@types/*`** in
the resolved lockfile. The security-relevant two are `katex` (**0.18.9** at root, **0.16.22** in
`packages/contracts`) and `zod` (**4.4.3** direct, **4.6.5** pulled in by `better-call` via `better-auth`).
KaTeX is the maths-rendering surface that `plans/14` §4:40 names as an XSS vector, and "`katex` is patched"
is therefore a per-workspace statement. See `DEPENDENCIES.md`.

---

### A05 — Security misconfiguration

#### TM-14 · Medium · **Live today; degrades every CI security gate** · new task **P14-T15**

**The CI `policy` job cannot succeed, so three of its four steps have never run.** `.github/workflows/ci.yml`:

| Line | Step | Exists? |
|---|---|---|
| `:253` | `pnpm audit:seals` | yes |
| `:255` | `pnpm audit:payloads` | **no** |
| `:257` | `pnpm a11y` | **no** |
| `:259` | `pnpm i18n:check` | **no** |
| `:261` | `pnpm audit:deps` (`osv-scanner --recursive .`) | yes |

None of the three missing names is a script in `package.json`. `pnpm <missing-script>` fails, so the job dies
at `:255` and `audit:deps` at `:261` **never executes**. That is the entire dependency-scanning control that
`plans/14` §8:130 relies on. The `policy` job also holds the accessibility and i18n gates, so those are down
with it.

**A second job is broken by the same kind of drift, and it belongs here.** `ci.yml:122` runs a `test` matrix
containing `grading`, and `:137` demands 100% branch coverage for `grading`/`exam-engine`/`analytics`. **There
is no `@orrery/grading` package in this workspace** — the grader was consolidated into
`packages/contracts/src/grading/`, and no `package.json` declares the old name — so `pnpm --filter
"@orrery/grading" test` matches no project and exits non-zero.

**Two of the seven jobs are therefore incapable of going green, and both failures are silent in the sense that
matters: they are not a security control failing, they are a security control never having run.** The required
status checks named at `ci.yml:16` are `lint · typecheck · test · schema · gate-integrity` — so the two broken
jobs are `test` and `policy`, and **three of the five required checks cannot be evaluated.** That is worth
stating plainly because the whole `D-35` argument rests on "every gate runs here, from a clean checkout", and
the honest current answer is that two of them do not.

I did not run the workflow (that would need a clean checkout and a push), so this is read from the YAML and the
workspace manifest, not observed. **It is the one finding in this document that a single `act` or a local
`pnpm --filter "@orrery/grading" test` would settle in five seconds**, which is why it is written as a claim
rather than a conclusion.

#### TM-15 · Medium · **Live today** · new task **P14-T16**

**Two invariants cite a gate that does not exist, and the registry gate cannot see it.** `plans/invariants.json`:

- `INV-Q-1` (*"Answer keys never leave the server"*) — `gates: ["audit:seals", "audit:payloads"]` (`:103`)
- `INV-TELEMETRY-2` (*"Telemetry carries no content and no PII"*) — `gates: ["audit:payloads"]` (`:167`)

There is no `audit:payloads` in `package.json` and no `scripts/audit-payloads.mjs`. `scripts/invariant-registry.mjs`
*does* check gate existence — `:111-114`, `gate \`${g}\` is not a script in package.json` — but only inside the
`status === 'active'` branch (`:87-107`). **Both invariants are `staged`, so the check never reaches them and the
registry gate reports green.** This is the repo's own `D-31`/`D-35` failure mode reproduced inside the mechanism
built to prevent it.

The same gap is asserted as fact in `packages/config/src/logging.ts:36-38`, which names `pnpm audit:seals` as
"the control" for answer keys reaching logs — `scripts/audit-seals.mjs` audits *student payloads* built from
`packages/contracts`, never log output. The log path's actual control is the redaction list at
`logging.ts:41` plus the canary test (A09 below).

#### TM-16 · Low · **Live today, maintenance hazard** · **P14-T5**

`.npmrc:2-3` sets `strict-peer-dependencies=false` and `auto-install-peers=true`, against `ADR-0008`'s stated
policy at `.npmrc:4` (*"exact pinning via the lockfile. No ^ ranges in package.json for runtime deps"*).
`engine-strict=false` (`.npmrc:36`) is deliberate and documented at `:26-35` and is **not** a finding.
The two that are: `auto-install-peers` lets a package enter the lockfile that no manifest declared, and
`strict-peer-dependencies=false` means a peer mismatch is not an install-time failure. For a repository whose
security argument includes "no user code, a dependency allowlist, prompt patching" (`plans/14` §5:66), an
undeclared transitive dependency is the wrong default. Full detail in `DEPENDENCIES.md`.

---

### A06 — Vulnerable and outdated components

See `DEPENDENCIES.md` (TM-08, TM-13, TM-16 above, plus the inventory and the exception process).

**No CVE scan was run and none could be.** `osv-scanner` is not installed in this environment and installing
it was out of scope. `pnpm audit:deps` exists (`:33`) and is wired to CI (`:261`) where, per TM-14, it does not
execute. **The honest statement is therefore that the *inventory* below is complete and the *vulnerability
status* of every package in it is unknown.** That is the first thing a reader should take from
`DEPENDENCIES.md`, and P14-T5's exit criterion is not met until a scanner has actually run.

---

### A07 — Identification and authentication failures

**Covered by TM-01 (no session layer), TM-06 (no reachable password/MFA defences), TM-07 (no pepper
enforcement), TM-05 (no rate limiting).** Nothing further to add that those do not already state. The single
sentence worth recording on its own: **the authentication story in `docs/07` §2 is a description of
`packages/auth`, and `packages/auth` is not on a request path.** Its unit tests pass, and they test pure
functions — which is exactly the right way to test them and no evidence at all that a session is ever
verified.

---

### A08 — Software and data integrity failures

#### TM-17 · Medium · **Not exploitable; the control cannot fail because nothing checks the output** · new task **P14-T17**

**A signature is computed, transmitted, never verified, and described incorrectly by two files that disagree
with the code they document.**

- `packages/exam-engine/src/evidence.ts:521` `signBatch` computes an HMAC over the canonical batch. The design
  is careful and the comments show why: `attemptId` and the sequence range are inside the signed material so a
  valid signature cannot be replayed onto another attempt (`:379-384`), and the fields are NUL-separated
  (`:387-397`).
- `flushOnce` (`:541`) and `flushOnUnload` (`:583`) both pass the **complete** signed batch to the transport.
- **But the comments still say the opposite.** `evidence.ts:433-440` states *"It was `Omit<SignedBatch,
  'signature'>` … the HMAC was computed, tested, and never left the batcher"*, and
  `forged-events.test.ts:408-411` states *"`flushOnce` calls `signBatch`, then passes the transport every field
  EXCEPT the signature; `flushOnUnload` does not sign at all."* Both were fixed — `forged-events.test.ts:420`
  (`ADV-E4`) now asserts `seen[0]` **has** a `signature` property, and `flushOnUnload` signs. The comments are
  stale.
- `forged-events.test.ts:17-24` carries the finding that matters and is still true: *"nothing in the repository
  verifies an evidence signature"*, with the verifier written three lines long **in a test file**.

So the tamper-evident property is real in the signing and absent in the verifying. Combined with TM-10 (no
ingestion endpoint), **the signed bytes reach no verifier because they reach no server.** Fix: write the
verifier where the events are stored, and delete the two stale comments in the same commit — a comment that
describes a bug that was fixed is how the bug gets "re-fixed".

#### TM-18 · Medium · **Latent** · new task **P14-T18**

**The simulation registry is not built by anything.** `apps/worker/src/index.ts:142-150`: `sim.build` throws
`not implemented — P6-T4`. `plans/14` §5:62 lists as a ticked release gate *"registry built by CI only; no user
code (`ADR-0018`)"*. There are 24 simulation directories under `sims/` and a real escape gate
(`scripts/sim-sandbox-escape.mjs`, which self-checks that the frame is a different origin and that at least one
escape attempt is actually observed as blocked — `:22-26`), but the *registry* those escapes are tested
against is `sims/registry/registry.json`, which no job in this repository produces.

Not scored as High: the escape test's value does not depend on who built the registry, and the registry being
absent means nothing is being served, which fails safe. It is Medium because the ADR's central claim — *no user
code reaches the sandbox* — currently rests on a directory listing.

---

### A09 — Security logging and monitoring

**No rate-limit or abuse signal to speak of (TM-05), and no audit trail, because there are no authenticated
paths to audit (TM-01).** What *is* real and should be credited:

- `packages/config/src/logging.ts` makes `redact()` the only sanctioned way to build log fields (`:8-14`), and
  `logging-hygiene.test.ts:38-51,115-136` seeds canary values and asserts none survives, while still asserting
  the useful fields *do* survive (`:132-135`) — a leak test that passed by deleting all logs would be caught.
  `plans/14` §10:163's "canary-value log-scrubbing test green" is, at unit level, **already satisfied**.
- `SENSITIVE_KEY` (`logging.ts:41`) is a blocklist matched case-insensitively against the key, so
  `studentEmail` and `STUDENT_EMAIL` are both caught.

#### TM-19 · Low · **Live today** · new task **P14-T16**

**A canary interpolated into the log *message* is not redacted, and no test covers it.** `redact()` operates on
fields; `msg` is a free string copied straight onto the record at `logging.ts:161`, while `fields` goes through
`redact()` at `:163`. The end-to-end test
(`logging-hygiene.test.ts:115-136`) varies the *field name* — its own title is *"never emits a canary,
whatever the field is called"* — but every canary it plants is in a field. `log.info(\`failed for ${email}\`)` is
one interpolation away from a violation, and nothing says so.

Low, not Medium, because it takes a mistake rather than an attacker. It is listed because the existing test
name invites exactly that mistake.

#### TM-20 · Low · **Live today; requires a code mistake, not an attacker** · new task **P14-T16**

**Telemetry `detail` keys are unconstrained, so "no PII in telemetry" is a comment rather than a type.**
`packages/exam-engine/src/evidence.ts:307-313`:
```ts
export interface EvidenceRecord {
  readonly seq: number;
  readonly type: EvidenceType;
  readonly at: Millis;
  /** Free-form. Never an answer, never a score: this is read by a human. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}
```
The *values* are constrained to primitives and there is no top-level answer or score field, which is real
progress. **The keys are not constrained at all.** `{ detail: { studentEmail: 'a@b.c' } }` typechecks, compiles,
passes every existing test and reaches a table retained for 400 days.

Scored **Low** and grouped with TM-19 deliberately: both are defect-shaped rather than attacker-shaped, and
naming that plainly is more useful than inflating either. It is listed because `INV-TELEMETRY-2` names
`audit:payloads` as its control and **that gate does not exist** (TM-15), so the property has a name, a
`plans/invariants.json` entry, and no mechanism.

#### TM-21 · Medium · **Live today; the property holds by convention only** · new task **P14-T16**

**"Exactly one place mounts generated markup" is claimed on the strength of a lint ban that does not exist.**
`apps/web/src/features/editor/TrustedHtml.tsx:18-20`:

> *"`dangerouslySetInnerHTML` is banned by the lint config, which is the right default and the reason this
> component had to be written: **the ban is what makes 'there is exactly one place that does this' a
> checkable claim rather than a convention.**"*

`grep -rn dangerouslySetInnerHTML` across the repository returns **this comment and nothing else**, and
`eslint.config.js` has no such rule — its `no-restricted-syntax` block (`:83-93`) bans exactly one thing,
unguarded `new Date()`, and the `no-restricted-properties` / `no-restricted-globals` / `no-restricted-imports`
blocks cover `Date.now`, `Math.random`, the Prisma import and barrel files.

So the underlying property is true **only because nobody has written the attribute** — which is precisely the
"convention" the sentence says it is not. And `plans/14` §4:39's headline, *"**No user HTML, ever.** A closed
block union rendered to HTML we generate"*, leans on it.

Worth noting what the fix costs: the repository already owns the mechanism. A `no-restricted-syntax` selector
for `JSXAttribute[name.name='dangerouslySetInnerHTML']` is one entry in a config that already exists, and
`ci.yml:294` treats `eslint.config.js` as a gate file requiring a `GATE-CHANGE:` rationale — so adding the ban
is deliberately expensive, which is the right cost for a rule that will fire on legitimate framework code.

Also worth recording, because the component is otherwise well made: it builds the DOM with `DOMParser` in an
inert document and moves the resulting **nodes** rather than assigning a string to `innerHTML`
(`TrustedHtml.tsx:43-50`), so the string never reaches a sink at all. That is a better mechanism than the lint
ban it credits for existing.

#### TM-22 · Medium · **Live today** · new task **P14-T16**

**The invariant registry names eleven mechanisms that do not exist, and the gate built to catch exactly that
only checks the invariants it would not catch.**

`plans/invariants.json` declares a `files` and/or `gates` list per invariant. Checking every entry against the
filesystem and `package.json`:

| Invariant | Status | Names | Reality |
|---|---|---|---|
| `INV-POLICY-1`, `INV-POLICY-2` | staged, due P8 | `packages/exam-engine/src/policy.ts` | moved to `packages/contracts/src/policy/index.ts` |
| `INV-LATE-1` | staged, due P8 | `packages/exam-engine/src/deadline.ts` | moved to `packages/contracts/src/policy/deadline.ts` (the real file is `deadlines.ts` — singular *and* relocated) |
| `INV-BANK-1` | staged, due P5 | `packages/analytics/src/pool-health.ts` | moved to `packages/contracts/src/pool-health/index.ts` |
| `INV-BANK-2` | staged, due P5 | `packages/analytics/src/draw.ts` | **no successor found**; the variant work is `packages/analytics/src/variant-audit.ts` |
| `INV-BANK-3` | staged, due P5 | `packages/db/src/snapshot.ts` | moved to `packages/db/src/version-snapshot.ts` |
| `INV-ATTEMPT-1`, `INV-ATTEMPT-2` | staged, due P7 | `packages/grading/src/index.ts` | **`packages/grading` does not exist at all**; the grader is `packages/contracts/src/grading/index.ts` |
| `INV-ABUSE-1` | staged, due P4 | `packages/auth/src/rate-limits.ts` | **never existed** — no rate limiter is anywhere in the tree (TM-05) |
| `INV-Q-1`, `INV-TELEMETRY-2` | staged | gate `audit:payloads` | **no such script** (TM-15) |

**Eight of these are stale paths, not missing mechanisms** — code was consolidated into `packages/contracts` and
the registry was not updated with it. That distinction matters and is the reason this is Medium rather than
High: the properties may well hold. **What does not hold is the registry's ability to tell anyone.**

`scripts/invariant-registry.mjs` does check both things — `:111-114` for gates, `:115-123` for files — but only
inside the `status === 'active'` branch. Its own comment at `:83-84` says *"STAGED invariants declare the phase by
which they must become active — being honestly staged is fine, being silently unenforced is not."* **Eight
staged invariants past their `enforcedFrom` phase, and the gate's definition of "honestly staged" does not
include "the mechanism is where you said it was."**

**Why this belongs in a threat model rather than a maintenance note:** `plans/14` §3's authorisation argument
leans on this registry by name, and `plans/14` §10's exit criterion is *"IDOR tests exist … `can()` matrix is
mechanically complete"*. A registry that cannot see its own staleness is not evidence for either. The fix is
small — extend the staged branch to check existence and report it as a **warning with a named phase**, and
extend `REACHED_PHASE` (`:147`) so a phase we are already past is an error rather than a note.

**A second-order consequence, which belongs to TM-14 but is worth stating here:** `.github/workflows/ci.yml:122`
runs a `test` matrix containing `grading`, and `:137` demands 100% branch coverage for
`grading`/`exam-engine`/`analytics`. **There is no `@orrery/grading` package for that filter to match**, so the
`test` job fails as well as the `policy` job. Two of the seven CI jobs are broken by the same consolidation that
left the invariant registry stale — which is a better argument for a gate that runs in CI than any policy
sentence.

---

### A10 — Server-side request forgery

**No finding.** `embedExternal` has **no URL field** — an author picks a provider from an allowlist and
supplies only provider-specific parameters (`packages/contracts/src/blocks/index.ts:362-364`,
`packages/contracts/src/blocks/providers.ts:6`). There is no code path in `packages/db`, `apps/web` or
`apps/worker` that fetches a user-supplied URL. Recorded so the next reviewer does not re-audit it, and so
that the *future* provider set is understood to be a security decision: adding a provider that accepts an
arbitrary URL would create the first SSRF in the codebase.

---

## 2. Summary table

| ID | OWASP | Finding | Severity | Live today? | Fix |
|---|---|---|---|---|---|
| TM-01 | A01 | No session layer; identity is `ORRERY_DEV_USER_ID`, defaulting to a fixed UUID on the roster page | **Critical** | Yes (state 2); partly state 1 | **P14-T11** (new) |
| TM-02 | A01 | Route-protection table is not wired to any request path | **High** | Latent; live once TM-01 lands | **P14-T11** (new) |
| TM-03 | A05 | Impersonation gate inert; cookie signature unimplemented | Medium | Fail-safe | **P14-T12** (new) |
| TM-04 | A07 | Impersonation window measured against a client-supplied `x-now` | Medium | Latent | **P14-T12** (new) |
| TM-05 | A04 | No rate limiting; `INV-ABUSE-1` names a file that does not exist | Medium | Yes | P14-T4, P14-T11 |
| TM-06 | A02 | `verifyLogin`, breach check and TOTP have no production caller | Medium | Yes (absent) | P14-T11 |
| TM-07 | A02 | `requirePepper()` documented but does not exist | Medium | Yes (absent) | P14-T11 |
| TM-08 | A06 | Argon2 resolved at 2.0.2 in `packages/auth` and 2.2.1 at root | Medium | Yes | P14-T5 |
| TM-09 | A05 | CSP reads `SIMS_ORIGIN`; the validated name is `SIM_ORIGIN` | Medium | Yes | **P14-T13** (new) |
| TM-10 | A04 | No telemetry ingestion endpoint exists | High | Absent | **P14-T14** (new) |
| TM-11 | A04 | Retention sweep throws `not implemented`; two docs call it a real cron job | High | Absent | P14-T6 |
| TM-12 | A04 | `stripImageMetadata` never called on the upload path; EXIF survives | Medium | Not reachable (no upload route) | P14-T9 |
| TM-13 | A06 | Two `katex` versions, two `zod`, and five more duplicates | Medium | Yes | P14-T5 |
| TM-14 | A05 | CI `policy` and `test` jobs cannot go green; `audit:deps` never runs; 3 of 5 required checks unevaluable | Medium | Yes | **P14-T15** (new) |
| TM-15 | A05 | `INV-Q-1` and `INV-TELEMETRY-2` cite `audit:payloads`, which does not exist | Medium | Yes | **P14-T16** (new) |
| TM-16 | A05 | `auto-install-peers` + `strict-peer-dependencies=false` vs ADR-0008 | Low | Yes | P14-T5 |
| TM-17 | A08 | Evidence signature never verified; two comments describe a fixed bug | Medium | Absent | **P14-T17** (new) |
| TM-18 | A08 | Sim registry not built by any job | Medium | Latent | **P14-T18** (new) |
| TM-19 | A09 | `msg` is not redacted; the canary test varies field names only | Low | Yes | **P14-T16** (new) |
| TM-20 | A04 | Telemetry `detail` keys unconstrained; "no PII" is a comment, not a type | Low | Yes | **P14-T16** (new) |
| TM-21 | A03 | "Exactly one place mounts generated markup" rests on a lint ban that does not exist | Medium | Yes | **P14-T16** (new) |
| TM-22 | A05 | Invariant registry names **eleven** mechanisms that do not exist; the gate checks only `active` invariants | Medium | Yes | **P14-T16** (new) |
| — | A03 | Injection: SQL, XSS, CSV, SVG, KaTeX, prototype pollution — **nothing found by reading** | **None found** | — | — |
| — | A10 | SSRF: no user-supplied URL is ever fetched server-side | **None found** | — | — |

**Three of these deserve to be read as a pattern rather than as instances.** TM-20, TM-21 and TM-22 are all
cases of a security property asserted by a **comment or a registry entry** and backed by no working mechanism —
TM-20's is `INV-TELEMETRY-2`'s missing gate (TM-15), TM-21's is a lint rule that was never written, and
TM-22's is a gate that cannot see its own staleness. TM-19 belongs with them at Low. Together they are four
findings against the *checking machinery*, and they are the reason this document spends more space on
`scripts/` and `plans/invariants.json` than on `apps/`: **this repository has already built the instruments that
would catch most of §1, and the instruments have drifted while the claims kept being repeated.**

---

## 3. Where the implementation contradicts the plan documents

These are not "gaps to close later". Each is a sentence in a document someone will act on.

| Document | Claim | Reality |
|---|---|---|
| `plans/14` §7.2:97 · `docs/07`:95 | "Retention sweeps are a real cron job with a dry-run mode and a report — **not a promise**." | A promise. `apps/worker/src/index.ts:138` throws. (TM-11) |
| `plans/14` §3:28 · `docs/07`:31-33 | "One entry point: `can(actor, action, subject, context)` … **Default deny.** An unrecognised pair … denies in production." | True of `can()`. False as a statement about requests: `decideRoute`'s default-deny table is never called. (TM-02) |
| `plans/14` §8:130 | "`osv-scanner` in CI; high/critical blocks merge." | Wired to a job that fails before reaching it; and a second job fails too. (TM-14) |
| `plans/14` §8:124 | CSP with `frame-src`/`connect-src` limiting sim reach to the sim origin. | Names `SIMS_ORIGIN`, which no deployment sets. (TM-09) |
| `plans/14` §4:44 · `docs/07`:44 | "image re-encode stripping EXIF" | Stripper implemented, never called; no re-encode. (TM-12) |
| `plans/14` §4:132 | "Rate limits … with each limit test-covered." | No rate limiter; `INV-ABUSE-1`'s declared mechanism file does not exist. (TM-05) |
| `plans/14` §5:62 | "registry built by CI only; no user code" | `sim.build` throws. (TM-18) |
| `plans/14` §2:23 · `docs/07`:21-25 | Argon2id, breach check, MFA required for teachers | All three exist as modules with no production caller; no pepper enforcement. (TM-06, TM-07) |
| `plans/14` §10:171 | "Impersonation denied all write paths" | Untestable: no impersonation can exist. (TM-03) |
| `packages/auth/src/password.ts:44-46` | "`requirePepper()` is called at boot" | It does not exist. (TM-07) |
| `packages/exam-engine/src/evidence.ts:433-440` · `forged-events.test.ts:408-411` | "the transport receives every field except the signature" | Fixed in code; the comments are stale. (TM-17) |
| `apps/web/src/app/classrooms/…/roster/page.tsx:11,158-165` | "reads a header … a caller who forges the header" | Reads a process env var. (TM-01) |
| `apps/web/src/features/editor/TrustedHtml.tsx:18-20` | "`dangerouslySetInnerHTML` is banned by the lint config … the ban is what makes this a checkable claim rather than a convention" | No such rule exists in `eslint.config.js`. (TM-21) |
| `packages/exam-engine/src/evidence.ts:311` | `detail` — "Free-form. **Never an answer, never a score**" | Values are primitives; **keys are unconstrained**, and the invariant naming the control cites a gate that does not exist. (TM-20, TM-15) |

**One structural observation, because it is the pattern rather than the instances:** **every one of the
fourteen cases above has the same shape.** The claim lives in a comment, a docstring, an invariant entry or a
security document, and the mechanism is a module that is never called, a file that does not exist, a rule that
was never written, or a stub that throws. Not one of them would be found by reading the mechanism more
carefully — each mechanism reads correctly. The repo already knows this — `D-31` ("every gate is local"), `D-35` ("a CI job that runs
the gate is bypassable by editing the gate"), and the note at `apps/web/src/middleware.ts:19-21` about the CSP
being found *"by RUNNING the container and reading the response headers"*. The recommendation that follows
from this document is therefore not a control. It is: **find the next class of claim that only a running
system can refute, and write the thing that runs it.**

---

## 4. What I could not assess, and why

An honest gap is more useful than a confident guess. Each of these is a real limit on the confidence of
everything above.

1. **Vulnerability status of every dependency.** `osv-scanner` is not installed and installing it was out of
   scope. The inventory in `DEPENDENCIES.md` is complete and read from `pnpm-lock.yaml`; the advisory status
   of all 527 lockfile entries is **unknown**. Not a stylistic caveat — it means TM-08, TM-13 and TM-16 are
   structural findings only.
2. **Anything requiring a running database.** I did not start Postgres, a server, or a container. Every
   claim here is from source. The `packages/db` predicates (classroom scoping, release gating, item-analysis
   suppression) are covered by their integration tests and by `audit/score-projections.json`, but I did not
   observe them run.
3. **Whether the sandbox escape gate actually passes.** `scripts/sim-sandbox-escape.mjs` needs a real browser
   and two origins. Its own header claims it refuses to report success without two self-checks
   (`:22-26`), which is the right shape — but "the right shape" is not "I watched it fail an escape".
4. **The working tree is moving.** Three other lanes are writing to this checkout concurrently. Line numbers
   and file contents were read at a point in time; a file cited here may have changed by the time you read
   it. **Findings are stated against commit content, not against a moving target** — if a line disagrees, the
   line is wrong or the file moved, and that is worth resolving before acting.
5. **`sims/registry/registry.json` provenance.** I did not trace how it was produced, so TM-18's claim is
   "no job in this repository builds it", not "it was built by hand".
6. **Absence of a route.** The single most consequential verification in this document is the negative one:
   *there is no `/api/auth/**` route and no other file under `apps/web/src/app/api`*. I established it by
   directory listing plus a full-tree `find`. A route generated at runtime, by middleware, or added by another
   lane after my listing, would change TM-01's severity. **Re-run `find apps/web/src/app/api -type f` before
   acting on TM-01.**
7. **Deployment configuration.** Whether any environment sets `ORRERY_DEV_USER_ID`, whether `SIM_ORIGIN` is
   spelled correctly in a real deployment, and what secrets a production process receives, are all outside the
   repository. TM-01 is stated as two states precisely because I cannot say which one a deployment is in.
8. **The `audit/score-projections.json` predicates are claims, not proofs** — and the file says so itself.
   `audit/score-projections.json:27` records *"UNVERIFIED BY ME: I did not trace this file's callers"*, and
   `scripts/audit-projections.mjs:199-203` lists four leak classes it cannot see. I read those limits and
   agree with them; I did not independently re-verify any predicate.

---

## 5. New task IDs, and why they are new

`P14-T1` … `P14-T10` are taken (`plans/20-PHASE-PACKETS.md:314-325`). Of the twenty-two findings above, **six
map onto a task that already exists** — TM-05 → `P14-T4`, TM-08 and TM-13 and TM-16 → `P14-T5`, TM-11 →
`P14-T6`, TM-12 → `P14-T9`. **The remaining sixteen have nowhere to go**, so this proposes **`P14-T11` …
`P14-T18`**, continuing the phase's own numbering rather than inventing a scheme.

**These eight task IDs are new. They are not in `plans/20`, they have no dependency data, and they are not in
`.tmp/TRACKER.md`.** They are proposals, and the sizes below are my estimate of the work, not a commitment
made on the phase's behalf.

| ID | Task | Size | Deps | Findings |
|---|---|---|---|---|
| **P14-T11** | Mount the session layer; replace both `ORRERY_DEV_USER_ID` placeholders; wire the route table into middleware; enforce pepper at boot; add rate limiting | **L** | P14-T1 | TM-01, TM-02, TM-05, TM-06, TM-07 |
| **P14-T12** | Sign the impersonation cookie; source the impersonation clock from the server | S | P14-T11 | TM-03, TM-04 |
| **P14-T13** | CSP: derive `frame-src`/`connect-src` from validated `SIM_ORIGIN`; add report-only review and a test that asserts the header names the configured origin | M | P14-T2 | TM-09 |
| **P14-T14** | Telemetry ingestion route: closed schema, re-stamping, reclassification, accommodation routing, signature verification | **L** | P14-T11 | TM-10, and the verification half of TM-17 |
| **P14-T15** | Repair the broken CI jobs: fix or remove the `grading` matrix entry, fix the `policy` job's three missing scripts, and make a missing script a hard failure rather than a typo | S | — | TM-14, and the second-order half of TM-22 |
| **P14-T16** | Repair the machinery that has gone stale: write `audit:payloads`; extend the invariant registry to check declared gates **and files** on staged invariants and to fail an overdue one; add the `dangerouslySetInnerHTML` ban; cover `msg` and telemetry `detail` keys in the canary tests | **L** | P14-T2 | TM-15, TM-19, TM-20, TM-21, TM-22 |
| **P14-T17** | Move the evidence verifier out of the test file into the ingestion path; delete the two stale comments | M | P14-T14 | TM-17 |
| **P14-T18** | Build the sim registry in CI and prove no user code reaches it | M | P6-T4 | TM-18 |

**Why finding IDs are `TM-nn` and not something existing.** `INV-*` is the invariant registry and is checked by
a gate (`scripts/invariant-registry.mjs`) — a finding is not an invariant. `D-*` is decisions
(`plans/23-REVIEW-ACTIONS.md`). `PF-*`, `C-*`, `V-*`, `U-*`, `B-*` and `ADV-*` are review findings and
corrections recorded in `.tmp/TRACKER.md`. `T1`–`T14` are taken by the exam threat table in
`plans/09` §3 and `docs/05` §2, and TM-04/TM-10 in particular would have collided confusingly with those.
`TM-nn` is new, and it is used **only** in this document.

---

## 6. Review

`plans/14` §10 requires the threat model to be *"reviewed by someone who did not write it"*, and this document
should be read as **a draft that has not yet met that bar.** The specific things a reviewer should attack first,
in the order I would attack them:

1. **TM-01's two-state framing.** If `ORRERY_DEV_USER_ID` is in fact set in a deployment I could not see, the
   severity of the roster *write* path is worse than Critical-as-written suggests and the second state is the
   only one that matters.
2. **The negative claims.** TM-01, TM-02, TM-10, TM-17 and TM-22 are all partly "this thing does not exist".
   Those are the claims most likely to be wrong, because absence is the hardest thing to check and I am one
   agent with one listing.
3. **Whether the severity scale is being applied consistently.** TM-09 (a broken CSP origin, fail-closed) and
   TM-12 (EXIF survives) are both scored Medium, and I am content with that, but a reviewer may reasonably
   argue TM-09 belongs with TM-02 in High because both are "a stated control that is not in effect".
4. **Whether TM-22's eight stale paths should be re-pointed or whether the invariants are genuinely
   unimplemented.** I traced each one to a plausible successor and found them all — but "the file moved" is my
   reading of where the code now lives, not a history of what happened, and `INV-BANK-2` (`draw.ts`) is the one
   where I found no successor at all.

**Nothing in `plans/14` §10 is ticked by this document.** Two items are arguably *partially* evidenced —
the canary log-scrubbing test (A09) and the CSV-injection escaping (A03) — and both are described above with
the limits that stop them being ticks: the canary test varies field names but not `msg` (TM-19), and the CSV
escaping is tested in `packages/contracts/src/csv/index.test.ts` but not *inside* the hand-rolled roster error
report that duplicates it.