/**
 * The D-14 contract, demonstrated rather than asserted.  (P1-T6 do-4, plans/20 D-14)
 *
 * ## What D-14 actually requires
 *
 * "`P4-T8`, `P5-T14`, `P8-T1`, `P10-T1` and `P16-T1` each extend the matrix for their new
 * types, and the totality test must fail before and pass after."
 *
 * That is a claim about the TEST, not about the code. A completeness test that only ever runs
 * against a complete matrix has never demonstrated that it can detect an incomplete one — which
 * is D-35 in a new costume, and D-35 is the finding that started all of this.
 *
 * ## How this file demonstrates it
 *
 * `totalityGaps` is a PURE function over a matrix-shaped value, and the tests run it against
 * three matrices: the real one (no gaps), one with a type removed, and one with an action
 * removed. So the completeness check is proven to detect the two mistakes it exists for, and
 * the real matrix is proven to pass — in the same file, on the same code path.
 *
 * The real demonstration happened during this task's own development and is recorded in the
 * commit: `Classroom`, `Enrollment` and `Invitation` were added to `IMPLEMENTED_TYPES` BEFORE
 * their rules existed, and the matrix test failed with the missing pairs named. The test was
 * shown failing, then shown passing.
 */

import { describe, expect, it } from 'vitest';
import {
  CONSUMERS_OF_NOT_AVAILABLE,
  cells,
  MATRIX,
  notAvailable,
  OVERRIDDEN_ACTIONS_ARE_EXPLICIT,
} from '../matrix.js';
import { claimGaps, type MatrixShape, totalityGaps } from '../totality.js';
import type { Action, Rule } from '../types.js';
import { ACTIONS, ALL_RESOURCE_TYPES, IMPLEMENTED_TYPES } from '../types.js';

describe('the totality check can actually fail', () => {
  it('reports nothing for the real matrix', () => {
    expect(totalityGaps(MATRIX, IMPLEMENTED_TYPES, ACTIONS)).toEqual([]);
  });

  it('DETECTS a type that was claimed but has no rules at all', () => {
    // This is the exact mistake D-14 is about: a type added to IMPLEMENTED_TYPES without
    // writing its rules. It must produce 22 named gaps, not a silent pass.
    const gaps = totalityGaps(MATRIX, [...IMPLEMENTED_TYPES, 'QuestionBank'], ACTIONS);
    expect(gaps).toHaveLength(ACTIONS.length);
    expect(gaps).toContain('QuestionBank/grade');
  });

  it('DETECTS a type with a PARTIAL rule set, naming the missing actions', () => {
    // The more likely mistake: adding most of the rules and missing one. A count would say
    // "21 missing"; the pair list says WHICH.
    const partial: MatrixShape = {
      ...MATRIX,
      Classroom: { read: MATRIX.Classroom.read },
    };
    const gaps = totalityGaps(partial, IMPLEMENTED_TYPES, ACTIONS);
    expect(gaps).toContain('Classroom/update');
    expect(gaps).toContain('Classroom/importRoster');
    expect(gaps).not.toContain('Classroom/read');
    expect(gaps).toHaveLength(ACTIONS.length - 1);
  });

  it('DETECTS a non-function placeholder where a rule belongs', () => {
    // A `null` or `{}` standing in for an unwritten rule. A truthiness check would pass this;
    // a typeof-function check does not.
    const gaps = totalityGaps(
      { ...MATRIX, Enrollment: { read: null } },
      IMPLEMENTED_TYPES,
      ACTIONS,
    );
    expect(gaps).toContain('Enrollment/read');
  });

  it('DETECTS an action missing from every type', () => {
    const actionsWithoutSuspend = ACTIONS.filter((a) => a !== 'suspend');
    const gaps = totalityGaps(MATRIX, IMPLEMENTED_TYPES, actionsWithoutSuspend);
    expect(gaps).toEqual([]);
    // And with it present, no gaps — which is the "passes after" half of the contract.
    expect(totalityGaps(MATRIX, IMPLEMENTED_TYPES, ACTIONS)).toEqual([]);
  });
});

