# Orrery execution tracker

**Reconstructed 2026-09-28** after the workspace moved WSL → Fedora (`/home/zero` is a symlink to
`/home/day`; all paths still resolve). The previous `.tmp/TRACKER.md` did not survive the move.
This file is rebuilt from git history, the plans, and the live repository — **not** from memory of
the old file, so anything it cannot evidence is marked UNKNOWN rather than guessed.

## How to read this

- Every phase has a status: **DONE**, **IN PROGRESS**, or **NOT STARTED**. Nothing is "mostly done".
- **The summary tables are AUTHORITATIVE, and this rule exists because they were not.** A task is
  **DONE** in a summary table only when the commit exists AND its evidence is recorded; a detail
  section saying "complete" does not make a summary row true. A row reading `DONE` with
  `*(this commit)*` in the commit column, or a detail section declaring a phase closed while its
  summary rows still say `NOT STARTED`, is a **defect in this file** — the kind that makes a
  tracker worth less than no tracker, because the one thing it exists to answer (what is done?)
  has two answers.
  - Therefore: a commit hash in the commit column, never `*(this commit)*` — that placeholder is
    written before the commit exists and is the exact shape the drift took.
  - A row describing **the commit that introduces it** cannot contain its own hash, because
    amending to add the hash changes the hash. Those rows are written `*(next commit)*` and
    **resolved by the immediately following commit**. A placeholder that survives one commit is
    itself drift: `598cfb2` → `477a933` is what resolving it looks like, and P5-T1's row is the
    example the rule now cites.
  - A phase moves to **DONE** in the same commit that completes its last task, and the summary
    rows are rewritten there, not deferred to a later tidy-up.
  - When a detail section and a summary row disagree, the summary row is the defect. It is the
    part a reader scans, and a scanned part that lies is worse than no part.
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
| Commits | 62 |
| Unit tests | **1074** (db 23 with 15 new slot tests, auth 436, contracts 327, web 158) |
| Integration tests | **282** across 19 db files + 6 worker outbox, real Postgres |
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
| P3-T5 ratings, comments, flagging, takedown SLA | **DONE** | `2bff89f` | Vocabulary, schema, migration, auth rules, moderation service, 29 integration tests. The SLA is a **gate**, not a number in a column. |
| P3-T6 slugs, canonical URLs, OG images, sitemap | **DONE** | `460d193` | `/library/<slug>` with the subject deliberately OUT of the path, a partial unique index for the public namespace, SVG OG cards with three security headers, and a sitemap that is a public surface and is filtered like one. |

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

### P4 — Classrooms, membership, invites, notifications · **DONE** (46h est.)

Commits `b3405c9` … `0d78de6`. Membership is a property of MEMBERSHIP rather than of a global
role, the roster is a read model that cannot leak an unreleased grade, notifications have exactly
one opt-out and it governs email only, and §4's table is enforced cell by cell.

| Task | Status | Commit | Note |
|---|---|---|
| P4-T1 `Classroom` lifecycle, ownership transfer | **DONE** | `b3405c9` | Migration `0010_membership_history`; cycle-safe rename with a slug-collision retry; ownership transfer restricted to a TEACHER already in the room. |
| P4-T2 Membership: roles, removal, leaving, role history | **DONE** | `b3405c9` | Append-only `MembershipEvent`. Fixed three P1 matrix bugs: unsatisfiable `sameClassroom` on create, teacher role-management denied, missing `owningClassroomId`. |
| P4-T3 Invitations: email, bulk, hashed join codes | **DONE** | `edfb36e` | Migration `0011_invite_codes`; 8-character HMAC join codes on a 25-symbol alphabet; keyed hashes; exactly-one-target checks. |
| P4-T4 Invitation lifecycle: accept, revoke, expire, resend cooldown | **DONE** | `edfb36e` | Idempotent acceptance, revoke, expiry, 10-failure lock, 5-minute resend cooldown, extension, direct add. |
| P4-T5 Roster CSV: dry run, error report, idempotent apply | **DONE** | `d47f3c8` | Hand-written RFC 4180 parser, **no new dependency** (`plans/00` §RN). 1,000-row import 5,000 ms → 396 ms. The plan's own CSV rule created a bug; `unescapeCsvCell` is the fix. |
| P4-T6 Roster UI with per-student summary | **DONE** | `e04fe85` | `listRoster` read model + `RosterTable`. An unreleased grade is **never selected**, so there is nothing to leak. The plan asked for dialogs; the codebase bans them, so the requirement is met by naming every person inline. |
| P4-T7 Notifications: templates, queue, dedupe, quiet hours | **DONE** | `2f45bc2` | Migration `0012_notifications`. `emailOptOut` is the ONLY opt-out, and there is no parameter that can carry it to the in-app path. Quiet hours found by asking `Intl`, so they survive a DST change. |
| P4-T8 Permission matrix tests: every cell of §4 | **DONE** | `0d78de6` | §4 transcribed as 21 cells and walked by a loop. **Found six bugs**, including four types with no rules at all and `User.read` being self-or-admin. |

