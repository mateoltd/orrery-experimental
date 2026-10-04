/**
 * The workspace's wording.  (P9-T2, P9-T3)
 *
 * Held to the standard `integrity/timeline.ts` set: the screen describes what is stored and what happened, and never
 * characterises the student or states a conclusion nobody reached. These run over EVERY sentence in `copy.ts`.
 */

import { describe, expect, it } from 'vitest';

import * as copy from './copy';
import type { AwaitingReason, MarkingState } from './markingState';

const everything = copy.allCopy();

describe('the sweep covers the file', () => {
  it('includes every string constant the module exports', () => {
    const missing = Object.entries(copy)
      .filter(([, value]) => typeof value === 'string')
      .filter(([, value]) => !everything.includes(value as string))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('includes every reason a response can be awaiting a mark', () => {
    for (const sentence of Object.values(copy.AWAITING_REASON)) {
      expect(everything).toContain(sentence);
    }
  });
});

describe('nothing here is about the person', () => {
  /**
   * Words that describe a student rather than a piece of work, and words that state intent. None is needed to say
   * what is stored or what happened, so any appearance is a characterisation that got in.
   */
  const CHARACTERISING =
    /\b(lazy|careless|carelessly|weak|poor|bright|able|ability|clever|stupid|struggl\w*|confused|capable|incapable|cheat\w*|dishonest\w*|suspicious\w*|guess(ed|ing|es)?|at[- ]risk|falling behind|below average|above average|top of|bottom of|rank\w*|percentile|should have|failed to|did not bother|obviously|clearly)\b/i;

  it('uses no word that characterises a student or their intent, in any sentence', () => {
    const offenders = everything.filter((sentence) => CHARACTERISING.test(sentence));
    expect(offenders).toEqual([]);
  });

  it('never makes the student the subject of a judgement', () => {
    // "selected by the student" describes an event. "the student is/seems/lacks..." describes a person.
    const JUDGING =
      /\bthe student (is|was|seems|appears|lacks|cannot|can’t|could not|does not|did not|has not|needs)\b/i;
    expect(everything.filter((sentence) => JUDGING.test(sentence))).toEqual([]);
  });

  it('attributes every platform fault to the platform, the question or the simulation, and says it is not the work', () => {
    const FAULTS: readonly AwaitingReason[] = [
      'SIMULATION_FAULT',
      'KEY_UNREADABLE',
      'ANSWER_UNREADABLE',
    ];
    for (const reason of FAULTS) {
      expect(copy.AWAITING_REASON[reason], reason).toMatch(/not in the work/);
    }
    expect(copy.ANSWER_UNREADABLE).toContain('not in the work');
    expect(copy.simFaultLine('GRADER_THREW', 'x')).toContain('not in the work');
  });
});

describe('a response nobody has marked is never given a number or called wrong', () => {
  const awaiting: MarkingState = { kind: 'AWAITING_MARK', why: 'MARKED_BY_HAND', maxPoints: 5 };

  it('states what the question is worth and nothing about what was earned', () => {
    expect(copy.stateLine(awaiting)).toBe('Awaiting a mark. Worth 5.');
    expect(copy.stateLine(awaiting)).not.toMatch(/\bof\b/);
    expect(copy.stateLine(awaiting)).not.toMatch(/\b0\b/);
  });

  it('says a real zero as a zero, so the two are distinguishable in words and not only in colour', () => {
    expect(copy.stateLine({ kind: 'MARKED_AUTOMATICALLY', points: 0, maxPoints: 5 })).toBe(
      'Marked automatically: 0 of 5.',
    );
    expect(copy.stateLine({ kind: 'MARKED', points: 0, maxPoints: 5 })).toBe(
      'Marked by a teacher: 0 of 5.',
    );
  });

  it('never calls an awaiting response wrong, failed or zero in any of the reasons', () => {
    const VERDICT = /\b(wrong|failed|fails|zero marks|no marks|0 of|scored 0|nothing earned)\b/i;
    for (const [reason, sentence] of Object.entries(copy.AWAITING_REASON)) {
      expect(sentence, reason).not.toMatch(VERDICT);
    }
  });

  it('explains a penalised-below-zero response by the METHOD and says where the floor is applied', () => {
    const sentence = copy.AWAITING_REASON.PENALISED_BELOW_ZERO;
    expect(sentence).toContain('scoring method');
    expect(sentence).toContain('raw scale');
    expect(sentence).toContain('attempt total');
  });

  it('gives the counts line no score, percentage or total of marks', () => {
    const line = copy.countsLine({
      total: 7,
      awaiting: 2,
      marked: 1,
      markedAutomatically: 3,
      excused: 1,
    });
    expect(line).toBe(
      '7 response(s): 2 awaiting a mark, 1 marked by a teacher, 3 marked automatically, 1 excused.',
    );
    expect(line).not.toMatch(/%|\bscore\b|\btotal\b|\bout of\b/i);
  });
});

describe('"saved" is reserved for an acknowledged mark', () => {
  const LOCAL = [
    copy.DRAFT_NONE,
    copy.draftKept('14:32'),
    copy.DRAFT_NOT_KEPT,
    copy.draftRestored('yesterday at 14:32', false),
    copy.draftRestored('yesterday at 14:32', true),
    copy.DRAFT_UNREADABLE,
  ];

  it('never says a draft on this device is saved', () => {
    // The only permitted use of "saved" in a draft sentence is the denial: "not a saved mark". ("Save the mark
    // before leaving" is an instruction, not a claim about the draft, and is allowed.)
    for (const sentence of LOCAL) {
      const withoutDenial = sentence.replace(/not a saved mark/g, '');
      expect(withoutDenial, sentence).not.toMatch(/\bsaved\b/i);
    }
  });

  it('says where a kept draft is, and that it is not a mark', () => {
    expect(copy.draftKept('14:32')).toBe(
      'Draft kept on this device at 14:32. It is not a saved mark yet.',
    );
    expect(copy.draftRestored('14:32', false)).toContain('on this device');
    expect(copy.draftRestored('14:32', false)).toContain('not a saved mark');
  });

  it('tells the teacher what a refused draft means for them, not only that it happened', () => {
    expect(copy.DRAFT_NOT_KEPT).toContain('only in this tab');
    expect(copy.DRAFT_NOT_KEPT).toContain('closing or reloading the tab will lose it');
  });

  it('adds the staleness warning to a restored draft only when it is stale', () => {
    expect(copy.draftRestored('14:32', true)).toContain('has changed since this draft was written');
    expect(copy.draftRestored('14:32', false)).not.toContain('has changed since');
  });

  it('says after a failed save whether the draft survives, because that is the only thing that matters then', () => {
    expect(copy.markNotSaved('the request did not complete', true)).toBe(
      'The mark was not saved: the request did not complete. Your draft is still kept on this device.',
    );
    expect(copy.markNotSaved('the request did not complete', false)).toBe(
      'The mark was not saved: the request did not complete. The draft exists only in this tab.',
    );
  });
});

describe('required sentences', () => {
  it('says a prefilled comment is the teacher’s, not the platform’s, and is to be edited', () => {
    expect(copy.PREFILL_HINT).toContain('your comment, not the platform’s');
    expect(copy.PREFILL_HINT).toContain('edit it');
  });

  it('tells the teacher WHY the band comment was not inserted', () => {
    expect(copy.OFFER_INTRO).toContain('Your comment was kept');
    expect(copy.OFFER_INTRO).toContain('would have replaced what you wrote');
  });

  it('points feedback at the answer, in both places a teacher writes it', () => {
    expect(copy.FEEDBACK_HINT).toContain('Write about the answer');
    expect(copy.BAND_COMMENT_HINT).toContain('Write about the answer');
  });

  it('says a sealed mark is changed by a flag and a regrade of every affected attempt, not here', () => {
    expect(copy.SEALED_NOTE).toContain('cannot be changed here');
    expect(copy.SEALED_NOTE).toContain('every attempt that had this question is regraded together');
  });

  it('states the band bound in the editor, with the question’s own maximum', () => {
    expect(copy.rubricBound(5)).toBe(
      'A band is worth between 0 and 5. A band cannot take marks away.',
    );
  });

  it('says editing a band does not regrade', () => {
    expect(copy.RUBRIC_DOES_NOT_REGRADE).toContain('does not change marks already saved');
  });

  it('tells the teacher a quick score is recorded and what it is used for', () => {
    expect(copy.QUICK_SCORED_NOTE).toContain('recorded as quick-scored');
    expect(copy.QUICK_SCORED_NOTE).toContain('sampled for moderation');
  });

  it('says what accepting a penalised mark keeps, and what typing 0 would do instead', () => {
    expect(copy.ACCEPT_AUTO_NOTE).toContain('keeps the raw score, including the deduction');
    expect(copy.ACCEPT_AUTO_NOTE).toContain('would remove the deduction');
  });

  it('says in the stacked arrangement that the panes are NOT side by side, and in what order they are', () => {
    expect(copy.STACKED_NOTE).toContain('too narrow');
    expect(copy.STACKED_NOTE).toContain('question, answer, simulation replay, mark');
  });

  it('says the replay pane shows what is stored and changes nothing', () => {
    expect(copy.SIM_REPLAY_NOTE).toContain('does not re-run the grader');
    expect(copy.SIM_REPLAY_NOTE).toContain('does not change the mark');
  });
});
