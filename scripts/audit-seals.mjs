#!/usr/bin/env node
/**
 * SEALED GRADES GATE — `INV-RELEASE-2`.  (P7-T10)
 *
 * > No score may be *inferable* before release. Therefore: no score field in any endpoint, no count of correct
 * > answers, no toast, no difference in status code, no difference in payload **shape**.  (`plans/01` §9)
 *
 * ## WHY A GATE AND NOT A TEST
 *
 * Because the failure is not a crash. A leaked `finalScore` in a student-facing payload compiles, typechecks,
 * renders, and passes every unit test in the repository — the field is a `number` where a `null` was expected
 * and nothing complains. `plans/01`'s own table gives the mechanism as "**route audit**", and a route audit is
 * only a gate if something runs it on every commit.
 *
 * The list of forbidden keys already exists as `SCORE_BEARING_KEYS` in `@orrery/interop`, and `findScoreBearingKeys`
 * walks a payload for them. So this script does not re-implement either: it supplies the CORPUS, which is the part
 * that does not exist and the part that goes stale.
 *
 * ## AND THE CORPUS IS THE WHOLE POINT, BECAUSE `is Released` IS NOT THE QUESTION
 *
 * The obvious check is "does this endpoint return a score while sealed". That check passes trivially forever,
 * because it only looks at code written to return a score. The hazard is the opposite one: a payload that *grows* a
 * score field by accident, or a route that starts including `correctCount` because it was useful for a progress
 * bar. So this audits every payload the student boundary can produce, sealed and released alike, and requires that
 * a SEALED payload carries nothing from the list.
 *
 * `answerKey`, `correctAnswer` and `modelAnswer` are in the list, and that is deliberate: `plans/07`'s key-material
 * rules and `INV-ATTEMPT-2` are the same requirement from the other direction, and a sealed payload that leaks the
 * key leaks the score.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * LOADED FROM `dist` BY PATH, like every other gate in this directory: a root script importing a workspace
 * package name needs a link in the root `node_modules` that is not there when the workspace is built per-package.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SCORE_BEARING_KEYS, findScoreBearingKeys } = await import(
  pathToFileURL(join(root, 'packages/interop/dist/boundary.js')).href
);

/**
 * THE CORPUS IS BUILT FROM THE FUNCTIONS THAT PRODUCE STUDENT PAYLOADS, NOT FROM FILES.
 *
 * The first version looked for JSON fixtures, and there are none -- so it would have audited nothing and passed,
 * which is the exact failure mode of a gate whose input has moved. A gate that cannot find its subject has lost it.
 *
 * The subjects that matter are not files anyway. The hazard is a payload that *grows* a score field, or a
 * projection that starts including `correctCount` because it was useful for a progress bar. Both happen in the
 * function that builds the payload, so the corpus is the OUTPUT of those functions, over every question type.
 *
 * `teacherQuestionSpec` is deliberately NOT audited: it contains the answer key, and that is its purpose. Only
 * student-facing surfaces are in scope, which is what `INV-RELEASE-2` is about.
 */
const contracts = await import(
  pathToFileURL(join(root, 'packages/contracts/dist/question/index.js')).href
);
const { QUESTION_TYPES } = await import(
  pathToFileURL(join(root, 'packages/contracts/dist/question/index.js')).href
);

/** One representative spec per type, with the key fields an author would actually set. */
const specFor = (type) => {
  const common = {
    id: `audit-${type}`,
    points: 4,
    gradingMode: 'AUTO',
    shuffleOptions: false,
    estimatedSeconds: 60,
    cognitiveDemand: 'APPLY',
    tags: [],
  };
  switch (type) {
    case 'single_choice':
      return {
        ...common,
        type,
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
        key: { choiceId: 'a' },
      };
    case 'multi_select':
      return {
        ...common,
        type,
        choices: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
        key: { choiceIds: ['a'] },
        partialCredit: 'NC',
      };
    case 'true_false':
      return { ...common, type, key: { value: true } };
    case 'numeric':
      return { ...common, type, key: { value: 5 }, tolerance: { absolute: 0.1 } };
    case 'short_text':
      return { ...common, type, key: { text: 'answer' }, matcher: 'EXACT' };
    case 'ordering':
      return {
        ...common,
        type,
        items: [
          { id: 'i1', text: 'one' },
          { id: 'i2', text: 'two' },
        ],
        key: { itemIds: ['i1', 'i2'] },
      };
    case 'free_response':
      return { ...common, type, rubric: [{ points: 4, descriptor: 'any' }] };
    case 'file_submission':
      return { ...common, type, allowedTypes: ['application/pdf'], maxBytes: 1_000_000 };
    case 'simulation':
      return {
        ...common,
        type,
        simId: 'mechanics.newtons-cradle',
        simVersion: '1.0.0',
        params: {},
        scoringSurface: 'ENDPOINT_ONLY',
      };
    case 'worked_solution':
      // `steps`, not `solution` -- `WorkedSolutionSpec` has no `solution` field. The gate caught this by
      // reporting that the projection THREW, which is the behaviour it should have when handed a spec it cannot
      // read: a silent skip would have left one of the ten types unaudited.
      return {
        ...common,
        type,
        steps: [{ id: 's1', prompt: 'Show the first step', points: 4, key: { text: 'because' } }],
      };
    default:
      throw new Error(`audit-seals: no representative spec for type ${type}`);
  }
};

