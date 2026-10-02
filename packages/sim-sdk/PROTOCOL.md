# `sim-host@1` — the host protocol

**Status:** normative. **Source of truth:** `src/protocol.ts` — where the frames, the error codes,
the handshake decision and every timeout constant are declared. This document explains them; it does
not define them. A disagreement between the two is a bug in one of them, and the tests are on the
TypeScript.

`plans/10` §2 is the design input. Everything here is either that document's content made
checkable, or a decision it left open.

---

## 1. Transport and trust

A sim runs in `<iframe sandbox="allow-scripts">`, served from a dedicated static origin
(`sims.<domain>`).

- **Exactly one sandbox token.** `allow-scripts` and nothing else. No `allow-same-origin`, so the
  frame is a unique opaque origin and cannot read the app's DOM, cookies, `localStorage` or
  `IndexedDB`, and cannot `fetch()` our endpoints with our credentials. No `allow-forms`,
  `allow-popups`, `allow-top-navigation`, `allow-modals`, `allow-downloads`, `allow-pointer-lock`.
- **`allow-downloads` is refused on purpose.** A sim that can write a file can exfiltrate a
  student's work through the download shelf, and no CSP directive prevents that.
- **`srcdoc` is never used.** An inline frame is reachable in ways a URL frame is not, and it makes
  the bundle unhashable.
- **Communication is `postMessage`.** Because the frame is cross-origin, `'*'` is the only workable
  target origin, so `event.origin` proves nothing about who is talking.

### 1.1 The nonce is the only authentication

The host generates a per-mount nonce, puts it in `sim:init`, and requires it on **every inbound
frame** together with `event.source` identity. Both checks, always:

- the nonce proves the frame is answering *this* mount;
- `event.source` proves it came from *that* frame.

`isAuthenticated` checks `event.source` **before** it looks at the payload. A frame with the wrong
nonce has not been authenticated, so parsing its contents is reasoning about attacker input — and an
expensive parse before a cheap comparison is how a page gets slow from somebody else's traffic.

### 1.2 A sim is never trusted, including about its own grade

`sim:gradePreview` is decorative and teacher-facing. The frame carries a `surface` field, and it is
**not** evidence: `assertAllowedOn(frame, hostSurface)` decides, and the host passes the surface it is
actually rendering. A sim may lie in the field; the frame is untrusted code.

Server-side grading is the authority in all cases. `grader(state)` is re-run in Node, in an isolated
worker thread, against stored state.

---

## 2. Frames

### Host → sim

| Frame | Payload | When |
|---|---|---|
| `sim:init` | `{ protocol, nonce, simId, simVersion, params, seed, mode, initialState?, grading? }` | once, on mount |
| `sim:setParams` | `{ params, seed? }` | host-driven parameter change (author preview, "new numbers") |
| `sim:command` | `{ name, args }` | `reset`, `play`, `pause`, `step`, `loadScenario`, `focus`, `setTheme` |
| `sim:requestState` | `{ reason }` | `save` \| `submit` \| `blur` \| `unload` \| `replay` \| `resize` |
| `sim:visibility` | `{ visible }` | tab shown/hidden, so rAF loops pause |
| `sim:teardown` | `{}` | unmount |

`sim:requestState.reason` is a closed set because "why did we save at that moment" is a support
question, and an open string makes it unanswerable.

### Sim → host

| Frame | Payload | When |
|---|---|---|
| `sim:ready` | `{ protocol, nonce, simId, simVersion, capabilities, exports }` | after `sim:init` |
| `sim:error` | `{ code, message, recoverable, stack? }` | any failure |
| `sim:resize` | `{ width, height }` | debounced by the sim |
| `sim:state` | `{ state, checksum }` | unsolicited checkpoint, debounced by the host |
| `sim:answer` | `{ answer, confidence?, explanation? }` | a gradable answer exists |
| `sim:gradePreview` | `{ points, correct, rationale, surface }` | teacher-facing only |
| `sim:telemetry` | `{ name, value }` | allowlisted metrics |
| `sim:readyForInput` | `{}` | drives focus management |

**Every inbound frame carries the nonce**, `sim:ready` included. A handshake that identifies itself
without proving it is a handshake anyone can complete.

**Telemetry names are allowlisted** (`TELEMETRY_NAMES`). A free-form name is a side channel: a sim
reporting `student_answer_correct` would put pre-release outcomes into a warehouse, outside the
release gate. The allowlist lives in the type, so a sim that tries this does not compile.

---

## 3. The handshake

`evaluateHandshake(frame, expected)` returns a decision, not a boolean, and the four outcomes are
distinguished on purpose:

| Situation | Verdict | Why |
|---|---|---|
| Everything matches | `ok: true` | — |
| **`simVersion` differs** | `UNSUPPORTED_CAPABILITY`, message naming both versions and the fallback | Degrade, never crash. The surrounding lesson stays usable, and the message is one a teacher can act on rather than "something went wrong". |
| **`protocol` differs** | `HANDSHAKE_FAILED` | A protocol revision change means the frames mean *different things*. Proceeding would be guessing. This is the distinction that is easy to get wrong by treating a protocol bump like a version bump. |
| `simId` differs | `HANDSHAKE_FAILED` | The frame is not the sim that was mounted. |
| `grading: true` but the host supplied no grading instruction | `UNSUPPORTED_CAPABILITY` | Otherwise a student sees a gradable-looking surface and submits something nothing can score. |
| `capabilities` absent | `HANDSHAKE_FAILED` | The host needs them to decide about state capture and fallback. |
| `state: false` | `ok: true` | A lesson sim need not have state. The host must then not promise "captured on unmount" — a host-side decision made *from* this value, not a reason to refuse. |

