/**
 * The grader, in bare Node.  (P6-T11, gold sim 18)
 *
 * ## THE TESTS THAT MATTER ASSERT THE ABSENCE OF A DECISION
 *
 * Every other gold sim's grader tests assert that it awarded the RIGHT number of points. This one asserts
 * that it awarded none, said so, and reported the student's claims faithfully. A grader that quietly scored
 * 4 for a textbook answer would fail most of these, and that is the intended direction of the failure.
 */
import { describe, expect, it } from 'vitest';
import sim, { claimsFrom, rubricReview, rubricSummary } from '../src/grader.js';
import { clamp, describeForces, forcesFor, netForce, weightNewtons } from '../src/model.js';

const PARAMS = clamp({ mass: 2, friction: 3 });

const THREE = {
  claims: [
    { claim: 'weight of 19.62 N pointing down', evidence: 'entered 19.62' },
    { claim: 'normal force of 19.62 N pointing up', evidence: 'entered 19.62' },
    { claim: 'friction of 3 N pointing left', evidence: 'entered 3' },
  ],
};

const grade = (answer: unknown, params = PARAMS) => sim.grader.grade(null, params, answer);

describe('physics.free-body-diagram grading', () => {
  it('AWARDS NOTHING EVEN FOR A PERFECT DIAGRAM', () => {
    // The point of the whole simulation. A rubric-marked item must not look machine-scored, and a grader
    // returning 4 here would produce exactly that.
    const result = grade(THREE);
    expect(result.points).toBe(0);
    expect(result.maxPoints).toBe(4);
    expect(result.strategy).toBe('RUBRIC');
  });

  it('SAYS IN ITS OWN REASON THAT A PERSON DECIDES', () => {
    // A zero with no explanation is a mark a student cannot appeal, and the SDK refuses those. The reason
    // must carry the band structure or a marker has nothing to apply.
    const reason = grade(THREE).rationale;
    expect(reason).toMatch(/does not mark its own work/u);
    expect(reason).toMatch(/await a teacher/u);
    expect(reason).toMatch(/4 for all three forces/u);
  });

  it('REPORTS THE CLAIMS VERBATIM, in the order the student made them', () => {
    // The work is what gets marked. A summary that reordered or paraphrased it would be marking something
    // the student did not write.
    const reason = grade(THREE).rationale;
    expect(reason.indexOf('weight of 19.62')).toBeLessThan(reason.indexOf('normal force'));
    expect(reason.indexOf('normal force')).toBeLessThan(reason.indexOf('friction of 3'));
  });

  it('GIVES THE MARKER COUNTS AND NOT A SCORE', () => {
    expect(grade(THREE).rationale).toMatch(/3 claim\(s\) await a teacher/u);
    expect(grade(THREE).rationale).toMatch(/3 of 3 named/u);
  });

  it('NAMES A FORCE THAT DOES NOT ACT, rather than quietly ignoring it', () => {
    // A review reporting only "3 of 3" would hide a fourth arrow. Not-acting is the count whose absence
    // makes a review worthless.
    const withExtra = {
      claims: [...THREE.claims, { claim: 'tension of 4 N pointing right', evidence: '4' }],
    };
    expect(grade(withExtra).rationale).toMatch(/not acting in this scenario: tension/u);
  });

  it('DISTINGUISHES "NOTHING SUBMITTED" from "SUBMITTED AND AWAITING A MARKER"', () => {
    // Two different facts about the release, and conflating them loses the one a data report needs.
    expect(grade(null).rationale).toMatch(/No free-body diagram was submitted/u);
    expect(grade({ claims: [] }).rationale).toMatch(/No free-body diagram was submitted/u);
    expect(grade(THREE).rationale).toMatch(/does not mark its own work/u);
  });

  it('NEVER ASSERTS A CLAIM IS CORRECT', () => {
    // `correct: false` would be the simulation reporting a judgement it never made. Every claim is `null`.
    for (const claim of claimsFrom(THREE)) expect(claim.correct).toBeNull();
  });

  it("keeps the student's own wording in the EVIDENCE field", () => {
    // A teacher reads this, not the simulation, so the evidence is not regenerated.
    const [claim] = claimsFrom({
      claims: [{ claim: 'a force', evidence: '  I think it is the weight  ' }],
    });
    expect(claim?.evidence).toBe('I think it is the weight');
  });

  it('DROPS A BLANK CLAIM rather than submitting an empty one', () => {
    // An empty row is not a claim, and a marker reading "1. ; 2. friction" has been handed noise.
    expect(
      claimsFrom({ claims: [{ claim: '   ' }, { claim: 'friction of 3 N left' }] }),
    ).toHaveLength(1);
  });

  it('REJECTS A NON-ARRAY `claims` WITHOUT THROWING', () => {
    // The answer arrives off a wire and nothing guarantees its shape. A grader that threw would take the
    // whole submission down instead of degrading to "nothing was submitted".
    expect(claimsFrom({ claims: 'friction' })).toEqual([]);
    expect(claimsFrom('nonsense')).toEqual([]);
    expect(claimsFrom(7)).toEqual([]);
    expect(grade({ claims: 7 }).rationale).toMatch(/No free-body diagram was submitted/u);
  });

  it('PUBLISHES ITS BANDS to the student', () => {
    // A rubric a student cannot read before submitting is applied to them rather than with them.
    expect(rubricSummary).toMatch(/4 — all three forces/u);
    expect(rubricSummary).toMatch(/1 — one of the three forces/u);
  });

  it('COUNTS an invented force as neither right nor acting', () => {
    const review = rubricReview(['weight', 'normal force', 'friction', 'tension'], PARAMS);
    expect(review.named).toBe(4);
    expect(review.expected).toBe(3);
    expect(review.right).toBe(3);
    expect(review.notActing).toEqual(['tension']);
  });
});

