/**
 * The wiring: Postgres behind the policy, and Next.js behind the cookie.  (P14-T11, INV-AUTH-1)
 *
 * ## WHY THE SPLIT IS A SEPARATE FILE
 *
 * `session-user.ts` holds the policy and imports nothing from Next.js, which is what lets a test
 * exercise every failure mode of a forged, expired and revoked cookie with a plain object and no
 * mocking framework. This file is the only place that knows `next/headers` exists, that reaches
 * for `getPrisma()`, or reads `AUTH_SECRET` — so there is exactly one place where a change of
 * framework or of persistence could quietly change what "the caller" means, and it is a file with
 * a name.
 *
 * ## WHY `AUTH_SECRET` IS READ HERE AND REFUSED WHEN ABSENT
 *
 * `Session.tokenHash` is an HMAC-SHA-256 keyed by this secret (`@orrery/auth/token`). A missing
 * secret must NOT become a constant: every deployment would share a key, so a token hash lifted
 * from a staging dump would be valid in production, and nothing would look wrong until it was
 * exploited. A short secret is refused for the same reason `packages/config` refuses one at boot,
 * and the check is repeated here because this module is reachable from a route handler that runs
 * without the boot-time validation having happened.
 *
 * ## THE DEV IDENTITY IS ONLY CONSULTED WHEN NO COOKIE WAS SENT AT ALL
 *
 * A caller presenting a STALE cookie while the escape hatch is on must get `null`, not the dev
 * identity. The alternative is that "my session expired" silently becomes "you are a different
 * person", which is a genuinely baffling bug to chase and would be found in production.
 */

import { systemClock } from '@orrery/clock';
import { getPrisma, type PrismaClient } from '@orrery/db';
import { cookies } from 'next/headers';
import { authLog } from './credential-store';
import {
  type CallerResolution,
  devIdentity,
  readCookie,
  resolveCaller,
  type SessionCaller,
  type SessionLookup,
  type StoredSession,
  sessionCookieName,
} from './session-user';

export { authLog };

/**
 * The current user for a Server Component or a Server Action, or `null`.
 *
 * `null` rather than a throw, because "nobody is signed in" is an ordinary answer to a page
 * render and the roster page has a real thing to say in that case. A Server Component cannot write
 * a cookie during a render, so the sliding-window refresh that `resolveCaller` may produce is
 * DROPPED here; a Route Handler must use `requireUser`, which returns it.
 */
export async function currentUser(): Promise<SessionCaller | null> {
  const jar = await cookies();
  const presented = jar.get(sessionCookieName())?.value ?? null;
  const resolution = await resolveForToken(presented);
  if (resolution === null) return null;
  return resolution.caller;
}

/**
 * The current user for a Route Handler, with the cookie refresh it may need to apply.
 *
 * The cookie is read out of the `Request` rather than `next/headers` for one concrete reason: a
 * route handler already has the request, and reading the header directly means the whole
 * unauthenticated path is exercisable in a unit test without standing up the framework. There is
 * one `Cookie` header and one parser, and `readCookie` is that parser.
 */
export async function requireUser(request: Request): Promise<CallerResolution | null> {
  const presented = readCookie(request.headers.get('cookie'), sessionCookieName());
  return resolveForToken(presented);
}

/**
 * The HMAC key, or `null`. `null` means "fail closed", never "use a default" — see the header.
 *
 * THE WARNING IS EMITTED ONCE, AND THAT IS A CORRECTNESS POINT RATHER THAN A NOISE POINT. This
 * runs on EVERY request, so an unconfigured deployment would otherwise write one line per request
 * — which is how a log line that exists to be read becomes a log line nobody reads. A missing
 * secret is a boot condition, not a per-request event, and it is loud once rather than endlessly.
 */
let missingSecretWarned = false;

function authSecret(): string | null {
  const value = process.env.AUTH_SECRET;
  if (typeof value !== 'string' || value.length < 32) {
    if (!missingSecretWarned) {
      missingSecretWarned = true;
      authLog.error(
        'AUTH_SECRET is absent or shorter than 32 bytes, so every session cookie is being ' +
          'refused. Set it before serving traffic; do not default it.',
      );
    }
    return null;
  }
  return value;
}

