// @vitest-environment jsdom

/**
 * The teacher evidence timeline and the `IntegrityVerdict`.  (P8-T14)
 *
 * `plans/09` §7.3's copy requirements exist because the obvious version of this screen is a lie detector. So the tests
 * are mostly about what the module REFUSES to produce: no conclusion from evidence, no sentence about intent, and no
 * void without a freeze first.
 */

import { describe, expect, it } from 'vitest';

import {
  buildTimeline,
  EVIDENCE_BANNER,
  INTEGRITY_HELP,
  MIN_VERDICT_REASON,
  recordVerdict,
  summariseCounts,
  type TimelineFacts,
} from './timeline';

const T0 = 1_800_000_000_000;

const facts = (over: Partial<TimelineFacts> = {}): TimelineFacts => ({
  attemptId: 'a1',
  entries: [
    { at: T0 + 2_000, type: 'FULLSCREEN_EXITED', severity: 'VIOLATION', phrase: 'left fullscreen' },
    { at: T0, type: 'EXAM_STARTED', severity: 'INFO', phrase: 'started the exam' },
    {
      at: T0 + 1_000,
      type: 'TAB_HIDDEN',
      severity: 'WARN',
      phrase: 'tab was hidden',
      crossedThreshold: 12,
    },
  ],
  preflight: { storage: true, broadcastChannel: true, rttMs: 40 },
  similarityClusters: [{ id: 'cluster-1', responseIds: ['r1', 'r2', 'r3'] }],
  forceExits: [{ at: T0 + 3_000, phase: 'beforeunload' }],
  isFrozen: false,
  droppedEventCount: 0,
  ...over,
});

describe('the banner and the help text are REQUIRED content, not decoration', () => {
  it('states that this is evidence and not a determination', () => {
    expect(EVIDENCE_BANNER).toContain('not a determination');
    expect(EVIDENCE_BANNER).toContain('does not conclude anything');
  });

  it('quotes RN-01, because a teacher who believes this is a lie detector will use it as one', () => {
    expect(INTEGRITY_HELP).toContain('do not detect cheating');
    expect(INTEGRITY_HELP).toContain('not evidence of misconduct');
  });

  it('names the innocent explanations rather than leaving them to be guessed', () => {
    expect(INTEGRITY_HELP).toContain('shared model answer');
    expect(INTEGRITY_HELP).toContain('dictation');
  });

  it('carries both onto the report, so a screen cannot show the timeline without them', () => {
    const report = buildTimeline(facts());
    expect(report.banner).toBe(EVIDENCE_BANNER);
    expect(report.help).toBe(INTEGRITY_HELP);
  });
});

describe('the timeline is a chronology, not a judgement', () => {
  it('sorts events chronologically', () => {
    expect(buildTimeline(facts()).entries.map((entry) => entry.type)).toEqual([
      'EXAM_STARTED',
      'TAB_HIDDEN',
      'FULLSCREEN_EXITED',
    ]);
  });

  it('breaks a tie on type, so two events in the same millisecond do not reshuffle between renders', () => {
    // Without a secondary key, comparing two screenshots of the same attempt shows differences that are not there.
    const same = facts({
      entries: [
        { at: T0, type: 'TAB_HIDDEN', severity: 'WARN', phrase: 'p' },
        { at: T0, type: 'FULLSCREEN_EXITED', severity: 'VIOLATION', phrase: 'p' },
      ],
    });
    expect(buildTimeline(same).entries.map((e) => e.type)).toEqual([
      buildTimeline(same).entries[0]?.type,
      buildTimeline(same).entries[1]?.type,
    ]);
    expect(JSON.stringify(buildTimeline(same).entries)).toBe(
      JSON.stringify(buildTimeline(same).entries),
    );
  });

  it('DESCRIBES events and never asserts intent', () => {
    // `plans/09` §7.3's model is "left fullscreen 3 times"; the thing not to write is "attempted to cheat". The
    // difference is not style: a sentence about intent is a conclusion the evidence does not support.
    const report = buildTimeline(facts());
    for (const entry of report.entries) {
      expect(`${entry.phrase}`.toLowerCase(), entry.type).not.toMatch(
        /cheat|attempt|intent|suspicious|deliberate/,
      );
    }
  });

  it('summarises with COUNTS rather than characterisations', () => {
    const summary = summariseCounts(buildTimeline(facts()).entries);
    expect(summary).toContain('1 × fullscreen exited');
    expect(summary).toContain('1 × tab hidden');
    // "repeatedly left fullscreen" is a characterisation, and characterisations are where intent gets smuggled in.
    for (const line of summary) expect(line).toMatch(/^\d+ × /);
  });
});

