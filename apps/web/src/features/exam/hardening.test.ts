// @vitest-environment jsdom

/**
 * Copy/paste/context-menu/print hardening.  (P8-T8)
 *
 * The property that matters is the PAIRING: every block has a declared route around it. A block with no escape is a
 * student with no way to answer the question, which is a worse outcome than the thing being prevented -- and `RN-01` /
 * `RN-02` record that these controls disproportionately harm students with disabilities, students using assistive
 * technology, and students on unstable connections.
 */

import { describe, expect, it } from 'vitest';

import {
  blockingDecision,
  DEFAULT_HARDENING,
  HATCH_COPY,
  type HardeningEvent,
  type HardeningPolicy,
  switchesFor,
} from './hardening';

const EVENTS: readonly HardeningEvent[] = [
  'COPY_ATTEMPT',
  'PASTE_ATTEMPT',
  'CONTEXT_MENU',
  'PRINT_ATTEMPT',
];

const policy = (over: Partial<HardeningPolicy> = {}): HardeningPolicy => ({
  ...DEFAULT_HARDENING,
  ...over,
});

describe('NOTHING IS PREVENTED, because intercepting the platform is its own harm', () => {
  it('allows every event even when the switch is on', () => {
    // The first version was going to `preventDefault()` the paste and re-insert the text, so the student would not
    // notice. That is a silent modification of the student's own device behaviour, and it intercepts pastes the
    // platform handled correctly.
    for (const event of EVENTS) {
      expect(blockingDecision(event, policy(), false).allow, event).toBe(true);
    }
  });

  it('still COUNTS the attempt even though it allowed the action', () => {
    // Reporting is the enforcement. A block that only announces itself is theatre.
    for (const event of EVENTS) {
      expect(blockingDecision(event, policy(), false).countsAsStrike, event).toBe(true);
    }
  });
});

describe('every block HAS a route around it', () => {
  it('offers the accommodation hatch for every blocked event', () => {
    for (const event of EVENTS) {
      expect(blockingDecision(event, policy(), false).hatch, event).toBe('accommodation');
    }
  });

  it('states `never` only when no hatch is available at all, and says why', () => {
    // `never` is a type rather than an oversight: the module cannot silently produce a block with no exit.
    for (const event of EVENTS) {
      const verdict = blockingDecision(
        event,
        policy({ accommodationHatchAvailable: false }),
        false,
      );
      expect(verdict.hatch, event).toBe('never');
      expect(verdict.countsAsStrike, event).toBe(true);
    }
  });

  it('checks the ACCOMMODATION FIRST, before any switch', () => {
    /**
     * Checking the switches first would report the attempt and then decide it does not matter -- so the evidence
     * exists, a teacher sees it, and the only thing missing is the explanation. Worse than not reporting it, because
     * it looks like a real event.
     */
    const verdict = blockingDecision('COPY_ATTEMPT', policy({ blockCopyPaste: false }), true);
    expect(verdict.countsAsStrike).toBe(false);
    expect(verdict.hatch).toBe('accommodation');
    expect(verdict.reason).toContain('accommodation');
  });

  it('does NOT count a strike while an accommodation is in force, under INV-ACC-1', () => {
    // A relaxation is a right. Striking a student during one punishes them for using it.
    for (const event of EVENTS) {
      expect(blockingDecision(event, policy(), true).countsAsStrike, event).toBe(false);
    }
  });

  it('ignores an accommodation when the policy has withdrawn the hatch', () => {
    // Otherwise `accommodationActive` would be a client-side bypass of a server decision.
    const verdict = blockingDecision(
      'COPY_ATTEMPT',
      policy({ accommodationHatchAvailable: false }),
      true,
    );
    expect(verdict.countsAsStrike).toBe(true);
  });
});

describe('the switches are INDEPENDENT', () => {
  it('does not let blocking copy also block the context menu', () => {
    // They are separate switches because they harm different students: one breaks a screen reader, the other a
    // switch-access user.
    const verdict = blockingDecision(
      'CONTEXT_MENU',
      policy({ blockCopyPaste: true, blockContextMenu: false }),
      false,
    );
    expect(verdict.countsAsStrike).toBe(false);
    expect(verdict.hatch).toBe('already_allowed');
  });

  it('does not let blocking print also block copy', () => {
    const verdict = blockingDecision(
      'COPY_ATTEMPT',
      policy({ blockPrintSave: true, blockCopyPaste: false }),
      false,
    );
    expect(verdict.countsAsStrike).toBe(false);
  });

  it('records nothing at all when the switch is off', () => {
    // "This paper does not restrict it, so the attempt is not recorded" -- an un-restricted paper must not accumulate
    // events a teacher will later read as a pattern.
    for (const event of EVENTS) {
      const verdict = blockingDecision(
        event,
        policy({
          blockCopyPaste: false,
          blockContextMenu: false,
          blockPrintSave: false,
        }),
        false,
      );
      expect(verdict.countsAsStrike, event).toBe(false);
      expect(verdict.reason, event).toContain('not recorded');
    }
  });
});

describe('the hatch copy', () => {
  it('never implies wrongdoing, and never mentions a strike', () => {
    // A student told "this counts against you" has been told something they cannot act on.
    // `against you` was in the first version of this pattern, and it flagged the reassuring clause "not held against
    // you" -- which is the opposite of an accusation. The pattern matches terms that ASSERT a consequence, not words
    // that happen to appear near one.
    expect(HATCH_COPY.toLowerCase()).not.toMatch(/strike|penalt|flag|cheat|violat|disqualif/);
  });

  it('names the actual situations it exists for, so a student can recognise their own', () => {
    expect(HATCH_COPY).toContain('screen reader');
    expect(HATCH_COPY).toContain('switch');
    expect(HATCH_COPY).toContain('paste');
  });

  it('says using an accommodation is not held against the student', () => {
    expect(HATCH_COPY).toContain('not held against you');
  });
});

describe('the policy projection', () => {
  it('maps each switch to its own event, with no cross-contamination', () => {
    const switches = switchesFor({
      blockCopyPaste: true,
      blockContextMenu: false,
      blockPrintSave: true,
    });
    expect(switches.COPY_ATTEMPT).toBe('WARN');
    expect(switches.PASTE_ATTEMPT).toBe('WARN');
    expect(switches.CONTEXT_MENU).toBe('OFF');
    expect(switches.PRINT_ATTEMPT).toBe('WARN');
  });
});