describe('the scenario is an EQUILIBRIUM case', () => {
  // If this stops holding, the prompt asks students to look for a resultant that does not exist.
  it('has ZERO VERTICAL net force, because weight and normal cancel', () => {
    expect(forcesFor(PARAMS).map((force) => force.name)).toEqual([
      'weight',
      'normal force',
      'friction',
    ]);
    expect(netForce(forcesFor(PARAMS).filter((force) => force.component !== 'right'))).toBe(0);
  });

  it('includes the NORMAL FORCE, which most mistakes leave out', () => {
    expect(forcesFor(PARAMS).map((force) => force.name)).toContain('normal force');
  });

  it('WEIGHTS WITH g = 9.81, NOT g = 10', () => {
    // The whole point of a real constant: a 2 kg crate is 19.62 N and not 20. Whether a student who rounds
    // to 20 deserves the marks is a RUBRIC judgement, which is why this is not a tolerance simulation.
    expect(weightNewtons(2)).toBe(19.62);
    expect(weightNewtons(2)).not.toBe(20);
    expect(weightNewtons(7.5)).toBe(73.58);
  });

  it('reports 2 DECIMALS, so 19.62 is not flattened to 19.6', () => {
    expect(weightNewtons(1)).toBe(9.81);
    expect(weightNewtons(0.5)).toBe(4.91);
  });
});

describe('the text alternative describes the task WITHOUT answering it', () => {
  it('does not give away the weight, which is half the question', () => {
    const text = describeForces(PARAMS);
    // The mass and the friction are the question's own inputs and belong here. The WEIGHT is the
    // calculation, and `19.62` appearing there hands over the number a student is asked to derive.
    expect(text).toMatch(/2 kg/u);
    expect(text).toMatch(/3 N/u);
    expect(text).not.toContain('19.62');
    expect(text).toMatch(/CONSTANT SPEED/u);
  });
});
