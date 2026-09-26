/**
 * Deletion planning tests.  (P1-T5)
 *
 * ## The test this file is built around
 *
 * `describe('the dry run and the real run cannot disagree')`. The packet requires that the
 * dry-run report matches the real run's counts. Here that is structural rather than
 * aspirational: there is ONE `planDeletion`, and the test asserts the plan is a pure function
 * of the manifest, so the dry run and the real run are computing the same thing by
 * construction.
 *
 * ## The other test that matters
 *
 * `describe("a student's own work is never falsified")`. Not because it is likely, but
 * because nulling a student's free text is a two-line change that would silently destroy their
 * essays and every grade computed from them, and because it is a rights question rather than
 * a technical one.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoFalsification,
  BLOCKER_OWNS_CLASSROOM,
  canExecute,
  type DeletionManifest,
  planDeletion,
  planExport,
} from '../deletion.js';

const manifest = (over: Partial<DeletionManifest> = {}): DeletionManifest => ({
  userId: 'u-1',
  authRows: 2,
  sessions: 3,
  notificationPreferences: 1,
  authoredReferencedByGrade: ['resource-7'],
  authoredUnreferenced: ['resource-9', 'resource-10'],
  ownFreeTextSubmissions: ['response-1', 'response-2', 'response-3'],
  gradesAuthored: 12,
  ownedClassrooms: [],
  enrollments: 4,
  ...over,
});

describe('the dry run and the real run cannot disagree', () => {
  it('the plan is a pure function of the manifest', () => {
    expect(planDeletion(manifest())).toEqual(planDeletion(manifest()));
  });

  it('two dry runs over an unchanged account produce the same fingerprint', () => {
    // Which is what lets a UI refuse to execute a plan the user agreed to when the account
    // has changed underneath them.
    expect(planDeletion(manifest()).fingerprint).toBe(planDeletion(manifest()).fingerprint);
  });

  it('a changed account produces a DIFFERENT fingerprint', () => {
    const before = planDeletion(manifest()).fingerprint;
    const after = planDeletion(manifest({ sessions: 4 })).fingerprint;
    expect(after).not.toBe(before);
  });

  it('entry ORDER does not change the fingerprint', () => {
    // Otherwise the fingerprint would depend on an unspecified query order, and the "has
    // anything changed" check would fire at random.
    const a = planDeletion(manifest({ authoredUnreferenced: ['x', 'y'] })).fingerprint;
    const b = planDeletion(manifest({ authoredUnreferenced: ['y', 'x'] })).fingerprint;
    expect(a).toBe(b);
  });

  it('the counts are derived from the entries, never tracked separately', () => {
    // Two independent counters is how a dry run and a real run drift apart.
    const p = planDeletion(manifest());
    const tally = { delete: 0, anonymise: 0, retain: 0 };
    for (const e of p.entries) tally[e.outcome] += 1;
    expect(p.counts).toEqual(tally);
  });
});

describe("a student's own work is never falsified", () => {
  it('their free-text answers are RETAINED, with a reason that says why', () => {
    const p = planDeletion(manifest());
    const own = p.entries.filter((e) => e.id.startsWith('response-'));
    expect(own).toHaveLength(3);
    for (const e of own) {
      expect(e.outcome, `${e.id} must be retained`).toBe('retain');
      expect(e.reason).toContain('academic records');
    }
  });

  it('the confirmation says it plainly, not softened', () => {
    // A user who does not know their own work is being kept has not been told what they
    // agreed to. plans/13 §1.2 rule 4 requires this sentence, specifically.
    const text = planDeletion(manifest()).confirmation.join(' ');
    expect(text).toContain('NOT deleted');
    expect(text).toContain('delete your account, not to change your work');
  });

  it('assertNoFalsification passes for a real plan', () => {
    expect(() => assertNoFalsification(planDeletion(manifest()))).not.toThrow();
  });

  it('and THROWS for a doctored one, which is the point of having it', () => {
    // The tempting implementation is a post-processing pass that nulls free text on the way
    // out. This is the test that makes that a deliberate act rather than an accident.
    const p = planDeletion(manifest());
    const doctored = {
      ...p,
      entries: p.entries.map((e) =>
        e.id === 'response-1'
          ? { ...e, outcome: 'delete' as const, reason: 'own answers — PII removed' }
          : e,
      ),
    };
    expect(() => assertNoFalsification(doctored)).toThrowError(/falsify their work/);
  });
});

describe('the three outcomes, and why each exists', () => {
  it('DELETES authored content nothing references', () => {
    const p = planDeletion(manifest());
    for (const id of ['resource-9', 'resource-10']) {
      const entry = p.entries.find((e) => e.id === id);
      expect(entry?.outcome, id).toBe('delete');
    }
  });

  it('uses the PLURAL for the anonymised sentence when more than one is kept', () => {
    // Every manifest in this file has exactly ONE referenced item, so the plural branch of
    // that sentence was never reached and the 100% branch threshold flagged it. The coverage
    // report finding an unreachable branch is the report working; the fix is a real case, not
    // a threshold change.
    const p = planDeletion(
      manifest({
        authoredReferencedByGrade: ['resource-7', 'resource-8', 'resource-11'],
      }),
    );
    expect(p.counts.anonymise).toBe(3);
    expect(p.confirmation.join(' ')).toContain(
      '3 items you created will be kept without your name',
    );
  });

  it('ANONYMISES authored content a grade depends on, and explains the asymmetry', () => {
    // A grade with nothing to grade is incoherent, and plans/13 §1.2 is explicit that a
    // historical grade should be attributable to a tombstone rather than a person.
    const p = planDeletion(manifest());
    const entry = p.entries.find((e) => e.id === 'resource-7');
    expect(entry?.outcome).toBe('anonymise');
    expect(entry?.reason).toContain('without identifying details');
    expect(p.confirmation.join(' ')).toContain('kept without your name');
  });

  it("DELETES the account's auth material, every session, and unreferenced content", () => {
    const p = planDeletion(manifest());
    // authRows 2 + sessions 3 + notificationPreferences 1 + enrollments 4 + unreferenced
    // content 2 = 12. The first draft of this expectation omitted the unreferenced content and
    // was simply wrong arithmetic — the plan was right.
    expect(p.counts.delete).toBe(2 + 3 + 1 + 4 + 2);
    expect(p.confirmation.join(' ')).toContain('3 active sessions');
  });

  it('RETAINS the grades the user gave, so no student is left with marks from nobody', () => {
    const p = planDeletion(manifest());
    expect(p.confirmation.join(' ')).toContain('12 grades you gave are kept');
  });
});

describe('owning a classroom blocks deletion', () => {
  it('and says so as a refusal, not a warning', () => {
    // Deleting would either orphan the classrooms or hand them to nobody, and both are worse
    // than asking a person.
    const p = planDeletion(manifest({ ownedClassrooms: ['c-1'] }));
    expect(canExecute(p)).toBe(false);
    expect(p.blockers).toEqual([BLOCKER_OWNS_CLASSROOM]);
    expect(p.confirmation.join(' ')).toContain('still own a classroom');
  });

  it('and an unblocked plan can execute', () => {
    expect(canExecute(planDeletion(manifest()))).toBe(true);
  });
});

describe('the singular/plural, which is a small honesty issue', () => {
  it('does not say "1 item you created" — the content sentence is pluralised too', () => {
    // The two content sentences have their own singular branches, separate from the session
    // and grade ones. Only the latter were covered, and an uncovered singular branch is an
    // uncovered branch.
    const oneOfEach = planDeletion(
      manifest({
        authRows: 1,
        sessions: 1,
        notificationPreferences: 1,
        enrollments: 1,
        authoredUnreferenced: ['resource-9'],
        authoredReferencedByGrade: ['resource-7'],
        ownFreeTextSubmissions: ['response-1'],
        gradesAuthored: 1,
      }),
    );
    const text = oneOfEach.confirmation.join(' ');
    expect(text).not.toMatch(/\b1 items\b/);
    expect(text).not.toMatch(/\b1 grades\b/);
    // Every singular branch in the confirmation, in one manifest with a count of exactly 1.
    expect(text).toContain('1 item you created that no graded work');
    expect(text).toContain('1 item you created will be kept without your name');
    expect(text).toContain('Your own answers (1)');
  });

  it('omits a sentence entirely when its count is zero', () => {
    // A confirmation that says "0 items you created will be deleted" is noise, and reads as
    // though something went wrong.
    const nothingToSay = planDeletion(
      manifest({
        authoredUnreferenced: [],
        authoredReferencedByGrade: [],
        ownFreeTextSubmissions: [],
      }),
    );
    const text = nothingToSay.confirmation.join(' ');
    expect(text).not.toContain('no graded work depends on');
    expect(text).not.toContain('kept without your name');
    expect(text).not.toContain('NOT deleted');
  });

  it('does not say "1 items" or "1 sessions"', () => {
    const p = planDeletion(
      manifest({
        sessions: 1,
        authoredUnreferenced: [],
        ownFreeTextSubmissions: ['response-1'],
        gradesAuthored: 1,
      }),
    );
    const text = p.confirmation.join(' ');
    expect(text).not.toMatch(/\b1 (items|sessions|grades)\b/);
    expect(text).toContain('1 active session');
    expect(text).toContain('1 grade you gave');
  });
});

describe('export', () => {
  it('lists everything before the user asks, with a total', () => {
    const p = planExport({
      userId: 'u-1',
      submissions: 8,
      gradesReceived: 8,
      gradesGiven: 12,
      authoredContent: 3,
      classrooms: 2,
      auditEvents: 41,
    });
    expect(p.total).toBe(74);
    expect(p.sections.map((s) => s.label)).toContain('Your submitted answers');
    expect(p.sections.map((s) => s.label)).toContain('Account history');
  });

  it('exports zero of everything for a new account without dividing by zero or lying', () => {
    const p = planExport({
      userId: 'u-1',
      submissions: 0,
      gradesReceived: 0,
      gradesGiven: 0,
      authoredContent: 0,
      classrooms: 0,
      auditEvents: 0,
    });
    expect(p.total).toBe(0);
  });
});
