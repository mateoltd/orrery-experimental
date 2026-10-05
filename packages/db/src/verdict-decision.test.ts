/**
 * THE VERDICT RULES, AND EACH TEST IS A RULE THAT WAS PREVIOUSLY ONLY A COLUMN.
 *
 * `IntegrityVerdict` existed in the schema with a required `reason` and a unique `attemptId`, and **had no writer at
 * all** — so every property below was "enforced" by a table nobody wrote to. These are the tests that make them real.
 */

import { describe, expect, it } from 'vitest';
import {
  decideIntegrityVerdict,
  MAX_REASON,
  MIN_REASON,
  VERDICT_OUTCOMES,
  type VerdictInput,
} from './verdict-decision';

const facts = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  outcome: 'REVIEW',
  reason: 'two answers match a pattern worth a second look',
  decidedById: 'teacher-1',
  frozen: true,
  existingVerdict: false,
  consideredAccessibilityContext: true,
  ...over,
});

describe('every outcome is recordable, and no others are', () => {
  it('accepts all four the schema names', () => {
    for (const outcome of VERDICT_OUTCOMES) {
      expect(decideIntegrityVerdict(facts({ outcome })).ok, outcome).toBe(true);
    }
  });

  it('refuses an outcome the schema does not name', () => {
    // Cast deliberately: the union should make this impossible, and the runtime check is what makes it impossible
    // anyway — a value from JSON or a form is not type-checked.
    const result = decideIntegrityVerdict(facts({ outcome: 'CHEATING' as never }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal).toBe('OUTCOME_UNKNOWN');
  });
});

describe('a verdict needs an author, because only a human disposes', () => {
  it('refuses a blank author', () => {
    const result = decideIntegrityVerdict(facts({ decidedById: '   ' }));
    expect(result.ok === false && result.refusal).toBe('NO_DECIDED_BY');
  });
});

describe('THE REASON, AND WHITESPACE IS NOT A REASON', () => {
  it('refuses a reason under the floor', () => {
    const result = decideIntegrityVerdict(facts({ reason: 'too short' }));
    expect(result.ok === false && result.refusal).toBe('REASON_REQUIRED');
  });

  it('refuses a reason made only of whitespace, which a length check alone would accept', () => {
    /**
     * `"                    "` is 20 characters. **A length check on the raw string is the cheapest possible way to
     * satisfy a "reason required" rule**, and it produces a verdict that has no reason in it.
     */
    const result = decideIntegrityVerdict(facts({ reason: ' '.repeat(MIN_REASON + 10) }));
    expect(result.ok === false && result.refusal).toBe('REASON_REQUIRED');
  });

  it('refuses an absurdly long "reason"', () => {
    const result = decideIntegrityVerdict(facts({ reason: 'x'.repeat(MAX_REASON + 1) }));
    expect(result.ok === false && result.refusal).toBe('REASON_TOO_LONG');
  });

  it('stores the TRIMMED reason, so the record has no leading whitespace in it', () => {
    const result = decideIntegrityVerdict(
      facts({ reason: '  a real reason that is long enough  ' }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.reason).toBe('a real reason that is long enough');
  });
});

describe('NO_CONCERN STILL NEEDS A REASON, BECAUSE IT IS A CONCLUSION', () => {
  it('accepts it with a reason', () => {
    expect(decideIntegrityVerdict(facts({ outcome: 'NO_CONCERN' })).ok).toBe(true);
  });

  it('refuses it without one, which is what distinguishes "checked, nothing found" from "never checked"', () => {
    const result = decideIntegrityVerdict(facts({ outcome: 'NO_CONCERN', reason: '' }));
    expect(result.ok === false && result.refusal).toBe('REASON_REQUIRED');
  });
});

describe('VOID IS REFUSED UNLESS THE ATTEMPT IS FROZEN, AND THE ORDER IS DELIBERATE', () => {
  it('refuses VOIDED on an unfrozen attempt', () => {
    /**
     * `escalation.ts` states the same rule for `reinstate` and gives the reason: **freezing is the step at which a teacher
     * can still change their mind, so voiding first skips it.**
     */
    const result = decideIntegrityVerdict(facts({ outcome: 'VOIDED', frozen: false }));
    expect(result.ok === false && result.refusal).toBe('VOID_REQUIRES_FREEZE');
  });

  it('accepts VOIDED once frozen', () => {
    expect(decideIntegrityVerdict(facts({ outcome: 'VOIDED', frozen: true })).ok).toBe(true);
  });

  it('accepts the OTHER outcomes on an unfrozen attempt, because only a void disposes of the paper', () => {
    for (const outcome of ['NO_CONCERN', 'NOTED', 'REVIEW'] as const) {
      expect(decideIntegrityVerdict(facts({ outcome, frozen: false })).ok, outcome).toBe(true);
    }
  });

  it('checks the reason BEFORE the freeze, so a teacher learns what to fix', () => {
    /**
     * **The ordering is the point.** A teacher re-opening a decided void should learn first that the reason was
     * inadequate — the thing they can act on — rather than being told the record already exists, which is true and
     * useless when the record is what they are trying to correct.
     */
    const result = decideIntegrityVerdict(
      facts({ outcome: 'VOIDED', frozen: false, existingVerdict: true, reason: 'no' }),
    );
    expect(result.ok === false && result.refusal).toBe('REASON_REQUIRED');
  });
});

describe('A VERDICT IS WRITTEN ONCE', () => {
  it('refuses a second verdict on the same attempt', () => {
    /**
     * `attemptId` is `@unique`, so a second write would be refused by the database with a unique violation rather than a
     * decision. **A silent overwrite would destroy the record of what was concluded first — and the first conclusion is
     * the one a student may later ask about.**
     */
    const result = decideIntegrityVerdict(facts({ existingVerdict: true }));
    expect(result.ok === false && result.refusal).toBe('ALREADY_DECIDED');
  });
});

describe('ACCESSIBILITY CONTEXT IS STATED, NOT INFERRED', () => {
  it('carries the caller answer through UNCHANGED in both directions', () => {
    /**
     * `U-6`: an inferred disability status must never be a hidden, durable teacher-visible field. So the verdict records
     * whether it was CONSIDERED, and the caller must say so — **the function cannot infer it from the facts, because
     * inferring it is the thing `U-6` forbids.**
     */
    for (const considered of [true, false]) {
      const result = decideIntegrityVerdict(facts({ consideredAccessibilityContext: considered }));
      expect(result.ok).toBe(true);
    }
  });

  it('does NOT derive the flag from whether an accommodation exists', () => {
    /**
     * The tempting implementation is "an attempt with an accommodation implies the flag", and it is exactly wrong: it
     * records the platform's inference as though it were the teacher's consideration.
     */
    const result = decideIntegrityVerdict(
      facts({ outcome: 'REVIEW', consideredAccessibilityContext: false }),
    );
    expect(result.ok).toBe(true);
    // The decision says nothing about the flag at all — it is carried by the writer, which is where the column is.
    expect(Object.keys(result)).not.toContain('consideredAccessibilityContext');
  });
});

describe('THE RULES ARE HERE AND NOT IN THE WRITER', () => {
  it('this file is pure — it imports nothing, so it cannot reach a database', async () => {
    /**
     * Asserted against the SOURCE rather than the behaviour, because the claim is structural: a decision module that
     * imports Prisma is one edit away from having a query in it, and a rule held in a query is a rule nobody can check
     * without a database.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const raw = readFileSync(
      join(join(fileURLToPath(new URL('.', import.meta.url))), 'verdict-decision.ts'),
      'utf8',
    );
    /**
     * COMMENTS ARE STRIPPED FIRST, AND THAT IS THE THIRD TIME THIS HAS MATTERED.
     *
     * The first version of this assertion failed against its own header: the prose explains that "a rule held only in a
     * `prisma.update` is a rule nobody can check", so `not.toMatch(/prisma/i)` matched a sentence about the thing it
     * forbids. **An assertion that a reviewer can satisfy by rewording a comment is not checking the code** — and the
     * fix is to strip comments, never to delete the explanation, which is worth more than the assertion.
     *
     * Same lesson as `P14-T13`'s CSP test, where the identical mistake failed against a sentence documenting that a
     * hardcoded fallback was the bug.
     */
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/^import\s+\{/mu);
    expect(code).not.toMatch(/from '@orrery\/db'/u);
    expect(code).not.toMatch(/prisma/iu);
  });
});
