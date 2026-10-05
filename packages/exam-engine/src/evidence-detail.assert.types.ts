/**
 * The compiler assertions behind `TM-20`: a `detail` key outside the closed set is a COMPILE ERROR.  (P14-T16)
 *
 * ## SAME RULES AS `packages/interop/src/outbound.assert.types.ts`, AND THE SAME REASON FOR BEING A `.ts` FILE
 *
 * There is no runtime behaviour to observe. `@ts-expect-error` asserts the ABSENCE of a compile error with no new
 * dependency, and it has the better failure mode: if the compiler ever stops objecting, the directive becomes unused and
 * `tsc` reports `TS2578`. **`pnpm run typecheck` is the only thing that runs this file.**
 *
 * ## AND THE FILENAME IS LOAD-BEARING, WHICH THE FIRST ATTEMPT AT THIS FILE GOT WRONG
 *
 * This was first written as `evidence-detail.compile.test.ts` and **it was never compiled at all**:
 * `packages/exam-engine/tsconfig.json:7` excludes every `src` glob ending `.test.ts`, so test files sit outside the
 * program. A file of `@ts-expect-error` directives that nothing typechecks is a comment with import statements — the exact
 * defect class this task exists to remove, committed by me, and caught only because the file was written down. The name
 * follows `outbound.assert.types.ts` for that reason: the suffix is what keeps it inside the program.
 *
 * ## EVERY PROBE IS INSIDE A NEVER-CALLED FUNCTION
 *
 * `no-unused-expressions` refuses a bare `pii;` at module scope, and a file of bare expressions is a file nobody can
 * review. Each probe is a statement handed to a declared sink.
 */

import type { EvidenceDetail, EvidenceRecord } from './evidence.js';

declare const anyRecord: EvidenceRecord;

/** A sink, so each probe is a statement with an effect rather than a stray token. */
declare function _use(value: unknown): void;

/**
 * `Record<string, unknown>`: what a codec, a `JSON.parse` or a merged config hands you.
 *
 * Used by `theTypeDoesNotCloseASpread`, and its purpose there is to be ASSIGNABLE to the closed type — see that
 * function for the whole point, which is that it is.
 */
const WIDE_DETAIL: Record<string, unknown> = { studentEmail: 'student@school.invalid' };

/**
 * A local alias, purely so the record probes fit inside Biome's 100-column `lineWidth`.
 *
 * **`EvidenceRecord` in full puts the headline probe at 105 columns, and a formatter that wraps it moves the error off the
 * `@ts-expect-error` above it.** That happened twice on this file before the alias existed, and it is the single most
 * dangerous thing that can happen to a file of compile-time assertions: the build goes red with `TS2578` and `TS2353`
 * together, which reads as agreement rather than as a broken probe.
 */
type Ev = EvidenceRecord;

// ── the property: an unknown key is an excess-property error ─────────────────────────────────

/**
 * THE ERROR MUST BE ON THE LINE THE DIRECTIVE IS ABOVE, AND THAT IS NOT A STYLE CHOICE.
 *
 * **`@ts-expect-error` suppresses the NEXT line only, and this file was written wrong twice.** The first version put the
 * directive above `_use({ … } satisfies EvidenceDetail)`; Biome then reformatted the object literal across five lines,
 * moving the excess-property error to the line holding `detail:` — so the build failed with `TS2578` (directive unused)
 * and `TS2353` (it really is an error) in the same run. The second version bound each detail to a `const` and put the
 * directive above the `satisfies` line, which is the same mistake with a different line number: the error is reported at
 * the ANNOTATED DECLARATION, not at the place the value is used.
 *
 * So each probe below annotates the const and the directive sits above it, and nothing here is long enough for a
 * formatter to be able to move an error off its directive.
 */
export function unknownKeyIsAnError(): void {
  // The legal case first, and it is not a formality: a closed set that refuses everything is a closed set nobody
  // notices until production, and `evidence-detail.test.ts` asserts the runtime half accepts all twenty-two.
  const legal: EvidenceDetail = { awayForMs: 12, peerTabId: 'tab-2', threshold: 3 };
  _use(legal);

  // @ts-expect-error `studentEmail` is not one of the reviewed keys, and `TM-20` is that it is not.
  const pii: EvidenceDetail = { studentEmail: 'student@school.invalid' };

  // @ts-expect-error An answer key is the exact thing the old docstring forbade in prose.
  const answer: EvidenceDetail = { answerKey: 'a' };

  // @ts-expect-error The compound form. `Exclude` matches WHOLE names, so it has to be spelled out in
  // `PII_OR_CONTENT_KEYS` too — see that list for why a substring rule is not available.
  const named: EvidenceDetail = { studentName: 'Alex' };

  // @ts-expect-error `note` is what `evidence-wire.test.ts` used before the key set was closed.
  const innocuous: EvidenceDetail = { note: 'x' };

  // @ts-expect-error An innocuous name is not a licence: the list is closed, so nothing is innocuous by default.
  const arbitrary: EvidenceDetail = { a: 1, b: 2 };

  _use([legal, pii, answer, named, innocuous, arbitrary]);
}

// ── the property: a value that is not a primitive is refused ────────────────────────────────

