# Dependencies and the exception process

**P14-T5.** The audit half of this task. The process half is §6, and it is the part that has to survive the
next person who finds something inconvenient.

---

## 1. Read this first: the inventory is complete and the vulnerability status is unknown

Two claims, and they must not be run together.

- **Complete:** every direct dependency of all 16 workspace packages, and the full shape of
  `pnpm-lock.yaml` — 527 package entries, 450 distinct names, 69 of them at more than one version. Read from
  the manifests and the lockfile, not estimated.
- **Unknown:** **the advisory status of every one of those 527 entries.** `osv-scanner` is not installed in
  the environment this audit was run in, and installing it was out of scope. `pnpm audit:deps`
  (`package.json:18`) is the wired-up command, and it is wired to a CI job that **cannot reach it** — see
  `THREAT-MODEL.md` TM-14, where the `policy` job fails at its second step.

So: **no dependency in this repository has a known-clean vulnerability scan, and this document does not claim
otherwise.** The findings below are structural — duplicated versions, undeclared packages with build-script
permission, and installer settings that weaken the pinning ADR — and none of them required an advisory
database to identify. `plans/14` §10's *"Dependency scan clean; exceptions documented with expiry"* is **not
met**, and cannot be honestly ticked until a scanner has actually run. That is the exit criterion for P14-T5.

---

## 2. Direct dependencies, as declared and as resolved

Declared ranges come from each `package.json`; resolved versions come from `pnpm-lock.yaml`. Where they
differ from each other in a security-relevant way, §4 says so.

### 2.1 Runtime — the attack surface

| Package | Declared at | Resolved | Notes |
|---|---|---|---|
| `better-auth` | root | `1.7.6` | Credential storage, session cookie, magic links. **Configured but never mounted** — `THREAT-MODEL.md` TM-01. |
| `@node-rs/argon2` | root `2.2.1` · `packages/auth` **`2.0.2`** · `packages/db` dev `2.0.2` + peer `^2` | **two versions** | The password primitive. See §4.1. |
| `katex` | root `0.18.9` · `packages/contracts` **`0.16.22`** | **two versions** | Maths rendering — the XSS surface named at `plans/14` §4:40. See §4.2. |
| `zod` | root `4.4.3` · `packages/contracts` `4.4.3` · peer `^4` | `4.4.3` direct, **`4.6.5`** via `better-call` | Every inbound schema is a Zod `strictObject`, so this validates essentially all input. See §4.3. |
| `next` | `apps/web` | `15.5.25` | Serves every route; owns the middleware that emits the CSP. |
| `react` / `react-dom` | `apps/web` | `19.2.0` | |
| `@prisma/client` | `packages/db` | `6.19.3` | ORM; the only database path. |

### 2.2 Workspace-internal

`@orrery/*` at `workspace:*`, resolved to `link:` in the lockfile. **No internal package is published, and
no internal package has an external dependency outside the list above** — `clock`, `ids` and `rng` have no
dependencies at all. That is worth stating as a property: the modules that decide time, identity generation
and seeded randomness have nothing to compromise.

### 2.3 Build, test and development

| Package | Declared | Resolved | Reaches production? |
|---|---|---|---|
| `typescript` | root `^5.9.0` | `5.9.3` | No — build-time |
| `vitest` | root `^3.0.0` + per-package `3.2.7` | `3.2.7` | No |
| `@vitest/coverage-v8` | `3.2.7` | `3.2.7` | No |
| `playwright` / `@playwright/test` | `1.56.1` | `1.56.1` | No — but it drives `scripts/sim-sandbox-escape.mjs`, a release gate |
| `prisma` (CLI) | root `^6` | `6.19.3` | No |
| `@biomejs/biome` | root `^2.0.0` | `2.5.14` | No |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | root | `9.39.5`, `8.67.0`, `17.11.0` | No |
| `jsdom` | root `30.1.1`, `packages/contracts` `26.1.0` | two versions | No |
| `jest-axe` | root `11.0.0`, `packages/contracts` `10.0.0` | two versions | No |
| `fast-check` | `3.23.2` in 4 packages | `3.23.2` | No |
| `esbuild` | `0.28.2` | `0.28.2` | No — build-time bundler |
| `@testing-library/*`, `@types/*` | various | — | No |

