/**
 * Forgot password.  (P14-T11, P1-T3)
 *
 * ## THE ENDPOINT THAT MOST OFTEN BECOMES AN ACCOUNT ENUMERATOR
 *
 * `authTransport.requestReset` posts to `/api/auth/forgot` (`server/auth/transport.ts:50`) and that
 * path did not exist, so the forgot-password page could not succeed either.
 *
 * `/api/auth/forgot` is the single easiest endpoint in a product to turn into a list of who has
 * an account, and the reason is that the honest implementation is so tempting: 200 + "we sent you
 * a link" for a real address, 404 + "no account with that address" for a fake one, and every
 * support article in the world says the user should be told. `GENERIC_DISPATCH` exists because
 * that is wrong — a user WITH an account is not confused by the conditional sentence, because the
 * email arrives, and a user WITHOUT one learns nothing.
 *
 * ## THE ONE ROW IS BOTH THE RATE LIMIT AND THE QUEUE ENTRY
 *
 * The cooldown is enforced by an `INSERT … ON CONFLICT (dedupeKey) DO NOTHING` into `EmailOutbox`,
 * with a dedupe key derived from `throttleDedupeKey` over the HASHED address and a 30-second
 * bucket. That gives three properties at once, and each of them is a security property:
 *
 *   1. **It applies to an address with no account**, which a per-account limiter cannot do and
 *      which is the whole reason `flow.ts:125-129` insists the cooldown is evaluated against the
 *      ADDRESS rather than the account.
 *   2. **It is durable and shared across replicas**, which the in-process login attempt log is not.
 *   3. **Its outcome is not observable**, because the response does not depend on it. A duplicate
 *      inside the bucket inserts nothing and changes nothing the caller can see.
 *
 * ## THE STATUS COLUMN IS HOW THE TWO PATHS DO THE SAME WORK WITHOUT SENDING MAIL
 *
 * An account gets `QUEUED`; an address with no account gets `SUPPRESSED`. `claimDueMessages`
 * filters on `status = 'QUEUED'` (`packages/db/src/notifications.ts:479`), so a `SUPPRESSED` row is
 * inert — and crucially the row is still INSERTED on both paths, so the two requests cost the same
 * number of database round trips. The alternative — writing nothing at all for an unknown address
 * — is faster and re-opens the timing oracle that `password.ts` spends forty lines closing.
 * `SUPPRESSED` is already a real state in this schema for exactly the "we are deliberately not
 * sending this" meaning.
 *
 * ## WHAT THIS DOES NOT DO, STATED HERE RATHER THAN DISCOVERED LATER
 *
 * It does not mint a reset token. There is no `AuthenticationToken` table in the schema and
 * `MAGIC_LINK`'s policy in `packages/auth/src/session.ts:337` is unimplemented, so there is
 * nowhere to put a token that a future `/reset` route could consume. Writing a fake token here
 * would put an unverifiable credential into an email queue, which is worse than a queued request
 * with no link in it. The outbox row records the request; the mint is reported as outstanding.
 */

import { actorPresence } from '@orrery/auth/can';
import { throttleDedupeKey } from '@orrery/auth/throttle';
import type { Clock } from '@orrery/clock';
import { dispatchResponse, RESPONSES, TIMING } from '@/features/auth/flow';
import { normaliseEmail } from './sign-in';

export interface ForgotStore {
  /** The account for a NORMALISED address, or `null`. One query, on both paths. */
  findAccountIdByEmail(emailNormalized: string): Promise<string | null>;
  /**
   * Record the request. Returns nothing: whether the row was new is deliberately NOT reported,
   * because a caller that could see it could tell a first request from a throttled one.
   */
  enqueue(input: {
    toEmail: string;
    userId: string | null;
    /** `QUEUED` when there is somebody to send to, `SUPPRESSED` when there is not. */
    status: 'QUEUED' | 'SUPPRESSED';
    dedupeKey: string;
    now: Date;
  }): Promise<void>;
}

export interface ForgotDeps {
  readonly store: ForgotStore;
  readonly clock: Clock;
}

/**
 * Handle the request.
 *
 * Returns the SAME `dispatchResponse` on every path — same status, same body, same byte count —
 * because there is nothing about this endpoint's outcome that the caller is entitled to know.
 */
export async function requestReset(
  deps: ForgotDeps,
  input: { readonly email: string },
): Promise<{ status: 200; body: ReturnType<typeof dispatchResponse>['body'] }> {
  const now = deps.clock.now();
  const identifier = normaliseEmail(input.email);

  const userId = await deps.store.findAccountIdByEmail(identifier);

  // The cooldown key is computed from the ADDRESS, in both cases, which is the property that makes
  // an address with no account rate-limitable at all. `throttleDedupeKey` hashes the identifier, so
  // the unique column never becomes a list of every address anybody has asked about.
  const dedupeKey = throttleDedupeKey({
    kind: 'auth.passwordResetRequested',
    identifier,
    ipPseudonym: 'address',
    at: now,
    bucketMinutes: RESPONSES.cooldownSeconds / 60,
  });

  await deps.store.enqueue({
    toEmail: identifier,
    userId,
    // `actorPresence` rather than `userId === null`. It is the kernel's one answer to "is anybody
    // here", and using it keeps this module free of a hand-rolled identity presence check — which
    // is what the authz-ownership gate is for, and what `can.ts` says to do instead of widening
    // its pattern list.
    status: actorPresence(userId).ok ? 'QUEUED' : 'SUPPRESSED',
    dedupeKey,
    now: new Date(now),
  });

  return dispatchResponse('passwordResetSent');
}

/**
 * The uniform-latency floor, as `respondUniformly` does for sign-in.
 *
 * The same reasoning and the same number, and it is applied to the one response shape there is —
 * so it is a statement that the endpoint does not branch on time at all, rather than a
 * compensation for branching. Duplicated as three lines rather than shared because the sign-in
 * version takes a `SignInDeps`, and a shared helper with a union parameter would be the more
 * confusing of the two.
 */
export async function respondUniformly(
  deps: ForgotDeps,
  work: Promise<unknown>,
): Promise<Response> {
  const startedAt = deps.clock.monotonic();
  await work;
  const remaining = TIMING.minimumFailureDisplayMs - (deps.clock.monotonic() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));

  const response = dispatchResponse('passwordResetSent');
  return Response.json(response.body, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