let devIdentityWarned = false;

/**
 * Resolve, then fall back to the development identity — and only then.
 *
 * The fallback is reached only when `presented === null`, i.e. the request carried no session
 * cookie whatsoever. See the header for why a stale cookie must not get here.
 */
async function resolveForToken(presented: string | null): Promise<CallerResolution | null> {
  const secret = authSecret();
  const resolution =
    secret === null
      ? null
      : await resolveCaller({
          token: presented,
          secret,
          lookup: prismaSessionLookup(getPrisma()),
          clock: systemClock,
        });
  if (resolution !== null) return resolution;
  if (presented !== null) return null;

  const devUserId = devIdentity({
    nodeEnv: process.env.NODE_ENV,
    allowFlag: process.env.ORRERY_ALLOW_DEV_IDENTITY,
    userId: process.env.ORRERY_DEV_USER_ID,
  });
  if (devUserId === null) return null;

  // LOUD, ONCE. An identity that silently substitutes itself for a session is the exact failure
  // TM-01 describes, and a warning nobody sees is not much better than none.
  if (!devIdentityWarned) {
    devIdentityWarned = true;
    authLog.warn(
      'ORRERY_DEV_USER_ID is acting as the caller because ORRERY_ALLOW_DEV_IDENTITY=true. ' +
        'Every unauthenticated request is being served as one user. Never set either in a ' +
        'deployed environment; this path is refused outright when NODE_ENV=production.',
    );
  }
  return {
    caller: { kind: 'dev', userId: devUserId, sessionId: null, familyId: null },
    setCookie: null,
  };
}

/**
 * The `SessionLookup` over Prisma.
 *
 * Every method is the narrow thing the policy asked for and nothing more — the policy never sees
 * a client it can start a transaction on, which is the reason `@orrery/db` exists and the reason
 * this is an implementation of an interface rather than a dependency on Prisma's types.
 */
export function prismaSessionLookup(db: PrismaClient): SessionLookup {
  return {
    async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
      return db.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          familyId: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedReason: true,
        },
      });
    },

    async slide(sessionId: string, expiresAt: Date, now: Date): Promise<void> {
      // `lastSeenAt` is written HERE and nowhere else on this path: `Session.lastSeenAt` is
      // documented as written on a slide rather than on every request precisely because an
      // UPDATE per request on the hottest table during an assessment window is a real cost for a
      // field a human reads once a month.
      await db.session.update({
        where: { id: sessionId },
        data: { expiresAt, lastSeenAt: now },
      });
    },

    /**
     * REVOKE THE FAMILY AND BUMP THE EPOCH IN ONE TRANSACTION.
     *
     * Two statements, and the atomicity is the requirement rather than tidiness. A revoke that
     * commits without the epoch bump leaves every replica's cache serving a dead session for its
     * remaining TTL, which is the C25 defect re-introduced through the back door by writing the
     * right statements in the wrong order. The epoch moves unconditionally — a user with no live
     * rows can still have this session in somebody else's cache.
     */
    async revokeFamily(input): Promise<void> {
      await db.$transaction(async (tx) => {
        await tx.session.updateMany({
          where: { userId: input.userId, familyId: input.familyId, revokedAt: null },
          data: { revokedAt: input.now, revokedReason: input.reason },
        });
        await tx.user.update({
          where: { id: input.userId },
          data: { sessionsEpoch: { increment: 1 } },
        });
      });
    },

    /**
     * A signal, recorded as ONE ROW THAT INCREMENTS.
     *
     * Never throws. This is called on the request path for a caller presenting a revoked token,
     * and an audit write that turns a security refusal into a 500 helps nobody — the refusal
     * already happened and must stand regardless of whether the row was written.
     */
    async raiseSecurityEvent(event): Promise<void> {
      try {
        await db.securityEvent.upsert({
          where: { dedupeKey: event.dedupeKey },
          create: { kind: event.kind, userId: event.userId, dedupeKey: event.dedupeKey },
          update: { occurrences: { increment: 1 } },
        });
      } catch (error) {
        authLog.error('could not write the revokedTokenReuse security event', {
          kind: event.kind,
          error,
        });
      }
    },
  };
}
