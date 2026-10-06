/**
 * MISCONCEPTION CASES: the negative test each simulation must declare, and the one that is actually run.
 *
 * ## WHY A FORMAT TEST IS NOT A GRADER TEST  (P12-T3)
 *
 * `biology.genetics-punnett` had four wrong-answer tests before its bug was found:
 *
 *   - "awards nothing for a blank answer"
 *   - "does NOT fold case: `aa` is not `AA`"
 *   - "treats `aA` and `Aa` as the same genotype"
 *   - "strips the keyboard and keeps the biology"
 *
 * **Every one tests an axis its author had already thought about: spacing, case, ordering, keyboard noise.** And the sim
 * still awarded `CORRECT 4/4` to a student who omitted a heterozygote from a cross that produces two -- because multiplicity
 * was an axis nobody tested.
 *
 * That is the finding this file exists to encode. **A grader tested only with grossly wrong answers is unverified in the
 * direction that matters:** "zzz" fails against any grader on earth, so such a test cannot fail and proves nothing. The
 * defect lives in the NEAR MISS -- the answer a student produces from one specific, nameable misconception.
 *
 * ## SO A SIM DECLARES ITS MISCONCEPTION, WITH THE MARKS IT EARNS, IN A DATA FILE
 *
 * `audit/sim-misconception-cases.json` pairs each sim with the wrong answer a student holding that misconception would
 * submit, and the ceiling that answer may earn. This script RUNS the grader and fails if it awards more.
 *
 * The declaration is data rather than a test because **a test asserting its own premise cannot report the premise has
 * stopped being true.** A test that says "a wrong answer scores 0" also said that while the grader scored it 4 -- the test
 * passed for the wrong reason, or was simply not there. Here the expectation lives outside the sim's own suite, so the sim
 * cannot quietly agree with itself.
 *
 * ## AND IT IS A REGRESSION GATE, NOT A COVERAGE GATE, ON PURPOSE
 *
 * Any simulation listed here is checked and FAILS the build if its grader regresses. Simulations not listed are reported
 * as a **count**, not a failure.
 *
 * The reason is the lesson this project has now learned three times, the hard way: **a gate that is permanently red gets
 * ignored, and an ignored gate is worse than an absent one because it is still cited as evidence.** Hard-failing 24
 * unreviewed simulations would produce a permanently failing check that everyone learns to skip. So the shortfall is made
 * loud and numeric, and it is a number somebody is expected to drive to zero -- `COVERAGE:` in this script's output is that
 * number, and it is the honest one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesPath = join(root, 'audit', 'sim-misconception-cases.json');

if (!existsSync(casesPath)) {
  console.error(
    `MISSING ${casesPath}\n` +
      `  This file is the authority for which simulations have a run misconception case. Without it the\n` +
      `  gate has nothing to check, and a gate with nothing to check prints PASS -- which is the failure\n` +
      `  this project has hit repeatedly. Create it rather than skipping this script.`,
  );
  process.exit(1);
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const declared = cases.cases ?? [];

/** Every simulation on disk, so coverage is measured against reality rather than against the file. */
const simulationIds = readdirSync(join(root, 'sims'))
  .filter((entry) => entry !== 'registry' && !entry.startsWith('_'))
  .filter((entry) => existsSync(join(root, 'sims', entry, 'sim.manifest.json')))
  .sort();

const problems = [];
let checked = 0;

/**
 * The built grader is CONTENT-HASHED (`grader.fc006cd16a56.js`), so the filename is not knowable from the sim id.
 *
 * Reading it out of `dist/registry-entry.json` rather than globbing is the point: **the registry entry is what the host
 * loads, so this runs the artefact that will actually be graded with.** A glob would work until the hash convention changed
 * and then silently match nothing -- and a check that matches nothing passes.
 */
const graderPathFor = (id) => {
  const entryPath = join(root, 'sims', id, 'dist', 'registry-entry.json');
  if (!existsSync(entryPath)) return null;
  const built = JSON.parse(readFileSync(entryPath, 'utf8'));
  const file = built.artefacts?.grader?.file;
  if (typeof file !== 'string') return null;
  return join(root, 'sims', id, 'dist', file.replace(/^\.\//u, ''));
};

for (const entry of declared) {
  const graderPath = graderPathFor(entry.id);
  if (graderPath === null || !existsSync(graderPath)) {
    problems.push(
      `DECLARED CASE WITH NO BUILT GRADER: ${entry.id}\n` +
        `  Run \`pnpm sim:build\` first. A case that cannot be executed is not a check, and a check that\n` +
        `  silently skips is worse than one that fails.`,
    );
    continue;
  }

  let sim;
  try {
    sim = (await import(pathToFileURL(graderPath).href)).default;
  } catch (why) {
    problems.push(
      `GRADER FOR ${entry.id} DID NOT LOAD: ${why instanceof Error ? why.message : String(why)}`,
    );
    continue;
  }

  const grade = sim.grader.grade(entry.state ?? {}, entry.params ?? {}, entry.answer);
  checked += 1;

  if (grade.points > entry.atMost) {
    problems.push(
      `MISCONCEPTION ANSWER SCORED TOO HIGH: ${entry.id}\n` +
        `  The answer a student holding "${entry.misconception}" would submit earned ${grade.points}/${grade.maxPoints} ` +
        `(${grade.code}), and this case declares a ceiling of ${entry.atMost}.\n` +
        `  A false-positive mark: the student is told they are right when they are not. Fix the GRADER, not the\n` +
        `  ceiling -- and if the ceiling is genuinely wrong, say why in the case's "why" before changing it.`,
    );
  }
}

/** Coverage is a NUMBER, not a failure. See the header. */
const onDisk = new Set(simulationIds);
const uncovered = [...onDisk].filter((id) => !declared.some((entry) => entry.id === id));
const stale = declared
  .map((entry) => entry.id)
  .filter((id) => !onDisk.has(id))
  .sort();

for (const id of stale) {
  problems.push(
    `DECLARED CASE FOR A SIM THAT NO LONGER EXISTS: ${id}\n` +
      `  Remove it, or the file accumulates checks for simulations that cannot fail because they cannot run.`,
  );
}

console.log('SIM MISCONCEPTION CASES (P12-T3)');
console.log(`  simulations on disk:  ${String(simulationIds.length)}`);
console.log(`  cases declared:      ${String(declared.length)}`);
console.log(`  cases executed:      ${String(checked)}`);
console.log(
  `  COVERAGE:            ${simulationIds.length - uncovered.length}/${simulationIds.length} reviewed`,
);
if (uncovered.length > 0) {
  console.log(`  not yet reviewed:    ${uncovered.join(', ')}`);
  console.log(
    `    ⚠️ NOT A FAILURE, AND THAT IS DELIBERATE. A gate that is permanently red is ignored, and an\n` +
      `    ignored gate is worse than an absent one because it is still cited as evidence. This number is\n` +
      `    the honest one, and it is expected to reach ${String(simulationIds.length)}.`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\nSIM MISCONCEPTION AUDIT FAILED (${String(problems.length)})`);
  process.exit(1);
}

console.log('  ✓ every declared misconception answer stays at or below its declared ceiling');
console.log('\nSIM MISCONCEPTION AUDIT PASSED');
