import { systemClock } from '@orrery/clock';
import { getPrisma } from '@orrery/db';
import { prismaForgotStore } from '@/server/auth/credential-store';
import { requestReset, respondUniformly } from '@/server/auth/forgot';

/**
 * `POST /api/auth/forgot`.  (P14-T11)
 *
 * ## THE PATH `transport.ts` HAS ALWAYS CALLED
 *
 * `authTransport.requestReset` posts here (`server/auth/transport.ts:50`) and this route did not
 * exist, so the forgot-password page could not succeed either.
 *
 * ## THIS ROUTE HAS EXACTLY ONE RESPONSE
 *
 * One status, one body, for an address with an account, an address without one, and an address
 * that has been asked about forty times in the last minute. The cooldown, the queue entry and the
 * evidence are all written; none of them is readable from here. `server/auth/forgot.ts` is where
 * that is argued, and `forgot.test.ts` is where it is proved — including that the number of
 * database writes is the same on both paths, which is the half a body assertion cannot reach.
 *
 * ## NOTHING IN THE BODY CAN SELECT A USER
 *
 * There is an `email` field and no others. A `userId` sent alongside it is ignored rather than
 * rejected, because there is no field to read.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  if (body === null) {
    // A body that is not a JSON object contains no address, so it discloses nothing about any
    // account and a 400 is the honest answer. `transport.ts:38` collapses it to the generic
    // string anyway, which is where that decision belongs.
    return Response.json(
      { ok: false, reason: 'MALFORMED_BODY' },
      { status: 400, headers: NO_STORE },
    );
  }

  const deps = { store: prismaForgotStore(getPrisma()), clock: systemClock };
  const email = typeof body.email === 'string' ? body.email : '';
  return respondUniformly(deps, requestReset(deps, { email }));
}

/** A body that is not a JSON object is a 400 rather than an exception. */
const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};
