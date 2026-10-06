/**
 * xAPI 2.0 STATEMENT EMISSION: queued, batched, idempotent, dead-lettered.  (P16-T5)
 *
 * ## WHAT THIS MODULE IS AND IS NOT
 *
 * This module BUILDS statements. It does not deliver them: there is no LRS endpoint, `plans/16` §3 says
 * "No LRS is built or operated", and delivery is an injected `XapiTransport` the database layer drives
 * from the outbox. **A statement builder that also delivered would couple grading to the network.**
 *
 * The queue/batch/idempotent/dead-letter half lives in `packages/db/src/xapi-outbox.ts`, mirroring the
 * proven `EmailOutbox` pattern (`claimDueMessages` with `SKIP LOCKED`, `dedupeKey` unique, give up after
 * `maxAttempts`). This file is the pure half, and it is pure so the security properties below are testable
 * without a database.
 *
 * ## NO ANSWER CONTENT, BY CONSTRUCTION -- NOT BY REVIEW
 *
 * `plans/16` §3: "no answer content in any payload, so xAPI never becomes a side channel around `INV-Q-1`".
 * The input types carry NO answer field at all: there is no `response`, no `choices`, no `answer` anywhere in
 * this file's signatures. **A reviewer does not have to check that answers are omitted, because there is
 * nowhere to put one.** In particular the xAPI `result.response` field -- the obvious place an answer would
 * go -- is never set: `answered` carries duration only.
 *
 * ## SCORED REQUIRES RELEASED, AND THE REQUIREMENT IS NOT CHECKED HERE
 *
 * `plans/16` §4.1: AGS grade passback sends `finalScore` only when released; the same rule governs the
 * `scored`/`completed`/`passed`/`failed` statements here. The first version of this file took a raw score
 * with a `releasedAt` field and re-checked it -- a SECOND, PARALLEL release gate next to the chokepoint's,
 * and two gates that can disagree are worse than one. So `buildScoredStatement` takes a `ReleasedOutbound`
 * produced by `prepareOutbound()`: **the chokepoint stays the only place a score is produced, and this file
 * only formats what the chokepoint approved.** Passing anything else -- a sealed body, an LTI_AGS body --
 * throws, because both are ways of smuggling an unapproved mark into a record store.
 *
 * The audit gate (`audit-outbound.mjs`) fired on this file for naming the three score verb IRIs, which is
 * exactly its job. The file is listed in `audit/outbound-boundary.json` with the reason: it names the IRIs
 * to CONSTRUCT statements from chokepoint-approved bodies and never produces a score.
 *
 * ## IDEMPOTENCY IS THE STATEMENT ID
 *
 * `id` is `${attemptId}:${event}`, per the plan ("the attempt's ULID + event type"). A retried emission
 * produces the same id, so a consumer dedupes. The outbox's `dedupeKey` is the same string, so the local
 * queue and the remote consumer agree on identity.
 */

import type { ReleasedOutbound, XapiResult } from './outbound.js';

export const XAPI_VERBS = {
  experienced: 'http://adlnet.gov/expapi/verbs/experienced',
  answered: 'http://adlnet.gov/expapi/verbs/answered',
  scored: 'http://adlnet.gov/expapi/verbs/scored',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
} as const;

export type XapiVerb = keyof typeof XAPI_VERBS;

export interface XapiActor {
  /** Account, not mbox: an email address in a learning record is a leak with a timestamp. */
  readonly account: { readonly homePage: string; readonly name: string };
}

export interface XapiObject {
  readonly id: string;
  readonly definition?: { readonly type?: string; readonly name?: Record<string, string> };
}

export interface XapiStatement {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: XapiActor;
  readonly verb: { readonly id: string; readonly display?: Record<string, string> };
  readonly object: XapiObject;
  readonly result?: {
    readonly score?: {
      readonly scaled?: number;
      readonly raw?: number;
      readonly min?: number;
      readonly max?: number;
    };
    readonly success?: boolean;
    readonly completion?: boolean;
    readonly duration?: string;
  };
  readonly context?: { readonly extensions?: Record<string, unknown> };
}

export interface XapiEventBase {
  readonly attemptId: string;
  readonly actorHomePage: string;
  readonly actorName: string;
  readonly objectId: string;
  readonly timestamp?: string;
}

/** `answered`: duration and attempt number only. No `result.response` -- see the header. */
export interface AnsweredEvent extends XapiEventBase {
  readonly event: 'answered';
  readonly durationSeconds: number;
  readonly attemptNumber: number;
}

export interface ExperiencedEvent extends XapiEventBase {
  readonly event: 'experienced';
}

/** A scored/completed/passed/failed event, carrying the chokepoint's approved body -- never a raw score. */
export interface ScoredEvent extends XapiEventBase {
  readonly event: 'scored' | 'completed' | 'passed' | 'failed';
  readonly outbound: ReleasedOutbound;
}

function base(
  event: XapiEventBase,
  eventName: string,
  verb: XapiVerb,
): Omit<XapiStatement, 'result' | 'context'> {
  return {
    id: `${event.attemptId}:${eventName}`,
    timestamp: event.timestamp ?? new Date().toISOString(),
    actor: { account: { homePage: event.actorHomePage, name: event.actorName } },
    verb: { id: XAPI_VERBS[verb] },
    object: { id: event.objectId },
  };
}

export function buildAnsweredStatement(event: AnsweredEvent): XapiStatement {
  return {
    ...base(event, event.event, 'answered'),
    result: { duration: `PT${Math.max(0, Math.floor(event.durationSeconds))}S` },
    context: {
      extensions: { 'https://orrery.example/extensions/attempt-number': event.attemptNumber },
    },
  };
}

export function buildExperiencedStatement(event: ExperiencedEvent): XapiStatement {
  return base(event, event.event, 'experienced');
}

export function buildScoredStatement(event: ScoredEvent): XapiStatement {
  // The chokepoint's body is the ONLY score this file will format. A sealed body has no score at all;
  // an LTI_AGS body has the WRONG standard's score. Both throw, because both are unapproved marks.
  if (event.outbound.state !== 'RELEASED') {
    throw new Error(
      'XAPI_SEALED_SCORE: refusing to build a scored/completed/passed/failed statement from a sealed body. ' +
        'Before release the answer is not a zero and not a placeholder -- it is the absence of a statement.',
    );
  }
  if (event.outbound.standard !== 'XAPI') {
    throw new Error(
      `XAPI_WRONG_STANDARD: refusing to wrap a ${event.outbound.standard} body as an xAPI statement. ` +
        'Cross-standard re-wrapping is how a mark approved for one peer reaches another.',
    );
  }
  const score = event.outbound.score as XapiResult;
  const verb = event.event;
  // Emitted exactly as the chokepoint computed: no `min` is invented here (XapiResult carries none),
  // and `scaled` passes through only when the chokepoint set it. An xAPI `score.min` defaulting is the
  // consumer's spec business, not a value for this file to assert about someone else's grading.
  const scoredScore: { readonly scaled?: number; readonly raw: number; readonly max: number } =
    score.scaled === undefined
      ? { raw: score.raw, max: score.max }
      : { scaled: score.scaled, raw: score.raw, max: score.max };
  return {
    ...base(event, event.event, verb),
    result: {
      score: scoredScore,
      success: verb === 'passed' ? true : verb === 'failed' ? false : undefined,
      completion: true,
    },
  };
}

/** The dedupe key the outbox and the consumer share. Same string, both sides. */
export function dedupeKey(attemptId: string, event: string): string {
  return `${attemptId}:${event}`;
}