#### P4-T8 detail (complete) — P4 IS CLOSED

**THE TEST IS A TRANSCRIPTION, AND THE TRANSCRIPTION IS CHECKED TWICE.** §4 is copied into the
test as a table of 21 cells, and a loop walks it. A hand-written assertion per cell would be a
test covering the cells its author remembered; a walked table cannot skip one without the count
changing. And because a transcription is a copy that rots, every cell must name an `Action` and a
`Subject`, the test refuses to run if one does not, and each named pair is asserted to EXIST in
the matrix — a cell naming a typo'd action would otherwise "pass" by denying, and a deny because
of a typo is indistinguishable from a correct deny.

**IT FOUND SIX BUGS, AND NOT ONE OF THEM WAS A CRASH.** Every one was reasonable-looking code
that was not the plan:

1. `assign` and `publish` were OWNER-ONLY. A co-teacher could not publish an the class they were
   employed to teach. §4 lists `Teacher ✓` in plain sight.
2. `grade` granted to any member holding the GLOBAL `teacher` role — so a teacher enrolled as a
   STUDENT in another teacher's room could mark it. The fix was `actorClassroomRoles` in the
   context, because §4's rows are about a relationship to a CLASSROOM and membership alone cannot
   express that. The kernel could not ask the question, so it was asked of the wrong thing.
3. `viewEvidence` was REVIEWER-ONLY, contradicting §4's `Owner ✓, Teacher ✓`. Resolved in the
   plan's favour — a school needs its own teacher to see the proctoring record, because the
   teacher is the person with the standing to act on it — with a NEW action, `adjudicate`, split
   out so the reviewer's standing over a VERDICT survives the loosening. That is a plan-versus-code
   disagreement and it is recorded rather than buried.
4. `Assignment`, `ExamAttempt`, `IntegrityEvidence` and `ReleaseBatch` had NO RULES AT ALL. §4
   has rows for grading, releasing, taking an assignment and viewing evidence, and all four are
   actions on these types — so the matrix had no opinion about §4's most important cells, and the
   test said exactly that: "§4 says nothing enforceable about this". `types.ts` had already named
   P4-T8 as the task that appends them.
5. `enrollmentRules` had no `changeRole`, no `removeMember` and no `invite`. P4-T2 wrote those
   rules on `Classroom`, but the capability is about an ENROLLMENT, so a service authorising
   against `Enrollment` got `notAvailable` and one authorising against `Classroom` got the real
   rule. Which you got depended on which type the service happened to pass to `can()`.
6. `User.read` was SELF-OR-ADMIN — §4's third column and not its first two. A teacher could not
   read a student at all, so the roster page's per-student summary had no authorisation behind it.
   The grant is "a classroom we BOTH belong to", and both sides are needed: a teacher in A cannot
   read a student in B, and two schools cannot grant it by sharing a tenant.

**§4's OWNER COLUMN MEANS THE OWNER OF THE CLASSROOM, AND FOR AN ENROLLMENT THAT IS NOT
`subject.ownerId`.** The first version of the fix compared the owner actor against
`subject.ownerId`, which for an Enrollment is the STUDENT — so the test was asking "is the owner"
about the child. The owner's grant belongs on the classroom role, which they hold, because
`createClassroom` writes an OWNER enrollment. Getting that wrong produced `roleForbidden` for the
owner of their own roster.

**A DENY CODE THAT LIES IS WORSE THAN NO DENY CODE.** Two of them. A REVIEWER who IS enrolled was
being told `notMember` — "they are not in this class", about somebody who is — and an operations
dashboard keyed on that code triages on it. And a student told `notVisible` about their own
unreleased marks is told a falsehood; `releaseNotPublished` exists because "your results are not
out yet" and "you may not see this" are different sentences with different remedies.

**A STUDENT NEVER SEES COHORT AGGREGATES — AND THE TEST IS STRONGER THAN A DENIAL.** Not "one
action is refused" but "no verb in the vocabulary hands a student aggregate performance": the
test iterates all 28 actions and pins the granted set to exactly `['read', 'start']`. A single
denied action can be circumvented by reaching for a different one, and the day somebody adds
`readCohort` a weaker test would pass while the breach was live.

**THE COMPILER CAUGHT A VOCABULARY MISTAKE I MADE.** The release rule first read
`subject.lifecycleStatus !== 'RELEASED'`, and `lifecycleStatus` is the CONTENT vocabulary
(`DRAFT | PUBLISHED | ARCHIVED | WITHDRAWN`) while a release batch is `DRAFT | RELEASED`. The
type error was the right outcome: the invariant would have been a comparison between two
vocabularies that happen to share letters. So `releaseBatchStatus` is its own context field, and
the invariant is stated in the rule rather than inferred from a lifecycle enum.