const failures = [];
let audited = 0;
let sealedCount = 0;
let releasedCount = 0;

/** The student projection of every type. A leaked key here leaks the score. */
for (const type of QUESTION_TYPES) {
  audited += 1;
  sealedCount += 1;
  let projected;
  try {
    projected = contracts.publicQuestionSpec(specFor(type));
  } catch (error) {
    failures.push(
      `publicQuestionSpec(${type}) threw: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }
  for (const violation of findScoreBearingKeys(projected)) {
    failures.push(`publicQuestionSpec(${type}): "${violation.key}" at ${violation.path}`);
  }
}

/**
 * A SEALED GRADE PAYLOAD, built by the real boundary function.
 *
 * `buildStudentGrade` is the function whose output reaches a student's browser, so it is the one place a score
 * could appear without anybody editing a schema. Sealed output must carry nothing from the list; RELEASED output
 * is expected to carry a score and is NOT audited, because that is the whole point of release.
 */
const { buildStudentGrade } = await import(
  pathToFileURL(join(root, 'packages/interop/dist/boundary.js')).href
);

const gradeInput = {
  attemptId: 'at-audit',
  assignmentId: 'as-audit',
  submittedAt: '2026-03-01T09:00:00.000Z',
  answers: [{ questionId: 'q1', answer: 'x', submittedAt: '2026-03-01T09:00:00.000Z' }],
};

for (const released of [false, true]) {
  audited += 1;
  const grade = buildStudentGrade({ ...gradeInput, released });
  const violations = findScoreBearingKeys(grade);
  if (released) releasedCount += 1;
  else sealedCount += 1;
  if (!released) {
    for (const violation of violations) {
      failures.push(`buildStudentGrade(sealed): "${violation.key}" at ${violation.path}`);
    }
  } else {
    // Asserted rather than assumed: a RELEASED grade that carried no score would mean release does nothing, which
    // is the opposite defect and just as serious.
    if (violations.length === 0)
      failures.push('buildStudentGrade(released) carried no score at all');
  }
}

process.stdout.write('SEALED GRADES GATE (INV-RELEASE-2)\n');
process.stdout.write(`  score-bearing keys watched: ${String(SCORE_BEARING_KEYS.size)}\n`);
process.stdout.write(
  `  payloads audited: ${audited} (${sealedCount} sealed, ${releasedCount} released)\n`,
);

/**
 * A CORPUS TOO SMALL IS A FAILURE, and that check is the one that keeps this gate honest.
 *
 * The first version of this script looked for JSON fixtures, found none, printed "0 payloads audited" and PASSED.
 * That is the exact failure mode of a gate whose input has moved: it would have gone green for ever while auditing
 * nothing at all. A gate that cannot find its subject has lost it, and the honest report is that it did not run.
 *
 * The floor is `QUESTION_TYPES.length + 2` -- every type's student projection, plus one sealed and one released
 * grade -- so a type added without a representative spec fails here rather than being quietly skipped.
 */
if (audited === 0) {
  process.stdout.write('  NO PAYLOADS FOUND — the gate has no subject and cannot pass\n');
}

if (failures.length > 0) {
  process.stdout.write(`\nFAILED — ${failures.length} score-bearing key(s) in sealed payloads:\n`);
  for (const failure of failures.slice(0, 20)) process.stdout.write(`  • ${failure}\n`);
  if (failures.length > 20) process.stdout.write(`  … and ${String(failures.length - 20)} more\n`);
  process.exit(1);
}

if (audited < QUESTION_TYPES.length + 2) {
  process.stdout.write(
    `\nFAILED — expected at least ${String(QUESTION_TYPES.length + 2)} payloads, audited ${String(audited)}\n`,
  );
  process.exit(1);
}

process.stdout.write('\nSEALED GRADES GATE PASSED\n');
