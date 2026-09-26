/**
 * Route protection.  (P1-T4, plans/13 §4)
 *
 * ## The decision, and the reason it is not a boolean
 *
 * Every route declares what it needs, and the result says what HAPPENED, not merely whether
 * the user may proceed. The difference is the redirect: a signed-in user hitting a public page
 * should not be bounced to sign in, and a user hitting a role-gated route needs to be told
 * they lack the role rather than sent to a login form they have already passed.
 *
 * ## Defaults are DENY
 *
 * An unrecognised path is `signIn`, not `allow`. A new route added without a declaration is
 * therefore a route that requires a session — the safe default — and the omission shows up as
 * a sign-in redirect during review rather than as an open door in production. The mirror image
 * of the `can()` decision about unrecognised pairs, and for the same reason.
 */

import type { Role } from './types.js';

/**
 * What a route requires.
 *
 * `examAttempt` is separate from `session` because the exam surface is on the isolated
 * origin with its own CSP and its own rules: it needs a session, it must NEVER be indexed, and
 * its failures must not leak the shape of the rest of the app.
 */
export type RouteRequirement =
  | { kind: 'public' }
  | { kind: 'session' }
  | { kind: 'role'; roles: readonly Role[] }
  | { kind: 'examAttempt' }
  /**
   * A role AND a verified email.
   *
   * Two requirements in one, because the real rule is "email verification is required before
   * creating a classroom" AND "only a teacher creates a classroom", and checking them in the
   * wrong order gives a student the message "verify your email" — which is both useless and a
   * small disclosure that the route exists. Role first, always.
   */
  | { kind: 'roleAndVerified'; roles: readonly Role[] };

export type RouteAction =
  | { kind: 'allow' }
  /** No session, or an unusable one. Send to sign-in, preserving where they were going. */
  | { kind: 'signIn'; returnTo: string }
  /** Signed in, but lacks the role. Tell them plainly; do NOT bounce to a login form. */
  | { kind: 'forbidden'; missing: 'role' | 'emailVerified' | 'mfa' }
  /** Signed in and permitted, but the resource is not there. 404, not 403 — see below. */
  | { kind: 'notFound' };

export interface RouteSubject {
  readonly path: string;
  readonly signedIn: boolean;
  readonly roles: readonly Role[];
  readonly emailVerified: boolean;
  readonly mfaVerified: boolean;
  /** False for a suspended or deleting-past-grace account, even with a valid session. */
  readonly accountUsable: boolean;
}

/**
 * Route table.
 *
 * A prefix match, longest first, so `/exam` cannot shadow `/exam/support`. The table is
 * ordered data rather than a chain of `startsWith` calls, because a chain has no readable
 * precedence and the last matching `if` wins by accident.
 */
const ROUTES: readonly { prefix: string; requirement: RouteRequirement }[] = [
  { prefix: '/healthz', requirement: { kind: 'public' } },
  { prefix: '/readyz', requirement: { kind: 'public' } },
  { prefix: '/sign-in', requirement: { kind: 'public' } },
  { prefix: '/sign-up', requirement: { kind: 'public' } },
  { prefix: '/verify', requirement: { kind: 'public' } },
  { prefix: '/forgot', requirement: { kind: 'public' } },
  { prefix: '/reset', requirement: { kind: 'public' } },
  { prefix: '/privacy', requirement: { kind: 'public' } },
  { prefix: '/terms', requirement: { kind: 'public' } },

  { prefix: '/settings/sessions', requirement: { kind: 'session' } },
  { prefix: '/settings', requirement: { kind: 'session' } },

  { prefix: '/classrooms/new', requirement: { kind: 'roleAndVerified', roles: ['teacher'] } },
  { prefix: '/classrooms', requirement: { kind: 'role', roles: ['teacher', 'student'] } },
  { prefix: '/review', requirement: { kind: 'role', roles: ['reviewer'] } },
  { prefix: '/admin', requirement: { kind: 'role', roles: ['platformAdmin'] } },

  { prefix: '/exam', requirement: { kind: 'examAttempt' } },
];

