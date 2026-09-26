/**
 * STRUCTURAL proofs about the matrix.  (P1-T6 Do 1–2, plans/13 §3.3, D-14)
 *
 * These tests do not judge whether the rules are RIGHT — `adversarial.test.ts` does that.
 * They prove the matrix is TOTAL, that its claim list is honest, and that it never grants
 * something it also says is required. Together they are what makes "every cell has a test"
 * true rather than aspirational.
 *
 * ## The D-14 contract
 *
 * Each later phase adds resource types. The contract is that the totality test FAILS before
 * the rules are added and PASSES after. `implementation-claim-is-honest` below is the test
 * that makes that true: adding a type to `IMPLEMENTED_TYPES` without writing its rules fails
 * here, naming the exact type and action.
 */

import { describe, expect, it } from 'vitest';
import { can, assertObligations, missingObligations } from '../can.js';
import { checkKernelObligations, isKernelEnforced } from '../decide.js';
import { MATRIX, cells } from '../matrix.js';
import {
  ACTIONS,
  ALL_RESOURCE_TYPES,
  IMPLEMENTED_TYPES,
  KERNEL_ENFORCED_OBLIGATIONS,
  ROLES,
  SERVICE_ENFORCED_OBLIGATIONS,
  type Actor,
  type CanInput,
  type Obligation,
  type Role,
  type Subject,
} from '../types.js';

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u-1',
  roles: ['student'] as readonly Role[],
  mfaVerified: false,
  suspended: false,
  ...over,
});

/** A subject that carries every field, so no rule can pass by accident of a missing field. */
const subject = (over: Partial<Subject> = {}): Subject => ({
  type: 'User',
  id: 'u-2',
  owningClassroomId: 'c-1',
  ownerId: 'u-2',
  ...over,
});

describe('totality — every claimed (action, type) pair has a rule', () => {
  it('every action has a rule for every implemented type', () => {
    const missing: string[] = [];
    for (const type of IMPLEMENTED_TYPES) {
      const rules = (MATRIX as Record<string, Record<string, unknown>>)[type];
      for (const action of ACTIONS) {
        if (typeof rules?.[action] !== 'function') missing.push(`${type}/${action}`);
      }
    }
    // Naming the missing pairs is the whole value of this assertion. A bare
    // `expect(missing).toHaveLength(0)` tells a developer nothing about where to look.
    expect(missing, `matrix has no rule for: ${missing.join(', ')}`).toEqual([]);
  });

  it('every action appears exactly once per type — no duplicates hiding a gap', () => {
    for (const type of IMPLEMENTED_TYPES) {
      const rules = (MATRIX as Record<string, Record<string, unknown>>)[type];
      expect(Object.keys(rules).sort(), `${type} keys`).toEqual([...ACTIONS].sort());
    }
  });
});

describe('the implementation claim is honest', () => {
  it('IMPLEMENTED_TYPES is a subset of ALL_RESOURCE_TYPES', () => {
    const known = new Set<string>(ALL_RESOURCE_TYPES);
    for (const t of IMPLEMENTED_TYPES) {
      expect(known.has(t), `${t} is claimed but is not a real resource type`).toBe(true);
    }
  });

  it('the matrix implements EXACTLY the claimed types — no extras, no omissions', () => {
    // The two halves are different mistakes: a key in the matrix that nobody claimed (a
    // type nobody will ever audit) and a claim with no key (a type that silently denies).
    expect(Object.keys(MATRIX).sort()).toEqual([...IMPLEMENTED_TYPES].sort());
  });

  it('every claimed type is a type the plan actually plans for', () => {
    // Guards the list against drift when P4/P5/P8 append to it. If a type is claimed that
    // the plan never mentions, either the plan or the claim is wrong.
    expect(IMPLEMENTED_TYPES.length).toBeLessThanOrEqual(ALL_RESOURCE_TYPES.length);
  });
});

