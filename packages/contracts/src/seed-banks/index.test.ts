/**
 * The seed banks, checked as CONTENT rather than as code.  (P5-T15, `D-37`)
 *
 * Most of this file is item quality, which is unusual for a test suite and deliberate: the thing
 * `D-37` found missing was never a function, it was questions. A bank is only worth installing if
 * the items in it are answerable, marked correctly and honestly described by their metadata.
 *
 * The one test that matters most is `Bank B is BELOW the threshold and SAYS SO`, because a health
 * check that has never been seen to fail is not a health check.
 */
import { describe, expect, it } from 'vitest';
import { MIN_HEALTHY_ITEM_COUNT } from '../pool-health/index.js';
import {
  allSeedBankReports,
  SEED_BANKS,
  type SeedBank,
  type SeedQuestion,
  seedBankReport,
} from './index.js';

const questionsOf = (b: SeedBank): readonly SeedQuestion[] => b.questions;

describe('the authored seed banks', () => {
  it('there are two banks, and they are not empty', () => {
    // `D-37`: nothing in 183 tasks authored a single question. The regression test for that is
    // simply this assertion, and it fails if someone deletes the content to make a build faster.
    expect(SEED_BANKS.length).toBe(2);
    for (const bank of SEED_BANKS) {
      expect(bank.questions.length, `${bank.id} is empty`).toBeGreaterThan(20);
    }
  });

  it('every item id is unique across ALL banks', () => {
    const seen = new Map<string, string>();
    for (const bank of SEED_BANKS) {
      for (const q of bank.questions) {
        assertUnique(seen, q.id, bank.id);
      }
    }
    expect(seen.size).toBeGreaterThan(60);
  });

  it('every item has a topic, a response process and a rationale', () => {
    // The topic drives blueprint coverage and the response process drives `poolHealth`'s
    // cohort-distinctness number. An item missing either is invisible to both.
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        expect(q.topic, `${q.id} has no topic`).not.toBe('');
        expect(q.responseProcess, `${q.id} has no response process`).not.toBe('');
        // A key an author cannot check is a key an author cannot trust.
        expect(q.rationale.length, `${q.id} has no rationale`).toBeGreaterThan(20);
      }
    }
  });

  it('every item has an estimated time and a sane point value', () => {
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        expect(q.estimatedSeconds).toBeGreaterThan(0);
        expect(q.estimatedSeconds).toBeLessThanOrEqual(600);
        expect(q.points).toBeGreaterThan(0);
      }
    }
  });

  it('every item prompt is free of placeholders, and no two items ask the same thing', () => {
    // This assertion started as "the prompt must be a question or an imperative" and rejected five
    // legitimate items in a row: an imperative recall prompt ending in a full stop, a multi-select
    // with its instruction after the question, a bare stem completing into its options, and an
    // imperative mid-sentence. Style policing dressed as a test. What is actually worth failing on
    // is a placeholder, or two items in a RANDOMLY DRAWN pool asking the same question — the second
    // is a genuine measurement defect, because a student who meets the same item twice in one paper
    // has been given free marks by the draw rather than by their own work.
    const prompts = new Map<string, string>();
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        expect(q.prompt.length, `${q.id} prompt is too short`).toBeGreaterThan(20);
        expect(
          /\bTODO\b|\bXXX\b|\bFIXME\b|\bTBD\b/.test(q.prompt),
          `${q.id} has a placeholder`,
        ).toBe(false);
        const normalised = q.prompt
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const previous = prompts.get(normalised);
        if (previous !== undefined) {
          throw new Error(`DUPLICATE_PROMPT: ${q.id} and ${previous} ask the same question`);
        }
        prompts.set(normalised, q.id);
      }
    }
    expect(prompts.size).toBe(SEED_BANKS.reduce((n, b) => n + b.questions.length, 0));
  });

  it('no prompt contains its own answer', () => {
    // The authoring mistake that turns a randomised pool into free marks for whoever reads
    // carefully.
    //
    // NOT applied to NUMERIC items, and the first version applied it to everything. It fired on
    // "a plant absorbs 12 units of CO2 ... how many units of oxygen does photosynthesis produce?",
    // whose key is 12: a number in the stem is DATA, not an answer, and refusing to write numeric
    // items whose arithmetic returns a supplied value would ban half of physics and biology. The
    // check belongs where the key is a word or a sequence.
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        if (q.options !== undefined) continue;
        if (q.type !== 'SHORT_TEXT' && q.type !== 'ORDERING') continue;
        expect(
          q.prompt.toLowerCase().includes(q.modelAnswer.toLowerCase()),
          `${q.id}: the prompt contains its own answer`,
        ).toBe(false);
      }
    }
  });

  it('every choice item has options, and its key names options that EXIST', () => {
    // The key is stored as comma-separated option ids, so a typo is a zero for everyone who
    // answered correctly and there is no error anywhere.
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        if (q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_SELECT' || q.type === 'TRUE_FALSE') {
          expect(
            q.options?.length ?? 0,
            `${q.id} is a choice item with no options`,
          ).toBeGreaterThanOrEqual(2);
          const ids = new Set((q.options ?? []).map((o) => o.id));
          const keys = q.modelAnswer.split(',').filter((k) => k !== '');
          expect(keys.length, `${q.id} has no key`).toBeGreaterThan(0);
          for (const key of keys)
            expect(ids.has(key), `${q.id}: key ${key} is not an option`).toBe(true);
          if (q.type === 'SINGLE_CHOICE')
            expect(keys, `${q.id} has more than one key`).toHaveLength(1);
          if (q.type === 'MULTI_SELECT')
            expect(keys.length, `${q.id} needs 2+ keys`).toBeGreaterThan(1);
          // Option texts must be distinct, or two identical options make the question unanswerable
          // and the key arbitrary.
          const texts = (q.options ?? []).map((o) => o.text);
          expect(new Set(texts).size, `${q.id} has duplicate option text`).toBe(texts.length);
        }
      }
    }
  });

  it('every NUMERIC item has a tolerance, and it is not zero-sized on a rounded key', () => {
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        if (q.type === 'NUMERIC') {
          expect(q.tolerance, `${q.id} is numeric with no tolerance at all`).toBeGreaterThanOrEqual(
            0,
          );
          expect(Number.isFinite(q.tolerance ?? Number.NaN)).toBe(true);
          expect(q.modelAnswer).toMatch(/^-?\d+(\.\d+)?/);
          // A tolerance of exactly 0 is right for an integer answer ("2 ATP") and wrong for a
          // fractional one, where a float comparison decides a student's mark.
          const magnitude = Math.abs(Number.parseFloat(q.modelAnswer));
          if (!Number.isInteger(magnitude)) {
            expect(
              q.tolerance,
              `${q.id} has a fractional key and a zero tolerance`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('every FREE_RESPONSE item has a rubric worth marking against', () => {
    for (const bank of SEED_BANKS) {
      for (const q of questionsOf(bank)) {
        if (q.type === 'FREE_RESPONSE') {
          expect(q.gradingMode, `${q.id} must be MANUAL`).toBe('MANUAL');
          expect(q.rubric?.length ?? 0, `${q.id} has no rubric`).toBeGreaterThan(0);
        }
        if (q.gradingMode === 'AUTO')
          expect(q.rubric, `${q.id} is auto-graded and has a rubric`).toBeUndefined();
      }
    }
  });

  it('every pool draws from items that exist in ITS OWN bank', () => {
    for (const bank of SEED_BANKS) {
      const ids = new Set(bank.questions.map((q) => q.id));
      for (const pool of bank.pools) {
        for (const qid of pool.questionIds) {
          expect(ids.has(qid), `${pool.id} references ${qid}, which is not in ${bank.id}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('every pool can fill its own draw without replacement', () => {
    for (const bank of SEED_BANKS) {
      for (const pool of bank.pools) {
        expect(
          pool.drawCount,
          `${pool.id} draws ${pool.drawCount} from ${pool.questionIds.length}`,
        ).toBeLessThanOrEqual(pool.questionIds.length);
      }
    }
  });

  it('covers every item type and every response process somewhere', () => {
    // A bank that only has SINGLE_CHOICE cannot test partial credit, ordering or free response,
    // and the parts of the grader that handle them stay untested by real content.
    const types = new Set(SEED_BANKS.flatMap((b) => b.questions.map((q) => q.type)));
    for (const t of [
      'SINGLE_CHOICE',
      'MULTI_SELECT',
      'TRUE_FALSE',
      'NUMERIC',
      'SHORT_TEXT',
      'ORDERING',
      'FREE_RESPONSE',
    ] as const) {
      expect(types.has(t), `no authored item uses ${t}`).toBe(true);
    }
    const processes = new Set(SEED_BANKS.flatMap((b) => b.questions.map((q) => q.responseProcess)));
    expect(processes).toEqual(new Set(['RECOGNITION', 'RECALL', 'PRODUCTION']));
  });

  it('the whole-bank pools draw a paper that is most of the bank, not all of it', () => {
    // A pool that draws EVERY item gives each student the same exam, which is a pool in name only.
    // The anti-collusion claim is the fraction, and it is printed in the report.
    for (const bank of SEED_BANKS) {
      const whole = bank.pools.find((p) => p.questionIds.length === bank.questions.length);
      expect(whole, `${bank.id} has no whole-bank pool`).toBeDefined();
      expect(whole?.drawCount ?? 0).toBeLessThan(bank.questions.length);
    }
  });
});

describe('the authoring report', () => {
  it('reports zero key problems and zero metadata gaps for the shipped content', () => {
    for (const report of allSeedBankReports()) {
      expect(report.keyProblems, `${report.bankId} key problems`).toEqual([]);
      expect(report.itemsMissingMetadata, `${report.bankId} metadata gaps`).toEqual([]);
    }
  });

  it('Bank A is AT the threshold and says there is nothing to do', () => {
    const report = seedBankReport('seed-biology-core');
    const whole = report.pools.find((p) => p.poolId === 'seed-biology-core-all');
    expect(whole?.itemCount).toBeGreaterThanOrEqual(MIN_HEALTHY_ITEM_COUNT);
    expect(whole?.itemsShortOfTarget).toBe(0);
    expect(whole?.health.drawable).toBe(true);
  });

  it('Bank B is BELOW the threshold and SAYS SO, with the exact item count', () => {
    // This is the test that makes `D-37`'s tooling real. If every bank were authored to 40 the
    // shortfall path would never run against shipped content, and a warning that has never fired
    // is indistinguishable from a warning that cannot fire.
    const report = seedBankReport('seed-physics-core');
    const whole = report.pools.find((p) => p.poolId === 'seed-physics-core-all');
    expect(whole?.itemCount).toBeLessThan(MIN_HEALTHY_ITEM_COUNT);
    expect(whole?.itemsShortOfTarget).toBe(MIN_HEALTHY_ITEM_COUNT - (whole?.itemCount ?? 0));
    expect(whole?.itemsShortOfTarget).toBeGreaterThan(0);
    expect(report.totalItemsShortOfTarget).toBeGreaterThan(0);
    // And it is a TASK, with a count and a pool name in it, not an adjective.
    expect(report.authoringTask).toMatch(/needs \d+ more item/);
    expect(report.authoringTask).toMatch(/All core physics \(\d+\): \+\d+/);
  });

  it('the shortfall is reported per pool, and pools are named rather than counted', () => {
    const report = seedBankReport('seed-biology-core');
    const short = report.pools.filter((p) => p.itemsShortOfTarget > 0);
    expect(short.length).toBeGreaterThan(0);
    for (const pool of short) {
      expect(pool.name.length).toBeGreaterThan(3);
      expect(pool.itemsShortOfTarget).toBe(MIN_HEALTHY_ITEM_COUNT - pool.itemCount);
    }
  });

  it('reports the expected overlap as a FRACTION, which is the actionable number', () => {
    const report = seedBankReport('seed-biology-core');
    const whole = report.pools.find((p) => p.poolId === 'seed-biology-core-all');
    // N/M, exact: a 30-student cohort each sharing ~26% of a paper with a given peer.
    expect(whole?.health.expectedOverlapFraction).toBeCloseTo(12 / (whole?.itemCount ?? 1), 6);
    expect(whole?.health.probabilityAnyShared).toBeGreaterThan(0.9);
    expect(whole?.health.cohortItemUtilisation).toBeGreaterThan(0);
  });

  it('a SMALL pool is visibly worse than a big one, and the report shows it as a fraction', () => {
    // The pair `N²/M` cannot distinguish: a 46-item pool drawing 12 and a 11-item pool drawing 6
    // both report ~3 shared items, and as fractions they are 26% and 55%. That difference is the
    // difference between "reasonable" and "the anti-collusion claim is decoration".
    const bio = seedBankReport('seed-biology-core').pools.find(
      (p) => p.poolId === 'seed-biology-core-all',
    );
    const forces = seedBankReport('seed-physics-core').pools.find(
      (p) => p.poolId === 'seed-physics-forces',
    );
    expect(
      Math.abs((bio?.health.expectedOverlap ?? 0) - (forces?.health.expectedOverlap ?? 0)),
    ).toBeLessThan(1);
    expect(
      (forces?.health.expectedOverlapFraction ?? 0) / (bio?.health.expectedOverlapFraction ?? 1),
    ).toBeGreaterThan(1.5);
  });

  it('refuses an unknown bank rather than reporting on nothing', () => {
    expect(() => seedBankReport('nope')).toThrow(/UNKNOWN_SEED_BANK/);
  });
});

function assertUnique(seen: Map<string, string>, id: string, bankId: string): void {
  const previous = seen.get(id);
  if (previous !== undefined) {
    throw new Error(`DUPLICATE_SEED_ITEM_ID: ${id} is in both ${previous} and ${bankId}`);
  }
  seen.set(id, bankId);
}
