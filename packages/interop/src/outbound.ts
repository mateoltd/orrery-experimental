/**
 * THE OUTBOUND CHOKEPOINT: the only way a grade may leave the system.  (P10-T10)
 *
 * ## WHAT THIS CLOSES, AND WHY IT IS A SEPARATE FILE FROM `boundary.ts`
 *
 * `boundary.ts` (P5-T13) owns the *type* that cannot carry a score while sealed, and `assertGradeIsExportable` throws
 * if a sealed `Grade` is handed to an exporter. That is a real lock and it is not enough, for one specific reason this
 * file exists to record:
 *
 * **`SCORE_BEARING_KEYS` DOES NOT CONTAIN THE FIELD NAMES LTI AND xAPI ACTUALLY USE FOR A SCORE.**
 *
 * The AGS grade passback payload is `{ scoreGiven, scoreMaximum, activityProgress }`, and the xAPI result carries
 * `success`, `completion` and `scaled`. `SCORE_BEARING_KEYS` contains `score`, `scores`, `percentage`, `finalScore`,
 * `rubricScore` and eighteen others -- and **not one of those names is the name these two standards put a mark in.**
 * `assertNoScoreLeak({ scoreGiven: 87, scoreMaximum: 100 })` returns clean. That is not a near miss; it is the exact
 * payload `plans/16` §4.1 describes, passing the guard `plans/16` §7 calls "the boundary where `INV-RELEASE-2` is
 * hardest to see".
 *
 * The xAPI case is subtler and worth stating separately: `result: { score: { raw: 87 } }` IS caught, because the walker
 * matches the parent key `score` and reports `$.result.score`. The gap is only where a standard spells it differently --
 * `scoreGiven`, `success`, `scaled` -- so a codec written by somebody who had read `SCORE_BEARING_KEYS` would be caught
 * for one standard and not the other, which is a far worse position than being caught for neither.
 *
 * So this file widens the key set for the OUTBOUND direction, and it does that by UNION rather than by replacement:
 * `INTEROP_SCORE_BEARING_KEYS` is `SCORE_BEARING_KEYS` plus the two standards' own names. Replacing would be tidier and
 * would silently drop whatever `P10-T4`'s sealed results view depends on.
 *
 * ## THE LIST IS DELIBERATELY NOT AS WIDE AS IT COULD BE, AND THREE NAMES ARE LEFT OUT ON PURPOSE
 *
 * An earlier draft of this file also watched `duration`, `min` and `max`. **All three were removed**, and the reason is
 * the same one `boundary.ts` gives for not calling `assertNoScoreLeak` on the released arm: a guard that refuses
 * legitimate payloads gets weakened until it stops objecting, and by then it is not a control.
 *
 *  · **`duration` -- `plans/16` §3 EXPLICITLY PERMITS TIME ON TASK BEFORE RELEASE**, under the `experienced` verb
 *    ("launch, scroll depth, time on task"). Refusing it would refuse a statement the plan requires.
 *  · **`min` / `max` -- ordinary words.** xAPI puts them inside `score`, where the parent key is already watched, and a
 *    payload carrying `{ min: 0, max: 100 }` for a zoom level or a simulation's parameter range is not a leak. A key that
 *    means something else should not be called a score, but neither should a guard have to know which one it is.
 *
 * ## WHY ONE FUNCTION, AND WHY IT RETURNS BYTES
 *
 * The obvious shape is a helper called before sending: `assertNoInteropScoreLeak(payload); await post(payload)`. That is
 * two decisions in two places, and the second has no memory of the first -- which is how a leak arrives on a Friday: a
 * new transport, a retry wrapper, a batch sender, none of which calls the helper because none of them remembers it
 * exists.
 *
 * **SO THE CHOKEPOINT IS WHAT HANDS OVER THE BODY, AND THE BODY IS THE ONLY THING THAT CAN BE SENT.** A caller cannot
 * obtain a serialised outbound payload from this package by any other route: the package has no dependencies, performs no
 * I/O, and exports no other constructor for `OutboundBody`. `scripts/audit-outbound.mjs` enforces the first half against
 * the whole repository, and this file is the second half.
 *
 * ## THE SEALED ARM STILL HAS NO SCORE FIELD, AND IT IS STILL THE MECHANISM
 *
 * `SealedOutbound` has `state`, the target, an identity block and the envelope. There is nothing to omit. A handler that
 * reads `body.score` on a value it has not narrowed does not compile (`outbound.assert.types.ts`). **AND THE RUNTIME SCAN
 * IS STILL THERE**, because the sealed arm's guarantee is about what WE build and the scan's is about what a caller hands
 * us in `envelope` -- an `Record<string, unknown>` from a codec nobody has audited, and that is exactly the nested shape a
 * mark would be smuggled through.
 */

