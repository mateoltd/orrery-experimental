// ESLint exists for exactly the things Biome does not express: package import
// boundaries, the no-barrel rule, and the four INV-guarding restrictions.
// Everything else is Biome's job (ADR-0004). Keeping this surface tiny is
// deliberate — a large lint surface is a large autonomous-work surface, and
// ESLint's dependency chain is a supply-chain risk (RN-08).
//
// Every rule below is proven to fire by `packages/config/src/lint-rules.verify.test.ts`.
// A rule that cannot fail is theatre and gets deleted (plans/23-REVIEW-ACTIONS.md D-35).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  // NOTE: `.tmp/**` is deliberately absent. The lint-rule verification test writes its
  // fixtures there and needs ESLint to lint them; `.tmp/` is gitignored so nothing leaks.
  {
    // The Prisma client's generated output. Gitignored, but gitignoring a file does not tell
    // ESLint about it — `eslint .` walked `packages/db/prisma/generated/**` and reported 3,121
    // problems inside generated runtime code. Only visible after actually running
    // `pnpm db:generate`, which is why it survived every earlier check.
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/prisma/generated/**',
      // `.tmp/` is deliberately NOT ignored. `lint-rules.verify.test.ts` writes its fixtures
      // there and needs ESLint to lint them — that file is the proof every invariant rule can
      // actually fire. Ignoring `.tmp` silenced the harness's 7 assertions, which is the exact
      // "make the gate pass by breaking it" failure the test exists to prevent. A stray file
      // in `.tmp` failing lint is correct behaviour, not a nuisance.
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `.tmp/` is ignored here but NOT in the block below, because the lint-rule
    // verification test writes fixtures there and needs ESLint to actually lint them.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Declaring the globals is what makes `no-restricted-globals` able to see them:
      // without this, `Date` is not a "known global" and the rule silently never fires.
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // ── INV-TIME-1 ──────────────────────────────────────────────────────────────
      // A bare Date.now() makes the deadline model untestable and puts a second,
      // student-controllable clock into the exam path. @orrery/clock is the only source.
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'INV-TIME-1: use @orrery/clock. Inject a Clock so tests can use a FrozenClock.',
        },
        { object: 'performance', property: 'now', message: 'INV-TIME-1: use @orrery/clock.' },
        // INV-RNG-1. This had to move here from `no-restricted-globals`, which matches a
        // global VARIABLE name and therefore silently matched nothing for 'Math.random'.
        // The gate test caught the dead rule; a config that looks right is not a gate.
        {
          object: 'Math',
          property: 'random',
          message: 'INV-RNG-1: use @orrery/rng. A stored seed must re-derive its draw.',
        },
      ],
      // `no-restricted-globals` cannot see `new Date()` once the global is declared in
      // languageOptions — it only inspects unresolved references. This is the rule that
      // actually catches the constructor, verified by the gate test.
      // INV-TIME-1 bans READING THE HOST CLOCK. It does not ban CONVERTING A NUMBER INTO A
      // DATE, and the difference is not pedantic: `Intl.DateTimeFormat.format()` takes a
      // `Date`, so a module that renders an injected `Millis` has to write
      // `new Date(instant)` exactly once. The previous selector matched every `new Date(...)`
      // regardless of arguments, and a blanket `no-restricted-globals` on `Date` banned the
      // identifier entirely — so the only options were a suppression or a broken module.
      //
      // That is the ADR-0027 trap again, and it is the second time this rule has been
      // over-broad. `lint-rules.verify.test.ts` now asserts the precision, so it cannot widen
      // a third time without a test failing.
      'no-restricted-syntax': [
        'error',
        {
          // ONLY the no-argument form, which is the one that reads the wall clock.
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'INV-TIME-1: `new Date()` with no argument reads the host clock. ' +
            'Inject a Millis and use @orrery/clock. `new Date(injectedMillis)` is a ' +
            'conversion and is fine.',
        },
      ],
      // A leading underscore means "deliberately unused", and it is the only way to say so
      // without a disable comment. `signInFailure(_kind)` takes a kind and does not read it —
      // that is the entire point, since reading it is what would leak. Reporting an unused
      // ARG there would push people towards `void _kind`, which is noisier and says less.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      'no-restricted-globals': [
        'error',
        // `Date.now` is caught precisely by `no-restricted-properties` below. The bare
        // identifier is NOT banned, because `Date.parse` and `Date.UTC` are static and
        // `new Date(millis)` is a conversion — none of which read a clock.
        { name: 'Date.now', message: 'INV-TIME-1: use @orrery/clock.' },
      ],

      // NOTE: the `next` ban is deliberately NOT here. It lives in the `packages/*/src/**`
      // block below, because it is a framework-boundary rule and only applies to packages.
      // It was originally global and fired on apps/web/src/middleware.ts — a legitimate
      // framework import — which would have taught every future agent to add a suppression
      // instead of fixing the rule (ADR-0027: an over-broad rule is as bad as none).
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '.prisma/client'],
              message:
                'Only packages/db may import Prisma, and it exports functions, never a client.',
            },
            {
              group: ['**/index'],
              message: 'ADR-0016: no barrel files. Use an explicit subpath export.',
            },
          ],
        },
      ],
    },
  },
  {
    // A STOPWATCH is not a CLOCK.
    //
    // `apps/web/src/features/**` may read `performance.now()`. INV-TIME-1 exists to stop a
    // second source of TIME — business logic that behaves differently depending on when it
    // runs, and that a FrozenClock therefore cannot pin down. A user-perceived latency floor
    // is the opposite: it depends on real elapsed time, and injecting a clock would make it
    // untestable.
    //
    // `Date.now()` stays BANNED here. The wall clock is a clock; a high-resolution monotonic
    // stopwatch is not, and keeping the distinction is what stops this exemption becoming a
    // general one. Only the `performance` global is allowed.
    files: ['apps/web/src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'INV-TIME-1: use @orrery/clock.' },
        { property: 'Math.random', message: 'INV-RNG-1: use @orrery/rng.' },
      ],
    },
  },
  {
    // The gate scripts in `scripts/**` are plain ESM CLIs, run by `node` directly. They were
    // matching no block at all, so they were linted with NO declared globals — which produced
    // 3,204 `no-undef` errors on `console` and `process` and buried the handful of real
    // problems underneath them.
    //
    // A gate that cannot be linted cleanly is a gate nobody re-reads, so this block exists to
    // make the output mean something. Note these are `.mjs`, deliberately outside the
    // `no-restricted-globals` block above: a gate script printing PASSED is the one place
    // `console.log` is the correct thing to do.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // ADR-0005: a package importing `next` cannot be tested in isolation and drags React
    // into every consumer's bundle. Scoped to packages/* — the app is the one place that
    // legitimately imports the framework.
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
      // `scripts/` too. The rule's real intent is "framework imports belong in apps/", and a
      // ban that leaks in a build script is the same defect in a different place.
      'scripts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'ADR-0005: packages/* must not import next. Move it to apps/web.',
            },
            {
              group: ['@prisma/client', '.prisma/client'],
              message:
                'Only packages/db may import Prisma, and it exports functions, never a client.',
            },
            {
              group: ['**/index'],
              message: 'ADR-0016: no barrel files. Use an explicit subpath export.',
            },
          ],
        },
      ],
    },
  },
  {
    // INV-TIME-1 needs exactly one exemption, and it is this one.
    //
    // `@orrery/clock` exists to be the only module that touches the host clock. If the rule
    // applied to it, the package could not be written. Scoped to `src/**` rather than the
    // whole package, tests included: the tests compare `systemClock.now()` against a real
    // `Date.now()` to prove the real clock tracks real time, and a test that cannot name
    // `Date` cannot make that point. (An `ignores` for the test files was here first and was
    // simply wrong — it did the opposite of what the comment above it claimed.)
    files: ['packages/clock/src/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // packages/db is the single, narrow Prisma exception — and it is narrow on purpose.
    files: ['packages/db/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // The permission kernel is the ONE place ownership may be compared (13-IDENTITY-AUTHZ.md).
    files: ['packages/auth/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
