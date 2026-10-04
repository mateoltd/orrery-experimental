/**
 * ADVERSARIAL: the system must be able to NOT accuse.  (P8-T15, `RN-01`, `RN-02`, `INV-ACC-1`, `ADR-0017`)
 *
 * ## WHY A SUITE ABOUT DETECTION NEEDS A FILE THAT DETECTS NOTHING
 *
 * `RN-01`: automated proctoring caught 0 of 6 staged cheaters. `RN-02`: it disproportionately flags students with
 * disabilities, students using assistive technology, and students on unstable connections. Put together, the
 * expected content of an integrity timeline is mostly false positives about the students least able to contest them.
 *
 * Every other adversarial file asks "can the attacker get past this?". A suite made only of those would pass on a
 * system that accuses everyone -- the detection tests would all be green. So this file is the other half, and its
 * question is the one a wrongly-flagged student would ask: **is there a path through this exam, for someone who did
 * nothing, on which nothing is held against them?**
 *
 * Three populations, three ways the answer could be no:
 *
 *  · the student who did NOTHING -- escalated by arithmetic, with no event at all (`ADV-A2`);
 *  · the student whose DEVICE or NETWORK misbehaved -- events about the software read as events about them;
 *  · the student with an ACCOMMODATION -- the relaxation recorded, then counted anyway (`ADV-A1`).
 *
 * ## WHAT IS HAND-WRITTEN HERE, ON PURPOSE
 *
 * `NOT_ABOUT_THE_STUDENT` below is typed out, not derived from `EVIDENCE_RULES`. A list read off the table's own
 * `strike: 'never'` would agree with the table whatever the table said, and the point is for an edit to the table to
 * fail something.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type GrantedRelaxation,
  routeWatchdogEvent,
  type WatchdogName,
  watchdogsSilencedBy,
} from '../accommodations.js';
import {
  classifyBreaches,
  effectOf,
  evaluateEscalation,
  LADDER,
  type Rung,
} from '../escalation.js';
import {
  countsAsStrike,
  EVIDENCE_RULES,
  type EvidenceType,
  type StrikePolicyView,
} from '../evidence.js';
import { evaluatePreflight, type PreflightReport } from '../session.js';

const RUNS = 300;

/**
 * Events that describe the platform, the browser, the network, an accommodation, or the student COMING BACK.
 *
 * `plans/09` §7.1 marks four of these in bold. The rest are here because each has an obvious wrong reading: a lost
 * network as "went offline to look something up", a late-save rejection as "tried to cheat the clock", a return as a
 * second departure.
 */
const NOT_ABOUT_THE_STUDENT: readonly EvidenceType[] = [
  'EXAM_STARTED',
  'FULLSCREEN_ENTERED',
  'FULLSCREEN_DENIED',
  'POINTERLOCK_ENTERED',
  'WINDOW_FOCUSED',
  'TAB_VISIBLE',
  'SAVE_ATTEMPT',
  'DEVTOOLS_SIZE_ANOMALY',
  'SAVE_REJECTED_LATE',
  'QUESTION_WINDOW_CLOSED',
  'CLOCK_SKEW_DETECTED',
  'NETWORK_LOST',
  'NETWORK_RESTORED',
  'AUTOSAVE_QUEUED',
  'SIM_LOAD_FAILED',
  'ACCOMMODATION_RELAXED',
  'ATTEMPT_TERMINATED',
  'ATTEMPT_SUBMITTED',
];

/** A policy view as a hostile or careless caller might build it: the enums are plain strings at this boundary. */
const policyArb: fc.Arbitrary<StrikePolicyView> = fc.record({
  requireFullscreen: fc.oneof(fc.constantFrom('OFF', 'WARN', 'BLOCK'), fc.string({ maxLength: 8 })),
  requirePointerLock: fc.oneof(
    fc.constantFrom('OFF', 'WARN', 'BLOCK'),
    fc.string({ maxLength: 8 }),
  ),
  multiTabPolicy: fc.oneof(fc.constantFrom('WARN', 'BLOCK'), fc.string({ maxLength: 8 })),
  blockCopyPaste: fc.boolean(),
  blockPrintSave: fc.boolean(),
});

const ALL_RELAXATIONS: readonly GrantedRelaxation[] = [
  'DISABLE_FULLSCREEN',
  'DISABLE_POINTER_LOCK',
  'DISABLE_TAB_WATCHDOG',
  'ALLOW_COPY',
  'DISABLE_FOCUS_NAG',
  'EXTRA_TIME_PERCENT',
];
const ALL_WATCHDOGS: readonly WatchdogName[] = [
  'FULLSCREEN',
  'POINTER_LOCK',
  'TAB_HIDE',
  'FOCUS',
  'COPY',
];