---

## 4. Capability negotiation

`SimCapabilities` is a **claim**, delivered in `sim:ready`:

```ts
{ state, grading, randomised, audio, webgl, stepper, scenarios }
```

- `state` and `grading` are load-bearing. Without `state` there is nothing to save on unmount and
  nothing to grade.
- `scenarios` is the closed list the host's scenario picker offers, so a host cannot show a scenario
  the sim does not implement.

The host negotiates by *subsetting*: it grants the intersection of what the sim claims and what the
mount allows. A sim cannot grant itself anything.

---

## 5. Versioning

`id@semver`. Resources pin an exact version and old versions keep serving.

- **`MAJOR`** (a state- or answer-schema change) invalidates stored states. The host detects the
  mismatch from the pinned id/version and offers a safe reset rather than corrupting a grade.
- **`MINOR`/`PATCH`** are compatible and served transparently.
- A **deprecation** marks the version, sets `replacedById`, warns in authoring, and keeps serving. A
  live classroom is never broken by a registry decision.
- `DISABLED` is for a security incident only: blocked at author time, still resolvable for pinned
  versions.

---

## 6. Error taxonomy

Closed set of ten. The host switches on it exhaustively; a free-form `code: string` means the first
code nobody handled is a silent no-op, which is how a sim that cannot be graded ends up looking like
a student who gave up.

| Code | Meaning | Fatal |
|---|---|---|
| `HANDSHAKE_FAILED` | did not identify itself as the manifest says | — |
| `UNSUPPORTED_CAPABILITY` | asked for something not granted, or version degraded | — |
| `PARAM_INVALID` | a command or `setParams` carried something the schema rejects | — |
| `SCENARIO_UNKNOWN` | `loadScenario` named a scenario not in the manifest | — |
| `STATE_INVALID` | state failed its schema, or its checksum did not match its content | **yes** |
| `RENDER_FAILED` | the render layer threw; the host may remount | — |
| `GRADER_FAILED` | the grader threw | **yes** |
| `PROHIBITED_API` | navigation, window, clipboard, storage or network attempt | — |
| `TIMEOUT` | a declared budget or the handshake deadline was exceeded | — |
| `INTERNAL` | anything else, deliberately still a code | — |

Two notes on the two codes that look like oddities:

- **`GRADER_FAILED` and `STATE_INVALID` are always fatal.** A wrong grade is worse than no grade, and
  a frame whose state checksum does not match its content cannot be trusted to describe anything.
- **`PROHIBITED_API` has its own code** because it is not a bug: it is a conformance failure *and* an
  error, and the two responses differ. The host shows the fallback; the registry job fails the build.
  Folding it into `INTERNAL` would lose the second half.

The prohibited set is `PROHIBITED_APIS`, as names, so the conformance suite can walk it. A rule
stated only in prose is a rule nobody checks.

---

## 7. Timeouts and budgets

| Constant | Value | Why this number |
|---|---|---|
| `HANDSHAKE_TIMEOUT_MS` | **10 000** | The bundle comes off a separate origin on a cold cache over a school network. A 2 s budget fails exactly the students on the worst connections, who then get a fallback panel and learn nothing. The cost is a slower fallback for a genuinely broken sim — a far better place to spend patience. |
| `STATE_CHECKPOINT_DEBOUNCE_MS` | **3 000** | A student exploring a sim emits a checkpoint on every meaningful change. Persisting each one turns a state document into a write log. Three seconds is short enough that a refresh loses nothing a student would notice. |
| `RESIZE_DEBOUNCE_MS` | **120** | Host-side coalescing of whatever the sim sends. The sim debounces too; both are needed because either alone leaves a jittery layout. |
| `ANSWER_SETTLE_MS` | **750** | Not a timeout — a settle window. A sim with `stepper: false` and no animation may take a while, and a student thinking is not a broken sim. The host waits; it does not synthesise an answer. |

---

## 8. The five rules, and where each lives

| Rule (`plans/10` §2.3) | Enforced by |
|---|---|
| 1. The host never trusts a sim; the server-side grader is the authority | `assertAllowedOn` for previews, `grader-host` isolation for grading |
| 2. Unknown frames are ignored, not fatal | `HOST_FRAME_TYPES` / `SIM_FRAME_TYPES` are closed, so an unknown frame type is detectable and ignorable |
| 3. A version mismatch degrades with a clear panel, never a crash | `evaluateHandshake` |
| 4. One answer per question, revisioned at the response level, with a per-sim checkpoint history | host-side; the `reason` set on `sim:requestState` is what makes replay possible |
| 5. A sim cannot navigate, open windows, or read the clipboard | `PROHIBITED_APIS`, walked by the conformance suite |