/**
 * The marking state and the answer reader.  (P9-T2)
 *
 * The central property: a response the machine did not judge has NO NUMBER, even though the stored auto-grade says
 * `points: 0`. Every fixture's auto-grade comes from the real `grade()`, so the zero these tests refuse to render is
 * the zero production actually stores.
 */

import { describe, expect, it } from 'vitest';

import {
  autoMarkFor,
  choiceRight,
  choiceWrong,
  essayAwaiting,
  FREE_RESPONSE,
  MULTI_SELECT_NG,
  multiPenalised,
  SIMULATION,
  SINGLE_CHOICE,
  simFault,
} from './fixtures';
import {
  answerPresenceOf,
  canAcceptAutomaticMark,
  countMarking,
  isMarkable,
  markingStateOf,
  nextAwaiting,
  type ResponseFacts,
  readAnswer,
  storedText,
} from './markingState';

describe('the premise: the grader stores a zero for work it did not judge', () => {
  it('returns points 0 with NEEDS_HUMAN for an unmarked essay', () => {
    const auto = essayAwaiting().auto;
    expect(auto?.points).toBe(0);
    expect(auto?.flags).toContain('NEEDS_HUMAN');
  });

  it('returns the same points 0 for a wrong single-choice answer, with no flag', () => {
    const auto = choiceWrong().auto;
    expect(auto?.points).toBe(0);
    expect(auto?.flags).not.toContain('NEEDS_HUMAN');
  });
});

describe('markingStateOf', () => {
  it('reports an unmarked essay as AWAITING_MARK, and the state carries no points at all', () => {
    const state = markingStateOf(essayAwaiting());
    expect(state).toEqual({ kind: 'AWAITING_MARK', why: 'MARKED_BY_HAND', maxPoints: 5 });
    // The structural guarantee: there is no field a component could render as a zero.
    expect('points' in state).toBe(false);
  });

  it('reports a wrong auto-graded answer as MARKED_AUTOMATICALLY with its real zero', () => {
    expect(markingStateOf(choiceWrong())).toEqual({
      kind: 'MARKED_AUTOMATICALLY',
      points: 0,
      maxPoints: 2,
    });
    expect(markingStateOf(choiceRight())).toEqual({
      kind: 'MARKED_AUTOMATICALLY',
      points: 2,
      maxPoints: 2,
    });
  });

  it('treats a response with no auto-grade at all as awaiting, not as nothing earned', () => {
    expect(markingStateOf(essayAwaiting({ auto: null, needsHuman: false }))).toEqual({
      kind: 'AWAITING_MARK',
      why: 'MARKED_BY_HAND',
      maxPoints: 5,
    });
    expect(markingStateOf(choiceWrong({ auto: null }))).toEqual({
      kind: 'AWAITING_MARK',
      why: 'NOT_YET_GRADED',
      maxPoints: 2,
    });
  });

  it('follows the grader’s own NEEDS_HUMAN flag even when the column was not set', () => {
    // The two are written by different code. Trusting only the column would render a referred response as a zero
    // whenever the write that sets it was missed.
    const state = markingStateOf(essayAwaiting({ needsHuman: false }));
    expect(state.kind).toBe('AWAITING_MARK');
  });

  it('lets a teacher’s mark outrank the machine, and an excuse outrank both', () => {
    const marked = essayAwaiting({
      needsHuman: false,
      manual: { points: 3.5, feedback: 'x', bandId: null },
    });
    expect(markingStateOf(marked)).toEqual({ kind: 'MARKED', points: 3.5, maxPoints: 5 });
    expect(markingStateOf({ ...marked, isExcused: true })).toEqual({ kind: 'EXCUSED' });
  });

  it('names a simulation fault as OURS', () => {
    expect(markingStateOf(simFault())).toEqual({
      kind: 'AWAITING_MARK',
      why: 'SIMULATION_FAULT',
      maxPoints: 3,
    });
  });

  it('names a penalising method’s negative raw score, which is a real mark shown to a person', () => {
    const facts = multiPenalised();
    expect(facts.auto?.rawPoints).toBe(-2);
    expect(facts.auto?.points).toBe(0);
    expect(markingStateOf(facts)).toEqual({
      kind: 'AWAITING_MARK',
      why: 'PENALISED_BELOW_ZERO',
      maxPoints: 4,
    });
  });

  it('names an unreadable key, an absent grader, and an uncompilable pattern', () => {
    const broken = { ...SINGLE_CHOICE, key: { choiceId: null } } as unknown as typeof SINGLE_CHOICE;
    expect(
      markingStateOf(choiceWrong({ spec: broken, auto: autoMarkFor(broken, { choiceId: 'b' }) })),
    ).toEqual({ kind: 'AWAITING_MARK', why: 'KEY_UNREADABLE', maxPoints: 2 });

    expect(markingStateOf(simFault({ sim: undefined }))).toEqual({
      kind: 'AWAITING_MARK',
      why: 'NO_GRADER',
      maxPoints: 3,
    });

    const regex = {
      ...SINGLE_CHOICE,
      type: 'short_text',
      key: { text: 'x' },
      matcher: 'REGEX_SET',
      matchers: { patterns: ['('] },
    } as unknown as typeof SINGLE_CHOICE;
    const auto = autoMarkFor(regex, { text: 'anything' });
    expect(auto.flags).toContain('NEEDS_HUMAN');
    expect(
      markingStateOf(choiceWrong({ spec: regex, auto, answer: { text: 'anything' } })),
    ).toEqual({ kind: 'AWAITING_MARK', why: 'KEY_UNREADABLE', maxPoints: 2 });
  });

  it('falls back to REFERRED when the column says a person is needed and nothing says why', () => {
    expect(markingStateOf(choiceRight({ needsHuman: true }))).toEqual({
      kind: 'AWAITING_MARK',
      why: 'REFERRED',
      maxPoints: 2,
    });
  });
});