**THE EXISTING AUTH TESTS ENCODED THE OLD SEMANTICS, AND TWO OF THEM WERE WRONG IN A WAY THAT
MATTERED.** One asserted that mere ENROLMENT was enough to grade — a much weaker claim than §4's
"teacher in the room", and the loophole itself. The context builders now take a role, so "this
actor is in the room" and "this actor is a teacher in the room" are different function calls and a
test cannot mean the first when it needs the second.

#### P4-T7 detail (complete)

**"UNSUBSCRIBE" IS NOT A GLOBAL MUTE, AND THAT IS A SCHEMA DECISION.** §7's last rule is "one-click
unsubscribe on every email, and unsubscribing never disables in-app notifications a user needs
for their coursework." "Unsubscribe" reads like a global mute, and a `muted` boolean would
satisfy the first half of that sentence and quietly break the second. So there is exactly ONE
opt-out column, named `emailOptOut`, `notify` has no parameter that can carry it, and
`unsubscribe` has no parameter that could reach the notifications table. A test reads the inbox
after unsubscribing and asserts the notification is still there; a second one asserts a LATER
notification still arrives. The type is the guarantee and the tests are the echo.

**UNSUBSCRIBING HAS TO SUPPRESS THE QUEUE, not just set a flag.** Setting `emailOptOut` alone
leaves every already-queued message, and the drain sends them: a person who unsubscribes at 09:00
and receives forty emails over the afternoon has not been unsubscribed, and the next thing they
do is mark the sending domain as spam, which is much worse for the school than a delayed message.
So the queued rows go to `SUPPRESSED` in the same transaction — a state that exists precisely so
that "held" and "suppressed" can be told apart when somebody asks why an email did not arrive.

**A DIGEST ACTUALLY DIGESTS — AND THE FIRST VERSION DID NOT.** `DIGEST_NOW` was treated as "send
this third one on its own", which is not a digest, it is three emails with a different shape. The
test written for it passed and the plan's requirement was unimplemented behind it. Now the
individuals already queued for that address and kind are SUPPRESSED and replaced by ONE digest
row. Its dedupe key is derived from the ids being absorbed, so a concurrent second run produces
the same key and dedupes instead of sending twice; a timestamp or a random key would make every
run unique and the dedupe would protect nothing.

**NOTHING IN `notify` SENDS AN EMAIL, and that is the enforcement.** There is no send import, no
HTTP client, and no call that can block, so "a slow email provider must never delay a page render
or an autosave" is a fact about the module graph rather than a promise in a comment. The only
function that talks to a provider is `drainOnce` in the worker, and `EmailTransport` is injected
with NO DEFAULT — a default transport would be a function that can send from a test, and a test
that can send is one `vi.mock` from sending in production.

**A THROWN TRANSPORT IS A FAILED MESSAGE, not a failed drain.** The first version had one `try`
around the whole batch, so a provider that threw on the third message marked nothing and returned
a report that looked like success — the queue silently stopped draining. Now each message is
settled on its own. A bounced address in one school is not a reason forty other students get
nothing. And the claim happens BEFORE the send so a crashed worker's `SENDING` rows can be
released; the alternative, sending first, sends twice after a crash, and two copies of "your
results are out" is worse than a late one.

**QUIET HOURS ARE FOUND BY ASKING `Intl`, NOT BY ADDING AN OFFSET — and the test is a DST one.**
"07:00 local" is a different instant either side of a clock change, so any offset table in the
code is wrong twice a year and quietly so. `endOfWindow` steps a minute at a time and asks
`Intl` the local time at each step: 600 steps for a ten-hour window, correct across the
transition because it never computes an offset. The test asserts a window that ENDS INSIDE the
transition resolves to `06:00Z` on 29 March 2026 and reports 9h30 rather than 10h — the lost hour
is inside the quiet window. Three real bugs came out of this: an unbounded recursion between
`quietWindow` and `endOfWindow` that hung the suite (fixed by splitting out a non-recursive
`isInsideWindow`), a `minutesRemaining` that used the evening formula on the morning leg and
reported 25 hours for a window that ends in one, and `Intl.DateTimeFormat` being reconstructed on
every one of 1,440 steps, which made a ten-second window cost seconds of CPU.

**A MISSING PREFERENCE ROW IS THE DEFAULT, not an error.** Rows are created lazily on first
write. A migration that inserted one per user would be a migration whose rows then drift from
the default the code actually applies, and the first read of every user would be a row nobody
chose.