### 2.4 Packages granted install-script permission

`package.json:74-81` allows install scripts for six packages: `@prisma/client`, `@prisma/engines`, `prisma`,
**`sharp`**, `esbuild`, `unrs-resolver`. Three are declared as a dependency or devDependency in this
repository (`@prisma/client` in two places, plus `prisma` and `esbuild`). **The other three are not declared
anywhere**, and their actual status differs in a way worth stating precisely:

| Allowlist entry | Declared in a manifest? | In `pnpm-lock.yaml`? | Why |
|---|---|---|---|
| `sharp` | no | **yes** — `0.34.5`, an *optional* dependency of `next@15.5.25` | Installed, native binaries, **imported by nothing we wrote** |
| `@prisma/engines` | no | yes — `6.19.3`, pulled in by `prisma` | Installed, downloads query-engine binaries |
| `unrs-resolver` | no | **no — zero occurrences in the lockfile** | **A vestigial entry: not installed at all** |

---

## 3. Lockfile shape

`pnpm-lock.yaml` is `lockfileVersion: '9.0'` with `autoInstallPeers: true` recorded at `:3-4`.

**450 distinct package names across 527 resolved entries, and 69 names resolve to more than one version.**
That ratio — about 15% duplication — is normal for a tree with two jsdom generations and a framework that
peers on the test runner, and on its own it is not a finding. It becomes a finding when a duplicated package
is one a security argument rests on. Two are: argon2 (§4.1) and KaTeX (§4.2).

The 16 `@node-rs/argon2-*` platform binaries are duplicated along with the package itself, because
`@node-rs/argon2` ships one binary per platform and two versions means **two sets of native binaries built
from two source revisions**. A native binary is the least inspectable thing in the tree.

---

## 4. Security-relevant duplication

### 4.1 `@node-rs/argon2` — the password primitive is pinned twice, and the older pin is the live one

| Workspace | Lockfile evidence | Version |
|---|---|---|
| root (`orrery`) | `pnpm-lock.yaml:11-13` | `2.2.1` |
| `packages/auth` | `pnpm-lock.yaml:173-176` | **`2.0.2`** |
| `packages/db` (devDependency) | `pnpm-lock.yaml:243-245` | `2.0.2`, plus a `peerDependencies` entry of `^2` |

`packages/auth/src/password.ts:29` is the only place in the repository that imports it, and that workspace
resolves **2.0.2**. `packages/db` declares the dependency and never imports it.

**Why this is a finding and not tidiness.** Argon2id is the reason `plans/14` §2 can say Argon2id at all, and
"we patch the hasher" is not one fact in this repository — it is two, and the one that hashes passwords is the
older. A security fix released in 2.2.x reaches a root manifest that nothing imports and **not** the module
that runs on every sign-in. `packages/db`'s `^2` peer range makes the situation worse rather than better: it
permits either, so it cannot be used to reason about which one is deployed.

**Fix.** Converge on one version — 2.2.1 — and delete `packages/db`'s unused declaration, including the peer
range. One line in each manifest, and then "the hasher is at 2.2.1" becomes true rather than approximately
true.

### 4.2 `katex` — two versions, and it is the maths-rendering surface

Root resolves `0.18.9`; `packages/contracts` resolves **`0.16.22`**. `plans/14` §4:40 names KaTeX explicitly as
an XSS vector and specifies `trust: false` and `strict: 'error'` — the mitigations, not the version. The
mitigations are configured and correct (`packages/contracts/src/render/index.ts:35-38`, asserted by
`packages/contracts/src/render/render.test.ts:17,27-47`), so **"KaTeX is patched" is nonetheless a per-workspace
statement**, and a reader who checks it will check one of them.