describe('what a teacher may do to a response', () => {
  it('cannot enter a mark on a sealed auto-grade', () => {
    expect(isMarkable(choiceWrong())).toBe(false);
    expect(isMarkable(essayAwaiting())).toBe(true);
    expect(isMarkable(multiPenalised())).toBe(true);
  });

  it('offers "accept the automatic mark" ONLY for a penalised-below-zero response', () => {
    // Everywhere else the stored zero is not a mark, and accepting it would be the auto-zero the plan forbids.
    expect(canAcceptAutomaticMark(multiPenalised())).toBe(true);
    expect(canAcceptAutomaticMark(essayAwaiting())).toBe(false);
    expect(canAcceptAutomaticMark(simFault())).toBe(false);
    expect(canAcceptAutomaticMark(choiceWrong())).toBe(false);
    expect(canAcceptAutomaticMark(choiceRight({ needsHuman: true }))).toBe(false);
  });
});

describe('countMarking', () => {
  it('counts each state once and produces no score of any kind', () => {
    const counts = countMarking([
      essayAwaiting(),
      choiceWrong(),
      choiceRight(),
      simFault(),
      essayAwaiting({ responseId: 'r2', isExcused: true }),
      essayAwaiting({
        responseId: 'r3',
        needsHuman: false,
        manual: { points: 2, feedback: '', bandId: 'band-2' },
      }),
    ]);
    expect(counts).toEqual({
      total: 6,
      awaiting: 2,
      marked: 1,
      markedAutomatically: 2,
      excused: 1,
    });
    expect(Object.keys(counts).sort()).toEqual(
      ['awaiting', 'excused', 'marked', 'markedAutomatically', 'total'].sort(),
    );
  });
});

describe('nextAwaiting', () => {
  const paper: readonly ResponseFacts[] = [
    choiceRight(),
    essayAwaiting(),
    choiceWrong(),
    simFault(),
    choiceRight({ responseId: 'r-last' }),
  ];

  it('skips sealed auto-grades to the next response awaiting a mark', () => {
    expect(nextAwaiting(paper, 0)).toBe(1);
    expect(nextAwaiting(paper, 1)).toBe(3);
  });

  it('wraps past the end once, so an essay skipped earlier is still reached', () => {
    expect(nextAwaiting(paper, 3)).toBe(1);
    expect(nextAwaiting(paper, 4)).toBe(1);
  });

  it('returns null when nothing ELSE is awaiting, rather than pointing back at the same response', () => {
    expect(nextAwaiting([choiceRight(), essayAwaiting()], 1)).toBeNull();
    expect(nextAwaiting([choiceRight(), choiceWrong()], 0)).toBeNull();
    expect(nextAwaiting([], 0)).toBeNull();
  });
});

