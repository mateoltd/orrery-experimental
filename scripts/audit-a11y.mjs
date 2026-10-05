/**
 * `pnpm a11y` — WHICH `ci.yml` CALLED BEFORE IT EXISTED.  (`P13-T1`)
 *
 * ## WHY THIS FILE IS A RUNNER AND NOT A SET OF COMPONENT TESTS
 *
 * `ci.yml`'s `policy` job ran `pnpm a11y`, and no such script existed, so the job died on step one and **every gate after it
 * in that job — including the dependency scan — never ran**. `P14-T15` fixed the ordering and left this step commented
 * out; this file is what makes it honest to uncomment.
 *
 * ## WHAT IT ACTUALLY CHECKS, AND WHAT IT CANNOT
 *
 * Component-level axe, over `@orrery/web`'s own tests, **through vitest** rather than by importing the module. **It does
 * not crawl routes**: a runner that started a browser, rendered every page and reported would be a different and much
 * larger piece of work, and one that would fail for reasons nobody could act on.
 *
 * **The honest scope, printed on every run**, because a green tick from a floor-level check is a claim:
 *
 *   · component-level axe catches roughly a third of WCAG issues
 *   · it cannot see focus ORDER across a route, live-region announcement thresholds, a sticky element covering a
 *     focused control, or a keyboard trap that only exists after a state change
 *   · `P13-T9`, an independent manual WCAG 2.2 AA audit, is the mechanism for those
 *   · `P13-T2`'s keyboard work is the part a linter will never check
 *
 * **AND THE POSITIVE CONTROL IS THE POINT.** `axe.test.tsx` renders an image with no `alt` and asserts axe CATCHES it. A
 * harness proven only by clean runs is not proven at all.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web');

console.log('a11y: component-level axe over @orrery/web (P13-T1)');
console.log(
  '  scope:  component-level only. Focus order, live regions, sticky-element overlap and keyboard traps',
);
console.log(
  '          are NOT checked here -- P13-T9 is a manual WCAG 2.2 AA audit and P13-T2 owns the keyboard work.',
);
console.log(
  '  proof:  axe.test.tsx asserts axe CATCHES a missing alt and an unnamed button, so a green run means something.',
);

const result = spawnSync('npx', ['vitest', 'run', 'src/test/axe.test.tsx'], {
  cwd: web,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  console.error(
    '\nACCESSIBILITY GATE FAILED — a component has an axe violation, or the positive control stopped biting.',
  );
  process.exit(result.status ?? 1);
}
console.log('\nACCESSIBILITY GATE PASSED (component level)');
