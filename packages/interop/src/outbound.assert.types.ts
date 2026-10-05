/**
 * The compiler assertions behind `P10-T10`'s claim that an outbound leak is a compile error.  (P10-T10)
 *
 * ## SAME RULES AS `assert.types.ts`, AND THE SAME REASON FOR BEING A `.ts` FILE
 *
 * There is no runtime behaviour to observe. `@ts-expect-error` asserts the ABSENCE of a compile error with no new
 * dependency, and has the better failure mode: if the compiler ever stops objecting, the directive becomes unused and
 * `tsc` reports `TS2578`. `pnpm run typecheck` is what runs this file, and every directive below is USED on this commit,
 * which is the only evidence the guarantee still holds.
 *
 * ## A SEPARATE FILE RATHER THAN FOUR MORE DIRECTIVES IN `assert.types.ts`
 *
 * `assert.types.ts` asserts the SEALED/RELEASED split; this asserts the OUTBOUND split, which is a different union with
 * a different arm shape. Appending to the existing file would mean its header -- which is entirely about `P5-T13` and
 * about a codec that could not say what it was sending -- had to describe two boundaries, and a file documenting two
 * things documents neither.
 *
 * **EVERY PROBE IS INSIDE A NEVER-CALLED FUNCTION** because `no-unused-expressions` correctly refuses a bare
 * `sealed.score;` at module scope, and a file of them is a file nobody can review.
 */

import type { OutboundBody, ReleasedOutbound, SealedOutbound } from './index.js';

declare const sealed: SealedOutbound;
declare const released: ReleasedOutbound;
declare const anyBody: OutboundBody;

/** A sink, so each probe is a statement with an effect rather than a stray token. */
declare function _use(value: unknown): void;

/** Never called. If this ever returns, the outbound boundary has a hole in it. */
function _theCompilerStillRefusesOnTheWayOut(): unknown[] {
  // 1. THE HEADLINE, on the other side of the boundary from `assert.types.ts`'s first probe. The sealed OUTBOUND arm has
  //    no score field, so there is nothing to omit, and a sender that tries does not compile.
  // @ts-expect-error Property 'score' does not exist on type 'SealedOutbound'.
  _use(sealed.score);

  // 2. Reading a score without narrowing the union is an error. `OutboundBody` discriminates on `state`, so
  //    `body.score ?? null` -- the shape a formatter reaches for -- names a property the union does not have.
  // @ts-expect-error Property 'score' does not exist on type 'OutboundBody'.
  _use(anyBody.score);

  // 3. A sealed body cannot be forged with a score even in one object literal. This is the smuggling shape a caller
  //    writes by hand, and it is a compile error rather than a thing the runtime scan has to catch.
  // @ts-expect-error Object literal may only specify known properties, and 'score' does not exist in type 'SealedOutbound'.
  const forged: OutboundBody = { ...sealed, score: { raw: 100 } };

  // 4. THE RECEIPT'S ANSWERS ARE NOT ON THE OUTBOUND ARM, so there is no expression that could put one in a payload.
  //    This is `plans/16` §3's "no answer content in any payload" as a TYPE rather than as a convention, and it is the
  //    assertion that stops an answer set reappearing in an export six months from now.
  // @ts-expect-error Property 'answers' does not exist on type 'SealedOutbound'.
  _use(sealed.identity.answers);

  // 5. And the honest path is still a CHECK. `anyBody.state === 'RELEASED' ? anyBody : sealed` widens back to the
  //    union, so a sender who wanted a score without narrowing would reach for a cast, which compiles and IS the leak.
  //    `prepareOutbound` is a function for the same reason `assertGradeIsExportable` is one.
  const narrowed: unknown[] = [];
  if (anyBody.state === 'RELEASED') {
    narrowed.push(anyBody.score);
  } else {
    _use(sealed);
  }

  // 6. A RELEASED body may be read as released without any assertion, because that is what it is for. Written so that
  //    widening the sealed arm's protections cannot be mistaken for a rule that also forbids sending a real grade.
  _use(released.score);

  // 7. `prepareOutbound` takes a `Grade`, so a caller holding an already-narrowed sealed value cannot pass a forged
  //    released one by accident either -- and a `Grade` cannot be cast into `OutboundBody` without a directive.
  // @ts-expect-error Type 'SealedOutbound' is not assignable to type 'ReleasedOutbound'.
  const miscast: ReleasedOutbound = sealed;

  return [forged, miscast, ...narrowed];
}