describe('readAnswer', () => {
  it('reads each type’s own shape', () => {
    expect(readAnswer(SINGLE_CHOICE, { choiceId: 'b' })).toEqual({
      kind: 'CHOICES',
      selected: ['b'],
    });
    expect(readAnswer(MULTI_SELECT_NG, { choiceIds: ['a', 'e'] })).toEqual({
      kind: 'CHOICES',
      selected: ['a', 'e'],
    });
    expect(readAnswer(FREE_RESPONSE, { text: 'Gravity.' })).toEqual({
      kind: 'TEXT',
      text: 'Gravity.',
    });
    expect(readAnswer(SIMULATION, { simState: {}, answer: { deltaV: 12.5 } })).toEqual({
      kind: 'SIMULATION',
      reported: '{\n  "deltaV": 12.5\n}',
    });
  });

  it('shows a number AS WRITTEN when the written form was kept, because 9.810 and 9.81 differ in figures', () => {
    const numeric = {
      ...SINGLE_CHOICE,
      type: 'numeric',
      key: { value: 9.81 },
      tolerance: {},
    } as unknown as typeof SINGLE_CHOICE;
    expect(readAnswer(numeric, { value: 9.81, raw: '9.810', unit: 'm/s' })).toEqual({
      kind: 'NUMBER',
      written: '9.810',
      unit: 'm/s',
    });
    expect(readAnswer(numeric, { value: 9.81 })).toEqual({
      kind: 'NUMBER',
      written: '9.81',
      unit: null,
    });
  });

  it('reads every shape of "wrote nothing" as BLANK', () => {
    expect(readAnswer(FREE_RESPONSE, null)).toEqual({ kind: 'BLANK' });
    expect(readAnswer(FREE_RESPONSE, undefined)).toEqual({ kind: 'BLANK' });
    expect(readAnswer(FREE_RESPONSE, {})).toEqual({ kind: 'BLANK' });
    expect(readAnswer(FREE_RESPONSE, { text: '  \n ' })).toEqual({ kind: 'BLANK' });
    expect(readAnswer(FREE_RESPONSE, { text: null })).toEqual({ kind: 'BLANK' });
    expect(readAnswer(MULTI_SELECT_NG, { choiceIds: [] })).toEqual({ kind: 'BLANK' });
    expect(readAnswer(SINGLE_CHOICE, {})).toEqual({ kind: 'BLANK' });
  });

  it('reports something stored that is NOT an answer as UNREADABLE, never as blank', () => {
    // Rendering these as "no answer" would tell a teacher the student left the question empty.
    expect(readAnswer(FREE_RESPONSE, 'just a string')).toEqual({
      kind: 'UNREADABLE',
      stored: '"just a string"',
    });
    expect(readAnswer(FREE_RESPONSE, { text: 42 }).kind).toBe('UNREADABLE');
    expect(readAnswer(SINGLE_CHOICE, { choiceId: 7 }).kind).toBe('UNREADABLE');
    expect(readAnswer(MULTI_SELECT_NG, { choiceIds: 'a' }).kind).toBe('UNREADABLE');
    expect(readAnswer(MULTI_SELECT_NG, ['a']).kind).toBe('UNREADABLE');
  });

  it('does not quietly drop the entries of a list it cannot read', () => {
    // `['a', 7]` filtered to `['a']` would show the teacher a selection the student did not make.
    expect(readAnswer(MULTI_SELECT_NG, { choiceIds: ['a', 7] }).kind).toBe('UNREADABLE');
  });

  it('reads worked-solution steps as text or as objects carrying text, and a paper of empty steps as blank', () => {
    const worked = {
      ...SINGLE_CHOICE,
      type: 'worked_solution',
      steps: [
        { id: 's1', prompt: 'State the law', points: 1 },
        { id: 's2', prompt: 'Apply it', points: 1 },
      ],
    } as unknown as typeof SINGLE_CHOICE;
    expect(readAnswer(worked, { steps: ['F = ma', { id: 's2', text: 'a = 2' }] })).toEqual({
      kind: 'STEPS',
      steps: ['F = ma', 'a = 2'],
    });
    expect(readAnswer(worked, { steps: ['', null] })).toEqual({ kind: 'BLANK' });
    expect(readAnswer(worked, { steps: [42] }).kind).toBe('UNREADABLE');
  });
});

describe('storedText', () => {
  it('never throws, including on a value JSON cannot serialise', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => storedText(circular)).not.toThrow();
    expect(storedText(undefined)).toBe('undefined');
    expect(storedText(10n)).toBe('10');
  });
});

describe('answerPresenceOf', () => {
  it('separates not reached, omitted, blank and present', () => {
    expect(answerPresenceOf(essayAwaiting())).toBe('PRESENT');
    expect(answerPresenceOf(essayAwaiting({ answer: { text: '' } }))).toBe('BLANK');
    expect(answerPresenceOf(essayAwaiting({ answer: null, isOmitted: true }))).toBe('OMITTED');
    expect(answerPresenceOf(essayAwaiting({ answer: null, notReached: true }))).toBe('NOT_REACHED');
  });

  it('reports NOT_REACHED over OMITTED when both are set: the clock is the cause that matters (V-4)', () => {
    expect(
      answerPresenceOf(essayAwaiting({ answer: null, isOmitted: true, notReached: true })),
    ).toBe('NOT_REACHED');
  });

  it('counts an unreadable answer as PRESENT, because something is stored', () => {
    expect(answerPresenceOf(essayAwaiting({ answer: 'rubbish' }))).toBe('PRESENT');
  });
});
