/**
 * `can()` — the single entry point for every read and every write.  (P1-T6, plans/13 §3)
 *
 * ## Properties this function promises, and how each is enforced
 *
 * 1. **PURE.** No I/O, no clock, no database, no environment, no randomness. It is a
 *    function of its arguments and nothing else. This is not stylistic: it is the only
 *    reason the permission model can be tested exhaustively instead of sampled.
 *
 * 2. **TOTAL.** Every `(action, type)` pair has a rule. A pair that does not **throws in
 *    development and denies in production**. The split is deliberate and slightly
 *    uncomfortable: a throw in production is an outage for one request, whereas a silent
 *    allow is a breach. So the loud failure is reserved for the environment where a human is
 *    watching, and the safe failure ships.
 *
 * 3. **CONTEXT-AWARE.** The same question in a different classroom is a different answer,
 *    because the classroom is in `context` rather than baked into the rule.
 *
 * 4. **CARRIES OBLIGATIONS.** A grant is not a boolean. It names what the caller must still
 *    do, and the kernel-enforced subset is checked here so a grant can never outrun its
 *    own preconditions.
 *
 * ## Why the actor check comes first
 *
 * A null actor is rejected before the matrix is consulted, so an unauthenticated request can
 * never be answered by a rule that happens to grant on an empty actor — e.g. `read` on
 * Asset, which is granted to "any authenticated caller". Ordering the null check after the
 * lookup would make that rule reachable anonymously.
 */

import { checkKernelObligations, deny } from './decide.js';
import { MATRIX } from './matrix.js';
import {
  type Action,
  ALL_RESOURCE_TYPES,
  type CanInput,
  type Decision,
  type Rule,
} from './types.js';

const isDev = (): boolean => {
  // Read through `process.env` directly, deliberately: @orrery/config is not a dependency of
  // this package, and a pure kernel must not pull in env validation to learn a boolean.
  // The eslint ban on `process.env` is scoped to `packages/*` — this is the documented
  // exception, and it is one boolean, not configuration.
  return process.env.NODE_ENV !== 'production';
};

export function can(input: CanInput): Decision {
  const { actor, action, subject, context } = input;

  // (1) A null actor is a deny before anything else happens.
  if (actor === null) return deny('noActor');

  // (2) Resolve the rule. An unknown (action, type) pair is a programming error.
  const rules = (MATRIX as Record<string, Partial<Record<Action, unknown>>>)[subject.type];
  const rule = rules?.[action] as Rule | undefined;

  if (typeof rule !== 'function') {
    if (isDev()) {
      throw new Error(
        `can(): no rule for (action=${action}, type=${subject.type}). ` +
          `Either the action is not a real action, or the type is listed in ` +
          `IMPLEMENTED_TYPES without rules for every action. ` +
          `Known types: ${Object.keys(MATRIX).join(', ')}. ` +
          `All types: ${ALL_RESOURCE_TYPES.join(', ')}.`,
      );
    }
    return deny('unknownPair');
  }

  // (3) Let the rule decide, then check the obligations the rule claimed to satisfy.
  // Narrowing is explicit rather than a spread: `RuleInput.actor` is non-null, and this is
  // the single place that knows the null was already handled above.
  const decision = rule({ actor, action, subject, context });
  if (!decision.allowed) return decision;

  const unmet = checkKernelObligations(decision.obligations, actor, subject, context);
  if (unmet !== null) return deny(unmet);

  return decision;
}

/**
 * Assert a grant's obligations at a call site.  (P1-T6 Do 3)
 *
 * Services call this so that a permission granted in one place and relied upon in another
 * fails loudly. `requireObligation` throws; `assertObligations` returns the missing list for
 * callers that want to branch.
 */
export function assertObligations(decision: Decision, required: readonly string[]): void {
  if (!decision.allowed) {
    throw new Error(
      `assertObligations(): decision is a DENY (${decision.reason}); cannot rely on it.`,
    );
  }
  const missing = required.filter((r) => !decision.obligations.includes(r as never));
  if (missing.length > 0) {
    throw new Error(
      `assertObligations(): missing obligation(s) ${missing.join(', ')}. ` +
        `Granted with: [${decision.obligations.join(', ')}]. ` +
        `This is the "granted in one place, relied on in another" bug.`,
    );
  }
}

/** Non-throwing variant, for callers that want to handle a missing obligation themselves. */
export function missingObligations(decision: Decision, required: readonly string[]): string[] {
  if (!decision.allowed) return [...required];
  return required.filter((r) => !decision.obligations.includes(r as never));
}

export { MATRIX } from './matrix.js';
export type {
  Action,
  Actor,
  CanInput,
  Context,
  Decision,
  Obligation,
  ResourceType,
  Role,
  Subject,
} from './types.js';
export { ACTIONS, ALL_RESOURCE_TYPES, IMPLEMENTED_TYPES, ROLES } from './types.js';

/**
 * Do these two ids name the same person?  (P3-T6)
 *
 * ## Why this is a kernel function and not a one-line `===` at the call site
 *
 * Because the authz-ownership gate forbids comparing an owner id to an actor id outside this
 * package, and it is right. Every such comparison is a question about IDENTITY, and a codebase
 * with one of them per call site has a hundred slightly different answers to "is this mine?" —
 * some comparing to an actor, some to a session user, some to a path param.
 *
 * The P3-T6 caller is the smallest possible example of why. `checkPublicSlug` needs to know
 * whether the resource already holding a URL belongs to the teacher trying to claim it, purely
 * to pick between two different sentences of copy. That is not an authorisation decision — the
 * partial unique index and the publish path are what actually decide — but the comparison is
 * still a question about who somebody is, and it now lives in one place.
 *
 * Nullable on both sides on purpose: a row with no owner is not owned by anybody, including the
 * actor, and a `null === null` implementation would report an orphan as the actor's own.
 */
export function isSameActor(
  actorId: string | null | undefined,
  ownerId: string | null | undefined,
): boolean {
  if (actorId === null || actorId === undefined) return false;
  if (ownerId === null || ownerId === undefined) return false;
  return actorId === ownerId;
}