describe('no cell grants allowed:true with a contradictory obligation', () => {
  /**
   * The grid. Every (action, type, role, mfa, membership) combination, which is 2 types ×
   * 22 actions × 4 roles × 2 mfa states = 352 evaluations. Small enough to be exhaustive,
   * large enough that a hand-written spot check would miss a branch.
   *
   * The property: if `can()` returns allowed, then every KERNEL-ENFORCED obligation on the
   * decision is actually satisfied by the actor and subject that produced it. A cell that
   * asked for `requireMfa` from an actor with no verified factor, and was granted anyway,
   * would be a permission that does not require what it claims to require.
   */
  it('holds across the full grid of roles, MFA states and memberships', () => {
    const violations: string[] = [];

    for (const { type, action } of cells()) {
      for (const role of ROLES) {
        for (const mfaVerified of [true, false]) {
          for (const member of [true, false]) {
            const input: CanInput = {
              actor: actor({ roles: [role], mfaVerified }),
              action,
              subject: subject({ type }),
              context: {
                scopeClassroomId: 'c-1',
                actorClassroomIds: member ? new Set(['c-1']) : new Set<string>(),
                subjectOwnerId: 'u-2',
              },
            };
            const d = can(input);
            if (!d.allowed) continue;
            const unmet = checkKernelObligations(d.obligations, input.actor!, input.subject, input.context);
            if (unmet !== null) {
              violations.push(
                `${action}/${type}/${role}/mfa=${mfaVerified}/member=${member} ` +
                  `granted with unmet ${d.obligations.filter(isKernelEnforced).join(',')} (${unmet})`,
              );
            }
          }
        }
      }
    }

    expect(violations, `contradictory grants:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('every obligation name is either kernel-enforced or service-enforced — never neither', () => {
    // A typo'd obligation would satisfy every structural check and enforce nothing. This is
    // the cheapest possible guard against the most expensive possible bug.
    const known = new Set<string>([...KERNEL_ENFORCED_OBLIGATIONS, ...SERVICE_ENFORCED_OBLIGATIONS]);
    const seen = new Set<Obligation>();
    for (const { type, action } of cells()) {
      const d = can({
        actor: actor({ roles: ['platformAdmin'], mfaVerified: true }),
        action,
        subject: subject({ type }),
        context: { scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1']) },
      });
      if (d.allowed) for (const o of d.obligations) seen.add(o);
    }
    for (const o of seen) {
      expect(known.has(o), `obligation "${o}" is in neither the kernel-enforced nor the service-enforced set`).toBe(true);
    }
  });
});

describe('an unrecognised pair is loud in development and safe in production', () => {
  const unknown: Subject = { type: 'Classroom', id: 'c-1' };

  it('throws in development, naming the pair', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      expect(() => can({ actor: actor(), action: 'read', subject: unknown })).toThrowError(
        /action=read, type=Classroom/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('denies in production, because a throw there is an outage and an allow is a breach', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(can({ actor: actor(), action: 'read', subject: unknown })).toEqual({
        allowed: false,
        reason: 'unknownPair',
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('treats a non-function cell as unknown too, rather than calling it', () => {
    // A `null` or `{}` placeholder where a rule belongs must fail the same way a missing one
    // does, not throw `TypeError: rule is not a function` from inside the kernel.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      (MATRIX as Record<string, unknown>).Probe = { read: null };
      expect(can({ actor: actor(), action: 'read', subject: { type: 'Probe' as never, id: 'x' } }))
        .toEqual({ allowed: false, reason: 'unknownPair' });
    } finally {
      delete (MATRIX as Record<string, unknown>).Probe;
      process.env.NODE_ENV = prev;
    }
  });
});

describe('obligations are assertable at the call site', () => {
  // The context is REQUIRED, not decorative: `publish` on a classroom-scoped asset now
  // carries the `sameClassroom` obligation, and a grant with no scope to check is a deny.
  // This test was written before that obligation existed and failed with a DENY — which was
  // the rule working, not the test being wrong.
  const granted = can({
    actor: actor({ roles: ['teacher'] }),
    action: 'publish',
    subject: subject({ type: 'Asset', id: 'a-1' }),
    context: { scopeClassroomId: 'c-1', actorClassroomIds: new Set(['c-1']) },
  });
  it('the publish grant is actually a grant (guards the fixtures below from silently testing a DENY)', () => {
    expect(granted.allowed).toBe(true);
  });

  it('assertObligations passes when the obligation is present', () => {
    expect(() => assertObligations(granted, ['twoPersonRelease'])).not.toThrow();
  });

  it('assertObligations throws when the obligation is missing — the "granted here, relied on there" bug', () => {
    // `retainEvidence` is genuinely absent from a publish grant. It was `sameClassroom` in an
    // earlier draft of this test, which stopped testing anything once `publish` began
    // carrying that obligation — a test that stops failing is worse than no test.
    expect(() => assertObligations(granted, ['retainEvidence'])).toThrowError(/retainEvidence/);
  });

  it('the publish grant really does carry sameClassroom, audit and twoPersonRelease', () => {
    if (!granted.allowed) throw new Error('expected a grant');
    expect([...granted.obligations].sort()).toEqual(['audit', 'sameClassroom', 'twoPersonRelease']);
  });

  it('assertObligations throws when handed a DENY', () => {
    const denied = can({ actor: null, action: 'read', subject: subject() });
    expect(() => assertObligations(denied, ['audit'])).toThrowError(/DENY/);
  });

  it('missingObligations returns the list instead of throwing', () => {
    expect(missingObligations(granted, ['twoPersonRelease', 'retainEvidence']))
      .toEqual(['retainEvidence']);
    expect(missingObligations(can({ actor: null, action: 'read', subject: subject() }), ['audit']))
      .toEqual(['audit']);
  });
});
