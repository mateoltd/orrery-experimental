#!/usr/bin/env node

/**
 * `verify-receipt <receipt.json>` — recompute a submission receipt and report the FIRST divergence.
 *
 * ## WHY THIS EXISTS AS A COMMAND
 *
 * `plans/01` §9.4: "A teacher can recompute it from the revision chain with `pnpm --filter @orrery/grading
 * verify-receipt <attemptId>`, which reports the first divergence. That is what makes 'I didn't change my answer'
 * checkable rather than deniable."
 *
 * The value is entirely in WHICH question it names. A boolean "does not match" sends a teacher through the whole
 * paper; the first divergence is the earliest point at which the two histories part, and everything after it is
 * downstream of the same edit.
 *
 * ## IT READS A FILE RATHER THAN A DATABASE, AND THAT IS A REAL LIMITATION
 *
 * The plan's signature takes an `attemptId` and looks the chain up. There is no database client in this script and
 * no `attemptId` lookup, so it takes the seed, the chain and the order as JSON. That is honest about what it can
 * do -- and it means it works on a chain exported from a support ticket, which is the case where a teacher
 * actually needs it and cannot reach production.
 *
 * Exit codes: 0 the receipt reproduces, 1 it does not, 2 the input could not be read.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { verifyReceipt } = await import(
  pathToFileURL(join(root, 'packages/contracts/dist/grading/receipt.js')).href
);

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write('usage: verify-receipt.mjs <receipt.json>\n');
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  process.stderr.write(
    `could not read the receipt: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const sha256 = (bytes) => createHash('sha256').update(bytes, 'utf8').digest('hex');

const divergence = verifyReceipt(
  {
    attemptId: String(input.attemptId ?? ''),
    assignmentId: String(input.assignmentId ?? ''),
    policySnapshot: input.policySnapshot ?? null,
  },
  Array.isArray(input.revisions) ? input.revisions : [],
  Array.isArray(input.questionOrder) ? input.questionOrder : [],
  String(input.receiptHash ?? ''),
  sha256,
);

if (divergence === null) {
  process.stdout.write('the receipt reproduces\n');
  process.exit(0);
}

process.stdout.write(
  `DIVERGES${divergence.questionId === null ? ' at the anchor' : ` at question ${divergence.questionId}`}\n` +
    `  because: ${divergence.because}\n` +
    `  recomputed: ${divergence.got}\n` +
    `  recorded:   ${divergence.expected ?? '(none recorded)'}\n`,
);
process.exit(1);