**Which version is live is no longer an inference.** `packages/contracts/src/render/index.ts:27` is the only
`import katex` in the repository, so the maths renderer runs on **`0.16.22`** — the older of the two. Root's
`0.18.9` is declared and not imported by anything we wrote.

**Fix.** Move `packages/contracts` to `0.18.9` (or root to whatever `packages/contracts` should track), then
delete the unused root declaration. The test that asserts the *options* is the thing to keep: a version bump
that silently changed `trust` or `strict` would be caught by it and by nothing else.

### 4.3 `zod` — two versions, one of them transitive

`4.4.3` is declared (root and `packages/contracts`, both exact) and `4.6.5` is pulled in by `better-call@1.4.0`
via `better-auth`. The risk here is much lower than §4.1: both are the same major, and Zod's job is *rejecting*
malformed input rather than defending a boundary itself. It is recorded because it is another place where
"the version" is not a single value, and because an upgrade to Zod will need to account for the transitive
copy rather than only the declared one.

---

## 5. `sharp` — a package this repository grants build-script permission to and does not depend on

`package.json:78` lists `sharp` in `pnpm.onlyBuiltDependencies`, which is pnpm's mechanism for **permitting a
package's install scripts to execute**. `sharp` is:

- **declared in no `package.json`** in this repository (the only occurrence of the name outside the lockfile is
  the allowlist entry itself),
- **imported by no source file** — `grep -rn "from 'sharp'"` across `packages` and `apps` returns nothing,
- **present in the lockfile as an optional dependency of `next@15.5.25`** (`pnpm-lock.yaml:4597`), resolved to
  `0.34.5`.

Next.js ships image optimisation through an optional `sharp` dependency. It is legitimate, it is not a red
flag in itself, and it is not a supply-chain attack. **It is a finding about the allowlist, not about sharp** —
and it generalises. Two of the six entries are packages that arrived transitively and that nobody in this
repository chose, and the third (`unrs-resolver`) is in the allowlist while being **absent from the lockfile
entirely**, so it grants nothing and documents a dependency nobody can find.

> **The build-script allowlist is not an inventory of what this project depends on. It is a list of things
> somebody thought might need a build step: two of them arrived transitively and one of them is not installed
> at all.**

An allowlist that grants native-code compilation to packages nobody chose is an allowlist whose contents
nobody has reviewed — and native code executes during install, **before any application code has had a chance
to run**, which is the entire reason install scripts are gated at all. `sharp` ships prebuilt native binaries;
`@prisma/engines` downloads query-engine binaries at install.

**Three consequences.** First, audit `sharp`: if image re-encoding is wanted (and see `THREAT-MODEL.md` TM-12 —
the EXIF stripper is implemented and never called, so an image pipeline is genuinely missing), then **declare**
it, and the allowlist entry becomes a decision rather than an inheritance. If it is not wanted, drop it from
`onlyBuiltDependencies` and pin Next's image optimiser off explicitly. Second, **delete `unrs-resolver`** —
an allowlist entry for an uninstalled package is worse than no entry, because a reader concludes a dependency
exists. Third, **write down why `@prisma/engines` needs to execute code**, because "we needed it once" is not
a review anyone has performed on this list.

### 5.1 Installer settings that weaken ADR-0008

`ADR-0008` is stated at `.npmrc:4` as *"exact pinning via the lockfile. No `^` ranges in package.json for
runtime deps"*, and `.npmrc:1,5` set `engine-strict=true` and `save-exact=true`. That much holds: **every
runtime dependency in §2.1 is pinned to an exact version.** `^` ranges appear only in `devDependencies`.

Two settings pull the other way:

| Setting | Effect |
|---|---|
| `auto-install-peers=true` (`.npmrc:3`, recorded in the lockfile at `pnpm-lock.yaml:4`) | A package can enter the lockfile because a dependency asked for it as a peer, **without any manifest declaring it.** The dependency inventory of §2 is then not the whole inventory. |
| `strict-peer-dependencies=false` (`.npmrc:2`) | A peer mismatch is not an install-time failure. A dependency requiring a version we do not have resolves anyway, quietly. |