import {
  type AttemptReceipt,
  assertGradeIsExportable,
  type Grade,
  type PayloadViolation,
  type ReleasedGrade,
  SCORE_BEARING_KEYS,
} from './boundary.js';

/**
 * `plans/16` §4, Assignment and Grade Services 2.0: one line item score per attempt, returned as `scoreGiven` /
 * `scoreMaximum`.
 *
 * **`activityProgress` IS HERE AND IT IS NOT A SCORE**, for the reason `INV-RELEASE-2` is about inference rather than
 * arithmetic: `Completed` against `Submitted` is a fact about whether the release has happened, and a student or a third
 * party reading it before release learns the timing of the release. `plans/16` §3 puts the `completed`/`passed`/`failed`
 * verbs after release for the same reason.
 */
export const LTI_AGS_SCORE_KEYS: ReadonlySet<string> = new Set([
  'scoreGiven',
  'scoreMaximum',
  'resultScore',
  'resultMaximum',
  'activityProgress',
]);

/**
 * `plans/16` §3, the xAPI `result`. `success` and `completion` are the pass/fail verdicts; `scaled` is a grade on a
 * different scale. `raw` is here for a codec that flattens `score` away, and `duration` is NOT here for the reason in
 * the header.
 */
export const XAPI_SCORE_KEYS: ReadonlySet<string> = new Set([
  'success',
  'completion',
  'scaled',
  'raw',
]);

/** The two standards this boundary governs. `QTI_ASSESSMENT` carries marks too, but it exports CONTENT, not grades. */
export const OUTBOUND_STANDARDS = ['LTI_AGS', 'XAPI'] as const;
export type OutboundStandard = (typeof OUTBOUND_STANDARDS)[number];

export const isOutboundStandard = (value: unknown): value is OutboundStandard =>
  typeof value === 'string' && (OUTBOUND_STANDARDS as readonly string[]).includes(value);

/**
 * EVERY KEY THAT MAY NOT APPEAR IN AN UNRELEASED OUTBOUND PAYLOAD, on either standard.
 *
 * A union rather than a replacement, so widening the standards' vocabulary cannot narrow what `P10-T4`'s sealed view
 * depends on. `SCORE_BEARING_KEYS` is spread first, so a name on both lists appears once.
 */
export const INTEROP_SCORE_BEARING_KEYS: ReadonlySet<string> = new Set([
  ...SCORE_BEARING_KEYS,
  ...LTI_AGS_SCORE_KEYS,
  ...XAPI_SCORE_KEYS,
]);

export interface InteropViolation extends PayloadViolation {
  readonly standard: OutboundStandard;
}

/**
 * EVERY SCORE-BEARING KEY ANYWHERE IN AN OUTBOUND PAYLOAD, WITH ITS PATH.
 *
 * The walker is `findScoreBearingKeys` from `boundary.ts` with a wider key set, and it is re-implemented rather than
 * parameterised because `findScoreBearingKeys` closes over the narrow set as a module constant -- **parameterising it
 * would have meant editing a committed file whose own tests assert the narrow set**, and a second walker is cheaper than
 * an argument about which of the two sets is the true one. `outbound.test.ts` asserts the two walkers agree wherever they
 * overlap, so they cannot drift apart unnoticed.
 *
 * Keys only, for the reason `boundary.ts` gives: a JSON `0.8` is a completion ratio in one payload and a mark in another,
 * and a guard that tried to read values would be wrong in one direction and clever in the other.
 */
