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
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts'] },
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
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'INV-TIME-1: use @orrery/clock. `new Date()` in logic is a second clock.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'INV-TIME-1: use @orrery/clock.' },
      ],

      // ── ADR-0005: packages stay framework-light ────────────────────────────────
      // A package importing next cannot be tested in isolation and drags React into
      // every consumer's bundle.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['next', 'next/*'],
              message: 'packages/* must not import next. Move it to apps/web (ADR-0005).',
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
    // packages/db is the single, narrow exception — and it is narrow on purpose.
    files: ['packages/db/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // The permission kernel is the ONE place ownership may be compared (13-IDENTITY-AUTHZ.md).
    files: ['packages/auth/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