export function nonPrimitiveValueIsAnError(): void {
  // @ts-expect-error A nested object is how a whole payload gets past a key allowlist.
  const nested: EvidenceDetail = { reason: { studentEmail: 'a@b.c' } };

  // @ts-expect-error An array likewise.
  const listed: EvidenceDetail = { reason: ['a@b.c'] };

  _use([nested, listed]);
}

// ── the property: the closed set reaches the RECORD, not only a standalone alias ─────────────

export function theRecordItselfRefusesIt(): void {
  // THE HEADLINE PROBE: the leak `TM-20` names, written on the RECORD rather than on a standalone alias.
  //
  // **HELD UNDER 100 COLUMNS ON PURPOSE, because Biome's `lineWidth` is 100 and this file has now been disarmed that
  // way three times.** A formatter that splits the literal moves the excess-property error onto the `detail:` line, the
  // `@ts-expect-error` on the line above becomes unused, and the build reports `TS2578` and `TS2353` in the same run —
  // which reads as "the control says this should not compile and it did not compile", the least informative pair of
  // diagnostics available.
  //
  // @ts-expect-error `detail.studentEmail` on a record is the property `TM-20` says compiled.
  const leak: Ev = { seq: 0, type: 'TAB_HIDDEN', at: 0, detail: { studentEmail: 'a@b.c' } };

  // A legal record, so the probe above is not passing because nothing is accepted.
  const fine: Ev = { seq: 0, type: 'TAB_HIDDEN', at: 0, detail: { awayForMs: 12 } };
  _use([leak, fine, anyRecord.detail]);
}

/**
 * THE ONE PLACE THE CLOSED TYPE DOES NOT REACH, ASSERTED AS COMPILING RATHER THAN AS AN ERROR.
 *
 * A `@ts-expect-error` here would be WRONG, and writing one would have been a probe passing for the wrong reason — the
 * exact failure `P14-T13` hit. So it is a call with no directive: **this compiles, and if it ever stops compiling this file
 * goes red.** That inverts the usual direction deliberately, because the property here is the existence of a hole.
 *
 * ## AN ALIAS LOSES THE CHECK AND A LITERAL KEEPS IT, AND THE DIFFERENCE IS FRESHNESS
 *
 * Excess-property checking applies to a fresh object LITERAL. A spread of a `Record<string, unknown>` produces an index
 * signature, and **the const it lands in is not fresh**, so nothing is checked. The two cases sit side by side below and
 * the contrast is the whole finding:
 *
 *  · `const pii: EvidenceDetail = { studentEmail: … }`   does NOT compile — a fresh literal, checked.
 *  · `const viaAlias: EvidenceDetail = { ...wider }`      COMPILES       — not fresh, unchecked.
 *
 * So the closed type is defeated by the single most ordinary way a `detail` reaches a writer — a codec output, a
 * `JSON.parse`, a merged config, an object handed across a function boundary — and `EvidenceBatcher.record()`'s runtime
 * check is not defence in depth here. **It is the only thing standing between `{ studentEmail }` and a row retained for
 * 400 days.**
 *
 * ### AND THE CLOSED TYPE IS *LOOSER* THAN THE ONE IT REPLACED, IN EXACTLY THIS ONE PLACE
 *
 * Which the RED run makes unarguable. Reverting `EvidenceDetail` to `Readonly<Record<string, string | number | boolean |
 * null>>` does not make `theTypeDoesNotCloseASpread` compile — it reports `TS2322` on all three probes, because
 * `Record<string, unknown>` is not assignable to `Record<string, string | number | boolean | null>`. So the OLD type caught
 * an aliased object *by accident*, because its values happened to be a union rather than `unknown`.
 *
 * **The closed type traded that accident for twenty-two named keys and lost nothing else.** `Record<string, unknown>` is
 * the honest type for a value that came off a codec, and pretending otherwise is what the old declaration did: it refused
 * `unknown` values, which is why a caller wanting to hand it a parsed object had to cast, and a cast is where a schema
 * stops being checked. `EvidenceBatcher.record()` re-checks at runtime precisely because the type cannot, and this is the
 * case it exists for.
 *
 * (The first draft of this contrast wrote `{ [key: string]: 'a@b.c' }`, which is an index signature and therefore only
 * legal in a TYPE position — in a value position the compiler reads `[key: string]` as a computed property and reports
 * `TS1005`. It was a malformed probe asserting a property by accident, which is worse than no probe.)
 *
 * `exactOptionalPropertyTypes` is a second, weaker hole: `tsconfig.base.json` sets it `false`, so `{ reason: undefined }`
 * typechecks while `isEvidenceDetailValue` refuses `undefined` at runtime. The behaviour is safe and only the type is
 * weaker, which is the safe direction to be wrong in. Turning the flag on is a whole-repository change other lanes are
 * mid-edit on, so it is recorded rather than done, and asserted in `evidence-detail.test.ts`.
 */
export function theTypeDoesNotCloseASpread(): void {
  const viaConst: EvidenceDetail = WIDE_DETAIL;
  _use(viaConst);

  const viaSpread: EvidenceDetail = { ...WIDE_DETAIL };
  _use(viaSpread);

  const undef: EvidenceDetail = { reason: undefined };
  _use(undef);
}
