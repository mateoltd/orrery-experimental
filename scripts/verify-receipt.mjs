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

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { receiptHash, verifyReceipt, verifyReceiptSignature } = await import(
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

/**
 * THE SIGNING KEY, OR `null` WHEN NONE WAS SUPPLIED.
 *
 * `ORRERY_RECEIPT_KEY` (hex or any string). **AND THE ABSENCE OF IT IS REPORTED, NOT IGNORED.**
 *
 * The first version of this script recomputed the fold and, on a match, printed "the receipt reproduces" and exited 0
 * -- with no signature check at all. That is the pre-P8-T10 behaviour and it is a weaker claim than the words suggest:
 * the fold is public, so anyone can construct a chain that folds to any receipt they like. "It reproduces" means
 * "internally consistent"; "the platform issued this" needs the key, and a script that cannot check the second must say
 * so rather than let the exit code imply otherwise.
 */
const key = process.env.ORRERY_RECEIPT_KEY ?? null;
const mac =
  key === null
    ? null
    : (message) => createHmac('sha256', key).update(message, 'utf8').digest('hex');

const seed = {
  attemptId: String(input.attemptId ?? ''),
  assignmentId: String(input.assignmentId ?? ''),
  policySnapshot: input.policySnapshot ?? null,
  // `keysHash` is part of the seed as of P8-T10. Absent means empty rather than omitted: an older export with no key
  // set should fail verification, not silently reproduce against a chain it no longer describes.
  keysHash: String(input.keysHash ?? ''),
};

const revisions = Array.isArray(input.revisions) ? input.revisions : [];
const questionOrder = Array.isArray(input.questionOrder) ? input.questionOrder : [];
const storedReceipt = String(input.receiptHash ?? '');

/**
 * THE ORDER MATTERS, AND GETTING IT WRONG IS SILENTLY CONVINCING.
 *
 * The first version ran the divergence check FIRST, comparing a recomputed bare fold against the stored value. Since the
 * stored value is `mac(Hₙ)`, that comparison never matches -- so every correctly-signed receipt reported "DIVERGES at
 * the anchor", which is both false and the most alarming possible message for someone checking a disputed mark.
 *
 * So: recompute the fold, decide whether the receipt is signed at all, and only then walk the chain for a divergence --
 * with the MAC passed in, because the comparison has to happen in the same space the value was stored in.
 */
const recomputedFold = receiptHash(seed, revisions, questionOrder, sha256);

if (storedReceipt === recomputedFold) {
  process.stdout.write(
    'the receipt REPRODUCES but is NOT SIGNED\n' +
      '  this receipt stores the bare fold, which anyone can construct, so it proves internal\n' +
      '  consistency only. It is not evidence that the platform issued anything.\n',
  );
  process.exit(1);
}

const verdict = verifyReceiptSignature(storedReceipt, recomputedFold, mac);

if (verdict.ok) {
  process.stdout.write('the receipt reproduces AND its signature verifies\n');
  process.exit(0);
}

if (verdict.reason === 'NO_KEY') {
  process.stdout.write(
    'the receipt is signed but CANNOT BE VERIFIED: no signing key\n' +
      '  set ORRERY_RECEIPT_KEY to the key the receipt was signed with. Absent a key this script\n' +
      '  cannot tell an issued receipt from a forged one, so it refuses rather than passes.\n',
  );
  process.exit(1);
}

/**
 * THE SIGNATURE DOES NOT VERIFY. The chain may ALSO be inconsistent, and the two need different responses -- so check
 * the chain on its own terms first.
 *
 * **PASSING THE RECOMPUTED FOLD AS THE "STORED" RECEIPT IS THE CHAIN-CONSISTENCY CHECK.** The walk recomputes from the
 * seed and compares each link against its stored predecessor; if it agrees with a value it produced itself, every
 * stored link is internally sound and the only thing wrong is the signature. Without this, a receipt whose chain is
 * perfect but whose MAC is forged reports "DIVERGES at the anchor", which sends a marker hunting through the whole paper
 * for tampering that did not happen.
 */
const chainIsConsistent =
  verifyReceipt(seed, revisions, questionOrder, recomputedFold, sha256) === null;

if (chainIsConsistent) {
  process.stdout.write(
    'the chain is INTERNALLY CONSISTENT but the SIGNATURE DOES NOT VERIFY\n' +
      '  every stored link agrees, so no answer was changed. This receipt was simply not\n' +
      '  issued by the holder of the key -- or it was issued with a different key.\n',
  );
  process.exit(1);
}

const divergence = verifyReceipt(
  seed,
  revisions,
  questionOrder,
  storedReceipt,
  sha256,
  mac ?? undefined,
);

if (divergence === null) {
  process.stdout.write(
    'the chain is internally consistent but the SIGNATURE DOES NOT VERIFY\n' +
      '  this receipt was not issued by the holder of the key.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `DIVERGES${divergence.questionId === null ? ' at the anchor' : ` at question ${divergence.questionId}`}\n` +
    `  because: ${divergence.because}\n` +
    `  recomputed: ${divergence.got}\n` +
    `  recorded:   ${divergence.expected ?? '(none recorded)'}\n`,
);
process.exit(1);
