import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A test that needs variety takes a seed and PRINTS IT in the failure message
    // (INV-RNG-1). An unreproducible flake is a flake that gets "fixed" by retrying.
    sequence: { shuffle: false },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Thresholds live here and are a GATE FILE. Changing them requires the literal
      // string 'GATE-CHANGE:' in the PR body (plans/00 §6.2 rule 9, R23).
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        /**
         * THE GRADING CORE IS AT 100%, PERCENT, NOT ON AVERAGE.
         *
         * `plans/07` §4 asks for "100% branch, enforced by a dedicated coverage threshold that cannot be
         * lowered". A global threshold cannot express that: the module is 3% of the tree, so a repo-wide 85%
         * passes with every branch in it uncovered, and the only way the number could drop is by editing this
         * file -- which the `GATE-CHANGE:` rule above already requires a PR body to justify.
         *
         * Globals are the floor. A per-path floor is the ceiling, and the grading core is the one place where
         * an uncovered branch is a mark a student did not get.
         */
        'packages/contracts/src/grading/index.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * The partial-credit methods, for the same reason and with more force: these six formulas decide
         * students' grades, and a seventh policy of the same shape -- a penalty term added to `SU`, a size clause
         * dropped from `RI` -- would change every mark on every affected item while leaving the file's shape
         * untouched. `plans/07` section 3's fixture table is the contract, so the code that implements it is
         * held to the same floor as the dispatcher that calls it.
         */
        'packages/contracts/src/grading/methods.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * The short-text matchers and the ordering grader, held to the same floor.
         *
         * `text.ts` decides whether a student's sentence is right, and its one non-obvious hazard is
         * REGULAR EXPRESSIONS: an author pattern that does not compile must match nothing rather than throw,
         * or a malformed pattern in one question fails every submission. `simulation.ts` holds `INV-SIM-2`,
         * which is a correctness property about the absence of a zero rather than about arithmetic, and an
         * uncovered branch there is an uncovered way to zero a student.
         */
        'packages/contracts/src/grading/text.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/contracts/src/grading/simulation.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * `answerFixtures` is held to the same floor, and the reason is specific rather than tidy.
         *
         * This file is DATA -- a table of marks a human wrote down -- and data has a coverage hazard that code
         * does not: a row nothing reads is a row nobody checked. Every branch in it is either a per-method rule
         * being derived, an edge of that derivation (`key` of no options, a method outside the six), or the
         * gap detector that reports a missing fixture. An uncovered one means either a rule in `plans/07` §3
         * that no fixture exercises, or a completeness check that has never reported a gap.
         */
        'packages/contracts/src/question/fixtures.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * The deadline arithmetic, held to the same floor because every one of its branches is a decision
         * about whether a student's work is still accepted.
         *
         * `evaluateWrite` has five refusal branches and the order they are checked in is the message the
         * student receives, so an uncovered branch is an uncovered way to tell a student their paper is closed
         * when it is not. `shuffle.ts` is here for a different reason: its uncovered branches would be the
         * `plans/06` cautions -- the catch-all option, the ordered scale, the author's `meaningfulOrder` -- and
         * each of those exists to stop a shuffle that would cost somebody a mark.
         */
        'packages/contracts/src/policy/deadline.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'packages/contracts/src/policy/shuffle.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * `@orrery/analytics`, at 100% branch, per `plans/08` §9.
         *
         * "A statistics bug produces a wrong number that looks exactly as trustworthy as a right one." That is the
         * whole argument for this floor: the output of this package is a decimal that a teacher acts on, there is no
         * crash to notice, and the failure mode is indistinguishable from a real finding at a glance. Every uncovered
         * branch here is an untested way of being wrong about that decimal.
         */
        'packages/analytics/src/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        /**
         * `time-on-item.ts` at 100% lines and 91.66% branches, and the three missing branches are all the SAME
         * construct: `?? null` on an array access that a preceding length check has already proven in range.
         *
         * `noUncheckedIndexedAccess` makes `sorted[middle]` a `number | undefined`, so SOMETHING has to handle the
         * undefined case. The two options are the nullish fallback -- a branch no test can ever reach, because the
         * guard above it means the undefined side is unreachable -- or an `as number` cast, which is worse: it asserts
         * a fact to the compiler instead of handling the case, and it is the kind of assertion that becomes a lie the
         * moment the guard above it is edited.
         *
         * So the fallback stays and the threshold records the exact ceiling rather than being gamed with a coverage
         * ignore, which would suppress real gaps in this file along with the two unreachable ones. Every OTHER branch
         * in the package is at 100%.
         */
        'packages/analytics/src/time-on-item.ts': {
          lines: 100,
          branches: 92,
          functions: 100,
          statements: 100,
        },
        /**
         * The `testGrader` harness, at 100% because it is the one surface an author TRUSTS.
         *
         * `grade` is allowed to be terse about why it refused -- a code and a flag are right for a program. The
         * harness translates those into a CAUSE and a FIX, and a mistranslation sends an author to fix the wrong
         * thing: told to check `partialCredit` on an essay, they find none and file a bug about the tool. The
         * table's ordering is therefore load-bearing rather than incidental, and every entry needs its case.
         */
        'packages/contracts/src/grading/harness.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
