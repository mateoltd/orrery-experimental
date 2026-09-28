/**
 * The exam policy.  (P5-T1)
 *
 * ## The tests that matter
 *
 *  · `the plan's own default survives a round trip through the database` — `Infinity` does not,
 *    and the failure mode is the exact opposite of the intent.
 *  · `a FROZEN policy is frozen all the way down` — `Object.freeze` is shallow, and INV-POLICY-1
 *    is about a snapshot that cannot change.
 *  · `extra time is the LARGER of the grant and the right` — C13's fold, and the direction that
 *    matters is the one nobody thinks about.
 *  · `per-question limits summing beyond the total is a WARNING` — INV-POLICY-2 grades one rule
 *    as an error and another as a warning, and a test that does not tell them apart proves
 *    nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  EXAM_PROFILE_DEFAULTS,
  extraTimePercent,
  freezePolicy,
  isPublishable,
  profileFor,
  QUIZ_PROFILE_DEFAULTS,
  readPolicySnapshot,
  resolvePolicy,
  validatePolicy,
} from './index.js';

const ac = (o: Partial<Parameters<typeof resolvePolicy>[0]['accommodation']> = {}) =>
  ({ relaxations: ['EXTRA_TIME'], status: 'ACTIVE', ...o }) as NonNullable<
    Parameters<typeof resolvePolicy>[0]['accommodation']
  >;

describe('exam policy', () => {
  it('the two profiles differ exactly where plans/09 §4.1 says they do', () => {
    const exam = profileFor('EXAM');
    const quiz = profileFor('ASSIGNMENT');
    expect(exam.requireFullscreen).toBe('WARN');
    expect(exam.focusWatchdog).toBe('WARN');
    expect(quiz.requireFullscreen).toBe('OFF');
    expect(quiz.focusWatchdog).toBe('OFF');
    // "Permissive defaults, strict EXAM profile" — a strict global default would break ordinary
    // quizzes, which is the sentence that makes the two-profile design necessary.
    expect(exam.thresholds.focusLosses).toBe(25);
    expect(quiz.thresholds.focusLosses).toBeNull();
    // V-12: a session is never ended automatically.
    expect(exam.escalation).not.toContain('TERMINATE');
  });

  it('pointerLockLosses is NEVER, because Escape releases pointer lock', () => {
    // The plan's reason, quoted: "`Escape` releases pointer lock and browsers deliberately
    // prevent interception, so counting it would penalise a documented browser behaviour."
    // Counting it at all is the bug; a threshold of 0 would be worse still.
    expect(EXAM_PROFILE_DEFAULTS.thresholds.pointerLockLosses).toBeNull();
  });

  it("the plan's own default survives a round trip through the database", () => {
    // The bug this exists for. `plans/09` §4.1 writes
    // `thresholds: { pointerLockLosses: Infinity }`, and `JSON.stringify(Infinity)` is `null`.
    // `ExamAttempt.policySnapshot` is a Prisma `Json` column, so that policy would be stored as
    // "no threshold" and read back as nothing — and an undefined threshold is a threshold of
    // ZERO, which terminates every student who presses Escape.
    const asStored = JSON.parse(JSON.stringify(EXAM_PROFILE_DEFAULTS)) as unknown;
    const read = readPolicySnapshot(asStored);
    expect(read, 'the default profile did not survive JSON').not.toBeNull();
    // `null` round-trips as "never", not as a number.
    expect(read?.thresholds.pointerLockLosses).toBeNull();
    // And every OTHER threshold survives with its value intact, which is the half that would
    // have been quietly zeroed.
    expect(read?.thresholds.fullscreenExits).toBe(8);
    expect(read?.thresholds.focusLosses).toBe(25);
    expect(read?.thresholds.tabHides).toBe(12);
    expect(read?.thresholds.copyAttempts).toBe(20);
  });

  it('a corrupt snapshot is refused rather than half-applied', () => {
    expect(readPolicySnapshot({ version: 1 })).toBeNull();
    expect(readPolicySnapshot('not a policy')).toBeNull();
    expect(readPolicySnapshot({ ...EXAM_PROFILE_DEFAULTS, maxAttempts: 0 })).toBeNull();
  });

  it('a FROZEN policy is frozen all the way down', () => {
    // `Object.freeze` is SHALLOW. The first version froze once and a test caught
    // `policy.thresholds.fullscreenExits = 0` going straight through -- so INV-POLICY-1 was a
    // frozen shell around a mutable object.
    const policy = freezePolicy(resolvePolicy({ mode: 'EXAM' }));
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.thresholds)).toBe(true);
    expect(Object.isFrozen(policy.escalation)).toBe(true);
    expect(() => {
      (policy.thresholds as { fullscreenExits: number | null }).fullscreenExits = 0;
    }).toThrow();
    expect(policy.thresholds.fullscreenExits).toBe(8);
  });

  it('the FOLD ORDER is the specification: version, then assignment, then student, then right', () => {
    const resolved = resolvePolicy({
      mode: 'EXAM',
      versionPolicy: { blockCopyPaste: false, blockContextMenu: false, maxAttempts: 3 },
      assignmentOverride: { blockCopyPaste: true, maxAttempts: 2 },
      studentOverride: { maxAttempts: 7, policyOverride: { blockContextMenu: true } },
    });
    // Each source only wins the fields it sets.
    expect(resolved.blockCopyPaste, 'the assignment beats the version').toBe(true);
    expect(resolved.blockContextMenu, 'the student beats both').toBe(true);
    expect(resolved.maxAttempts, 'the override beats the assignment').toBe(7);
  });

  it('extra time is the LARGER of the grant and the right, and never the smaller', () => {
    // C13: the two fields existed with no precedence. Taking the SMALLER would be the dangerous
    // choice: a teacher granting 25% and an accommodation saying 50% do not disagree, they
    // stack, and the smaller silently under-grants a child time the law promises them.
    expect(extraTimePercent({ mode: 'EXAM', studentOverride: { extraTimePercent: 25 } })).toBe(25);
    expect(extraTimePercent({ mode: 'EXAM', accommodation: ac({ extraTimePercent: 50 }) })).toBe(
      50,
    );
    expect(
      extraTimePercent({
        mode: 'EXAM',
        studentOverride: { extraTimePercent: 25 },
        accommodation: ac({ extraTimePercent: 50 }),
      }),
    ).toBe(50);
    // And the overlap, where the right is larger, resolves the same way.
    expect(
      extraTimePercent({
        mode: 'EXAM',
        studentOverride: { extraTimePercent: 75 },
        accommodation: ac({ extraTimePercent: 50 }),
      }),
    ).toBe(75);
    expect(extraTimePercent({ mode: 'EXAM' })).toBe(0);
  });

  it('a REVOKED or expired accommodation grants nothing', () => {
    const revoked = ac({ extraTimePercent: 50, revokedAt: new Date('2026-09-01T00:00:00Z') });
    expect(extraTimePercent({ mode: 'EXAM', accommodation: revoked })).toBe(0);
    // The instant is an INPUT, so the test supplies one. With `Date.now()` inside the fold this
    // branch could only be exercised by changing the machine's clock, which is why `now` is a
    // parameter at all.
    const NOW = new Date('2026-09-28T08:00:00Z');
    const expired = ac({ extraTimePercent: 50, expiresAt: new Date('2026-09-27T08:00:00Z') });
    expect(extraTimePercent({ mode: 'EXAM', accommodation: expired, now: NOW })).toBe(0);
    // And with no `now` supplied, an accommodation carrying an expiry is treated as ACTIVE.
    // Defaulting to "denied" would mean a caller who forgot `now` silently strips a child's
    // extra time — the failure direction that matters.
    expect(extraTimePercent({ mode: 'EXAM', accommodation: expired })).toBe(50);
    const inactive = ac({ extraTimePercent: 50, status: 'REVOKED' });
    expect(extraTimePercent({ mode: 'EXAM', accommodation: inactive })).toBe(0);
  });

  it('extra time multiplies ONCE into an absolute limit, and an untimed exam stays untimed', () => {
    const timed = resolvePolicy({
      mode: 'EXAM',
      versionPolicy: { totalTimeLimitSec: 3600 },
      studentOverride: { extraTimePercent: 50 },
    });
    expect(timed.totalTimeLimitSec).toBe(5400);

    // `null` stays `null`. An untimed exam plus extra time is still untimed: there is no limit
    // to extend, and inventing one would turn an untimed assignment into a timed one BECAUSE a
    // student has an accommodation -- a reward for disclosing a right.
    const untimed = resolvePolicy({
      mode: 'EXAM',
      versionPolicy: { totalTimeLimitSec: null },
      studentOverride: { extraTimePercent: 50 },
    });
    expect(untimed.totalTimeLimitSec).toBeNull();
  });

  it('the availability window is the NARROWEST of every source that states one', () => {
    const resolved = resolvePolicy({
      mode: 'EXAM',
      versionPolicy: {
        availabilityWindow: { from: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' },
      },
      assignmentWindow: {
        from: new Date('2026-09-05T00:00:00.000Z'),
        until: new Date('2026-09-30T00:00:00.000Z'),
      },
      // The student's own window is narrower still, in both directions.
      studentOverride: {
        availableFrom: '2026-09-10T00:00:00.000Z',
        availableUntil: '2026-09-20T00:00:00.000Z',
      },
    });
    expect(resolved.availabilityWindow?.from).toBe('2026-09-10T00:00:00.000Z');
    expect(resolved.availabilityWindow?.until).toBe('2026-09-20T00:00:00.000Z');
  });

  it('INV-POLICY-2: a window that ends before it starts is an ERROR', () => {
    const problems = validatePolicy(
      resolvePolicy({
        mode: 'EXAM',
        versionPolicy: {
          availabilityWindow: { from: '2026-10-01T00:00:00Z', until: '2026-09-01T00:00:00Z' },
        },
      }),
    );
    expect(problems.some((p) => p.error && p.field === 'availabilityWindow')).toBe(true);
    expect(isPublishable(problems)).toBe(false);
  });

  it('INV-POLICY-2: a window shorter than the time limit is an ERROR', () => {
    // Stated as an error by the plan, and it should be: a student who cannot finish inside the
    // window is a policy that cannot be sat.
    const problems = validatePolicy(
      resolvePolicy({
        mode: 'EXAM',
        versionPolicy: {
          totalTimeLimitSec: 7200,
          availabilityWindow: { from: '2026-09-01T00:00:00Z', until: '2026-09-01T01:00:00Z' },
        },
      }),
    );
    expect(problems.some((p) => p.error && p.problem.includes('cannot be completed'))).toBe(true);
  });

  it('INV-POLICY-2: perQuestionExpiry without a per-question limit is an ERROR', () => {
    // The plan: "`perQuestionExpiry ≠ SOFT` with no per-question limit is an error". `LOCK` and
    // `AUTO_SUBMIT` are statements about a per-question deadline; with no deadline they are two
    // different ways of saying nothing.
    for (const expiry of ['LOCK', 'AUTO_SUBMIT'] as const) {
      const problems = validatePolicy(
        resolvePolicy({
          mode: 'EXAM',
          versionPolicy: { perQuestionExpiry: expiry, perQuestionTimeLimitSec: null },
        }),
      );
      expect(
        problems.some((p) => p.error && p.field === 'perQuestionExpiry'),
        `${expiry} with no per-question limit was not an error`,
      ).toBe(true);
    }
    // And SOFT with no limit is exactly right, because SOFT only logs.
    const soft = validatePolicy(
      resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { perQuestionExpiry: 'SOFT', perQuestionTimeLimitSec: null },
      }),
    );
    expect(soft.filter((p) => p.error)).toHaveLength(0);
  });

  it('INV-POLICY-2: a per-question limit longer than the total is a WARNING, not an error', () => {
    // The plan grades this one differently on purpose: the total bounds the attempt, and the
    // authoring surface must not be a wall. A test that treated every problem as an error would
    // pass this and fail the previous three.
    const problems = validatePolicy(
      resolvePolicy({
        mode: 'EXAM',
        versionPolicy: { totalTimeLimitSec: 600, perQuestionTimeLimitSec: 1200 },
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.error, 'a warning was reported as an error').toBe(false);
    // And a warning does not block publication.
    expect(isPublishable(problems)).toBe(true);
  });

  it('a shape that will not parse is reported and NOT analysed further', () => {
    const problems = validatePolicy({
      ...EXAM_PROFILE_DEFAULTS,
      maxAttempts: -1,
    } as never);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.error)).toBe(true);
    // And no derived nonsense: the parse failed, so the window rules cannot be reasoned about.
    expect(problems.some((p) => p.problem.includes('window'))).toBe(false);
  });

  it('the default profiles are themselves publishable, so a fresh platform is not broken', () => {
    // A default that fails its own validator is a platform that cannot create an exam, and it
    // would be found by a teacher at the worst possible moment.
    expect(validatePolicy(EXAM_PROFILE_DEFAULTS)).toEqual([]);
    expect(validatePolicy(QUIZ_PROFILE_DEFAULTS)).toEqual([]);
  });
});