const thresholdsOf = (value: number | null) => ({
  fullscreenExits: value,
  focusLosses: value,
  tabHides: value,
  pointerLockLosses: value,
  copyAttempts: value,
});

describe('a student who did nothing has nothing held against them', () => {
  it('reaches no rung with no violations, under every threshold of one or more', () => {
    fc.assert(
      fc.property(
        fc.record({
          fullscreenExits: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.constant(null)),
          focusLosses: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.constant(null)),
          tabHides: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.constant(null)),
          pointerLockLosses: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.constant(null)),
          copyAttempts: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.constant(null)),
        }),
        (thresholds) => {
          const verdict = evaluateEscalation({ counts: {}, thresholds, ladder: LADDER });
          expect(verdict.rung).toBe('NONE');
          expect(verdict.reasons).toEqual([]);
          expect(verdict.freezesAttempt).toBe(false);
        },
      ),
      { numRuns: RUNS },
    );
  });

  /**
   * `ADV-A2` -- KNOWN DEFECT in `escalation.ts`, outside this lane. This one freezes an attempt nobody touched.
   *
   * A threshold of `0` is documented as "forbidden outright. The first one is the violation." The comparison is
   * `count >= threshold`, and `0 >= 0` is true -- so with a zero threshold a student is in breach at a count of
   * ZERO, before any event exists. `ExamPolicy` accepts `0` (`nonnegative()`), so this is a policy a teacher can
   * write, and the natural one for "no copying at all".
   *
   * It compounds. The rung is the number of breached KINDS, so a policy with zero tolerance on four kinds puts every
   * student on the fourth rung -- `FREEZE_AND_SUBMIT` -- at the first evaluation. `engine.test.ts` covers a zero
   * threshold only with a count of one or more, where `>=` and the intended rule agree.
   */
  it.fails('ADV-A2: does not breach a ZERO threshold at a count of zero', () => {
    const report = classifyBreaches({ counts: {}, thresholds: thresholdsOf(0), ladder: LADDER });
    expect(report.breached).toEqual([]);

    const verdict = evaluateEscalation({ counts: {}, thresholds: thresholdsOf(0), ladder: LADDER });
    expect(verdict.rung).toBe('NONE');
    expect(verdict.freezesAttempt).toBe(false);
  });

  it('still breaches a zero threshold on the FIRST violation, so fixing `ADV-A2` must not make zero mean never', () => {
    // The other side of the same boundary, pinned so the obvious fix (`>`) is caught: `0` and `null` are opposite
    // policies and must stay that way.
    const report = classifyBreaches({
      counts: { copyAttempt: 1 },
      thresholds: { ...thresholdsOf(null), copyAttempts: 0 },
      ladder: LADDER,
    });
    expect(report.breached).toEqual(['copyAttempt']);
  });

  it('is never told BLOCKED by a capability probe, whatever their browser lacks', () => {
    // `plans/09` §6.2: "A capability a modern browser lacks never produces `BLOCKED`". A locked-down school device and
    // a screen reader are both reports with everything missing, and both must reach the exam.
    const reportArb: fc.Arbitrary<PreflightReport> = fc.record({
      browser: fc.record({
        storage: fc.boolean(),
        pageLifecycle: fc.boolean(),
        broadcastChannel: fc.boolean(),
      }),
      network: fc.record({
        rttMs: fc.oneof(
          fc.integer({ min: 0, max: 600_000 }),
          fc.constant(Number.POSITIVE_INFINITY),
        ),
        effectiveType: fc.constantFrom('4g', '3g', '2g', 'slow-2g', ''),
        saveData: fc.boolean(),
      }),
      a11y: fc.record({
        reducedMotion: fc.boolean(),
        forcedColors: fc.boolean(),
        screenReaderGuess: fc.option(fc.constantFrom('NVDA', 'JAWS', 'VoiceOver', 'unknown'), {
          nil: null,
        }),
      }),
    });
    fc.assert(
      fc.property(reportArb, (report) => {
        const verdict = evaluatePreflight(report);
        expect(verdict.status).not.toBe('BLOCKED');
        // Every relaxation is explained. One the student cannot read is one they cannot challenge.
        expect(verdict.notes.length).toBeGreaterThanOrEqual(verdict.relaxations.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('does not have a policy relaxed, or tightened, on a GUESS that they use a screen reader', () => {
    // No browser reports a screen reader. A heuristic that gated anything would tighten the exam for a false positive
    // and out a disability for a true one.
    const base: PreflightReport = {
      browser: { storage: true, pageLifecycle: true, broadcastChannel: true },
      network: { rttMs: 40, effectiveType: '4g', saveData: false },
      a11y: { reducedMotion: false, forcedColors: false, screenReaderGuess: null },
    };
    const guessed = evaluatePreflight({
      ...base,
      a11y: { ...base.a11y, screenReaderGuess: 'NVDA' },
    });
    const plain = evaluatePreflight(base);
    expect(guessed.status).toBe(plain.status);
    expect(guessed.relaxations).toEqual(plain.relaxations);
  });
});

describe('an event about the software, the network or a return is never a strike', () => {
  it('counts none of them, under any policy that can be expressed', () => {
    // What breaks without it: one row of the table edited from `never` to `when_policy_says`, and a student on a
    // train is escalated for their signal.
    fc.assert(
      fc.property(fc.constantFrom(...NOT_ABOUT_THE_STUDENT), policyArb, (type, policy) => {
        expect(countsAsStrike(type, policy)).toBe(false);
      }),
      { numRuns: RUNS * 2 },
    );
  });

  it('files none of them as a VIOLATION, which is the severity a teacher reads as misconduct', () => {
    for (const type of NOT_ABOUT_THE_STUDENT) {
      expect(EVIDENCE_RULES[type].severity, type).not.toBe('VIOLATION');
    }
  });

  it('covers every type that is not one of the policed behaviours, so a new event has to be classified here', () => {
    // The complement, written out too. A type added to the table lands in neither list and fails this.
    const policed: readonly EvidenceType[] = [
      'FULLSCREEN_EXITED',
      'POINTERLOCK_LOST',
      'WINDOW_BLURRED',
      'TAB_HIDDEN',
      'MULTI_TAB_DETECTED',
      'COPY_ATTEMPT',
      'PASTE_ATTEMPT',
      'CONTEXT_MENU',
      'PRINT_ATTEMPT',
      // Server-emitted and never a strike; the batcher refuses it from a client. See `forged-events.test.ts`.
      'VIOLATION_THRESHOLD_REACHED',
    ];
    expect([...NOT_ABOUT_THE_STUDENT, ...policed].sort()).toEqual(
      (Object.keys(EVIDENCE_RULES) as EvidenceType[]).sort(),
    );
  });

  it('lets a whole sitting on a failing connection end with no strike and no rung', () => {
    // The `RN-02` student, end to end over the two decisions that exist: three hours of drops, re-syncs, queued saves
    // and a late save refused by the server, under the strictest policy there is.
    const strictest: StrikePolicyView = {
      requireFullscreen: 'BLOCK',
      requirePointerLock: 'BLOCK',
      multiTabPolicy: 'BLOCK',
      blockCopyPaste: true,
      blockPrintSave: true,
    };
    const sitting: EvidenceType[] = [];
    for (let minute = 0; minute < 180; minute += 1) {
      sitting.push('NETWORK_LOST', 'AUTOSAVE_QUEUED', 'NETWORK_RESTORED', 'CLOCK_SKEW_DETECTED');
      if (minute % 30 === 0) sitting.push('SAVE_REJECTED_LATE', 'SIM_LOAD_FAILED');
    }
    const strikes = sitting.filter((type) => countsAsStrike(type, strictest)).length;
    expect(sitting.length).toBe(732);
    expect(strikes).toBe(0);

    const verdict = evaluateEscalation({ counts: {}, thresholds: thresholdsOf(1), ladder: LADDER });
    expect(verdict.rung).toBe('NONE');
  });
});

describe('INV-ACC-1: a granted relaxation cannot be counted against the student who holds it', () => {
  it('routes every event from a silenced watchdog to INFO, recorded, with no strike', () => {
    fc.assert(
      fc.property(
        fc.subarray([...ALL_RELAXATIONS]),
        fc.constantFrom(...ALL_WATCHDOGS),
        fc.constantFrom<'INFO' | 'WARN' | 'VIOLATION'>('INFO', 'WARN', 'VIOLATION'),
        (relaxations, watchdog, severity) => {
          const silenced = relaxations.some((relaxation) =>
            watchdogsSilencedBy(relaxation).includes(watchdog),
          );
          const routed = routeWatchdogEvent({ watchdog, severity, relaxations });

          // Recorded either way: a quiet timeline has to be able to say why it is quiet.
          expect(routed.recorded).toBe(true);
          if (silenced) {
            expect(routed.severity).toBe('INFO');
            expect(routed.countsAsStrike).toBe(false);
            // The relaxation it names is one that was actually GRANTED, not merely one that would have applied.
            expect(routed.relaxedBy).not.toBeNull();
            expect(relaxations).toContain(routed.relaxedBy);
          } else {
            expect(routed.relaxedBy).toBeNull();
            expect(routed.severity).toBe(severity);
          }
        },
      ),
      { numRuns: RUNS * 2 },
    );
  });

  it('silences nothing for a relaxation the student was not granted', () => {
    // The other direction, which is the integrity half: an exemption cannot be acquired by anything but a grant.
    for (const watchdog of ALL_WATCHDOGS) {
      const routed = routeWatchdogEvent({ watchdog, severity: 'VIOLATION', relaxations: [] });
      expect(routed.countsAsStrike, watchdog).toBe(true);
      expect(routed.relaxedBy, watchdog).toBeNull();
    }
  });

  it('does not let extra time silence a watchdog', () => {
    // `EXTRA_TIME_PERCENT` is the commonest accommodation there is. It changes a deadline and nothing else.
    expect(watchdogsSilencedBy('EXTRA_TIME_PERCENT')).toEqual([]);
  });

  /**
   * `ADV-A1` -- KNOWN DEFECT, and it is two modules disagreeing, so neither file is wrong on its own.
   *
   * "Does this event count as a strike?" has two answers in this package:
   *
   *  · `evidence.ts` `countsAsStrike` -- `TAB_HIDDEN` and `WINDOW_BLURRED` are `WARN` severity and DO count
   *    ("thresholded"), which is `plans/09` §7.1's table.
   *  · `accommodations.ts` `routeWatchdogEvent` -- an un-relaxed event counts only if its severity is `VIOLATION`.
   *
   * So for a tab hide by a student with NO accommodation the first says yes and the second says no. Nothing calls
   * either yet (there is no telemetry route). Whichever the route calls, one invariant goes: route through
   * `routeWatchdogEvent` alone and `thresholds.tabHides` is dead -- five of the six policed behaviours are `WARN`;
   * route through `countsAsStrike` alone and `INV-ACC-1` is not applied at all. `accommodations.ts`'s own header
   * describes this exact shape -- "three implementations of one routing rule" -- as the defect it was written to end.
   */
  it.fails('ADV-A1: gives ONE answer to "does this count", for an event no relaxation applies to', () => {
    const policed: readonly (readonly [EvidenceType, WatchdogName])[] = [
      ['FULLSCREEN_EXITED', 'FULLSCREEN'],
      ['POINTERLOCK_LOST', 'POINTER_LOCK'],
      ['TAB_HIDDEN', 'TAB_HIDE'],
      ['WINDOW_BLURRED', 'FOCUS'],
      ['COPY_ATTEMPT', 'COPY'],
    ];
    const everythingPoliced: StrikePolicyView = {
      requireFullscreen: 'BLOCK',
      requirePointerLock: 'BLOCK',
      multiTabPolicy: 'BLOCK',
      blockCopyPaste: true,
      blockPrintSave: true,
    };
    for (const [type, watchdog] of policed) {
      const byTable = countsAsStrike(type, everythingPoliced);
      const byRouting = routeWatchdogEvent({
        watchdog,
        severity: EVIDENCE_RULES[type].severity,
        relaxations: [],
      }).countsAsStrike;
      expect(byRouting, type).toBe(byTable);
    }
  });
});

describe('ADR-0017: the worst the machine can do is stop and ask a human', () => {
  it('has no rung, for any evidence at all, that ends an attempt or cannot be undone', () => {
    /**
     * What breaks without it: a rung that sets a status other than `FROZEN`, or one marked irreversible. `V-12` was
     * that bug -- `TERMINATE` discarded unwritten answers with no human present.
     *
     * Hostile counts are included because the counts arrive from a counter a forged or looped event can run up: the
     * verdict for a count of ten million must be the same KIND of thing as the verdict for a count of four.
     */
    const countArb = fc.oneof(
      fc.nat({ max: 50 }),
      fc.constantFrom(10_000_000, Number.MAX_SAFE_INTEGER),
    );
    fc.assert(
      fc.property(
        fc.record({
          fullscreenExit: countArb,
          focusLoss: countArb,
          tabHide: countArb,
          pointerLockLoss: countArb,
          copyAttempt: countArb,
        }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: LADDER.length }),
        (counts, threshold, depth) => {
          const ladder: Rung[] = LADDER.slice(0, depth);
          const verdict = evaluateEscalation({
            counts,
            thresholds: thresholdsOf(threshold),
            ladder,
          });
          const effect = effectOf(verdict.rung);

          expect(verdict.reversible).toBe(true);
          expect(effect.reversible).toBe(true);
          expect(['NONE', 'FROZEN']).toContain(effect.attemptEffect);
          // Never past what the policy offered, however large the count.
          expect(verdict.rung === 'NONE' || ladder.includes(verdict.rung)).toBe(true);
          // And a student who is stopped is told, in words, what happened to their work.
          if (verdict.freezesAttempt)
            expect(effect.studentMessage).toMatch(/Nothing you have written/);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
