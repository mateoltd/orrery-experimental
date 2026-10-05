/**
 * "Does this event count as a strike?" has ONE answer.  (`ADV-A1`, `INV-ACC-1`, `plans/09` §7.1 and §8)
 *
 * ## WHY THIS IS NOT ONLY AN AGREEMENT TEST
 *
 * `ADV-A1` was two functions disagreeing, so the obvious test is that they now agree, and there is one below over every
 * `(type x policy x relaxations)` cell. PF-8 measured what that kind of test is worth: **an agreement test is blind by
 * construction to its callers moving together.** `routeEvidence` calls `countsAsStrike`, so if `countsAsStrike` stopped
 * counting every `WARN` event tomorrow the two would agree perfectly about the wrong answer.
 *
 * So the first three blocks pin what the answer IS, and every expectation in them is TYPED OUT rather than read off
 * `EVIDENCE_RULES` or `ROUTING`. A list derived from the table would agree with the table whatever the table said.
 * They are not redundant with the matrix and must not be deleted as such.
 *
 * Measured, not assumed: with `countsAsStrike`'s `when_policy_says` arm patched to `false`, `ADV-A1` in
 * `non-accusation.test.ts` stays GREEN and the first block here goes red.
 */

import { examPolicySchema } from '@orrery/contracts/policy';
import { describe, expect, it } from 'vitest';

import {
  eventsReportedBy,
  type GrantedRelaxation,
  routeEvidence,
  routeWatchdogEvent,
  WATCHDOG_OF_EVENT,
  type WatchdogName,
} from './accommodations.js';
import {
  countsAsStrike,
  EVIDENCE_RULES,
  type EvidenceType,
  type StrikePolicyView,
} from './evidence.js';

const ALL_TYPES = Object.keys(EVIDENCE_RULES) as EvidenceType[];

/** Every switch on, spelt the way `@orrery/contracts` spells it. Not `BLOCK`: see the `REQUIRE` block below. */
const POLICED: StrikePolicyView = {
  requireFullscreen: 'REQUIRE',
  requirePointerLock: 'REQUIRE',
  multiTabPolicy: 'BLOCK',
  blockCopyPaste: true,
  blockPrintSave: true,
};

/**
 * The nine types that count when everything is policed and the student holds no relaxation. `plans/09` §7.1, by hand.
 *
 * Seven of them are `WARN`. That is the whole of `ADV-A1`: a rule that reads strike off severity loses all seven.
 */
const COUNTS_WHEN_POLICED: readonly EvidenceType[] = [
  'FULLSCREEN_EXITED',
  'POINTERLOCK_LOST',
  'WINDOW_BLURRED',
  'TAB_HIDDEN',
  'MULTI_TAB_DETECTED',
  'COPY_ATTEMPT',
  'PASTE_ATTEMPT',
  'CONTEXT_MENU',
  'PRINT_ATTEMPT',
];

/** What each relaxation takes OUT of that list. `plans/09` §8 and §6.3, by hand. */
const SILENCED_BY: Readonly<Record<GrantedRelaxation, readonly EvidenceType[]>> = {
  DISABLE_FULLSCREEN: ['FULLSCREEN_EXITED'],
  DISABLE_POINTER_LOCK: ['POINTERLOCK_LOST'],
  DISABLE_TAB_WATCHDOG: ['TAB_HIDDEN', 'WINDOW_BLURRED'],
  // Narrower than the tab watchdog on purpose: not being nagged about focus is not permission to leave the tab.
  DISABLE_FOCUS_NAG: ['WINDOW_BLURRED'],
  // Print is here because §6.3 puts `beforeprint` in the copy/paste hardening and says accommodations disable it.
  ALLOW_COPY: ['COPY_ATTEMPT', 'PASTE_ATTEMPT', 'CONTEXT_MENU', 'PRINT_ATTEMPT'],
  // The commonest accommodation there is. It moves a deadline and nothing else.
  EXTRA_TIME_PERCENT: [],
};

const ALL_RELAXATIONS = Object.keys(SILENCED_BY) as GrantedRelaxation[];

