/**
 * The conformance-vocabulary gate.  (P6-T15)
 *
 * ## WHAT THIS GATES
 *
 * `schemas/sim.manifest.schema.json` and `scripts/sim-conformance.mjs` are two halves of one contract: the
 * schema says which words a manifest may use, and the runner decides what those words mean. **They had drifted
 * apart, and neither checked the other**, in both directions at once:
 *
 * 1. `expectation.prefix` was ALLOWED by the schema and IMPLEMENTED NOWHERE in the runner. A manifest
 *    declaring it passed schema validation and every other gate, then fell through to the runner's final
 *    `JSON.stringify(want) === JSON.stringify(got)` line -- which compared the WRAPPER `{prefix: "..."}`
 *    against the VALUE. It could never match, so the cell failed for a reason that had nothing to do with the
 *    simulation, and the note it printed was about the student's answer.
 *
 *    **A GATE THAT ACCEPTS WHAT NOTHING CONSUMES IS WORSE THAN A GATE THAT REFUSES IT**, because the author
 *    gets a green build and a mysterious failure at run time.
 *
 * 2. The runner implemented `step.what === 'fill' | 'select'`, but `additionalProperties: false` on the script
 *    step meant NO manifest could ever reach that code. The runner had vocabulary no author could use.
 *
 * This gate asserts REACHABILITY IN BOTH DIRECTIONS: the vocabulary the runner implements must be
 * schema-accepted, and everything else must be refused. Both halves matter. A schema that accepts anything is
 * not a gate either.
 *
 * ## WHY IT PROBES THE SHIPPED VALIDATOR AND THE RUNNER'S OWN CODE
 *
 * The schema is checked with `packages/contracts/dist/jsonschema` -- the same module `scripts/sim-validate.mjs`
 * deliberately imports instead of reimplementing the rules, because a second implementation is a second
 * opinion nobody maintains.
 *
 * The matcher is checked by LIFTING THE REAL FUNCTION OUT OF THE RUNNER SOURCE and evaluating it, rather than
 * by transcribing it here. A transcription would be a second implementation of exactly the thing under test,
 * which is the failure mode this whole task exists to remove. The lift means a change to the runner's semantics
 * fails this gate, and a change to the schema fails it too -- neither can drift alone.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

// ── the two halves, read as source and as data

const runnerPath = join(root, 'scripts', 'sim-conformance.mjs');
const schemaPath = join(root, 'schemas', 'sim.manifest.schema.json');
const runnerSource = readFileSync(runnerPath, 'utf8');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// ── part 1: is the vocabulary REACHABLE?

const contracts = await Promise.all([
  import(pathToFileURL(join(root, 'packages/contracts/dist/sim-manifest/index.js')).href),
  import(pathToFileURL(join(root, 'packages/contracts/dist/jsonschema/index.js')).href),
]);
const [manifestContracts, schemaModule] = contracts;

// A manifest is needed to hang a `conformance` block on, and the vocabulary questions do not depend on which
// simulation supplies it -- so any valid manifest will do. `maths.pythagoras` is the smallest.
const base = JSON.parse(
  readFileSync(join(root, 'sims', 'maths.pythagoras', 'sim.manifest.json'), 'utf8'),
);
const withConformance = (conformance) => ({ ...base, conformance });

/**
 * `validate` returns an ARRAY OF ERRORS, empty when valid -- NOT null.
 *
 * The first version of this gate treated `[]` as a failure, and so reported two perfectly valid manifests as
 * rejected. A checker that reports the opposite of the truth is worse than no checker, because it is trusted.
 */
const accepts = (conformance) => {
  schemaModule.assertSchemaIsSupported(schema);
  const errors = schemaModule.validate(withConformance(conformance), schema);
  return Array.isArray(errors) ? errors.length === 0 : errors === null || errors === undefined;
};

const vocabulary = [
  // ── the half that was unreachable: `what` on a click step
  [
    'accept',
    'click with what:fill (the runner implements this)',
    {
      script: [{ command: 'click', what: 'fill', args: { selector: '#sim-answer', value: '5' } }],
      expect: { value: 5, grade: 4 },
    },
  ],
  [
    'accept',
    'click with what:select (the runner implements this)',
    {
      script: [{ command: 'click', what: 'select', args: { selector: '#x', value: 'y' } }],
      expect: { value: 5, grade: 4 },
    },
  ],
  [
    'accept',
    'click with no what still means click',
    { script: [{ command: 'click', args: { selector: '#x' } }], expect: { value: 5, grade: 4 } },
  ],
  // ── the half that was unreachable: a prefix expectation
  [
    'accept',
    'expect.value prefix (the runner implements this now)',
    { script: [{ command: 'reset' }], expect: { value: { prefix: 'The area is' }, grade: 4 } },
  ],
  [
    'accept',
    'expect.answer prefix, keyed like any other expectation',
    {
      script: [{ command: 'reset' }],
      expect: { answer: { note: { prefix: 'note: ' } }, grade: 4 },
    },
  ],
  // ── and the refusals. A schema that accepts anything is not a gate.
  [
    'refuse',
    'what:drag -- a verb the runner does not implement',
    {
      script: [{ command: 'click', what: 'drag', args: { selector: '#x' } }],
      expect: { value: 5, grade: 4 },
    },
  ],
  [
    'refuse',
    'prefix under minLength 4 -- too short to assert anything',
    { script: [{ command: 'reset' }], expect: { value: { prefix: 'ab' }, grade: 4 } },
  ],
  [
    'refuse',
    'prefix that is not a string',
    { script: [{ command: 'reset' }], expect: { value: { prefix: 5 }, grade: 4 } },
  ],
  [
    'refuse',
    'an unknown key on a script step',
    { script: [{ command: 'reset', until: 'x' }], expect: { value: 5, grade: 4 } },
  ],
  [
    'refuse',
    'a key the expectation does not define',
    { script: [{ command: 'reset' }], expect: { value: { startsWith: 'ab' }, grade: 4 } },
  ],
];

