/**
 * The evidence schema, strike classification and batching.  (P8-T7)
 *
 * `plans/09` §7.1's table has four entries that are not about the student, and each can be turned into an accusation by
 * accident. Every one of them has a test here, because the failure mode is a strike against a student for a browser
 * policy, an accommodation, or our own bug.
 */

import { FrozenClock } from '@orrery/clock';
import { describe, expect, it, vi } from 'vitest';

import {
  batchSigningInput,
  canonicalEvent,
  countsAsStrike,
  EVIDENCE_RULES,
  EvidenceBatcher,
  type EvidenceType,
  SERVER_ONLY_EVENTS,
  type SignedBatch,
  type StrikePolicyView,
} from './evidence.js';

const T0 = 1_800_000_000_000;

const policy = (over: Partial<StrikePolicyView> = {}): StrikePolicyView => ({
  requireFullscreen: 'WARN',
  requirePointerLock: 'OFF',
  multiTabPolicy: 'WARN',
  blockCopyPaste: true,
  blockPrintSave: true,
  ...over,
});

describe('the event table is CLOSED', () => {
  it('has a rule for every declared type, with no extras', () => {
    // `as const` makes a MISSING row a compile error. The runtime check is for a row added to the union and not here.
    const declared: readonly EvidenceType[] = [
      'EXAM_STARTED',
      'FULLSCREEN_ENTERED',
      'FULLSCREEN_EXITED',
      'FULLSCREEN_DENIED',
      'POINTERLOCK_ENTERED',
      'POINTERLOCK_LOST',
      'WINDOW_BLURRED',
      'WINDOW_FOCUSED',
      'TAB_HIDDEN',
      'TAB_VISIBLE',
      'MULTI_TAB_DETECTED',
      'COPY_ATTEMPT',
      'PASTE_ATTEMPT',
      'CONTEXT_MENU',
      'PRINT_ATTEMPT',
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
      'VIOLATION_THRESHOLD_REACHED',
      'ATTEMPT_TERMINATED',
      'ATTEMPT_SUBMITTED',
    ];
    expect(Object.keys(EVIDENCE_RULES).sort()).toEqual([...declared].sort());
  });

  it('gives every rule a reason, because a rule nobody can explain is a rule nobody can challenge', () => {
    for (const [type, rule] of Object.entries(EVIDENCE_RULES)) {
      expect(rule.why.trim().length, type).toBeGreaterThan(10);
    }
  });
});

describe('the four events that are NOT about the student', () => {
  it('never counts a fullscreen REFUSAL, which is a capability failure', () => {
    /**
     * `plans/09` §7.1: "A capability failure, not misconduct". A locked-down school device denies fullscreen, so
     * counting it puts a strike against a student for a browser policy.
     */
    expect(countsAsStrike('FULLSCREEN_DENIED', policy())).toBe(false);
    expect(countsAsStrike('FULLSCREEN_DENIED', policy({ requireFullscreen: 'BLOCK' }))).toBe(false);
  });

  it('never counts a devtools size anomaly, which is not evidence of anything', () => {
    // "advisory evidence only, never punitive" -- and window size is trivially changed by any desktop user.
    expect(countsAsStrike('DEVTOOLS_SIZE_ANOMALY', policy())).toBe(false);
  });

  it('never counts a simulation that failed to LOAD, because that is our bug', () => {
    // "**never penalises the student for our bug**". A student's marks must not depend on our bundling.
    expect(countsAsStrike('SIM_LOAD_FAILED', policy())).toBe(false);
  });

  it('never counts an accommodation being relaxed, under INV-ACC-1', () => {
    // A relaxation is a right. Counting it would make an accommodation a way to lose marks.
    expect(countsAsStrike('ACCOMMODATION_RELAXED', policy())).toBe(false);
  });

  it("never counts the server's own threshold event, whatever the policy", () => {
    expect(countsAsStrike('VIOLATION_THRESHOLD_REACHED', policy())).toBe(false);
  });
});