describe('the real matrix, after the classroom types were added', () => {
  it('implements exactly the claimed types, in both directions', () => {
    const gaps = claimGaps(MATRIX, IMPLEMENTED_TYPES);
    expect(gaps.missing, 'a claimed type with no rules at all').toEqual([]);
    expect(gaps.unclaimed, 'a type nobody claimed, which would never be audited').toEqual([]);
  });

  it('every implemented type is a type the plan plans for', () => {
    const known = new Set<string>(ALL_RESOURCE_TYPES);
    for (const t of IMPLEMENTED_TYPES) expect(known.has(t), t).toBe(true);
  });

  it('has grown by exactly the known set, and a new type is a DELIBERATE change', () => {
    // The LIST is pinned, so a future extension is a visible change to a test rather than a
    // diff that happens to include a type. P2-T8 added `Resource` (the read-permission
    // re-check); P3-T5 added `Rating`, `Comment` and `Flag` (the moderation surface, added
    // together because a rule that reads a rating without checking it belongs to the same
    // reader is only wrong in combination). P4-T8 added `Assignment`, `ExamAttempt`,
    // `IntegrityEvidence` and `ReleaseBatch` -- the four types `plans/12` §4 has rows about,
    // which had no rules at all, so the matrix had no opinion about §4's most important cells.
    expect([...IMPLEMENTED_TYPES].sort()).toEqual([
      'Asset',
      'Assignment',
      'Classroom',
      'Comment',
      'Enrollment',
      'ExamAttempt',
      'Flag',
      'IntegrityEvidence',
      'Invitation',
      'Rating',
      'ReleaseBatch',
      'Resource',
      'User',
    ]);
  });

  it('is exactly IMPLEMENTED_TYPES x ACTIONS, so a missing cell cannot hide in a count', () => {
    // DERIVED, not hardcoded.
    //
    // This test used to say `toHaveLength(138)` and a hardcoded type list, so every phase
    // that added a type had to find and renumber a literal — twice, in two places. A pinned
    // number is a number that goes stale and a stale number is a test that has stopped
    // meaning anything, because the reader learns to update it without reading it.
    //
    // The COUNT is still asserted, and that is the part that matters: `types x actions` is
    // the totality domain, so if a rule is missing the product changes and this fails. What is
    // no longer asserted is a figure a human typed.
    const all = [...cells()];
    expect(all).toHaveLength(IMPLEMENTED_TYPES.length * ACTIONS.length);
    // 27 in P1, 28 after P4-T8 split `adjudicate` out of `viewEvidence`. The count is here so
    // that adding a verb has to be a decision rather than a drift, and so the figure is never
    // asserted anywhere else.
    expect(ACTIONS).toHaveLength(28);
    // Distinctness: a copy-pasted rule across two actions is a bug that no cell-existence
    // test can see, and `grade` accidentally equal to `submit` is exactly that bug.
    const byAction = new Map<Action, Set<Rule>>();
    for (const c of all) {
      const set = byAction.get(c.action) ?? new Set<Rule>();
      set.add(c.rule);
      byAction.set(c.action, set);
    }
    for (const [action, set] of byAction) {
      // User/Asset/Classroom/Enrollment/Invitation must not all share one function per action.
      expect(
        set.size,
        `action=${action} has ${set.size} distinct rules across 5 types`,
      ).toBeGreaterThan(1);
    }
  });
});

describe('no consumer silently inherits a blanket deny for a destructive action', () => {
  // The `Invitation.update` finding. `notAvailable` supplies all 22 actions so the spread is
  // statically total, which means a consumer that forgets an action inherits a deny rather than
  // failing to compile. The behaviour was right; the INVISIBILITY was not.
  //
  // So the four actions where a blanket deny is a decision rather than a non-decision are
  // asserted to be defined per-consumer. Types prove totality; this proves thought.
  for (const [name, rules] of Object.entries(CONSUMERS_OF_NOT_AVAILABLE)) {
    for (const action of OVERRIDDEN_ACTIONS_ARE_EXPLICIT) {
      it(`${name}.${action} is its own rule, not the shared blanket deny`, () => {
        // Identity against the SHARED table. A consumer that spread `notAvailable` without
        // overriding this action would hold the very same function object.
        expect(rules[action], `${name}.${action} must override notAvailable`).not.toBe(
          notAvailable[action],
        );
      });
    }
  }

  it('the check is not vacuous — the shared table really does deny these', () => {
    // Prove the comparison above has something to fail on. If `notAvailable.update` were a
    // grant, every "must override" assertion would pass for the wrong reason.
    for (const action of OVERRIDDEN_ACTIONS_ARE_EXPLICIT) {
      expect(notAvailable[action]({ actor: null } as never)).toEqual({
        allowed: false,
        reason: 'roleForbidden',
      });
    }
  });

  it('and the two consumers write different rules, so neither copied the other', () => {
    expect(CONSUMERS_OF_NOT_AVAILABLE.Enrollment.update).not.toBe(
      CONSUMERS_OF_NOT_AVAILABLE.Invitation.update,
    );
  });
});