for (const [want, what, conformance] of vocabulary) {
  const got = accepts(conformance) ? 'accept' : 'refuse';
  if (got !== want) fail(`vocabulary: ${what} -- expected ${want}, got ${got}`);
}

// ── part 2: does the runner MEAN what the schema now permits?

/**
 * Lift the matcher's own source and evaluate it.
 *
 * The alternative is to reimplement the comparison here, which would make this gate a second implementation of
 * the thing it is checking -- and then a change to the runner would leave this gate green and correct about a
 * function that no longer exists. Lifting the source means the gate fails when the runner's semantics change.
 */
function loadMatcher() {
  const signature = 'const matches = (want, got) => {';
  const start = runnerSource.indexOf(signature);
  if (start === -1) return null;
  const braceAt = runnerSource.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (let index = braceAt; index < runnerSource.length; index += 1) {
    if (runnerSource[index] === '{') depth += 1;
    else if (runnerSource[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        // `const matches = ...` becomes `return ...` so the arrow body is the function's return value. The
        // matcher closes over `tolerance` from its enclosing scope, which is supplied as a parameter rather
        // than faked: the prefix branch ignores it, which is precisely why a prefix assertion cannot
        // accidentally inherit a numeric tolerance.
        const source = runnerSource.slice(start, index + 1).replace('const matches =', 'return');
        return new Function('tolerance', source)(0);
      }
    }
  }
  return null;
}

const matcher = loadMatcher();
if (matcher === null) {
  fail(
    'could not lift `matches` out of scripts/sim-conformance.mjs -- has it been renamed or removed?',
  );
} else {
  const cases = [
    // ── prefix: the branch that did not exist before this gate.
    [true, { prefix: 'The area is' }, 'The area is 12 cm2'],
    [true, { prefix: 'The area is' }, 'The area is'],
    [false, { prefix: 'The area is' }, 'The perimeter is 12 cm'],
    /**
     * A NUMBER MUST NOT SATISFY A PREFIX. `String(2).startsWith('2')` is true, so an implementation that
     * coerced would pass here while the assertion reads as a text check -- these two cases are what tell a
     * real implementation from a permissive one.
     */
    [false, { prefix: '2' }, 2],
    [false, { prefix: '1' }, 21],
    [false, { prefix: 'true' }, true],
    // ── every pre-existing form, so this gate cannot be satisfied by breaking one.
    [true, { exact: 'The area is 12 cm2' }, 'The area is 12 cm2'],
    [false, { exact: 'The area is 12 cm2' }, 'The area is 12 cm3'],
    [true, 5, 5],
    [false, 5, 6],
    [true, { min: 4, max: 6 }, 5],
    [false, { min: 4, max: 6 }, 7],
    [true, { in: ['mass', 'force'] }, 'force'],
    [false, { in: ['mass', 'force'] }, 'energy'],
    [true, { set: [1, 2] }, [2, 1]],
    [false, { set: [1, 2] }, [1, 3]],
    [true, { sequence: [1, 2] }, [1, 2]],
    [false, { sequence: [1, 2] }, [2, 1]],
  ];
  for (const [want, expected, actual] of cases) {
    const got = matcher(expected, actual);
    if (got !== want) {
      fail(
        `matcher: ${JSON.stringify(expected)} vs ${JSON.stringify(actual)} -- expected ${String(want)}, got ${String(got)}`,
      );
    }
  }
}

// ── part 3: does the CONTRACTS package know about `what`?

// The manifest rules live beside the schema and are a second set of words. A `what` the schema allows but the
// rule module rejects would pass this gate and fail `sim:validate`, which is the same split-brain defect in a
// different place.
if (typeof manifestContracts.checkManifestRules !== 'function') {
  fail(
    'packages/contracts no longer exports checkManifestRules -- this gate cannot check the manifest rules',
  );
} else {
  const checked = manifestContracts.checkManifestRules(
    withConformance({
      script: [{ command: 'click', what: 'fill', args: { selector: '#sim-answer', value: '5' } }],
      expect: { value: 5, grade: 4 },
    }),
  );
  const problems = checked?.problems ?? checked;
  if (Array.isArray(problems) && problems.length > 0) {
    fail(
      `contracts reject a 'click + what:fill' step the schema now allows: ${JSON.stringify(problems).slice(0, 200)}`,
    );
  }
}

if (process.exitCode === 1) {
  process.stdout.write('\nconformance vocabulary gate FAILED\n');
} else {
  process.stdout.write(
    `\nconformance vocabulary gate passed — ${String(vocabulary.length)} reachability assertions and the matcher agree\n`,
  );
}
