/**
 * The grader half. Node, no DOM, deterministic.  (P12-T2, card 70 `computing.search-algorithms`)
 *
 * ## EVERY MARK IS EXACT, BECAUSE A BAND ON A COUNT IS SLACK
 *
 * Tolerance class T-A, `abs: 0, rel: 0`. The card's reason is that "a relative band on it would accept a
 * linear search that happened to get lucky" — and the two algorithms produce counts that differ by one for
 * most targets, so any non-zero bound is a mark for a different algorithm. `numeric()` is used for the
 * three integers and the boolean is compared as a boolean, because `asNumber` returns `null` for `true` and
 * `numeric` would then report UNPARSEABLE for a student who answered correctly.
 *
 * ## THE REFUSED COMBINATION SCORES NOTHING, AND SAYS WHY
 *
 * `algorithm: 'binary'` on a list that is not ascending has no comparison count. The grader reports
 * `UNSORTED_PRECONDITION` at zero rather than inventing a number. That combination is never set by the
 * manifest's conformance script, so it is a state a teacher could construct and not one any paper uses.
 */

import { asNumber, defineSim, numeric } from '@orrery/sim-sdk/grader';
import {
  asBoolean,
  clamp,
  describeSearch,
  INDEX_WHEN_ABSENT,
  type SearchParams,
  search,
  worstCase,
} from './model.js';

export const COUNT_MARKS = 1;
export const MAX_POINTS = COUNT_MARKS * 4;

const parse = (answer: unknown) => {
  if (answer === null || typeof answer !== 'object') return null;
  const record = answer as Record<string, unknown>;
  return record;
};

export default defineSim({
  meta: {
    id: 'computing.search-algorithms',
    title: 'Searching: linear and binary',
    version: '1.0.0',
    subjects: ['computing'],
    licence: 'CC-BY-4.0',
    provenance: 'ORIGINAL',
    protocol: 1,
  },
  params: {
    algorithm: {
      type: 'enum',
      name: 'algorithm',
      label: 'Search',
      values: ['binary', 'linear'],
      default: 'binary',
    },
    size: { type: 'integer', name: 'size', label: 'List length', min: 4, max: 64, default: 16 },
    target: {
      type: 'integer',
      name: 'target',
      label: 'Search for',
      min: -999,
      max: 999,
      default: 9,
    },
    ascending: {
      type: 'boolean',
      name: 'ascending',
      label: 'List is in ascending order',
      default: true,
    },
  },
  controls: { params: true, state: false, scenarios: [] },
  accessibility: {
    keyboard: true,
    screenReaderSummary:
      'A row of numbered boxes with the comparisons the search made marked on them, a table of the same marks, and four boxes for the comparison count, whether the target was found, its position and the worst case.',
    reducedMotion: true,
    textAlternative:
      'A list of 16 numbers in ascending order is searched for 9 by binary search, taking the lower of the two middles. It makes 4 comparisons and finds it at position 8. Its worst case on 16 elements is 5 comparisons.',
    summary: 'Run a linear or a binary search over a list and count the comparisons it makes.',
  },

  grade(_state: unknown, rawParams: unknown, answer: unknown) {
    const record = parse(answer);
    if (record === null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'No comparison count was submitted, so there was nothing to score. The answer is four integers: ' +
          'the number of comparisons, whether the target was found, the position it was found at, and the ' +
          'worst case.',
      };
    }
    const params = clamp(rawParams as Partial<SearchParams>);
    const result = search(params);
    if (result.refusal !== null) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNSORTED_PRECONDITION',
        feedback: result.refusal,
      };
    }
    const found = asBoolean(record.found);
    const expected = {
      comparisons: result.comparisons,
      index: result.index ?? INDEX_WHEN_ABSENT,
      worstCase: worstCase(params),
    };
    const keys = ['comparisons', 'index', 'worstCase'] as const;
    // `numeric` REPORTS AN UNPARSEABLE ANSWER AS `INCORRECT` (`grading.ts:311` omits the `'UNPARSEABLE'`
    // override that `tolerance` supplies at `grading.ts:206`), so the readability of each field is decided
    // HERE rather than read back out of the sub-grade. An item every student leaves blank is a different
    // intervention from an item everybody mis-conceives, and folding the two together hides that in exactly
    // the report meant to tell them apart.
    const readable: Record<string, number | null> = {
      comparisons: asNumber(record.comparisons),
      index: asNumber(record.index),
      worstCase: asNumber(record.worstCase),
    };
    const readableCount =
      keys.filter((key) => readable[key] !== null).length + (found === null ? 0 : 1);
    if (readableCount === 0) {
      return {
        points: 0,
        maxPoints: MAX_POINTS,
        code: 'UNPARSEABLE',
        feedback:
          'None of the four fields could be read as a number, so no comparison was made at all. The answer ' +
          'is four whole numbers: the comparisons made, whether the target was found (1 or 0), the position ' +
          'it was found at (-1 if not found), and the worst case.',
      };
    }
    const unread: string[] = [];
    let points = 0;
    const said: string[] = [];
    for (const key of keys) {
      const given = readable[key];
      if (given === null) {
        unread.push(key);
        said.push(`${key}: nothing readable was submitted`);
        continue;
      }
      const judged = numeric(given, expected[key], COUNT_MARKS);
      points += judged.points;
      said.push(`${key}: ${judged.feedback}`);
    }
    if (found === null) {
      unread.push('found');
      said.push('found: neither yes nor no');
    } else {
      points += found === result.found ? COUNT_MARKS : 0;
      said.push(`found: you said ${String(found)}, and it is ${String(result.found)}`);
    }
    if (points >= MAX_POINTS) {
      return {
        points: MAX_POINTS,
        maxPoints: MAX_POINTS,
        code: 'CORRECT',
        feedback: `Correct. ${describeSearch(params)}`,
      };
    }
    return {
      points,
      maxPoints: MAX_POINTS,
      code: points > 0 ? 'PARTIAL' : 'INCORRECT',
      feedback:
        `${said.join('. ')}. ${describeSearch(params)} ` +
        (unread.length === 0 ? '' : `No credit for ${unread.join(', ')}. `) +
        'A count is compared exactly: there is no band on it, because the two searches differ by about one ' +
        'comparison on most targets and a band would award a mark for the wrong algorithm.',
    };
  },

  validateState(state: unknown) {
    if (state === null || typeof state !== 'object') return 'the state is not an object';
    const record = state as Record<string, unknown>;
    if (typeof record.algorithm !== 'string') return 'the state has no `algorithm` name';
    if (typeof record.size !== 'number' || !Number.isFinite(record.size)) {
      return 'the state has no finite `size`';
    }
    return null;
  },
});