`engine-strict=false` (`.npmrc:36`) is **deliberate and documented at `.npmrc:26-35`** — a transitive package's
`engines` field turning a patch-level Node bump into a total install failure — and **is not a finding.**

---

## 6. The exception process

**An exception is a record of a decision, not a silence.** The failure mode this is written against is the one
`plans/14` §8:130 already gestures at — a scanner that is configured to fail and an exception that nobody
re-reads, so the policy is real for the first week and decorative after that.

### 6.1 What may be excepted, and what may not

| May be excepted | May **never** be excepted |
|---|---|
| A high or critical advisory with **no** fixed release available | An advisory with a fix, where "we cannot deploy yet" is the whole reason |
| A moderate advisory, with a plan and a date | Any advisory in a package that **decides a student's grade** — see below |
| A moderate advisory in a **dev-only** dependency, where the argument is about build-time exposure | A **known-exploitable** advisory in anything shipped to a browser or a server |
| An advisory whose reachability we can demonstrate in this repository | An advisory where the only evidence of reachability is that we have not looked |

**The hard line, and why it is hard:** a dependency on the grading, deadline or release path
(`@orrery/grading`, `@orrery/exam-engine`, `@orrery/db`, `@orrery/auth`, `@orrery/clock`, `@orrery/rng`) may not
carry an unfixed advisory at all. **The argument is not that these packages are the most exposed — it is that
they decide a student's mark, and an institution cannot be told a grade was computed correctly by a component
with a known defect.** Those six are listed because `plans/00` §6.3 already treats them as money packages and
the 100%-branch coverage floor exists for the same reason.

### 6.2 Who approves

- **High or critical on a grading-path dependency:** not exceptable. Fix it, or stop shipping the feature that
  uses it. This is a refusal, not an escalation.
- **High or critical elsewhere:** the phase owner for the affected phase, plus one reviewer who did not write
  the exception. **Two people, because one person approving their own exception is the shape of thing that is
  never revisited.**
- **Moderate:** the phase owner alone, with the compensating control recorded.

### 6.3 What an exception must contain

Six fields. **An entry missing any of them is not an exception; it is a note.**

| Field | Rule |
|---|---|
| **Advisory id** | The `GHSA-`/`OSV-`/`CVE-` identifier. "A scan flagged something" is not an identifier. |
| **Package and version** | Both the declared range and the **resolved** version, because §4 shows they can differ. |
| **Severity, and its source** | Which database, and on what date. Severity ratings move. |
| **Reachability** | **What in this repository reaches it, cited by `file:line`, or an honest "not traced".** "Probably not reachable" with no trace is not reachability analysis. |
| **Compensating control** | **A concrete mechanism, and where it lives.** §6.4. |
| **Expiry** | A date. Not a duration that starts when someone remembers. |

### 6.4 Compensating controls that are actually compensating

A control that reduces the *consequence* of the advisory. Each of these is a mechanism that exists or can be
written, not a sentiment:

| Advisory is in | Acceptable compensating control | Not acceptable |
|---|---|---|
| A rendering library (KaTeX) | Rendering is server-side from authored content with `trust: false` and `strict: 'error'`; no user-supplied macros; output is never `eval`'d | "Users are unlikely to paste LaTeX" |
| A dependency reachable only from the build | It never enters the published artifact; assert this by listing the production bundle's dependencies, not by asserting it in prose | "It's only a dev dependency" |
| An advisory in a transitive package we do not call directly | Name the direct package that pulls it in, and pin the direct package to a version that does not | "It's transitive" |
| Something with no fix | **A removal or a mitigation that changes the attack surface** — disabling the feature, or rejecting the input at a named boundary — plus a review date | "No fix is available yet" |

### 6.5 Lifetime and expiry

- **Default: 30 days.** The default is short because most exceptions are waiting for a patch, and a patch
  usually lands in days.