const countedBy = (
  decide: (type: EvidenceType) => boolean,
  types: readonly EvidenceType[] = ALL_TYPES,
): EvidenceType[] => types.filter(decide).sort();

/** Every subset of the six relaxations. Sixty-four, so the matrix can be exhaustive rather than sampled. */
const RELAXATION_SUBSETS: readonly (readonly GrantedRelaxation[])[] = Array.from(
  { length: 2 ** ALL_RELAXATIONS.length },
  (_, mask) => ALL_RELAXATIONS.filter((_relaxation, bit) => (mask & (1 << bit)) !== 0),
);

/** Every policy the switches can express, with the schema's three requirement values and the hardening word. */
const POLICIES: readonly StrikePolicyView[] = ['OFF', 'WARN', 'REQUIRE', 'BLOCK'].flatMap(
  (requireFullscreen) =>
    ['OFF', 'WARN', 'REQUIRE', 'BLOCK'].flatMap((requirePointerLock) =>
      ['WARN', 'BLOCK'].flatMap((multiTabPolicy) =>
        [true, false].flatMap((blockCopyPaste) =>
          [true, false].map((blockPrintSave) => ({
            requireFullscreen,
            requirePointerLock,
            multiTabPolicy,
            blockCopyPaste,
            blockPrintSave,
          })),
        ),
      ),
    ),
);

describe('what counts, for a student holding no relaxation', () => {
  it('counts exactly the nine policed behaviours when every switch is on, and nothing else', () => {
    // What breaks without it: `thresholds.tabHides` and three of its siblings are dead. Read strike off severity and
    // only `FULLSCREEN_EXITED` and `MULTI_TAB_DETECTED` survive, because they are the only two filed as `VIOLATION`.
    const expected = [...COUNTS_WHEN_POLICED].sort();
    expect(countedBy((type) => countsAsStrike(type, POLICED))).toEqual(expected);
    expect(
      countedBy((type) => routeEvidence({ type, policy: POLICED, relaxations: [] }).countsAsStrike),
    ).toEqual(expected);
  });

  it('counts a WARN event through BOTH functions, which is the cell `ADV-A1` was', () => {
    // The severities are asserted too, so this cannot pass by the table quietly refiling a tab hide as a VIOLATION.
    for (const type of [
      'TAB_HIDDEN',
      'WINDOW_BLURRED',
      'POINTERLOCK_LOST',
      'COPY_ATTEMPT',
    ] as const) {
      expect(EVIDENCE_RULES[type].severity, type).toBe('WARN');
      expect(countsAsStrike(type, POLICED), type).toBe(true);
      expect(routeEvidence({ type, policy: POLICED, relaxations: [] }).countsAsStrike, type).toBe(
        true,
      );
    }
  });

  it('counts nothing a switch has turned off, and each switch turns off only its own', () => {
    const off = (over: Partial<StrikePolicyView>): EvidenceType[] => {
      const policy = { ...POLICED, ...over };
      const counted = new Set(
        countedBy((type) => routeEvidence({ type, policy, relaxations: [] }).countsAsStrike),
      );
      return COUNTS_WHEN_POLICED.filter((type) => !counted.has(type)).sort();
    };

    expect(off({ requireFullscreen: 'OFF' })).toEqual(['FULLSCREEN_EXITED']);
    expect(off({ requirePointerLock: 'OFF' })).toEqual(['POINTERLOCK_LOST']);
    // A copy/paste block must not enable the print counter, nor the reverse.
    expect(off({ blockCopyPaste: false })).toEqual([
      'CONTEXT_MENU',
      'COPY_ATTEMPT',
      'PASTE_ATTEMPT',
    ]);
    expect(off({ blockPrintSave: false })).toEqual(['PRINT_ATTEMPT']);
    // A second live session counts under either setting: the setting decides what the student is shown.
    expect(off({ multiTabPolicy: 'WARN' })).toEqual([]);
  });
});