**TWO TESTS FOUND BUGS IN THE TESTS, WHICH IS THE USUAL CASE.** The quiet-hours test used
`RESULTS_RELEASED` and failed, and the failure was CORRECT: §7 calls results "the single
most-wanted notification we send", so they are deliberately not held, and a test quietly
assuming every kind respects quiet hours would have deleted that decision. And the worker test
used `void notify(...)` without awaiting, so the drain correctly claimed nothing.

#### P4-T6 detail (complete)

**THE PLAN ASKED FOR DIALOGS AND THE CODEBASE BANS THEM, SO I READ WHAT IT WAS ACTUALLY FOR.**
`plans/12` §5: "Remove / change role: confirmation dialogs that name the person. A mis-click that
removes 30 students is a support incident and a trust breach." The codebase is the other way:
`ResourceLibrary` says a dialog "is a modal the teacher clicks through, and a number inside a
dialog is a number they did not read", and a test pins it by asserting `[role="dialog"]` is null.
Both are right about different things, and the requirement survives the reconciliation — because
§5's demand is to NAME THE PERSON and STATE THE COUNT, and a modal makes both *worse*, since it
arrives after the decision rather than before it. So: consequences on the row, always, with no
interaction; an inline disclosure in place that names every affected person; and for more than one
person, the COUNT must be TYPED. The typing is not ceremony — it is the one control that catches a
mis-click aimed at one person and dragged across twelve. A test asserts no dialog and no
alertdialog exist, so the reconciliation cannot quietly rot into the app's first modal.

**A DISCLOSURE THAT LISTS 30 NAMES IS ITS OWN FAILURE.** So it prints twelve and says "and 18
more". Printing all thirty is a wall the teacher skims, which is the exact problem the
confirmation existed to fix.

**AN UNRELEASED GRADE IS NEVER SELECTED, so there is nothing to leak.** "Grade (released only)"
has an obvious implementation: fetch it, then decline to display it. That is a display rule in the
client, and a future component, an export, or a `title` attribute undoes it. The read model
filters in the `where` on `assignment.releaseBatches.some({status: 'RELEASED'})`, so the
invariant is the query. The test releases a DRAFT batch first and asserts the grade is still
absent, because a `releasedAt IS NOT NULL` shortcut would pass the happy path and leak on the
half that matters.

**FOUR EMPTY STATES BECAME THREE, BECAUSE THE FOURTH WAS DEAD CODE.** A room always has at least
one ACTIVE member — the owner — so an `endedHidden` empty state could never fire. A union arm
nobody can reach is worse than no arm, because the next reader trusts the union is exhaustive. A
student who left is not an empty page either; they are a row the teacher cannot see. So it is
`endedCount` on the page, which the UI offers to reveal, and the test asserts the count.

**THE CURSOR IS APPLIED TO THE SORTED WINDOW, and the reason is a mutable sort key.** The sort is
`COALESCE(displayNameOverride, name)` — §6 says the override is the name the class uses, so
sorting on the account name alone is a list the teacher has to re-scan — and Prisma cannot order by
a COALESCE. Worse, any teacher can change a display name at any moment, and a keyset over a
mutable sort key cannot be made correct: moving a row across the cursor drops it from both pages
or duplicates it. So the window is fetched already-scoped, sorted, and the cursor drops the
prefix. Weaker than a true keyset, stronger than ignoring it, and the test asserts pages neither
overlap nor skip. A stale cursor pages FORWARD rather than restarting, because an ignored cursor
makes a teacher read page 2 twice.

**THE AUTHZ GATE CAUGHT MY OWN TEST, and it was right to.** Nine comparisons of the form
`row.userId === student` in the new integration test failed the ownership gate, whose message is
"Do not suppress". It is right: "is this row the person I think it is" is an authorisation
question, and writing it in a test teaches the shape of the mistake. So rows are found by
DISPLAY NAME, which the fixture already makes unique with a per-run token. The assertions got
shorter and stopped modelling the thing the gate exists to prevent.

**A MALFORMED CURSOR IS REFUSED, not ignored.** A cursor that cannot be parsed is a client bug or
a tamper, and returning page one for it is indistinguishable from a fresh session.

#### P4-T5 detail (complete)