- **Maximum: 90 days, with a written justification naming the person who will chase it.**
- **High/critical: 14 days**, and the exception is reviewed at every expiry whether or not it has been
  resolved.
- **At expiry the build fails** until the exception is renewed, the dependency is upgraded, or the feature is
  removed. A renewal is a **new** entry with a new date and a new justification — never an edit of the old
  one. An exception that can be extended by editing it is an exception with no expiry.
- **A dependency that reaches a grading-path package stops being exceptable at the first expiry**, whatever
  the paperwork says.

### 6.6 Where exceptions live

**Not yet.** There is no `docs/`-adjacent exception register and no directory for one. Until it exists, the
register is §7 of this document, which contains the entry **"none currently granted"** rather than an example
invented to show the format works. **A register whose first entry is a fictional exception teaches its readers
that entries here can be invented.**

---

## 7. Exceptions currently granted

**None.**

That is the accurate answer, and it is not an evasion. No `osv-scanner` run has produced advisories for this
repository, so **no exception has ever been requested** — there is nothing to except. §1 says the same thing
from the other side: the vulnerability status of all 527 entries is unknown.

**When the first real exception arrives, its compensating control must be a mechanism with a `file:line`, not
a sentence.** If it cannot be written down that way, the honest resolution is to fix the dependency.

---

## 8. What must happen before P14-T5's exit criterion is met

In dependency order, because the first three change what the rest can even mean:

1. **Move KaTeX on one version** (§4.2) — `packages/contracts` to `0.18.9`, then delete the unused root
   declaration. The live renderer is the older version today.
2. **Converge `@node-rs/argon2` on one version** and delete `packages/db`'s unused declaration (§4.1). This is
   the only finding here with a **user impact** attached: today, a fix to the hasher does not reach the hasher.
3. **Triage the install-script allowlist** (§5) — declare `sharp` or remove it and pin Next's optimiser off;
   delete `unrs-resolver`, which grants nothing; record why `@prisma/engines` needs to execute code.
4. **Reconsider `auto-install-peers`** (§5.1). If the answer is to keep it, §2's inventory should say so
   explicitly, because a peer-installed package is a dependency nobody reviewed.
5. **Repair the CI `policy` job** (`THREAT-MODEL.md` TM-14, proposed task **P14-T15**) so `pnpm audit:deps`
   executes at all. **Until it does, every other item in this list is unverifiable in CI.**
6. **Run the scanner**, once, on a clean checkout, and record the output and the date. A scan nobody has run
   is indistinguishable from a scan that found nothing — which is the exact defect this repository has already
   hit three times (`D-31`, `D-35`, and the bundle gate that never measured a build, per
   `apps/web/src/middleware.ts:19-21`).
7. **Then** write the first real exception register, if step 6 produces an exception.

**What would make `plans/14` §10's *"Dependency scan clean; exceptions documented with expiry"* honest:** step 6
passing, and §7 saying "none currently granted" as a **conclusion with a date on it** rather than as an absence
of evidence.

---

## 9. What this audit did not do

1. **No advisory database was consulted.** 527 entries, 0 status lookups. §1.
2. **No install, no build, no lockfile regeneration.** Everything here is read from `pnpm-lock.yaml` as
   committed. A tree with `pnpm-lock.yaml` and a tree after a fresh `pnpm install` could differ if a manifest
   is out of step with the lockfile; I did not run `pnpm install --frozen-lockfile` to prove they agree.
3. **Transitive reachability was not traced for any advisory**, because there are no advisories to trace (§7).
   §5's `sharp` finding is the one reachability claim made here, and it was established by import grep, not by
   dependency analysis.
4. **Licence compatibility was not assessed.** `plans/05` and `P3-T3` cover provenance; this document is about
   version and advisory risk, and a licence question answered here would be answered by someone who had not
   looked.
5. **The `pnpm-workspace.yaml` and `.npmrc` interaction was not exercised**, and the Docker build was not run,
   so "what a production image actually contains" is inferred from the manifests rather than observed. Given
   §5, that inference deserves to be replaced with an observation at some point.