export function findInteropScoreBearingKeys(
  value: unknown,
  path = '$',
  standard: OutboundStandard = 'XAPI',
): InteropViolation[] {
  const out: InteropViolation[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((element, i) => {
        walk(element, `${at}[${String(i)}]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = `${at}.${key}`;
      if (INTEROP_SCORE_BEARING_KEYS.has(key)) out.push({ path: here, key, standard });
      walk(child, here);
    }
  };
  walk(value, path);
  return out;
}

/** THE OUTBOUND ASSERTION, and it throws with the PATH so a codec author is told where to look. */
export function assertNoInteropScoreLeak(
  value: unknown,
  standard: OutboundStandard,
  path = '$',
): void {
  const violations = findInteropScoreBearingKeys(value, path, standard);
  if (violations.length === 0) return;
  const detail = violations.map((v) => `${v.path} (${v.key})`).join(', ');
  throw new Error(
    `INTEROP_SCORE_LEAK: an outbound ${standard} payload for an UNRELEASED attempt carries ${detail}. Before release ` +
      'no line item score is posted at all -- not a zero, not a placeholder -- and no verdict, because a verdict is a ' +
      'score the student could read off it. If this field is legitimately something else then rename it: a key that ' +
      'means something else should not be called a score.',
  );
}

/* ───────────────────────────────────────────────────────────── the bodies ── */

/**
 * WHAT LEAVES, WHICH IS NOT THE RECEIPT.
 *
 * **`AttemptReceipt` CARRIES EVERY ANSWER THE STUDENT GAVE, AND THAT IS EXACTLY WHAT MUST NOT GO OUT.** `plans/16` §3
 * requires xAPI statements with "no answer content in any payload, so xAPI never becomes a side channel around
 * `INV-Q-1`", and the reason is stronger than the plan gives: an answer set is a fingerprint. Who answered which of
 * thirty questions, in which order, and how long each took is a signature that identifies one student across exams, and
 * it is not information anyone asked to be exported.
 *
 * So the outbound body carries four scalar facts and no answers. The boundary type is not narrowed by this -- the type
 * still has `answers` -- because the receiver of the release decision needs them; it is the TRANSPORT that drops them,
 * and a test asserts the serialised body does not contain them.
 */
export interface OutboundIdentity {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly submittedAt: string;
  readonly receiptHash: string;
}

/** THE RECEIPT MINUS ITS ANSWERS. The only part of it that belongs outside. */
export function outboundIdentity(receipt: AttemptReceipt): OutboundIdentity {
  return {
    attemptId: receipt.attemptId,
    assignmentId: receipt.assignmentId,
    submittedAt: receipt.submittedAt,
    receiptHash: receipt.receiptHash,
  };
}

/** AGS 2.0 line item score. The field names are the specification's, not ours. */
export interface AgsLineItemScore {
  readonly scoreGiven: number;
  readonly scoreMaximum: number;
  readonly activityProgress: 'Initialized' | 'Started' | 'InProgress' | 'Submitted' | 'Completed';
}

/** The xAPI `result` object, in the shape `plans/16` §3 describes for `scored`. */
export interface XapiResult {
  readonly success?: boolean;
  readonly completion?: boolean;
  readonly scaled?: number;
  readonly raw: number;
  /**
   * `max` is here because xAPI's `result.score` carries it, and it is NOT on the watched list -- see the header.
   * **The asymmetry is deliberate and is the reason the header explains the list at all:** this field is only ever
   * emitted on the RELEASED arm, which is not scanned, so widening the sealed arm's list to catch it would refuse
   * payloads the plan requires.
   */
  readonly max: number;
}

export interface OutboundTarget {
  readonly standard: OutboundStandard;
  /** The `ExternalBinding` this leaves through, so an audit event can name the route rather than the payload. */
  readonly bindingId: string;
  /** The peer's identifier for this binding. */
  readonly externalId: string;
  readonly attemptId: string;
  readonly assignmentId: string;
}

/**
 * BEFORE RELEASE. **There is no `score` field here -- not nullable, absent** -- so there is nothing for a caller to
 * forget to omit. This is `D-25`'s mechanism, and it is why the sealed arm is a different type rather than one type with
 * a nullable score.
 *
 * **`plans/16` §4.1 IS WHAT THIS ARM IS FOR**: "Before release, no line item score is posted at all -- not a zero, not a
 * placeholder." A body with no `score` key is that; a body with `scoreGiven: null` would be a placeholder, and a
 * placeholder is a thing whose presence or absence a recipient can time.
 */
export interface SealedOutbound {
  readonly state: 'SEALED';
  readonly standard: OutboundStandard;
  readonly target: OutboundTarget;
  readonly identity: OutboundIdentity;
  /** The codec's own members, scanned and kept. Not a place a mark may hide. */
  readonly envelope: Readonly<Record<string, unknown>>;
  /** The bytes to send. Serialised here so no caller can serialise something else instead. */
  readonly body: string;
}

/** AFTER RELEASE. The score is the reason this payload exists. */
export interface ReleasedOutbound {
  readonly state: 'RELEASED';
  readonly standard: OutboundStandard;
  readonly target: OutboundTarget;
  readonly identity: OutboundIdentity;
  readonly score: AgsLineItemScore | XapiResult;
  readonly releasedAt: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export type OutboundBody = SealedOutbound | ReleasedOutbound;

/**
 * A RELEASED SCORE IN WHICHEVER SHAPE THE STANDARD USES, AND `percentage` IS NEITHER OF THEM.
 *
 * AGS takes a raw mark against a maximum and xAPI takes the same pair plus a verdict. `percentage` appears in neither,
 * and it is not computed here because a percentage rounded twice is a percentage a teacher cannot reconcile with the
 * marks they set. **`success` IS `raw === max`, and it is deliberately not `percentage >= passMark`**: a pass mark is a
 * policy this package has no copy of, and inferring one would invent a threshold.
 */
const scoreFor = (
  standard: OutboundStandard,
  grade: ReleasedGrade,
): AgsLineItemScore | XapiResult => {
  const raw = grade.score.rawTotal;
  const max = grade.score.maxTotal;
  if (standard === 'LTI_AGS') {
    return { scoreGiven: raw, scoreMaximum: max, activityProgress: 'Completed' };
  }
  return { raw, max, success: raw === max, completion: true };
};

export interface PrepareOutboundInput {
  readonly target: OutboundTarget;
  /** The release decision, carried as the `Grade` union -- whose sealed arm has no score to begin with. */
  readonly grade: Grade;
  /** Anything else the standard's codec wants to carry. Scanned, never trusted. */
  readonly envelope?: Readonly<Record<string, unknown>>;
}

/**
 * THE CHOKEPOINT. THE ONLY WAY AN OUTBOUND LTI/xAPI PAYLOAD COMES INTO EXISTENCE.
 *
 * Three things happen here and none of them is a caller's job:
 *
 *  1. **THE SEALED DOCUMENT IS CONSTRUCTED FROM THE RECEIPT'S IDENTITY**, not from the record minus its secrets. That is
 *     the same discipline `buildStudentGrade` uses and for the same reason: a spread with a conditional in it grows a
 *     populated branch and an unpopulated one, written by different people.
 *  2. **`assertNoInteropScoreLeak` over the WHOLE sealed document, including `envelope`.** The type cannot stop an
 *     envelope -- it is `Record<string, unknown>` from a codec nobody has audited -- and the envelope is exactly where a
 *     nested mark would be put.
 *  3. **`assertGradeIsExportable` on the way to the released arm**, which is also what narrows the union: the honest path
 *     needs an `if`, and `boundary.ts` records why the obvious ternary does not narrow and why `as ReleasedGrade` would
 *     have compiled happily and been the leak.
 *
 * **THE SCAN RUNS ON THE SEALED ARM ONLY, FOR THE REASON `boundary.ts` GIVES:** `scoreGiven` IS what a released AGS
 * payload is for. A check that read "no score may ever cross" would be refused by the first legitimate release and would
 * then be weakened until it stopped objecting.
 */
export function prepareOutbound(input: PrepareOutboundInput): OutboundBody {
  if (!isOutboundStandard(input.target.standard)) {
    throw new Error(
      `OUTBOUND_UNKNOWN_STANDARD: "${String(input.target.standard)}" is not one of ` +
        `${OUTBOUND_STANDARDS.join(', ')}. An unknown standard would be scanned with this boundary's key set, which is ` +
        'a guess about a vocabulary nobody has read.',
    );
  }
  const standard = input.target.standard;
  const envelope = input.envelope ?? {};
  const identity = outboundIdentity(input.grade.receipt);

  if (input.grade.state === 'SEALED') {
    const document = {
      state: 'SEALED' as const,
      standard,
      target: input.target,
      identity,
      envelope,
    };
    assertNoInteropScoreLeak(document, standard);
    return { ...document, body: JSON.stringify(document) };
  }

  const grade = assertGradeIsExportable(input.grade);
  const document = {
    state: 'RELEASED' as const,
    standard,
    target: input.target,
    identity,
    score: scoreFor(standard, grade),
    releasedAt: grade.releasedAt,
    envelope,
  };
  return { ...document, body: JSON.stringify(document) };
}