describe('the events that DO count', () => {
  it('counts a fullscreen exit only when fullscreen was REQUIRED', () => {
    expect(countsAsStrike('FULLSCREEN_EXITED', policy({ requireFullscreen: 'WARN' }))).toBe(true);
    expect(countsAsStrike('FULLSCREEN_EXITED', policy({ requireFullscreen: 'OFF' }))).toBe(false);
  });

  it('counts a second live tab ALWAYS', () => {
    // `tabGuard` only emits this for a tab that answered, so "always" is safe: it cannot fire for a sleeping tab.
    expect(countsAsStrike('MULTI_TAB_DETECTED', policy({ multiTabPolicy: 'WARN' }))).toBe(true);
  });

  it('counts a copy attempt only when copy/paste is blocked', () => {
    expect(countsAsStrike('COPY_ATTEMPT', policy({ blockCopyPaste: true }))).toBe(true);
    expect(countsAsStrike('COPY_ATTEMPT', policy({ blockCopyPaste: false }))).toBe(false);
  });

  it('counts a print attempt only when print/save is blocked', () => {
    // A copy/paste block must not enable the print counter by accident.
    expect(countsAsStrike('PRINT_ATTEMPT', policy({ blockPrintSave: true }))).toBe(true);
    expect(countsAsStrike('PRINT_ATTEMPT', policy({ blockPrintSave: false }))).toBe(false);
  });

  it('counts a pointer-lock loss only when pointer lock is required', () => {
    // `Escape` always causes one, which is why the grace exists and why this is off by default.
    expect(countsAsStrike('POINTERLOCK_LOST', policy({ requirePointerLock: 'WARN' }))).toBe(true);
    expect(countsAsStrike('POINTERLOCK_LOST', policy({ requirePointerLock: 'OFF' }))).toBe(false);
  });

  it('never counts a return, however many times it happens', () => {
    expect(countsAsStrike('WINDOW_FOCUSED', policy())).toBe(false);
    expect(countsAsStrike('TAB_VISIBLE', policy())).toBe(false);
  });

  it('throws on an unknown type rather than defaulting to no strike', () => {
    // A lenient default silently un-strikes a violation the moment someone adds a type without a row.
    expect(() => countsAsStrike('NOPE' as EvidenceType, policy())).toThrow(/no evidence rule/);
  });
});

describe('canonical form', () => {
  it('sorts keys, so a phone and a server produce the same bytes', () => {
    const a = canonicalEvent({ seq: 1, type: 'TAB_HIDDEN', at: T0 });
    const b = canonicalEvent({ at: T0, type: 'TAB_HIDDEN', seq: 1 });
    expect(a).toBe(b);
  });

  it('drops `undefined` rather than deciding whether the key exists', () => {
    const withDetail = canonicalEvent({ seq: 1, type: 'TAB_HIDDEN', at: T0 });
    const withoutDetail = canonicalEvent({ seq: 1, type: 'TAB_HIDDEN', at: T0, detail: undefined });
    expect(withDetail).toBe(withoutDetail);
  });

  it('serialises an explicit `null` DIFFERENTLY from an absent key', () => {
    // `escapePossiblyInvolved: null` means "we do not know" and `{}` means "we did not look". Collapsing them would
    // make a recorded unknown indistinguishable from a recorded absence.
    expect(
      canonicalEvent({
        seq: 1,
        type: 'POINTERLOCK_LOST',
        at: T0,
        detail: { escapePossiblyInvolved: null },
      }),
    ).not.toBe(canonicalEvent({ seq: 1, type: 'POINTERLOCK_LOST', at: T0, detail: {} }));
  });
});

describe('the signing input', () => {
  const events = [
    { seq: 4, type: 'TAB_HIDDEN' as const, at: T0 },
    { seq: 5, type: 'TAB_VISIBLE' as const, at: T0 + 1 },
  ];

  it('includes the attemptId, so a signature cannot be replayed onto another attempt', () => {
    const a = batchSigningInput({ attemptId: 'a1', tabId: 't1', events });
    const b = batchSigningInput({ attemptId: 'a2', tabId: 't1', events });
    expect(a).not.toBe(b);
  });

  it('includes the tabId, so one tab cannot sign for another', () => {
    expect(batchSigningInput({ attemptId: 'a1', tabId: 't1', events })).not.toBe(
      batchSigningInput({ attemptId: 'a1', tabId: 't2', events }),
    );
  });

  it('includes the SEQUENCE RANGE, so a batch cannot be extended after signing', () => {
    const extended = [...events, { seq: 6, type: 'TAB_HIDDEN' as const, at: T0 + 2 }];
    expect(batchSigningInput({ attemptId: 'a1', tabId: 't1', events })).not.toBe(
      batchSigningInput({ attemptId: 'a1', tabId: 't1', events: extended }),
    );
  });

  it('is DOMAIN SEPARATED with a version tag', () => {
    const input = batchSigningInput({ attemptId: 'a1', tabId: 't1', events });
    expect(input.startsWith('orrery.evidence.v1')).toBe(true);
    // A signature obtained for one purpose must not be presentable as a signature for another.
    expect(input).not.toContain('joincode');
  });

  it('separates fields with an ESCAPED NUL, never a literal byte in the source', () => {
    const input = batchSigningInput({ attemptId: 'a1', tabId: 't1', events });
    expect(input.split('\u0000')[0]).toBe('orrery.evidence.v1');
  });
});