describe('`REQUIRE` is a requirement', () => {
  /**
   * FOUND WHILE UNIFYING, and not one of the seven. `ExamPolicy.requireFullscreen` is `OFF | WARN | REQUIRE`. The
   * fullscreen arm of `countsAsStrike` tested `=== 'WARN' || === 'BLOCK'`, so under the STRICTEST value the schema has
   * a fullscreen exit was never a strike. Every test spelt the strict value `BLOCK`, which the schema does not contain.
   *
   * The values are read from the schema here on purpose: a fourth one added to it should have to be decided.
   */
  const requirementValues = examPolicySchema.shape.requireFullscreen.options;

  it('reads the values from the real schema, or the loop below proves nothing', () => {
    expect([...requirementValues].sort()).toEqual(['OFF', 'REQUIRE', 'WARN']);
    expect([...examPolicySchema.shape.requirePointerLock.options].sort()).toEqual(
      [...requirementValues].sort(),
    );
  });

  it('counts a fullscreen exit and a pointer-lock loss under every value but OFF', () => {
    for (const value of requirementValues) {
      const expected = value !== 'OFF';
      expect(
        countsAsStrike('FULLSCREEN_EXITED', { ...POLICED, requireFullscreen: value }),
        value,
      ).toBe(expected);
      expect(
        countsAsStrike('POINTERLOCK_LOST', { ...POLICED, requirePointerLock: value }),
        value,
      ).toBe(expected);
    }
  });

  it('does not switch a counter ON for a value nobody recognises', () => {
    // The view arrives as plain strings. `!== 'OFF'` would count a strike for `'off'`, `''` and a typo alike.
    for (const value of ['', 'off', 'Off', 'NONE', 'required', 'true']) {
      expect(
        countsAsStrike('FULLSCREEN_EXITED', { ...POLICED, requireFullscreen: value }),
        value,
      ).toBe(false);
      expect(
        countsAsStrike('POINTERLOCK_LOST', { ...POLICED, requirePointerLock: value }),
        value,
      ).toBe(false);
    }
  });
});

describe('INV-ACC-1: what a relaxation takes out, and what it leaves', () => {
  it('silences exactly the events of the watchdog it names, for each relaxation alone', () => {
    // Both directions at once. Too few and a student is struck for using a right; too many and an exemption from
    // fullscreen has quietly become an exemption from the tab watchdog.
    for (const relaxation of ALL_RELAXATIONS) {
      const expected = COUNTS_WHEN_POLICED.filter(
        (type) => !SILENCED_BY[relaxation].includes(type),
      ).sort();
      expect(
        countedBy(
          (type) =>
            routeEvidence({ type, policy: POLICED, relaxations: [relaxation] }).countsAsStrike,
        ),
        relaxation,
      ).toEqual(expected);
    }
  });

  it('still counts a second live session for a student holding EVERY relaxation', () => {
    // Nothing a teacher can grant covers sitting the paper in two places. Pinned so that changing it is a decision.
    const routed = routeEvidence({
      type: 'MULTI_TAB_DETECTED',
      policy: POLICED,
      relaxations: ALL_RELAXATIONS,
    });
    expect(routed.countsAsStrike).toBe(true);
    expect(routed.relaxedBy).toBeNull();
    expect(routed.severity).toBe('VIOLATION');
  });

  it('records a relaxed event as INFO and names a relaxation the student actually HOLDS', () => {
    const routed = routeEvidence({
      type: 'WINDOW_BLURRED',
      policy: POLICED,
      // Both would silence it. The one named must be one that was granted, and it is.
      relaxations: ['EXTRA_TIME_PERCENT', 'DISABLE_FOCUS_NAG'],
    });
    expect(routed).toEqual({
      type: 'WINDOW_BLURRED',
      watchdog: 'FOCUS',
      severity: 'INFO',
      recorded: true,
      relaxedBy: 'DISABLE_FOCUS_NAG',
      countsAsStrike: false,
    });
  });

  it('leaves an event no relaxation reaches exactly as the table has it', () => {
    for (const type of ['NETWORK_LOST', 'CLOCK_SKEW_DETECTED', 'SIM_LOAD_FAILED'] as const) {
      const routed = routeEvidence({ type, policy: POLICED, relaxations: ALL_RELAXATIONS });
      expect(routed.watchdog, type).toBeNull();
      expect(routed.relaxedBy, type).toBeNull();
      expect(routed.severity, type).toBe(EVIDENCE_RULES[type].severity);
      expect(routed.countsAsStrike, type).toBe(false);
    }
  });

  it('throws for a type the table does not hold, before it routes anything', () => {
    // `WATCHDOG_OF_EVENT['constructor']` is a function, so reading the watchdog first would route a type that does
    // not exist -- `ADV-E1` again, one module along.
    for (const name of ['NOPE', 'TAB_HIDEN', 'constructor', '__proto__', 'toString']) {
      expect(
        () =>
          routeEvidence({
            type: name as EvidenceType,
            policy: POLICED,
            relaxations: ALL_RELAXATIONS,
          }),
        name,
      ).toThrow(/no evidence rule/);
    }
  });
});

