# Orrery execution tracker

**Reconstructed 2026-09-28** after the workspace moved WSL → Fedora (`/home/zero` is a symlink to
`/home/day`; all paths still resolve). The previous `.tmp/TRACKER.md` did not survive the move.
This file is rebuilt from git history, the plans, and the live repository — **not** from memory of
the old file, so anything it cannot evidence is marked UNKNOWN rather than guessed.

## How to read this

- Every phase has a status: **DONE**, **IN PROGRESS**, or **NOT STARTED**. Nothing is "mostly done".
- A task is DONE only if its code is committed **and** the evidence line lists a passing command.
- The `UNKNOWN` marker means the evidence needed to decide was lost with the old tracker. Those
  items are listed so they get re-checked, not so they can be quietly treated as done.

## Environment (new host, re-established 2026-09-28)

| Item | Value |
|---|---|
| OS | Fedora 44, kernel 6.19.10-300.fc44 |
| Node | 24.21.0 (the old host was 24.13.1, which was **below** Zod 4.4.3's `^24.15.0`; this host satisfies it) |
| pnpm | 10.0.0 (corepack) |
| Container runtime | rootless **podman 5.8.7**, with `systemctl --user start podman.socket` exposing the Docker API at `unix:///run/user/1000/podman/podman.sock` |
| Postgres | 16-alpine, container `orrery-pg`, published on **55432** (matches `.env.test`) |
| Extensions | citext, pg_trgm, btree_gin, pg_stat_statements (from `infra/postgres/init/01-extensions.sql`) |

Three things had to be re-established, and each is a portability finding worth keeping:

1. **`docker.sock` is not usable by this account.** The socket is `root:docker` mode `0660` and the
   user is in `wheel`, not `docker`; `sudo` needs a password. The Docker CLI works by pointing
   `DOCKER_HOST` at the rootless podman socket. **Every command that needs Docker must export it.**
2. **`docker compose` cannot bind the `infra/postgres/init` volume.** Fedora has SELinux enforcing
   and podman refuses a bind mount without a `:z` relabel. Rather than mutate `docker-compose.yml`
   for one host's policy, Postgres is run directly with `podman run` and the init SQL is applied
   with `docker cp` + `psql`. The compose file is therefore **untested on this host** — flagged
   below, because that is a real gap in what "the stack starts" means.
3. **`*.tsbuildinfo` survived the move but `dist/` did not.** `tsc -b` then believed every package
   was up to date and the workspace failed to resolve `@orrery/clock`. Fixed by deleting the
   `tsbuildinfo` files. This is a class of failure that will recur on any host move or partial
   checkout, and the first symptom is a bogus "cannot find module" for a package that exists.

## Current verified state

| Metric | Value |
|---|---|
| Commits | 50 (P3-T5 and P3-T6 landed after this file was first written) |
| Unit tests | **938** (clock 29, ids 10, rng 16, config 48, auth 384, i18n 25, db 8, contracts 274, web 142, worker 5 — approximately; per-package counts shift as suites grow) |
| Integration tests | **216** across 14 files, real Postgres |
| Gates | **8 / 8 passing** |
| Lint / typecheck | 0 / 0 errors |
| Invariants registered | 29 (8 active) |
| Web production build | succeeds; `app-build-manifest.json` present, so the bundle gate is real |

The bundle budget gate is only meaningful because `apps/web` was built on this host. A gate that
reports "no manifest — cannot measure" is a gate that is not running, and it says so.

## Phase status

### P0 — Foundation & decisions · **DONE** (24h est.)

Commits `e1e387f` … `09eb3c6`. Schema gate written as the root-cause fix for review finding B1 (a
Prisma schema that shipped in the plan set had ten validation errors and nothing ever ran
`prisma validate`). Next.js app with an isolated exam surface; bundle budget gate made real; a
Dockerfile that **runs the gates at build time**; logging with scrubbed fields and the `attemptId`
spine; worker; provisioning ledger; CSP nonce; ADRs 0025–0030 reconciling the plan against what
P0 actually built.

### P1 — Identity, sessions & the `can()` kernel · **DONE** (28h est.)

Commits `9245ebd` … `43399a2`. The `can()` kernel as data with 100% branch coverage; session
kernel with epoch invalidation; timezone-aware deadlines; argon2id with school-safe throttling and
the Better Auth seam; account lifecycle as a pure state machine plus the `SecurityEvent` it
revealed was missing; auth UI with account enumeration closed at three layers; sessions page
proving the P1-T4 done-when end to end; account deletion with the tombstone the schema forced;
classroom-scoped matrix types after the bug where membership granted authority; TOTP with replay
protection (two P1 invariants flipped active); impersonation as a read-only gate that runs
**before** authorisation.

### P2 — Content model, block schema & editor · **DONE** (64h est.)

Commits `187fa19` … `82a3ae8`.

- 16-type closed block union, and why `.strict()` is not enough. Block migration with a fixture
  corpus and the seventh gate.
- The block renderer: 16 types, axe clean, XSS corpus swept.
- Lifecycle, visibility, and the read-time re-check. Read path against a real row, with a cache
  that holds no permissions.
- `validateForPublish`: a checklist with fixes, not a wall of red.
- The P2-T3 risk spike — **the kill-switch did not fire.** Three blockers found, two resolved, one
  excluded by the trigger wording, and no 2× estimate consumed. P2-T11 remains unbuilt insurance.
- Autosave and the three-way conflict panel; atomic node attrs and the block handle (both
  remaining blockers resolved).
- Write-once versioning, structural diff, restore. **INV-CONTENT-1 active.** A duplicate is a new
  resource, not a new version, because INV-CONTENT-1 makes a second identical version a
  multi-valued answer that quietly breaks every pinning assignment.
- Media library, transactional quotas, the publish-time blocks cap.
- The resource library: blast radius, transfer, duplicate.
- The slash palette and four atomic node views; editor/renderer accessibility — computed contrast,
  a real key map.

### P3 — Subjects, library, search & moderation · **DONE** (30h est.)

| Task | Status | Commit | Note |
|---|---|---|---|
| P3-T1 subject hierarchy, tag merge, classification | **DONE** | `a8bd3b5` | Cycle-safe `moveSubject` under advisory lock; conflict-safe tag merge across `ResourceTag` and `QuestionTag`; real-Postgres concurrency tests prove at most one conflicting move succeeds. |
| P3-T2 subject seed | **DONE** | `4750a3c` | 246 subjects (plan said "~120" — recorded, and the gate asserts a *range*). **The gate found nine subjects that were their own parent**, plus nine roots sharing `position: 0`. |
| P3-T3 public library | **DONE** | `89d9c10` | No anonymous `Actor` by design. `plans/05` §6's **under-18 rule** enforced in SQL. Keyset paging. Four distinguishable empty states. |
| P3-T4 search, facets, zero-result log | **DONE** | `11e73ed` | Weighted `tsvector` as a generated column. Also **implemented schema-gate check 2**, which had been documented since P0-T4 and never written. |
| P3-T5 ratings, comments, flagging, takedown SLA | **DONE** | *(this commit)* | Vocabulary, schema, migration, auth rules, moderation service, 29 integration tests. The SLA is a **gate**, not a number in a column. |
| P3-T6 slugs, canonical URLs, OG images, sitemap | **DONE** | *(this commit)* | `/library/<slug>` with the subject deliberately OUT of the path, a partial unique index for the public namespace, SVG OG cards with three security headers, and a sitemap that is a public surface and is filtered like one. |

#### P3-T5 detail (complete)

Done and verified:

- **Four new actions** in the closed vocabulary: `rate`, `comment`, `flag`, `moderate`. `moderate`
  is the one genuinely new in kind: every other verb acts on content the actor is party to, and
  this one acts on a third party's content on the strength of a role alone.
- **Three new types** (`Rating`, `Comment`, `Flag`) added to `ALL_RESOURCE_TYPES` and
  `IMPLEMENTED_TYPES` together, because a rule that reads a rating without checking it belongs to
  the same reader is only wrong *in combination*.
- **Totality test evidence, before and after.** Declaring the types with no rules produced six
  `TS2739`/`TS1360` errors naming all four actions and all three types — the "prove the test fails
  first" evidence P1-T6 requires. After writing the rules: `tsc` clean, 384 auth tests passing.
- **Migration `0008_moderation`** with five `CHECK` constraints the schema language cannot
  express, each replacing a place where the application was the only thing holding a line:
  `Rating.value BETWEEN 1 AND 5`; a `HIDDEN`/`REMOVED` comment must carry a reason; a
  `PENDING_REVIEW` comment must carry `gatedAt` + `gateReason`; a resolved flag must carry a
  resolution; `reason = 'OTHER'` must carry detail; and `dueAt >= createdAt`.
- `Comment.status` changed from a bare `String @default("VISIBLE")` to a real `CommentStatus`
  enum. The old column let a typo become a row no query matched and no query rejected.
- Named relations, because a `User` is now on the other side of moderation in three distinct
  capacities — author, moderator, resolver — and three unnamed `User?` fields cannot be told
  apart in a query or in a mistake.
- `totality-d14.test.ts` now **derives** the cell count as `IMPLEMENTED_TYPES.length ×
  ACTIONS.length` instead of hardcoding `138`. The old literal had to be renumbered twice by
  hand, which is how a pinned number becomes a test that means nothing.

Decisions taken that a reviewer should look at:

- **A takedown is not a type.** It is the resolution of a `Flag` and lands on the thing itself
  (`Resource.status = WITHDRAWN` from P2-T8, or `Comment.status = HIDDEN`). A `Takedown` type
  would have been a second place to record "this content is down" and therefore a second thing to
  get out of step.
- **A `Flag` always has a `resourceId`**, and a `commentId` is optional and means "this comment on
  that resource". Two nullable polymorphic FKs would have needed a `CHECK` to stop the "neither"
  and "both" states; this way "both" is the only reachable option and it is the correct one.
- **The SLA tiers are a judgement, not a plan value.** `plans/05` §6 says "a documented takedown
  SLA" and gives no number, and no other plan gives one either. The tiers and their justification
  are written in the service header; they need a human decision before GA and this records that.
- **Comment gating is both-sided**: a comment *by* a minor is held, and so is a comment *on* a
  minor's resource. `plans/05` says "comments (moderation-gated for minors)" without saying
  which. The author-side is the stronger argument, since the public surface is where a stranger
  would target a child.

The service and its tests, landed in the same commit:

- `rateResource` is an **upsert**, not an insert. A unique `(resourceId, userId)` plus an
  INSERT makes the star widget single-use, so a visitor who changes their mind has to create a
  second account. `ratingSummary` returns all five buckets *including the zeroes* and a null
  mean when empty, because a UI needs five buckets to render five stars and "4.2" beside
  "2 ratings" is the case the count exists to explain.
- `postComment` gates on **both** ends: a comment *by* a minor is held, and so is a comment *on* a
  minor's resource. `plans/05` says "moderation-gated for minors" without saying which. The
  second is the stronger claim and the one that costs product; it is worth it because those
  resources are not publicly listed by default (P3-T3), so anything reachable is reachable
  through a deliberate share.
- `moderationQueue` is ordered by **deadline, not age**. Sorted by age, a week-old `COPYRIGHT`
  flag sits above a `SAFEGUARDING` flag raised an hour ago and the urgent thing is at the bottom.
  `overdueMs` is clamped at zero: reporting a negative lateness for "three hours early" makes a
  sum over the queue wrong in a way that averages to nothing and totals to something absurd.
- `resolveFlag` **refuses an overdue flag with 409** until the caller passes
  `acknowledgeOverdue`, which stamps `acknowledgedOverdueAt` on the row and puts `wasOverdue`
  and `overdueHours` in the audit event. A queue that merely *records* a deadline is a reporting
  feature, and reporting features are not read.
- A duplicate report is a **success**, not an error, and does not reset the running clock —
  otherwise a report could be kept alive forever by re-submitting it.
- Every deadline is computed from a `FrozenClock` in the tests. A queue whose deadline can only
  be tested by waiting an hour is a queue whose deadline is never tested.

**The bug the tests caught:** `withdraw: true` on a *comment* flag withdrew the whole resource,
so one moderated sentence removed a teacher's published lesson. The two easy fixes are both
wrong — silently ignoring the request would leave the moderator believing they took it down, and
honouring it is the bug. It is now **refused with 409** and the message says withdrawing a
resource is a separate door with a separate decision.

**The SLA tiers are a judgement, not a plan value.** No plan gives a number. `SAFEGUARDING` 1h,
`UNSAFE_OR_HARMFUL` and `PERSONAL_INFORMATION` 24h, `OFFENSIVE`/`MISINFORMATION` 72h,
`COPYRIGHT`/`SPAM`/`OTHER` 7 days. PII is deliberately on the same clock as unsafe content: a
child's name on a public resource is harmful on the same timescale, and a slower PII clock would
rank it as less urgent than a rude word. **These need a human decision before GA** — the file
is the documentation `plans/05` asks for, and the numbers are the part to argue with.

#### P3-T6 detail (complete)

The design decision, and the one to argue with: **the canonical path is `/library/<slug>` and the
subject is NOT in it.** The obvious URL is `/library/maths/algebra/quadratics` — keyword-rich,
what a CMS generates — and it is wrong here because `moveSubject` is a shipped, cycle-safe
feature (P3-T1) and moving a subject would break the URL of every resource beneath it. Dropping
the subject costs two things and both are handled:

  · **Ambiguity.** Two public resources cannot share a slug, enforced by a PARTIAL unique index —
    `UNIQUE (slug) WHERE visibility = 'PUBLIC'` — so uniqueness is required exactly where the URL
    is ambiguous and NOT in the authors' private libraries, where two teachers each having a
    draft called `quadratics` is correct. A global unique index would have blocked ordinary
    authoring to protect an ambiguity that does not yet exist, and it is the kind of wrong that
    looks right. Prisma cannot express a partial index, so it lives in migration 0009 as SQL and
    is declared in the schema as a plain `@@index` so `migrate diff` agrees.
  · **Renames.** The slug is assigned ONCE at creation and is **immutable**, so a title can change
    forever without touching a URL. That is what removes the need for a redirect table: there is
    no rename path, so there is nothing to redirect. An alias table would have been a second
    place to keep URLs in step, and a second place is a second thing to get out of step. If
    resource renames are ever a requirement, `packages/contracts/src/urls` is the file to revisit.

  · **`APP_URL`, not the `Host` header.** A sitemap needs absolute URLs and the obvious source of
    the origin is the request header, which is attacker-controlled. Reflecting it means a
    poisoned sitemap that a crawler submits on somebody else's instructions. `APP_URL` already
    existed in config with a "not localhost in production" refinement — I added a second
    `PUBLIC_ORIGIN` before noticing, and reverted it. **One origin, one place** is the lesson and
    it cost me one commit's worth of churn.

  · **The sitemap is a PUBLIC SURFACE.** It is built from the same exported `PUBLIC_LISTING`
    predicate as the public library and the search, so it inherits the `plans/05` §6 under-18
    rule. A sitemap entry is the hardest thing on the platform to take back: it ends up in a
    search engine's index and can be cached by third parties for months.

  · **The OG card is SVG, and an SVG is a document.** No image library, so it is a pure function
    and a reviewable diff. The consequence is that a browser will EXECUTE a script in an SVG it
    navigates to, which is what every link previewer does — so three things are required
    together and none suffices: XML-escape every interpolated value (the title is author text),
    send `Content-Security-Policy: default-src 'none'`, and send `X-Content-Type-Options:
    nosniff`. A missing resource is a 404, not a placeholder card, because a preview service
    caches whatever it is given and a generic card for a 404 becomes its permanent preview.

Three findings worth carrying forward:

  · **`<loc>` was relative, and no test caught it.** `renderSitemap` is path-based on purpose (it
    has no idea what a deployment is called), the unit tests assert paths — and the bug lived in
    the one layer between the tested function and the wire. Running the route against the real
    database and *reading the output* is what found it. There is now a test stating the contract:
    `renderSitemap` does NOT add an origin, so a caller who forgets produces relative URLs
    silently.
  · **A test that deliberately corrupts shared state breaks unrelated tests.** The
    cycle-termination check created a two-node subject cycle, queried, then repaired it — leaving
    a window in which a globally shared tree was cyclic. Two other test FILES read that tree and
    one started failing with "the JS rollup and the SQL predicate disagree", which looks exactly
    like the bug that test exists to catch. It is now inside a transaction that rolls back. A test
    that corrupts shared state is a test that can break other tests however carefully it repairs
    itself.
  · **ANY assertion that compares two reads must take them in ONE snapshot.** Vitest runs test
    files in parallel against one shared database, so a resource inserted *between* two reads
    makes the sets differ and the failure reads as "these two predicates have drifted". I chased
    that as a real bug and the diff was zero — the sets were 1890 and 1890 when read together.
    `REPEATABLE READ` in one transaction is the fix, applied to both affected tests.

### P4 — Classrooms, membership, invites, notifications · **IN PROGRESS** (46h est.)

| Task | Status | Note |
|---|---|---|
| P4-T1 `Classroom` lifecycle, ownership transfer | **DONE** | This commit. Migration `0010_membership_history`. |
| P4-T2 Membership: roles, removal, leaving, role history | **DONE** | This commit. Append-only `MembershipEvent`. |
| P4-T3 Invitations: email, bulk, hashed join codes | **DONE** | This commit. Migration `0011_invite_codes`. |
| P4-T4 Invitation lifecycle: accept, revoke, expire, resend cooldown | **DONE** | This commit. |
| P4-T5 Roster CSV: dry run, error report, idempotent apply | NOT STARTED | `RosterImport` model exists. |
| P4-T6 Roster UI with per-student summary | NOT STARTED | |
| P4-T7 Notifications: templates, queue, dedupe, quiet hours | NOT STARTED | `Notification` and `EmailOutbox` are still UNUSED. |
| P4-T8 Permission matrix tests: every cell of §4 | NOT STARTED | Partial coverage in this commit; the §4 table itself is not yet exhaustive. |

#### P4-T3/T4 detail (complete)

**A join code is a BEARER TOKEN, and every property follows from that.** Anyone holding a code is
in the room, so the platform holds only a KEYED hash, the code is derived rather than random, it
expires, regenerating revokes it, failures count against the ROW, and wrong/expired/revoked/locked
all return the same answer.

  · **MAC, not a plain digest.** 8 symbols from a 25-symbol alphabet is ~47 bits, and an
    UNKEYED SHA-256 of that is a lookup table anybody holding a stolen table can build offline —
    so "hashed at rest" is decorative without a key. `packages/auth`'s `hashRecoveryCode` had
    already made exactly this argument for TOTP recovery codes; the same reasoning applies and
    the same conclusion is drawn. A deployment-wide salt rather than per-row is deliberate: one
    stolen table is worth attacking ONCE, not 25^8 times.
  · **Derived, so regeneration cannot leak.** `HMAC(secret, classroomId ‖ counter)`. Regenerating
    is a counter bump — instant, auditable, and it cannot leave the old code alive in a
    photograph because there is no old code to forget. Rolling `randomBytes` and hoping is the
    version that leaks. Verified by test: a code is a function of the classroom, the counter AND
    the secret.
  · **THE ALPHABET IN `plans/01` IS STILL THE ONE B17 REJECTED.** §1 lists
    `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, which contains both `8`/`B` and both `5`/`S` — the exact
    contradiction B17 raised, and B17 says it was "FIXED" while the plan text still shows the
    unfixed alphabet. B17 is authoritative, the alphabet here drops `0/O`, `1/I/L`, `8/B`, `5/S`
    and `2/Z`, and the test asserts the ABSENCE of each pair rather than trusting a document that
    has not been corrected. **25 symbols, and the count was wrong in the first version of both
    the comment and the test (24, because 5 + 20 was done as 5 + 19).** A stated search-space size
    is a number somebody has to have counted.
  · **Wrong, expired, revoked, unknown and wrong-secret are ONE answer**, asserted as a set-size
    of 1 across all five. The cost is real — a legitimate user with an expired code is told it is
    "not valid" — and it is paid on purpose, because the alternative is an enumeration oracle on a
    bearer token.
  · **The failure counter is on the ROW, not the IP**, so a distributed sweep of one code still
    stops, and the LOCK is a separate sweeper pass. The first version locked inline, which cannot
    work: the increment and the threshold test are not the same read, so two concurrent guesses
    would both see 9 and both let the tenth through.
  · **Accepting is idempotent and transactional.** A double-click must not create two enrollments
    and must not ERROR either — a second click saying "already a member" reads as a failure to
    somebody who has just been told they joined.

#### Infrastructure fixed alongside P4-T3/T4

  · **The schema gate's shadow database now CREATES ITSELF, by discovery.** It hardcoded
    `docker exec orrery-postgres-1`, a name `docker compose` generates and that is therefore
    stable only for that compose project on that host. Everywhere else the `catch` returned
    quietly and the gate failed downstream with `Database orrery_shadow does not exist`, which says
    nothing about the cause. It now tries a local `psql`, then discovers a container by matching
    the PORT the URL points at, and if neither works prints the exact command to run. **A helper
    that silently does nothing on the machines it does not recognise is worse than one that is
    absent**, because the failure it produces looks like a different problem entirely. (Its
    "create it yourself" message also printed `psql "null/postgres"`, because `URL.origin` is the
    literal string `"null"` for every scheme this project uses.)
  · **`_prisma_migrations` had gone missing**, which is why `migrate dev` began reporting that
    the database was empty of all 58 tables and 26 enums while `migrate diff` said the schema and
    database were identical. `migrate reset` restored the bookkeeping — and, usefully, REPLAYED
    every hand-written migration from the files: all four `MembershipEvent` checks, the three
    `Flag` checks, `Rating_value_range` and the `Resource_public_slug_key` partial index came back,
    which is a real validation of hand-written SQL that `migrate dev` never performed.
  · The drift check then immediately caught MY OWN omission — `codeCounter` was in schema.prisma
    and not in migration 0011. Which is the check doing its job two days after being written.

#### P4-T1/T2 detail (complete)

**Three real bugs in the P1 authorisation layer, found by writing the first real caller.** The
matrix was written in P1 and exercised only by synthetic fixtures; P4 called it for real and
found three things that could not have been found any other way. All three produced a DENY for a
caller who was allowed, which is the safe direction and still a bug, because the feature simply
does not work:

1. **`Classroom.create` granted `sameClassroom`, which a classroom being CREATED cannot satisfy.**
   The obligation requires a `context.scopeClassroomId` and a subject that has an
   `owningClassroomId`; a room that does not exist yet has neither. Every call returned
   `wrongClassroom` and no classroom could be created. The fix is to DROP the obligation rather
   than fake a scope: `update`, `publish` and `grade` happen INSIDE a classroom, while creation
   ESTABLISHES one. **An obligation that cannot be satisfied by a correct caller is not a check,
   it is a wall.**
2. **The P1 matrix contradicted `plans/12` §4.** §4 says "Manage members and roles: OWNER ✓,
   TEACHER ✓ (not owner)" and P1 had made `invite`/`removeMember` owner-only and
   **`changeRole` a blanket `deny('roleForbidden')`** — a capability with no rule at all. A deputy
   head of year who cannot add a student is a product decision nobody made.
3. **`subject.owningClassroomId` was never populated**, so `sameClassroom` denied the OWNER the
   right to rename their OWN classroom. For a Classroom, its owning classroom is itself.

The structural fix for (1)–(3) is `classroomCanInput`/`permit` in `classrooms.ts`: ONE function
builds a complete `CanInput`, including `scopeClassroomId` and `owningClassroomId`, and reads
`actorClassroomIds` fresh from the database on every call (which is INV-CLASSROOM-2's "within one
request" made mechanical). The file now has exactly ONE inline `can()` — the `create` call, where
there is no classroom to scope to — and the reason is written next to it.

**A test-shaped instruction in a plan, honoured literally.** `plans/12` §4: "Classroom scoping is
applied *in the query*, not filtered afterwards, and a test asserts the generated SQL contains
the scope." The test captures Prisma's emitted SQL and asserts the enrollment predicate is in the
`where` and the actor is a bound parameter. It went through three wrong versions first: one read
a property that was a snapshot of an EMPTY array (so it "passed" vacuously — a spy that records
nothing is worse than no spy), one looked for `FROM "Classroom"` when Prisma emits
`FROM "public"."Classroom"`, and one asserted the actor's uuid was INLINED in the statement when
values are always bound. The final version asserts the PROPERTY.

**Role history is a table, not the audit log.** `AuditEvent` answers "who did what"; it cannot
answer "what was this student's role in March", because a role change overwrites the enrollment
and leaves an entry describing the act rather than the state. `MembershipEvent` is append-only,
and three `CHECK` constraints make a lying history impossible: a `ROLE_CHANGED` row must carry
both ends and they must differ, a `JOINED` row must have no previous role, and a departure must
have no next one. **A history that can lie is worse than no history, because it is believed.**

**Two boundary decisions worth arguing with.** `addMember` refuses `OWNER` outright — a roster
screen that can set anybody to OWNER bypasses the TEACHER check that `transferClassroomOwnership`
applies, and the matrix cannot see the target. And `endMembership` has no `cascade` parameter:
the way to guarantee INV-CLASSROOM-2's "the student's records are preserved" is for the function
to have no parameter capable of expressing the opposite.

**The authz-ownership gate fired four times** on `ownerId === actorId` comparisons in the service
layer and was right every time. All of them now ask `isSameActor` from `packages/auth`, because
"is this mine?" is an identity question and a codebase that answers it inline in a dozen places
has a dozen slightly different answers.

### P5 … P17 — **NOT STARTED**

P5 assignments/pinning/banks/blueprints · P6 simulation platform
and the 24 gold sims · P7 quiz runtime and auto-grading · P8 exam runtime and integrity · P9 teacher
review and grading · P10 atomic release and results · P11 item analysis and gradebook · P12
simulation scale-out to 220 · P13 accessibility and i18n · P14 security, privacy, compliance ·
P15 reliability, performance, DR · P16 interop (QTI/xAPI/LTI/OneRoster) · P17 pilot and GA.

## Carried-forward gaps (recorded before the move, re-confirmed where possible)

- **`readImpersonation()` returns `null`** because signed-cookie verification is not wired. It
  fails closed, so it is a missing feature rather than an open hole.
- **Register → verify integration seeds rows** rather than exercising the full Better Auth email
  flow.
- **P2-T7 2.4.11 occlusion and P2-T3b 500-block paint performance** need a real browser. jsdom
  proves the mechanisms, not the rendering.
- **`docker-compose.yml` is unverified on this host** (SELinux). The Postgres it declares works
  when run directly; the compose path does not. This should be fixed in the compose file with a
  `:z` relabel so `docker compose up` is portable to SELinux hosts, and that is a real task.
- **The shared integration database now holds thousands of fixture rows** from repeated runs,
  with no cleanup. Every test therefore uses exact per-run slugs rather than prefixes, and
  assertions that compare two reads use a `REPEATABLE READ` snapshot. A `--force` reset is
  occasionally worth doing by hand; the suite does not depend on being clean, but it is large.
- **P2-T11 remains unbuilt insurance.** The P2-T3 kill-switch never fired.

## Evidence commands

Run from the repo root, with `DOCKER_HOST=unix:///run/user/1000/podman/podman.sock` exported and
the `orrery-pg` container running.

```
pnpm run build          # must pass before typecheck; tsbuildinfo can go stale
pnpm run typecheck      # 0 errors
pnpm run lint           # 0 errors
pnpm run gates          # 8 / 8
pnpm run test           # 938 unit
pnpm run test:integration   # 216 across 14 files, needs DATABASE_URL
cd apps/web && pnpm run build   # produces app-build-manifest.json for the bundle gate
```

Integration tests need `DATABASE_URL=postgresql://orrery:orrery@localhost:55432/orrery`. The
database is **shared across runs with no cleanup**, so every test uses a per-run UUID-derived
slug or token; and a test count that has not moved is not evidence.