**The CSV PARSER IS WRITTEN OUT, not installed.** `plans/00` §RN: "Dependencies are pinned
exactly in the lockfile and updated by a dedicated, reviewed task — **never as a drive-by**."
Adding `csv-parse` inside a roster feature is a drive-by, and it is a dependency for a problem
with a published specification, in a codebase that names "zero runtime dependencies" as a value
and cites a decade-old jQuery becoming a liability (`RN-07`) as the reason to care. It is safe to
write out because it is a pure function over a string and it is TESTED — the dangerous version of
this file is not "somebody hand-rolled a parser" but "somebody hand-rolled one and never checked
it against a quoted newline". Which is the case: `a quoted field containing a NEWLINE is ONE
field` is in the suite, and it is the case that breaks every line-oriented approach.

**The plan's own CSV rule CREATED A BUG, and the fix is a precise inverse.** §3 says prefix a
dangerous cell with `'` on BOTH import and export. Export alone is fine; doing it on import too
means a name we exported returns with a stray apostrophe, because the apostrophe has become DATA.
The roster test caught a pupil stored as `'=HYPERLINK(...)`, which is a different name.
`unescapeCsvCell` undoes it, and it is unambiguous because our escape is specifically `'` + a
FORMULA-START character: a pupil genuinely called `'Twas Nightingale` survives intact. The one
name it cannot distinguish is a pupil literally called `'=1`, and that cost is documented rather
than left to be discovered.

**A DRY RUN THAT CANNOT WRITE, structurally.** There is no `dryRun` parameter on the apply path,
so there is no way to call the writing function in a mode that pretends not to write. A boolean
meaning "do the dangerous thing but maybe not" is a boolean somebody will pass `true`. The test
asserts it by READING the roster, users, events and import rows afterwards, because asserting
the absence of a parameter is the weak version of the claim.

**A malformed row NEVER blocks the good ones**, which is the requirement that shapes the shapes:
60 rows with four broken ones in the middle, 60 applied, 4 in a downloadable CSV report with one
line per PROBLEM (not per row — a row with two problems needs two fixes, and cramming them into
one cell is how the second fix gets skipped). Failing the whole import on the first bad row is
what a spreadsheet does, and it is why school IT gives up on imports.

**The P4 EXIT CRITERION, tested verbatim: a 1,000-row import completes.** 5,000 ms → 396 ms, and
the route there is the more interesting part. The first version did three queries PER ROW, and the
timing assertion I wrote to catch an N+1 caught it. Then a comment I wrote said "a test that
asserts a completion time only tells you about the FIRST N+1 you removed" — and there was
another one left: 1,000 individual `membershipEvent` inserts, and then 1,000 individual
`enrollment` inserts. Batching the lookups, the events and the enrollments is what took it to
396 ms. The lesson is the comment: the second N+1 was only findable by holding the first fix in
mind while looking for the next.

**Two false failures worth remembering.** The first fixture CSV for the injection test was built
by interpolating a payload containing double quotes into a quoted field — which is not valid CSV,
so the parse failed and the test measured MY quoting rather than the product. Fixtures are now
built with the renderer, so a fixture cannot be malformed. And the fixed addresses in the roster
tests (`a1@school.example`) collided across runs in the shared database, turning every `new` into
`unchanged`; they now carry a per-run token, like every other fixture here.