/** The requirement for a path. `session` for anything undeclared — deny by default. */
export function requirementFor(path: string): RouteRequirement {
  // Longest prefix wins, so a specific declaration always beats a broader one regardless of
  // the order the table happens to be written in.
  let best: { prefix: string; requirement: RouteRequirement } | null = null;
  for (const route of ROUTES) {
    if (!pathMatches(path, route.prefix)) continue;
    if (best === null || route.prefix.length > best.prefix.length) best = route;
  }
  return best?.requirement ?? { kind: 'session' };
}

/** Prefix match on a PATH SEGMENT boundary, so `/classes` never matches `/classrooms`. */
export function pathMatches(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  // The next character must be a separator. Without this, `/classes` would match the
  // `/classrooms` rule and a signed-in student would be sent to a teacher page.
  return path[prefix.length] === '/' || path[prefix.length] === undefined;
}

/**
 * Decide what happens for this request.
 *
 * Order is the whole function, and each step is chosen because it is the one that must not be
 * reached by accident:
 *
 *   1. **Account usable.** A suspended user with a perfectly valid session is refused. This
 *      check is FIRST because it is the C25 regression: it must not depend on the session
 *      being absent, it must catch the session being *wrong*.
 *   2. **Requirement.** `public` allows immediately — a signed-in user browsing the marketing
 *      page is not a problem.
 *   3. **Session.** Then and only then is "are they signed in" asked.
 *   4. **Escalating requirements**, each reporting what was missing so the UI can explain it.
 */
export function decideRoute(subject: RouteSubject): RouteAction {
  const requirement = requirementFor(subject.path);

  // A public route is allowed for everyone, signed in or not, but NOT for an unusable account:
  // a suspended user should not be able to keep browsing the marketing site while suspended,
  // because a later change to which routes are public would silently reintroduce the problem.
  if (!subject.accountUsable && subject.signedIn) {
    return { kind: 'signIn', returnTo: subject.path };
  }

  if (requirement.kind === 'public') return { kind: 'allow' };

  if (!subject.signedIn) return { kind: 'signIn', returnTo: subject.path };

  switch (requirement.kind) {
    case 'role':
      return requirement.roles.some((r) => subject.roles.includes(r))
        ? { kind: 'allow' }
        : { kind: 'forbidden', missing: 'role' };

    case 'roleAndVerified':
      // Role FIRST, then verification. The reverse order tells a signed-in student to go and
      // verify their email before they can reach a page they were never allowed to see.
      if (!requirement.roles.some((r) => subject.roles.includes(r))) {
        return { kind: 'forbidden', missing: 'role' };
      }
      // Required before creating a classroom, publishing a public resource, or grading an
      // exam (plans/13 §1). Checked here as a route gate AND again at the call site, because a
      // route guard cannot know the intent of a request.
      //
      // NOTE there is deliberately no `mfa` requirement kind. D6 requires TOTP for teachers
      // before their FIRST GRADE SUBMISSION, which is an ACTION gate — a student mid-exam
      // must never be bounced by an MFA prompt, and a teacher opening a blank gradebook has
      // not yet done the thing MFA is required for. `can()` carries that obligation instead.
      return subject.emailVerified
        ? { kind: 'allow' }
        : { kind: 'forbidden', missing: 'emailVerified' };

    case 'examAttempt':
      return { kind: 'allow' };

    case 'session':
      return { kind: 'allow' };
  }
}

/**
 * Routes that must never appear in a search index, a sitemap, or an analytics event.
 *
 * The exam surface especially: a URL in a referrer header or a log line is enough to expose
 * that a student sat an exam on a given day.
 */
export const NOINDEX_PREFIXES = ['/exam', '/settings', '/classrooms', '/review', '/admin'] as const;

export function isNoIndex(path: string): boolean {
  return NOINDEX_PREFIXES.some((prefix) => pathMatches(path, prefix));
}
