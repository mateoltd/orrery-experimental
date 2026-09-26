/**
 * `grant` and `deny` — the only two ways a decision is constructed.
 *
 * They exist as functions rather than inline object literals so that the kernel-enforced
 * obligations can be *checked at construction time*. A rule cannot return
 * `allowed: true` while claiming to require MFA without a verified factor, because
 * `grant()` refuses to build that decision.
 *
 * That is the contradiction check from P1-T6 DONE, made un-bypassable at the type level
 * rather than discovered by a test that enumerates a grid. The grid test still exists — it
 * proves the *rules* never ask for this — but the type makes the mistake unrepresentable
 * from the other direction.
 */

import type {
  Actor,
  Context,
  Decision,
  DenyCode,
  KernelObligation,
  Obligation,
  Subject,
} from './types.js';

export function deny(reason: DenyCode): Decision {
  return { allowed: false, reason };
}

/**
 * Obligations the kernel promises to have checked. A rule asks for them; `can()` verifies
 * them against the actual actor and downgrades to a deny if unmet.
 */
export const GRANT_REQUIRES = [
  'requireMfa',
  'noSelfGrade',
  'sameClassroom',
] as const satisfies readonly KernelObligation[];

export function grant(obligations: readonly Obligation[] = []): Decision {
  return { allowed: true, obligations: [...obligations] };
}

/** Is `o` one the kernel enforces itself (as opposed to merely reporting)? */
export function isKernelEnforced(o: Obligation): o is KernelObligation {
  return (GRANT_REQUIRES as readonly string[]).includes(o);
}

/**
 * Verify the obligations the kernel claims to enforce.
 *
 * Returns a deny reason, or `null` if every obligation is satisfied. A missing field is a
 * DENY, not a pass: `sameClassroom` with no `scopeClassroomId` cannot be shown to hold, and
 * a permission that cannot be shown to hold is not a permission.
 */
export function checkKernelObligations(
  obligations: readonly Obligation[],
  actor: Actor,
  subject: Subject,
  context: Context | undefined,
): DenyCode | null {
  for (const o of obligations) {
    switch (o) {
      case 'requireMfa':
        if (!actor.mfaVerified) return 'lastActorMfa';
        break;
      case 'noSelfGrade':
        if (context?.subjectOwnerId !== undefined && context.subjectOwnerId === actor.id)
          return 'notSelf';
        break;
      case 'sameClassroom': {
        const scope = context?.scopeClassroomId;
        if (scope === undefined) return 'wrongClassroom';
        if (subject.owningClassroomId !== undefined && subject.owningClassroomId !== scope) {
          return 'wrongClassroom';
        }
        if (subject.owningClassroomId === undefined) return 'wrongClassroom';
        if (!context?.actorClassroomIds?.has(scope)) return 'notMember';
        break;
      }
      // Service-enforced obligations pass through: the kernel reports them, the caller
      // asserts them. FALLTHROUGH is deliberate and commented, because a silent default
      // here would be a new obligation silently unenforced.
      default:
        break;
    }
  }
  return null;
}