describe('the two answers cannot differ, in any cell', () => {
  it('is `countsAsStrike` unless a held relaxation silences it, over every type, policy and grant', () => {
    /**
     * EXHAUSTIVE: 28 types x 128 policies x 64 sets of relaxations. See the note at the top of this file for what this
     * can and cannot see -- it holds the two functions together and says nothing about where they both stand.
     *
     * Disagreements are collected and asserted once. One `expect` per cell is four seconds of matcher overhead for a
     * loop that takes forty milliseconds, and a slow test is one somebody eventually samples.
     */
    const disagreements: string[] = [];
    let cells = 0;
    for (const type of ALL_TYPES) {
      for (const policy of POLICIES) {
        const byTable = countsAsStrike(type, policy);
        for (const relaxations of RELAXATION_SUBSETS) {
          const routed = routeEvidence({ type, policy, relaxations });
          cells += 1;

          const agrees =
            routed.relaxedBy === null
              ? routed.countsAsStrike === byTable &&
                routed.severity === EVIDENCE_RULES[type].severity
              : !routed.countsAsStrike &&
                routed.severity === 'INFO' &&
                relaxations.includes(routed.relaxedBy);
          // A relaxation never ADDS a strike, whatever else is true.
          const added = routed.countsAsStrike && !byTable;
          if (!agrees || added) {
            disagreements.push(`${type} ${JSON.stringify(policy)} [${relaxations.join(',')}]`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // A floor, so a refactor that empties one of the three lists fails instead of passing over nothing. My first
    // version of this line said 64 policies; there are 4 x 4 x 2 x 2 x 2, and the floor is what said so.
    expect(cells).toBe(28 * 128 * 64);
  });

  it('gives a student with no relaxation precisely the table’s answer', () => {
    for (const type of ALL_TYPES) {
      for (const policy of POLICIES) {
        expect(routeEvidence({ type, policy, relaxations: [] }).countsAsStrike).toBe(
          countsAsStrike(type, policy),
        );
      }
    }
  });
});

describe('the event-to-watchdog map', () => {
  it('assigns each watchdog the events it reports, by hand', () => {
    const expected: Readonly<Record<WatchdogName, readonly EvidenceType[]>> = {
      FULLSCREEN: ['FULLSCREEN_DENIED', 'FULLSCREEN_ENTERED', 'FULLSCREEN_EXITED'],
      POINTER_LOCK: ['POINTERLOCK_ENTERED', 'POINTERLOCK_LOST'],
      TAB_HIDE: ['TAB_HIDDEN', 'TAB_VISIBLE'],
      FOCUS: ['WINDOW_BLURRED', 'WINDOW_FOCUSED'],
      COPY: ['CONTEXT_MENU', 'COPY_ATTEMPT', 'PASTE_ATTEMPT', 'PRINT_ATTEMPT'],
    };
    for (const watchdog of Object.keys(expected) as WatchdogName[]) {
      expect([...eventsReportedBy(watchdog)].sort(), watchdog).toEqual(expected[watchdog]);
    }
  });

  it('has a row for every event type and no others', () => {
    // The `Record` type makes a missing row a compile error. This is for a row left behind by a removed type.
    expect(Object.keys(WATCHDOG_OF_EVENT).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('gives every watchdog at least one event that can count, or a relaxation of it silences nothing', () => {
    for (const watchdog of ['FULLSCREEN', 'POINTER_LOCK', 'TAB_HIDE', 'FOCUS', 'COPY'] as const) {
      expect(
        eventsReportedBy(watchdog).some((type) => countsAsStrike(type, POLICED)),
        watchdog,
      ).toBe(true);
    }
  });
});

describe('`routeWatchdogEvent`, the older shape, answers from the same rule', () => {
  it('never says NO where the event-keyed answer says YES', () => {
    // The direction that matters for policing: the older shape cannot lose a strike the table counts. Fed the table's
    // own severity for the type, under every set of relaxations.
    for (const type of ALL_TYPES) {
      const watchdog = WATCHDOG_OF_EVENT[type];
      if (watchdog === null) continue;
      for (const relaxations of RELAXATION_SUBSETS) {
        const full = routeEvidence({ type, policy: POLICED, relaxations });
        const older = routeWatchdogEvent({
          watchdog,
          severity: EVIDENCE_RULES[type].severity,
          relaxations,
        });
        if (full.countsAsStrike) expect(older.countsAsStrike, type).toBe(true);
        // And the relaxation half is the same function, so these are identical rather than merely compatible.
        expect(older.relaxedBy, type).toBe(full.relaxedBy);
        if (full.relaxedBy !== null) expect(older.countsAsStrike, type).toBe(false);
      }
    }
  });

  it('agrees exactly on every event that can count', () => {
    for (const type of COUNTS_WHEN_POLICED) {
      const watchdog = WATCHDOG_OF_EVENT[type];
      if (watchdog === null) continue;
      for (const relaxations of RELAXATION_SUBSETS) {
        expect(
          routeWatchdogEvent({ watchdog, severity: EVIDENCE_RULES[type].severity, relaxations })
            .countsAsStrike,
          type,
        ).toBe(routeEvidence({ type, policy: POLICED, relaxations }).countsAsStrike);
      }
    }
  });

  it('does not count a capability failure, which is the fullscreen watchdog’s WARN', () => {
    // `FULLSCREEN_DENIED` is `WARN` and `never`. The fullscreen watchdog's counting event is filed above it, so a
    // `WARN` from that watchdog cannot be one.
    expect(
      routeWatchdogEvent({ watchdog: 'FULLSCREEN', severity: 'WARN', relaxations: [] })
        .countsAsStrike,
    ).toBe(false);
  });

  it('CANNOT tell a return from a departure, or see the policy -- pinned as it is, with the limit stated', () => {
    /**
     * A KNOWN LIMIT OF THE SHAPE, not of the rule. `(watchdog, severity)` is the same pair for `TAB_HIDDEN` and
     * `TAB_VISIBLE`, and it carries no policy. So the older shape says YES in two cells where the event-keyed answer is
     * NO, and a telemetry route built on it would strike a student for COMING BACK.
     *
     * It is pinned rather than fixed because the pair genuinely does not contain the information, and `ADV-A1` requires
     * the departure to count. Nothing on a write path calls the older shape; this test is here so that stays a
     * decision. It should be deleted with the shape, once the three callers that still use it pass a type instead.
     */
    for (const type of ['TAB_VISIBLE', 'WINDOW_FOCUSED'] as const) {
      const watchdog = WATCHDOG_OF_EVENT[type];
      if (watchdog === null) throw new Error(`${type} has no watchdog`);

      expect(routeEvidence({ type, policy: POLICED, relaxations: [] }).countsAsStrike, type).toBe(
        false,
      );
      expect(
        routeWatchdogEvent({ watchdog, severity: EVIDENCE_RULES[type].severity, relaxations: [] })
          .countsAsStrike,
        type,
      ).toBe(true);
    }

    const unpoliced = { ...POLICED, blockCopyPaste: false };
    expect(
      routeEvidence({ type: 'COPY_ATTEMPT', policy: unpoliced, relaxations: [] }).countsAsStrike,
    ).toBe(false);
    expect(
      routeWatchdogEvent({ watchdog: 'COPY', severity: 'WARN', relaxations: [] }).countsAsStrike,
    ).toBe(true);
  });
});