describe('EvidenceBatcher', () => {
  const setup = (over: { maxQueued?: number; batchSize?: number } = {}) => {
    const clock = new FrozenClock(T0);
    const sent: Omit<SignedBatch, 'signature'>[] = [];
    const transport = vi.fn(async (batch: Omit<SignedBatch, 'signature'>) => {
      sent.push(batch);
      return true;
    });
    const batcher = new EvidenceBatcher(
      { batchSize: over.batchSize ?? 4, maxQueued: over.maxQueued ?? 16, transport },
      clock,
      'a1',
      'tab-a',
      (input) => `sig:${String(input.length)}`,
    );
    return { batcher, sent, transport, clock };
  };

  it('REFUSES to emit a server-only event', () => {
    const { batcher } = setup();
    // A client announcing its own escalation would have the ladder act on evidence a teacher has not seen.
    expect(batcher.record('VIOLATION_THRESHOLD_REACHED')).toBe(false);
    expect(batcher.stats.queued).toBe(0);
    for (const type of SERVER_ONLY_EVENTS) expect(batcher.record(type)).toBe(false);
  });

  it('numbers events monotonically from zero, whatever the clock says', () => {
    const { batcher, clock } = setup();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(1_000);
      batcher.record('TAB_HIDDEN');
    }
    expect(batcher.takeBatch().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('sends at most `batchSize` per flush and keeps the rest', () => {
    const { batcher, sent } = setup({ batchSize: 2 });
    for (let i = 0; i < 5; i += 1) batcher.record('TAB_HIDDEN');
    return batcher.flushOnce().then(() => {
      expect(sent[0]?.events).toHaveLength(2);
      expect(batcher.stats.queued).toBe(3);
    });
  });

  it('DROPS THE OLDEST on overflow, and COUNTS the loss', () => {
    /**
     * `plans/09` §7: telemetry may be incomplete and that is acceptable. The alternative -- growing without bound over
     * a three-hour exam, or blocking the exam to preserve it -- is worse than a hole in a timeline.
     */
    const { batcher } = setup({ maxQueued: 3 });
    for (let i = 0; i < 6; i += 1) batcher.record('TAB_HIDDEN');
    expect(batcher.stats.queued).toBe(3);
    expect(batcher.stats.dropped).toBe(3);
    // The OLDEST are shed, so what survives is the recent evidence a teacher is looking at.
    expect(batcher.takeBatch().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('counts a refused batch rather than throwing, because telemetry may be lost', () => {
    const clock = new FrozenClock(T0);
    const batcher = new EvidenceBatcher(
      { batchSize: 4, maxQueued: 16, transport: async () => false },
      clock,
      'a1',
      'tab-a',
      () => 'sig',
    );
    batcher.record('TAB_HIDDEN');
    return batcher.flushOnce().then((ok) => {
      expect(ok).toBe(false);
      expect(batcher.stats.batchesFailed).toBe(1);
      expect(batcher.stats.sent).toBe(0);
    });
  });

  it('counts a transport that THROWS rather than propagating into the exam', () => {
    const clock = new FrozenClock(T0);
    const batcher = new EvidenceBatcher(
      {
        batchSize: 4,
        maxQueued: 16,
        transport: () => {
          throw new Error('offline');
        },
      },
      clock,
      'a1',
      'tab-a',
      () => 'sig',
    );
    batcher.record('TAB_HIDDEN');
    return expect(batcher.flushOnce()).resolves.toBe(false);
  });

  it('flushes on unload WITHOUT awaiting, because the document is already going away', () => {
    const { batcher, sent } = setup();
    batcher.record('NETWORK_LOST');
    // A `pagehide` handler that awaits has already lost the race. This returns synchronously.
    expect(batcher.flushOnUnload()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('does nothing on unload when there is nothing queued', () => {
    const { batcher, transport } = setup();
    batcher.flushOnUnload();
    expect(transport).not.toHaveBeenCalled();
  });

  it('treats an empty flush as a success rather than an error', () => {
    const { batcher } = setup();
    return expect(batcher.flushOnce()).resolves.toBe(true);
  });

  it('signs with the injected signer, so a test can be deterministic and production uses an HMAC', () => {
    const { batcher } = setup();
    batcher.record('TAB_HIDDEN');
    const batch = batcher.signBatch(batcher.takeBatch());
    expect(batch.signature.startsWith('sig:')).toBe(true);
    expect(batch.fromSeq).toBe(0);
    expect(batch.toSeq).toBe(0);
  });
});