**`INV-TIME-1` caught the timing assertion twice, and was right both times.** `Date.now()` can be
adjusted mid-measurement, and `performance.now()` is the same class of thing — the gate restricts
every direct reading of the host clock. The fix was not to find a different host API but to go
through the one wrapper the codebase sanctions: `systemClock.monotonic()`, which
`@orrery/clock` documents as being for exactly this ("`monotonic()`: use for measuring elapsed
time and durations; never for storing an instant").

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

### P5 — Assignments, pinning, question banks & blueprints · **IN PROGRESS** (56h est.)

| Task | Status | Commit | Note |
|---|---|---|---|
| P5-T1 `Assignment` with a pinned `resourceVersionId`, window, attempts, weight, late penalty, policy override | **DONE** | `598cfb2` | `packages/contracts/src/policy/` + `packages/db/src/assignments.ts`. The pin is STRUCTURAL: `resourceId` is derived from the version, and there is no parameter for "the current version". |
| P5-T2 `AssignmentStudentOverride` | **DONE** | *(next commit)* | `assignment-overrides.ts`. A mid-exam grant is an **additive row**, never a rewrite of `deadlineAt` (C14). |
| P5-T3 Assignment builder, preview as student | NOT STARTED | | |
| P5-T4 Student "to do" | NOT STARTED | | |
| P5-T5 Pinning invariant enforcement (a) lint rule, (b) slot-level mutation test | PARTIAL | | (a) the gate exists (`scripts/pinning-gate.mjs`, ADR-0025). (b) the weak mutation test is done; the **slot-level** byte-identity check is not. |
| P5-T6 QuestionBank CRUD | NOT STARTED | | |
| P5-T7 QuestionPool, four draw strategies, `poolHealth` | NOT STARTED | | |
| P5-T8 Blueprint + worst-case coverage | NOT STARTED | | |
| P5-T9 `AssessmentSpec` slots + `variantMap` resolution | **DONE** | *(next commit)* | `packages/db/src/slots.ts`. One draw, one place, per-slot forked streams. | |
| P5-T10 Publish snapshots every drawable question | NOT STARTED | | |
| P5-T11 "Too similar" guard | NOT STARTED | | |
| P5-T13 Interop skeleton, `ExternalBinding` | NOT STARTED | | |
| P5-T14 `can()` matrix for the new P5 types | **DONE** | *(next commit)* | Three types added with full rules. **The tests found a bank readable by its own students.** |
| P5-T15 Author the seed banks | NOT STARTED | | D-37: nothing in 183 tasks authored a single question. |
| P5-T12 Publish gates: pool, blueprint, metadata, `INV-SLOT-1` | NOT STARTED | | |

#### P5-T1 detail (complete)

**THE PLAN'S OWN EXAM DEFAULTS CANNOT SURVIVE A ROUND TRIP THROUGH THE DATABASE.**
`plans/09` §4.1 specifies `thresholds: { …, pointerLockLosses: Infinity, … }`, and the reasoning
is sound and documented (Escape releases pointer lock and browsers deliberately prevent
interception, so counting it penalises a documented browser behaviour). But `ExamAttempt.
policySnapshot` is a Prisma `Json` column and `JSON.stringify(Infinity)` is `null`. That policy
would store as "no threshold", read back as undefined — and an undefined threshold is a threshold
of **zero**, which terminates every student who presses Escape. So "never" is a first-class
value in the serialised form, `null` on the wire, mapped back to `Infinity` internally. One place
decides the difference between `0` and "never", instead of every comparison remembering it.

**`Object.freeze` IS SHALLOW, AND INV-POLICY-1 IS ABOUT A SNAPSHOT THAT CANNOT CHANGE.** The first
version froze once, and a test caught `policy.thresholds.fullscreenExits = 0` going straight
through — a frozen shell around a mutable object. `freezePolicy` freezes `thresholds` and
`escalation` as well.

**MY `narrowest` IMPLEMENTED THE WIDEST, AND A TEST CAUGHT IT IMMEDIATELY.** It took the earliest
start and the latest end, which is the union of every window anyone states. So a student given a
personal window was handed back the longest one of the lot — narrowing is the entire point of a
per-student override, and the buggy version quietly undid it while looking completely correct.
It also compares by INSTANT, because a version policy may carry `+01:00` and an override `Z`, and
`09:00+01:00` is earlier than `08:00Z` while sorting later as a string.

**C13's `extraTimePercent` TAKES THE LARGER, AND THE DIRECTION MATTERS MORE THAN THE RULE.** A
teacher granting 25% and an accommodation saying 50% do not disagree, they stack, and the smaller
would silently under-grant a child time the law and the plan both promise. And an **untimed** exam
plus extra time stays untimed: there is no limit to extend, and inventing one would turn an
untimed assignment into a timed one *because* a student disclosed a right.

**`INV-TIME-1` CAUGHT `Date.now()` INSIDE WHAT WAS SUPPOSED TO BE A PURE FOLD, AND IT WAS RIGHT
FOR A REASON BEYOND THE RULE.** A function that reads the host clock is not pure, so an
accommodation expiring at 16:00 was evaluated against the server's wall clock rather than the one
the caller believes in, and a test could only reach the branch by changing the machine's clock.
`now` is an input now. And with no `now` supplied, an accommodation carrying an expiry is treated
as **ACTIVE**: defaulting to "denied" would mean a caller who forgot the parameter silently
stripped a child's extra time.

**THE PIN IS STRUCTURAL, NOT A CHECK.** `createAssignment` takes `resourceVersionId` and DERIVES
`resourceId` from it, because accepting both would let a caller pair version 3 of one resource
with version 1 of another — and every later read would join two ids that were never related.
There is no parameter through which "the current version" could arrive instead, so a caller that
forgets the version cannot call the function.

**A DRAFT PINS, AND PUBLISHING IS THE ACT OF SHOWING THE PIN.** Pinning at publish is one refactor
too many changes: a teacher edits the questions, a colleague publishes, and the colleague
published something the teacher never saw. `publishAssignment` RETURNS the pinned version so the
authoring surface can say "you are about to publish version 4" and a teacher can stop. Publishing
twice returns an answer rather than a 409 — a teacher double-clicking Publish must not get a
conflict that reads like a problem with their exam.

**THE PINNING TEST IS IN ITS STRONG FORM.** The weak version — "the assignment still points at
the old version id" — passes for an implementation that renders from the resource HEAD and merely
records the pin. So the test resolves the assessment SURFACE, publishes a new version, moves the
head onto it, and compares the resolved surface before and after. `P5-T5` adds the slot-level
version of this.

**WITHDRAWAL HAS NO ATTEMPT PARAMETER, AND THAT IS THE MECHANISM.** `INV-ASSIGN-2`: in-flight
attempts run to their own deadline and remain submittable. There is no way to call the function in
a mode that also cancels somebody's exam. A withdrawn assignment also cannot be re-published,
because a withdrawal is a statement to students and silently undoing it is worse than doing
nothing.

#### P5-T9 detail (complete)

**ONE STREAM PER SLOT, AND THE TEST PROVES WHY BY ADDING A SLOT.** A single RNG for the whole
exam makes each draw depend on every draw before it, so inserting a slot at position 1 shifts
every draw after it. That is how "fix a typo in question 3" becomes "rewrite the exam for three
hundred students", and the pinned version stops being pinned in any sense a student would
recognise. `rng.fork('slot:N')` gives each slot a stream derived from the attempt seed and the
slot's own position, so slot 4 draws the same four questions whether or not slot 3 exists. The
test runs 25 seeds, adds a slot, and asserts **zero** movements.

**A DRAW COUNT LARGER THAN THE POOL IS REFUSED, NOT CLAMPED.** Clamping produces a paper with
fewer questions than the blueprint promised, and a blueprint that silently under-delivers is worse
than one that refuses to publish. The same reasoning refuses a quota the pool cannot supply.

**A ZERO WEIGHT IS CLAMPED TO 1, NOT DROPPED, AND THE TEST SAYS WHY.** A question authored and
weighted to nothing is far more likely a mistake than an intent, and dropping it makes the item
unreachable for a reason nobody wrote down. The assertion is about the SHAPE of the distribution
over 200 seeds — the heavier item is drawn more often, and all three are reachable — because that
is the only claim a seed sweep can honestly make.

**`sameVariantMap` IS A FUNCTION BECAUSE A STRINGIFY COMPARISON IS WRONG HERE.** A fresh resolve
and a parsed snapshot differ in key ORDER, so `JSON.stringify(a) === JSON.stringify(b)` reports
two identical papers as different — and a real equality check that is always false gets deleted
rather than fixed.

**THE RESOLUTION ORDER IS BY POSITION, NOT BY ROW ORDER.** Slots come from a database and their
row order is not guaranteed, so a draw depending on it would give two identical assessments two
different exams. The test resolves the same slots forwards and reversed and compares.

**AN EMPTY ASSESSMENT IS NOT AN ERROR; AN EMPTY POOL IS.** Zero slots is a legitimate draft with
no questions in it yet, and refusing to save one would stop an author writing a blueprint. A pool
with no items is a pool that cannot be drawn from. Treating them alike would trade a real
inconvenience for a fake safety.

**THE SEED IS AN OPAQUE TYPE SO IT CANNOT BE STORED BY ACCIDENT.** INV-BANK-2 says the map is
stored and the seed is not, because the seed is the recipe for every paper in the cohort's scheme.
A `string` would survive a `JSON.stringify` and a log line; an opaque brand makes "somebody stored
the seed" a type error at the point of storage rather than a review note six months later.

#### P5-T9 evidence
- 1074 unit (15 new slot tests). 8/8 gates, lint 0, typecheck 0, image builds.

#### P5-T14 detail (complete)

**`QuestionBank`, `QuestionPool` and `Blueprint` HAD NO RULES, and P4-T8 had just found the same
class of bug.** `types.ts` names this task as the one that appends to `IMPLEMENTED_TYPES`, so it
is not a discovery — it is the second occurrence of a shape that a phase packet predicted and
nobody had written down as a checklist item. Both types and rules are here now, and the totality
test still runs before and after.

**THE TEST FOUND A QUESTION BANK READABLE BY THE STUDENTS OF THE CLASS IT WAS SHARED WITH.** The
grant was "a classroom the actor is in", and a student IS in the class. So a bank shared with
Year 9 so its teachers could build an exam was readable by Year 9 — who are, by definition, the
people about to sit it. A leaked question is a leaked EXAM, because a question is reusable, and
this is the single worst bug the phase could have shipped. The test that caught it asked "can a
STUDENT read a shared bank"; the test that did not catch it asked "can a teacher in another class
read it", and passed.

The rule now requires classroom STAFF, not membership. And the same requirement was applied to
`QuestionPool.read`, whose items ARE questions — a pool readable without its bank readable would
be a back door around the bank rule.

**A BANK IS NOT INSIDE A CLASSROOM, SO `classroomScoped` WAS THE WRONG HELPER.** `update` used
it, which claims a `sameClassroom` obligation that no correct caller can satisfy for an object with
no classroom — so the owner could not edit their own bank. This is the third instance of the
unsatisfiable-obligation family in this file, after `Classroom.create` and the classroom
`owningClassroomId`. The pattern is now worth naming: **a rule that claims a relationship the
subject does not have is a wall, not a check.**

**`ALL_RESOURCE_TYPES` HAD FOUR DUPLICATED ENTRIES, AND NOTHING FAILED.** My P4-T8 edit used a
replace that matched both `ALL_RESOURCE_TYPES` and `IMPLEMENTED_TYPES` and put a second copy of
`Assignment`, `ExamAttempt`, `IntegrityEvidence` and `ReleaseBatch` into the former. A duplicated
entry in a union of string literals collapses to the same type, so TypeScript was satisfied, every
behavioural test passed, and the only symptom was a list that had grown by four without anybody
adding a type. It is visible only by COUNTING, which is why `ALL_RESOURCE_TYPES has no
duplicates` is now a test — a defect invisible to every other kind of check is the definition of
the kind worth writing one for.

**THE TOTALITY TEST'S OWN PLANTED TYPE STOPPED BEING A VALID EXAMPLE, AND THAT WAS THE RIGHT
OUTCOME.** It plants a type with no rules to prove the check fires. `QuestionBank` was the
example, and P5-T14 made it a real one, so the test failed. A test whose subject is "a hole" going
stale because the hole was filled is the best outcome it can have; the planted type is now
`Question`, which P5-T6 will retire the same way.

#### P5-T14 evidence
- 436 auth unit (22 new). 8/8 gates, lint 0, typecheck 0, image builds.

#### P5-T2 detail (complete)

**C14'S SYMPTOM WAS IN A DIFFERENT SYSTEM THAN ITS CAUSE, WHICH IS WHY IT SURVIVED REVIEW.**
Rewriting `ExamAttempt.deadlineAt` for extra time broke `INV-POLICY-1` in a way nobody saw in the
exam system: `verify-receipt` began reporting DIVERGENCE on a legitimate action, and a teacher
receiving that message has no way to guess a fair accommodation caused it. So `deadlineAt` is
written once at first start and never again, and the test asserts on THE COLUMN rather than on
the arithmetic — because a rewrite and an addition produce the same effective deadline for one
extension, and only the column tells them apart.

`effectiveDeadlineAt = deadlineAt + Σ addedSec + pausedAccumSec` is one exported function taking
the extension rows as an argument, so the sweep, the exam header and the receipt verifier read
the same arithmetic instead of each having its own idea.

**THE GRACE PERIOD IS NOT PART OF THE DEADLINE A STUDENT IS TOLD.** It is a tolerance the SWEEP
applies when deciding to auto-submit. `plans/09` says the sweep runs at `deadlineAt + grace +
30s`. A student told "you have until 11:00" should be able to submit at 11:00:59, and baking the
grace into the displayed deadline would hand them 60 seconds the exam never agreed to give.

**A REASON IS ENFORCED IN THE SERVICE, NOT ONLY BY THE COLUMN.** The column is `NOT NULL`, which
stops an empty string and nothing else. A 5-character reason is a reason nobody can use in a
conversation with a parent six months later, so the minimum is 10 characters on both the override
and the extension. And a refusal leaves NO row behind: a refusal that still wrote a row would be
worse than no refusal, because the row looks like the grant somebody asked for.

**AN OVERRIDE IS A SETTING, NOT A RECORD, SO REVOKING DELETES IT.** The audit of *why* the
accommodation existed lives in the reason text and in the attempt events; keeping a revoked row
around with a flag would make every read have to filter, and a filter somebody forgets is a
child with extra time nobody can explain.

**A DECIMAL IS MAPPED TO A STRING ON THE WAY OUT, DELIBERATELY.** Prisma's `Decimal` serialises
through `toJSON` as a string, so a caller typing the field as `number` gets no type error,
`undefined` at the boundary and `NaN` in the first arithmetic expression it meets. A string the
UI can format is the honest answer, and the test asserts the runtime type rather than trusting
the annotation.

**THE TEST THAT CHECKS THE OVERRIDE DOES NOT LEAK.** One student with 50% extra time is the case
everybody writes; the more likely bug is the merge reaching the class policy, so the same test
resolves the policy twice — once for the student, once for nobody — and asserts the second is
untouched.

#### P5-T2 evidence
- 282 db integration (14 new). 8/8 gates, lint 0, typecheck 0, image builds.

#### P5-T1 evidence
- 327 contracts unit (16 new for the policy), 268 db integration (10 new).
- 8/8 gates, lint 0, typecheck 0, image builds.

### P6 … P17 — **NOT STARTED**

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
pnpm run test           # 1074 unit
pnpm run test:integration   # 282 db + 6 worker, needs DATABASE_URL
cd apps/web && pnpm run build   # produces app-build-manifest.json for the bundle gate
```

Integration tests need `DATABASE_URL=postgresql://orrery:orrery@localhost:55432/orrery`. The
database is **shared across runs with no cleanup**, so every test uses a per-run UUID-derived
slug or token; and a test count that has not moved is not evidence.
