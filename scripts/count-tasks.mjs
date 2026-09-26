#!/usr/bin/env node
/**
 * BOARD INTEGRITY GATE  (P0-T9)
 *
 * ## Why this script exists
 *
 * The task total in `plans/BOARD.md` was **wrong twice**: it said 173 when there were 183,
 * and 183 when there were 189. It survived an entire review cycle because nobody counted.
 *
 * A board whose totals are fiction cannot answer the only question it exists to answer —
 * "how much is left?" — and a plan that cannot be measured cannot be reported as finished.
 * So the total is now **derived from the task tables**, not typed by hand, and this gate
 * fails when the two disagree.
 *
 * The P4, P13 and P16 task tables live in their own topic documents rather than in
 * `20-PHASE-PACKETS.md`, which is why a naive count of the packets file is also wrong.
 * That asymmetry is the actual trap, and it is why this script reads both.
 *
 * Changing the rule by which a task counts requires `GATE-CHANGE:` (D-35).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plans = join(root, 'plans');

/** Where each phase's task table lives. Adding a phase means adding a row here. */
const SOURCES = [
  { doc: '20-PHASE-PACKETS.md', phases: 'all' },
  { doc: '12-CLASSROOM-COLLAB.md', phases: [4] },
  { doc: '15-A11Y-I18N.md', phases: [13] },
  { doc: '16-INTEROPERABILITY.md', phases: [16] },
];

/** A row is a task if it starts with a task id in the first cell. Struck-through = deferred. */
function readTasks(file, phases) {
  const active = new Set();
  const deferred = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*~*\s*(P(\d+)-T(\d+))\s*~*\s*\|/);
    if (!m) continue;
    const phase = Number(m[2]);
    if (phases !== 'all' && !phases.includes(phase)) continue;
    if (line.trim().startsWith('| ~')) deferred.add(m[1]);
    else active.add(m[1]);
  }
  return { active, deferred };
}

const byPhase = new Map();
const allActive = new Set();
const allDeferred = new Set();

for (const { doc, phases } of SOURCES) {
  const { active, deferred } = readTasks(join(plans, doc), phases);
  for (const id of active) {
    if (allActive.has(id)) {
      console.error(`  ✗ duplicate task id across sources: ${id} (also in ${doc})`);
      process.exit(1);
    }
    allActive.add(id);
    const p = Number(id.split('-')[0].slice(1));
    byPhase.set(p, (byPhase.get(p) ?? 0) + 1);
  }
  for (const id of deferred) allDeferred.add(id);
}

// ── continuity: task numbers within a phase should be 1..N with no holes ──────────
// A DEFERRED task still occupies its number. Task ids are stable — they appear in commit
// trailers and PR descriptions — so a deferred id is never renumbered and its slot is never
// reused. Treating a deferral as a hole would be the gate being wrong, not the plan.
const perPhase = new Map();
for (const id of [...allActive, ...allDeferred]) {
  const [, p, t] = id.match(/^P(\d+)-T(\d+)$/);
  if (!perPhase.has(Number(p))) perPhase.set(Number(p), new Set());
  perPhase.get(Number(p)).add(Number(t));
}
const holes = [];
const deferredSlots = new Set();
for (const [p, ids] of [...perPhase].sort((a, b) => a[0] - b[0])) {
  const max = Math.max(...ids);
  for (let i = 1; i <= max; i++) {
    if (ids.has(i)) {
      if (allDeferred.has(`P${p}-T${i}`)) deferredSlots.add(`P${p}-T${i}`);
    } else {
      holes.push(`P${p}-T${i}`);
    }
  }
}

console.log('\nBOARD INTEGRITY GATE\n=====================\n');
console.log(`  active tasks   : ${allActive.size}`);
console.log(
  `  deferred       : ${allDeferred.size}${allDeferred.size ? ` (${[...allDeferred].join(', ')})` : ''}`,
);
console.log(
  `  phases         : ${[...byPhase.keys()]
    .sort((a, b) => a - b)
    .map((p) => `P${p}`)
    .join(' ')}`,
);

if (holes.length > 0) {
  console.error(`\n  ✗ ${holes.length} hole(s) in task numbering: ${holes.join(', ')}`);
  console.error('     A hole means a task id was removed or renumbered. Task ids are STABLE');
  console.error('     (they appear in commit trailers and PRs), so a hole is either a gap in the');
  console.error('     plan or a numbering mistake — never something to paper over.');
  process.exit(1);
}
if (deferredSlots.size) {
  console.log(
    `  · ${deferredSlots.size} deferred slot(s) still hold their number: ${[...deferredSlots].join(', ')}`,
  );
}
console.log('  ✓ task numbering is continuous within every phase (deferred ids retain their slot)');

// ── the board total must match the derived total ─────────────────────────────────
const board = readFileSync(join(plans, 'BOARD.md'), 'utf8');
const claimed = board.match(/\|\s*\|\s*\|\s*\*\*(\d+)\s*\/\s*(\d+)\*\*\s*\|/);
if (!claimed) {
  console.error('  ✗ could not find a grand-total row in BOARD.md');
  process.exit(1);
}
const claimedTotal = Number(claimed[2]);
if (claimedTotal !== allActive.size) {
  console.error(
    `\n  ✗ BOARD.md claims ${claimedTotal} tasks; the task tables contain ${allActive.size}\n` +
      '     This number was wrong twice already (173 vs 183 vs 189) and survived a full\n' +
      '     review cycle. Update BOARD.md, or fix the task table.',
  );
  process.exit(1);
}
console.log(`  ✓ BOARD.md total (${claimedTotal}) matches the task tables`);

console.log('\n\x1b[32mBOARD INTEGRITY GATE PASSED\x1b[0m');