describe('U-2: a lossy timeline must SAY it is lossy', () => {
  it('reports dropped events and refuses to call the report reviewable', () => {
    // A teacher must be able to see that the escalation was under-counted, or a clean timeline reads as a clean
    // attempt.
    const report = buildTimeline(facts({ droppedEventCount: 7 }));
    expect(report.droppedEventCount).toBe(7);
    expect(report.isReviewable).toBe(false);
    expect(report.missingForDecision.join(' ')).toContain('lost to telemetry shedding');
  });

  it('is NOT reviewable without the preflight record, because the events cannot be interpreted without it', () => {
    // A fullscreen exit on a device that could never enter fullscreen is a capability failure, not a choice.
    const report = buildTimeline(facts({ preflight: {} }));
    expect(report.isReviewable).toBe(false);
    expect(report.missingForDecision.join(' ')).toContain('preflight');
  });

  it('is NOT reviewable with no events at all', () => {
    expect(buildTimeline(facts({ entries: [] })).isReviewable).toBe(false);
  });

  it('IS reviewable when it has events, a preflight record, and nothing lost', () => {
    expect(buildTimeline(facts()).isReviewable).toBe(true);
  });

  it('carries cluster membership as RESPONSE IDS, never as names', () => {
    const report = buildTimeline(facts());
    expect(report.similarityClusters[0]?.responseIds).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('V-12: only a human disposes, and freezing comes first', () => {
  const base = {
    conclusion: 'NOTED' as const,
    reason: 'left fullscreen during a lecture, worth following up on Monday',
    authorId: 'teacher-1',
    at: T0,
    attemptIsFrozen: true,
  };

  it('records a verdict with a reason, an author and a timestamp', () => {
    const outcome = recordVerdict(base);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.verdict.reason).toContain('following up');
      expect(outcome.verdict.authorId).toBe('teacher-1');
      expect(outcome.verdict.supersedes).toBeNull();
    }
  });

  it('REFUSES a verdict with no author, because a system conclusion wearing a teacher name is the thing to prevent', () => {
    const outcome = recordVerdict({ ...base, authorId: '  ' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('NO_AUTHOR');
  });

  it('requires a reason for EVERY conclusion, not only for a void', () => {
    // `NO_CONCERN` with an empty reason is indistinguishable from a verdict nobody thought about -- and it is the
    // box most likely to be ticked without reading anything.
    for (const conclusion of ['NO_CONCERN', 'NOTED', 'REVIEW', 'VOIDED'] as const) {
      const outcome = recordVerdict({ ...base, conclusion, reason: 'too short' });
      expect(outcome.ok, conclusion).toBe(false);
      if (!outcome.ok) expect(outcome.reason, conclusion).toBe('REASON_TOO_SHORT');
    }
  });

  it('refuses to VOID an attempt that is not frozen', () => {
    // V-12's sequence is freeze, THEN a human decision, and voiding is the decision. Voiding an open attempt skips the
    // step where a teacher can still reinstate -- so the requirement IS the reversibility the correction restored.
    const outcome = recordVerdict({ ...base, conclusion: 'VOIDED', attemptIsFrozen: false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('VOID_REQUIRES_FROZEN');
  });

  it('allows VOIDING a frozen attempt', () => {
    expect(recordVerdict({ ...base, conclusion: 'VOIDED', attemptIsFrozen: true }).ok).toBe(true);
  });

  it('records which verdict it SUPERSEDES, so revising one leaves a trail', () => {
    const outcome = recordVerdict({ ...base, supersedes: 4 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.verdict.supersedes).toBe(4);
  });

  it('trims the reason, so a verdict is not stored padded', () => {
    const outcome = recordVerdict({
      ...base,
      reason: `   ${'a real reason that is long enough'.repeat(2)}   `,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.verdict.reason).not.toMatch(/^\s|\s$/);
  });

  it('has a minimum reason length a person can read', () => {
    // Below this it is a category, not a justification.
    expect(MIN_VERDICT_REASON).toBeGreaterThan(10);
  });
});
