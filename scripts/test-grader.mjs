#!/usr/bin/env node
/**
 * `bank.testGrader` from the command line.  (P7-T12)
 *
 * ## WHY A SCRIPT AND NOT ONLY A FUNCTION
 *
 * The harness's whole value is that an author learns what the REAL grader does with their question, before a
 * student does. A function reachable only from an authoring UI reaches whoever is already in the UI, which is
 * not the person who most needs it: the person writing a question in a JSON seed file at eleven at night.
 *
 * ```
 *   node scripts/test-grader.mjs <spec.json> [response.json]
 * ```
 *
 * With no response it runs a SELF-CHOSEN BATCH -- full credit, no credit, and empty -- and reports whether the
 * question behaves as its own key implies. That is the check worth automating, and `testGraderBatch`'s `expect`
 * labels are what make it mechanical.
 *
 * ## AND IT EXITS NON-ZERO WHEN THE SAMPLES DISAGREE
 *
 * A check that only prints has no teeth in CI. Exit 1 on `unexpected.length > 0` so `pnpm test:grader` can gate
 * a commit, and exit 0 on a refusal-free clean run -- but note that a question whose key is unreadable produces
 * refusals, which the batch reports as `unexpected` rather than as a pass.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * LOADED FROM `dist` BY PATH, not as `@orrery/contracts/grading/harness`.
 *
 * That is the convention every gate in this directory follows (`migration-corpus-gate.mjs`,
 * `conformance-vocabulary-gate.mjs`), and it is deliberate: a root script importing a workspace package name
 * needs the root `node_modules` to contain a link to it, and when it does not the script fails with
 * `ERR_MODULE_NOT_FOUND` on a package that is present and built. A path cannot go missing that way.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { testGrader, testGraderBatch } = await import(
  pathToFileURL(join(root, 'packages/contracts/dist/grading/harness.js')).href
);

const [, , specPath, responsePath] = process.argv;

if (specPath === undefined) {
  process.stderr.write('usage: test-grader.mjs <spec.json> [response.json]\n');
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
} catch (error) {
  process.stderr.write(
    `could not read the question: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

if (responsePath !== undefined) {
  let response;
  try {
    response = JSON.parse(readFileSync(responsePath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `could not read the response: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
  const report = testGrader({ spec, response });
  process.stdout.write(
    `${JSON.stringify({ ...report, asMarker: '[withheld]', asStudent: report.asStudent }, null, 2)}\n`,
  );
  // A refusal is NOT a failure of the tool, so it exits 0; the exit code is for disagreement, not for refusal.
  process.exit(0);
}

/**
 * THE BATCH, DERIVED FROM THE QUESTION'S OWN TYPE AND KEY.
 *
 * Written out per type rather than sniffed, because the interesting sample is always "the key" -- and a harness
 * that guessed the response shape could not build it. A question type this function does not know produces NO
 * samples and an explicit message, which is better than a sample that is wrong about the type.
 */
const samplesFor = (question) => {
  const key = question?.key ?? {};
  switch (question?.type) {
    case 'single_choice': {
      // A DIFFERENT REAL OPTION, not a fabricated id: an id the question does not offer is a malformed response,
      // which is a refusal, and the batch would report the two as the same outcome.
      const other = (question.choices ?? []).map((c) => c.id).find((id) => id !== key.choiceId);
      return [
        { expect: 'FULL_CREDIT', note: 'the key', response: { choiceId: key.choiceId } },
        { expect: 'NO_CREDIT', note: 'a different option', response: { choiceId: other } },
      ];
    }
    case 'multi_select': {
      /**
       * THE WRONG SAMPLE IS A NON-EMPTY WRONG SELECTION, not an empty one.
       *
       * The first version used `{choiceIds: []}` labelled `NO_CREDIT`, and the tool exited 1 on its own output:
       * an empty response is a BLANK, which is a refusal, and a refusal is not a mark of zero. The distinction
       * is the harness's central one and the script was getting it wrong -- which is the best possible evidence
       * that the batch labels are doing their job.
       */
      const wrong = (question.choices ?? [])
        .map((choice) => choice.id)
        .filter((id) => !(key.choiceIds ?? []).includes(id));
      return [
        { expect: 'FULL_CREDIT', note: 'the key', response: { choiceIds: key.choiceIds } },
        { expect: 'NO_CREDIT', note: 'only wrong options', response: { choiceIds: wrong } },
      ];
    }
    case 'true_false':
      return [
        { expect: 'FULL_CREDIT', note: 'the key', response: { value: key.value } },
        { expect: 'NO_CREDIT', note: 'the opposite', response: { value: !key.value } },
      ];
    case 'numeric':
      return [
        { expect: 'FULL_CREDIT', note: 'the key', response: { value: key.value } },
        { expect: 'NO_CREDIT', note: 'far away', response: { value: (key.value ?? 0) + 1e6 } },
      ];
    case 'short_text':
      return [{ expect: 'FULL_CREDIT', note: 'the key', response: { text: key.text } }];
    case 'ordering':
      return [{ expect: 'FULL_CREDIT', note: 'the key', response: { itemIds: key.itemIds } }];
    default:
      return [];
  }
};

const samples = samplesFor(spec);

if (samples.length === 0) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ran: false,
        why: `no batch is defined for type ${JSON.stringify(spec?.type ?? null)}; pass a response file instead`,
      },
      null,
      2,
    )}\n`,
  );
  // Not a failure: an unknown type is the harness's gap, not the question's.
  process.exit(0);
}

const batch = testGraderBatch(spec, samples);
process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);

/**
 * EXIT 1 WHEN THE SAMPLES DISAGREE WITH THEIR OWN LABELS, so `test:grader` can gate a commit.
 *
 * Note what does NOT exit 1: a question that grades zero on its own key. That is a wrong key, and the batch
 * reports it -- but a non-zero exit for "this question is broken" would make the tool unusable on a bank that is
 * mid-edit, which is exactly when somebody needs to run it.
 */
process.exit(batch.unexpected.length > 0 ? 1 : 0);
