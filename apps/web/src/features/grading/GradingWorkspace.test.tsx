// @vitest-environment jsdom

/**
 * The grading workspace, through the DOM.  (P9-T2, P9-T3)
 *
 * Every test here drives the assembled screen the way a teacher does -- keys and controls -- and asserts what the
 * teacher would then see and what was sent. The pure modules have their own tests; these are about the things only
 * the assembled screen can get wrong: a response nobody marked being drawn as a zero, a key typed into a comment
 * being taken for a command, a draft that is silently not kept, a band's comment replacing a teacher's, and focus
 * ending up nowhere.
 *
 * jsdom computes no layout, so NOTHING here shows the panes are side by side. See `layout.ts`.
 */

import type { TeacherQuestionSpec } from '@orrery/contracts/question';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_AUTO_NOTE,
  AWAITING_REASON,
  CHANGED_WHILE_SAVING,
  DRAFT_DISCARDED,
  DRAFT_NONE,
  DRAFT_NOT_KEPT,
  EXCUSE_REASON_REQUIRED,
  FEEDBACK_HINT,
  OFFER_INTRO,
  PREFILL_HINT,
  QUICK_SCORED_NOTE,
  RELEASED_NOTE,
  SEALED_NO_MARK,
  SEALED_NOTE,
  SIM_REPLAY_NOTE,
  STACKED_NOTE,
} from './copy';
import {
  type DraftStore,
  EMPTY_DRAFT,
  memoryDraftStore,
  type StoredDraft,
  storageKeyFor,
} from './draft';
import {
  choiceRight,
  choiceWrong,
  ESSAY_RUBRIC,
  essayAwaiting,
  FREE_RESPONSE,
  multiPenalised,
  simFault,
} from './fixtures';
import {
  ANNOUNCER_ATTRIBUTE,
  GradingWorkspace,
  type GradingWorkspaceProps,
} from './GradingWorkspace';
import { EQUIVALENT_CONTROL, GRADING_KEYMAP, KEYS_OFF_ATTRIBUTE } from './keymap';
import { workspaceCss } from './layout';
import type { ResponseFacts } from './markingState';
import type { MarkingRubric } from './rubric';
import type { MarkSubmission, SaveMarkResult } from './submission';
import { assertAccessible, assertPanes, renderAudited } from './workspaceHarness';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const T0 = 1_800_000_000_000;
const ESSAY_FEEDBACK_2 = 'One force is named. The second force is not mentioned.';

/** A second essay on a different question, so two markable responses can sit next to each other. */
const secondEssay = (over: Partial<ResponseFacts> = {}): ResponseFacts =>
  essayAwaiting({
    responseId: 'r-essay-2',
    spec: { ...FREE_RESPONSE, id: 'q-essay-2' },
    prompt: 'Explain why the orbit is not a circle.',
    answer: { text: 'Because the speed is too high for a circle at that height.' },
    ...over,
  });

const PAPER = (): readonly ResponseFacts[] => [
  choiceRight(),
  essayAwaiting(),
  choiceWrong(),
  simFault(),
  multiPenalised(),
];

const RUBRICS: Readonly<Record<string, MarkingRubric>> = {
  'q-essay': ESSAY_RUBRIC,
  'q-essay-2': { ...ESSAY_RUBRIC, questionId: 'q-essay-2' },
};

interface Setup {
  readonly responses?: readonly ResponseFacts[];
  readonly store?: DraftStore;
  readonly respond?: (submission: MarkSubmission) => Promise<SaveMarkResult>;
  readonly props?: Partial<GradingWorkspaceProps>;
}

const setup = async ({ responses = PAPER(), store, respond, props }: Setup = {}) => {
  const held = store ?? memoryDraftStore();
  const sent: MarkSubmission[] = [];
  const clock = { now: T0 };
  const rendered = await renderAudited(
    <GradingWorkspace
      attemptId="attempt-9"
      candidateLabel="Candidate 14"
      responses={responses}
      graderId="teacher-1"
      store={held}
      now={() => clock.now}
      rubrics={RUBRICS}
      // Offsets from T0, so a time in the status line is an exact, locale-free string.
      formatTime={(at, form) => `${form} ${String(at - T0)}`}
      initialIndex={1}
      onSaveMark={(submission) => {
        sent.push(submission);
        return respond === undefined ? Promise.resolve({ ok: true }) : respond(submission);
      }}
      {...props}
    />,
  );
  return { ...rendered, sent, clock, store: held, user: userEvent.setup() };
};

const region = (name: string): HTMLElement => screen.getByRole('region', { name });
const marking = (): HTMLElement => region('Mark');
const answerPane = (): HTMLElement => region('Student’s answer');
const scoreField = (max = 5): HTMLInputElement =>
  screen.getByRole('textbox', { name: `Mark, out of ${String(max)}` }) as HTMLInputElement;
const feedbackField = (): HTMLTextAreaElement =>
  screen.getByRole('textbox', { name: 'Feedback to the student' }) as HTMLTextAreaElement;
const announced = (container: HTMLElement): string =>
  container.querySelector(`[${ANNOUNCER_ATTRIBUTE}]`)?.textContent ?? '';
const position = (): string =>
  within(screen.getByRole('navigation', { name: 'Responses in this attempt' })).getByText(
    /^Response \d+ of \d+/,
  ).textContent ?? '';
const checkbox = (name: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name }) as HTMLInputElement;
const key = (graderId = 'teacher-1', responseId = 'r-essay') =>
  storageKeyFor({ graderId, attemptId: 'attempt-9', responseId });

/** A promise the test settles by hand, to hold a save in flight. */
const deferred = <T,>() => {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

describe('as DRAWN', () => {
  it('draws the question, the answer and the mark as named regions, in that order', async () => {
    const { container } = await setup();
    expect(region('Marking: Candidate 14')).toBeDefined();
    assertPanes(container, ['Question 2', 'Student’s answer', 'Mark']);
    expect(screen.queryByRole('region', { name: 'Simulation replay' })).toBeNull();
  });

  it('adds the replay BETWEEN the answer and the mark for a simulation question, and nowhere else', async () => {
    const { container } = await setup({ props: { initialIndex: 3 } });
    assertPanes(container, ['Question 4', 'Student’s answer', 'Simulation replay', 'Mark']);
    expect(container.querySelector('[data-replay="true"]')).not.toBeNull();
  });

  it('carries the generated stylesheet and the "stacked" notice the stylesheet hides when it does not apply', async () => {
    const { container } = await setup();
    expect(container.querySelector('style')?.textContent).toBe(workspaceCss());
    const note = screen.getByText(STACKED_NOTE);
    expect(note.className).toBe('orrery-grading__stacked-note');
  });

  it('makes the two reading panes focusable, because a pane that scrolls must be scrollable by keyboard', async () => {
    await setup();
    expect(region('Question 2').getAttribute('tabindex')).toBe('0');
    expect(answerPane().getAttribute('tabindex')).toBe('0');
  });

  it('puts focus on the answer when the screen opens, and leaves it alone when asked to', async () => {
    await setup();
    expect(document.activeElement).toBe(answerPane());
    cleanup();
    await setup({ props: { focusOnOpen: false } });
    expect(document.activeElement).toBe(document.body);
  });

  it('places that opening focus WITHOUT scrolling, so a stacked screen does not open with the question scrolled away', async () => {
    const calls: (FocusOptions | undefined)[] = [];
    const original = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
      calls.push(options);
      original.call(this, options);
    };
    try {
      await setup();
    } finally {
      HTMLElement.prototype.focus = original;
    }
    expect(calls).toEqual([{ preventScroll: true }]);
    expect(document.activeElement).toBe(answerPane());
  });

  it('counts responses by state in the header and shows NO score for the attempt', async () => {
    await setup();
    const header = region('Marking: Candidate 14').querySelector('header');
    expect(header?.textContent).toContain(
      '5 response(s): 3 awaiting a mark, 0 marked by a teacher, 2 marked automatically, 0 excused.',
    );
    expect(header?.textContent).not.toMatch(/%|\btotal\b|\bscore\b/i);
  });

  it('shows the prompt, the model answer, and the concept hints labelled as suggestions', async () => {
    await setup();
    const question = within(region('Question 2'));
    expect(
      question.getByText("Explain why the satellite's speed changes at this point in its orbit."),
    ).toBeDefined();
    expect(question.getByText('Worth 5.')).toBeDefined();
    expect(question.getByText(/^Gravity is the only force/)).toBeDefined();
    expect(
      question.getByText(/gravity, centripetal\. Concept hints are suggestions/),
    ).toBeDefined();
  });

  it('says so when an attempt has no responses, rather than drawing empty panes', async () => {
    await setup({ responses: [] });
    expect(screen.getByText('This attempt has no responses to mark.')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('NEEDS_HUMAN is not zero', () => {
  it('draws an unmarked essay as awaiting a mark, with no number earned anywhere on the screen', async () => {
    const { container } = await setup();
    // The premise, from the real grader: the stored auto-grade for this response IS points 0.
    expect(essayAwaiting().auto?.points).toBe(0);

    const mark = within(marking());
    expect(mark.getByText('Awaiting a mark. Worth 5.')).toBeDefined();
    expect(mark.getByText(AWAITING_REASON.MARKED_BY_HAND)).toBeDefined();
    // Including in the list of bands: a zero-mark band is "Worth 0", never "0 of 5".
    expect(marking().textContent).not.toMatch(/\b0 of 5\b/);
    expect(screen.getByRole('radio', { name: '3. Worth 0: names no force' })).toBeDefined();
    expect(marking().textContent).not.toMatch(/incorrect|wrong|no credit/i);
    expect(container.textContent).not.toContain('0 of 5');
    // And the mark field is EMPTY, not prefilled with the zero.
    expect(scoreField().value).toBe('');
  });

  it('draws a wrong auto-graded answer as its real zero, sealed, with the grader’s reason and no way to change it', async () => {
    await setup({ props: { initialIndex: 2 } });
    const mark = within(marking());
    expect(mark.getByText('Marked automatically: 0 of 2.')).toBeDefined();
    expect(
      mark.getByText('The automatic marker reported: A different option was chosen.'),
    ).toBeDefined();
    expect(mark.getByText(SEALED_NOTE)).toBeDefined();
    expect(mark.queryByRole('textbox')).toBeNull();
    expect(mark.queryByRole('radio')).toBeNull();
    // The flag is the one thing a teacher can still do to a sealed response.
    expect(mark.getByRole('checkbox', { name: 'Flag this response for follow-up' })).toBeDefined();
  });

  it('says a simulation fault is the platform’s, in the mark pane AND the replay pane', async () => {
    await setup({ props: { initialIndex: 3 } });
    expect(within(marking()).getByText('Awaiting a mark. Worth 3.')).toBeDefined();
    expect(within(marking()).getByText(AWAITING_REASON.SIMULATION_FAULT)).toBeDefined();
    expect(marking().textContent).not.toMatch(/\b0 of 3\b/);

    const replay = within(region('Simulation replay'));
    expect(
      replay.getByText(
        'The simulation’s grader did not produce a mark (GRADER_THREW: TypeError: state.burns is not iterable). ' +
          'That is a fault in the platform or the simulation, not in the work.',
      ),
    ).toBeDefined();
    expect(replay.getByText(SIM_REPLAY_NOTE)).toBeDefined();
    expect(replay.getByText('orbit-decay@1.2.0')).toBeDefined();
    expect(replay.getAllByRole('listitem')).toHaveLength(2);
  });

  it('refuses to save an essay with nothing in the mark field: no submission, focus in the field, a reason next to it', async () => {
    const { user, sent, container } = await setup();
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(document.activeElement).toBe(scoreField());
    expect(scoreField().getAttribute('aria-invalid')).toBe('true');
    const described = scoreField().getAttribute('aria-describedby');
    expect(container.querySelector(`[id="${String(described)}"]`)?.textContent).toBe(
      'Enter a mark before saving.',
    );
    expect(announced(container)).toBe('Enter a mark before saving.');
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    await assertAccessible(container);
  });
});

describe('keyboard-first: the marking loop without a mouse', () => {
  it('applies a band with a digit, saves with Enter, and lands on the next response awaiting a mark', async () => {
    const { user, sent, container } = await setup();
    await user.keyboard('2');
    expect(scoreField().value).toBe('2');
    expect(feedbackField().value).toBe(ESSAY_FEEDBACK_2);
    expect(
      (
        screen.getByRole('radio', {
          name: '2. Worth 2: names one force',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(announced(container)).toBe('Band 2 applied: 2 of 5. Feedback prefilled from the band.');

    await user.keyboard('{Enter}');
    expect(sent).toEqual([
      {
        responseId: 'r-essay',
        questionId: 'q-essay',
        basedOn: 'v1',
        flagged: false,
        resolution: 'MARK',
        points: 2,
        feedback: ESSAY_FEEDBACK_2,
        bandId: 'band-2',
        quickScored: true,
      },
    ]);
    // Index 2 is a sealed auto-grade; the next response AWAITING a mark is the simulation at index 3.
    expect(await screen.findByText('Response 4 of 5, awaiting a mark')).toBeDefined();
    expect(announced(container)).toBe('Mark saved. Response 4 of 5, awaiting a mark.');
    expect(region('Marking: Candidate 14').querySelector('header')?.textContent).toContain(
      '2 awaiting a mark, 1 marked by a teacher',
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('moves with J and K through EVERY response in paper order, and says so at each end', async () => {
    const { user, container } = await setup({ props: { initialIndex: 0 } });
    expect(position()).toBe('Response 1 of 5, marked automatically');
    await user.keyboard('k');
    expect(announced(container)).toBe('This is the first response.');
    expect(position()).toBe('Response 1 of 5, marked automatically');

    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await user.keyboard('j');
      seen.push(announced(container));
    }
    expect(seen).toEqual([
      'Response 2 of 5, awaiting a mark.',
      'Response 3 of 5, marked automatically.',
      'Response 4 of 5, awaiting a mark.',
      'Response 5 of 5, awaiting a mark.',
    ]);
    await user.keyboard('j');
    expect(announced(container)).toBe('This is the last response.');
    await user.keyboard('k');
    expect(position()).toBe('Response 4 of 5, awaiting a mark');
  });

  it('takes NOTHING typed into the feedback field for a command', async () => {
    const { user, sent } = await setup();
    await user.click(feedbackField());
    await user.keyboard('jkefr 0123456789?{Enter}Fine');
    expect(feedbackField().value).toBe('jkefr 0123456789?\nFine');
    // Not moved, not excused, not flagged, no band, no mark, nothing sent.
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    expect(checkbox('Excuse this response').checked).toBe(false);
    expect(checkbox('Flag this response for follow-up').checked).toBe(false);
    expect(scoreField().value).toBe('');
    expect(screen.queryAllByRole('radio', { checked: true })).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('takes nothing typed into the MARK field for a command either: a digit there is a digit', async () => {
    const { user } = await setup();
    await user.click(scoreField());
    await user.keyboard('3');
    expect(scoreField().value).toBe('3');
    // Typed, so it is not a band and not a quick score.
    expect(screen.queryAllByRole('radio', { checked: true })).toEqual([]);
    expect(within(marking()).queryByText(QUICK_SCORED_NOTE)).toBeNull();
  });

  it('moves between responses from INSIDE the feedback field, keeps what was typed, and keeps focus in the field', async () => {
    const { user, container } = await setup({
      responses: [essayAwaiting(), secondEssay()],
      props: { initialIndex: 0 },
    });
    await user.click(feedbackField());
    await user.keyboard('First comment');
    await user.keyboard('{Alt>}j{/Alt}');

    expect(position()).toBe('Response 2 of 2, awaiting a mark');
    expect(announced(container)).toBe('Response 2 of 2, awaiting a mark.');
    // Focus never left the field, and the field now shows the OTHER response's (empty) draft.
    expect(document.activeElement).toBe(feedbackField());
    expect(feedbackField().value).toBe('');
    // No stray character from the chord landed in either draft.
    await user.keyboard('Second comment');
    await user.keyboard('{Alt>}k{/Alt}');
    expect(feedbackField().value).toBe('First comment');
    await user.keyboard('{Alt>}j{/Alt}');
    expect(feedbackField().value).toBe('Second comment');
  });

  it('saves from inside a field with Ctrl+Enter, and leaves a plain Enter there as a line break', async () => {
    const { user, sent } = await setup({
      responses: [essayAwaiting(), secondEssay()],
      props: { initialIndex: 0 },
    });
    await user.click(scoreField());
    await user.keyboard('4');
    await user.click(feedbackField());
    await user.keyboard('Line one{Enter}Line two');
    expect(sent).toEqual([]);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      resolution: 'MARK',
      points: 4,
      feedback: 'Line one\nLine two',
      bandId: null,
      quickScored: false,
    });
    expect(await screen.findByText('Response 2 of 2, awaiting a mark')).toBeDefined();
    // Still in the feedback field, now on the next response.
    expect(document.activeElement).toBe(feedbackField());
  });

  it('puts focus on the answer when the field it was in is GONE, not on the page', async () => {
    // From an essay's feedback field onto a sealed auto-grade, which has no fields at all.
    const { user } = await setup();
    await user.click(feedbackField());
    await user.keyboard('{Alt>}j{/Alt}');
    expect(position()).toBe('Response 3 of 5, marked automatically');
    expect(document.activeElement).toBe(answerPane());
    // And the shortcuts still work from there, which they would not from <body>.
    await user.keyboard('j');
    expect(position()).toBe('Response 4 of 5, awaiting a mark');
  });

  it('leaves the browser’s own chords alone: Ctrl+R, Ctrl+F, Ctrl+J, Ctrl+1 and Escape are not prevented', async () => {
    await setup();
    const untouched = (init: KeyboardEventInit): boolean => fireEvent.keyDown(answerPane(), init);
    expect(untouched({ key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true);
    expect(untouched({ key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(untouched({ key: 'j', code: 'KeyJ', ctrlKey: true })).toBe(true);
    expect(untouched({ key: 'r', code: 'KeyR', metaKey: true })).toBe(true);
    expect(untouched({ key: '1', code: 'Digit1', ctrlKey: true })).toBe(true);
    expect(untouched({ key: 'Escape', code: 'Escape' })).toBe(true);
    expect(untouched({ key: 'Tab', code: 'Tab' })).toBe(true);
    // The control: a bare `r` IS handled, so the assertion above is not passing for want of a listener.
    expect(untouched({ key: 'r', code: 'KeyR' })).toBe(false);
    // And none of them did anything.
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    expect(checkbox('Flag this response for follow-up').checked).toBe(false);
  });

  it('ignores a HELD key: auto-repeat on Enter does not save, and on J does not run through the paper', async () => {
    const { sent } = await setup();
    fireEvent.keyDown(answerPane(), { key: '2', code: 'Digit2' });
    for (let repeat = 0; repeat < 5; repeat += 1) {
      fireEvent.keyDown(answerPane(), { key: 'Enter', code: 'Enter', repeat: true });
      fireEvent.keyDown(answerPane(), { key: 'j', code: 'KeyJ', repeat: true });
    }
    expect(sent).toEqual([]);
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
  });

  it('flags with F, moves to the feedback field with R, and opens the shortcuts with ?', async () => {
    const { user, container } = await setup();
    await user.keyboard('f');
    expect(checkbox('Flag this response for follow-up').checked).toBe(true);
    expect(announced(container)).toBe('Flagged for follow-up.');
    await user.keyboard('f');
    expect(checkbox('Flag this response for follow-up').checked).toBe(false);
    expect(announced(container)).toBe('Flag removed.');

    await user.keyboard('r');
    expect(document.activeElement).toBe(feedbackField());
    // `r` moved focus; it was not typed into the field it moved to.
    expect(feedbackField().value).toBe('');

    answerPane().focus();
    await user.keyboard('?');
    const summary = screen.getByText('Keyboard shortcuts', { selector: 'summary' });
    expect(document.activeElement).toBe(summary);
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(true);
  });

  it('lets Enter on a focused BUTTON press the button, rather than save the mark', async () => {
    const { user, sent } = await setup();
    await user.keyboard('2');
    screen.getByRole('button', { name: 'Next response' }).focus();
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(position()).toBe('Response 3 of 5, marked automatically');
  });

  it('does nothing to a sealed response on a digit or E, and says why', async () => {
    const { user, container, sent } = await setup({ props: { initialIndex: 2 } });
    await user.keyboard('2');
    expect(announced(container)).toBe(SEALED_NO_MARK);
    await user.keyboard('e');
    expect(announced(container)).toBe(SEALED_NO_MARK);
    await user.keyboard('r');
    expect(announced(container)).toBe(SEALED_NO_MARK);
    // Still sealed, still its real zero, and still on the same response.
    expect(within(marking()).getByText('Marked automatically: 0 of 2.')).toBeDefined();
    expect(position()).toBe('Response 3 of 5, marked automatically');

    // Enter has nothing to save here, so it only moves on -- to the next response AWAITING a mark.
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(announced(container)).toBe(
      'Nothing to save on this response. Response 4 of 5, awaiting a mark.',
    );
  });
});

describe('every shortcut has a control that does the same thing', () => {
  it('lists every binding in the shortcuts table, from the key map itself', async () => {
    await setup();
    const table = screen.getByRole('table', { name: 'What each key does on this screen' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByRole('rowheader').textContent);
    expect(rows).toEqual(GRADING_KEYMAP.map((binding) => binding.chord));
    for (const binding of GRADING_KEYMAP) {
      expect(within(table).getByText(binding.description)).toBeDefined();
    }
  });

  it('has, in the DOM, the control `EQUIVALENT_CONTROL` names for each action', async () => {
    await setup();
    expect(screen.getByRole('button', { name: EQUIVALENT_CONTROL['response.next'] })).toBeDefined();
    expect(
      screen.getByRole('button', { name: EQUIVALENT_CONTROL['response.previous'] }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: EQUIVALENT_CONTROL['mark.saveAndNext'] }),
    ).toBeDefined();
    expect(screen.getByRole('group', { name: EQUIVALENT_CONTROL['mark.digit'] })).toBeDefined();
    expect(checkbox(EQUIVALENT_CONTROL['mark.excuse'])).toBeDefined();
    expect(checkbox(EQUIVALENT_CONTROL['mark.flag'])).toBeDefined();
    expect(
      screen.getByRole('textbox', { name: EQUIVALENT_CONTROL['feedback.open'] }),
    ).toBeDefined();
    expect(
      screen.getByText(EQUIVALENT_CONTROL['help.open'], { selector: 'summary' }),
    ).toBeDefined();
  });

  it('produces the SAME mark and comment from the band’s radio as from its digit', async () => {
    const byKey = await setup();
    await byKey.user.keyboard('2');
    const fromKey = { score: scoreField().value, feedback: feedbackField().value };
    await byKey.user.keyboard('{Enter}');
    cleanup();

    const byControl = await setup();
    await byControl.user.click(screen.getByRole('radio', { name: '2. Worth 2: names one force' }));
    expect({ score: scoreField().value, feedback: feedbackField().value }).toEqual(fromKey);
    await byControl.user.click(
      screen.getByRole('button', { name: 'Save mark and go to the next response' }),
    );

    // The one intended difference: how it was entered is recorded.
    expect(byControl.sent).toEqual([{ ...byKey.sent[0], quickScored: false }]);
    expect(byKey.sent[0]).toMatchObject({ resolution: 'MARK', quickScored: true });
  });

  it('moves, flags and excuses identically from the controls as from the keys', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Next response' }));
    expect(position()).toBe('Response 3 of 5, marked automatically');
    await user.click(screen.getByRole('button', { name: 'Previous response' }));
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    await user.click(checkbox('Flag this response for follow-up'));
    expect(checkbox('Flag this response for follow-up').checked).toBe(true);
    await user.click(checkbox('Excuse this response'));
    expect(checkbox('Excuse this response').checked).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Reason for excusing' })).toBeDefined();
  });
});

describe('excusing', () => {
  it('excuses with E, puts focus in the reason, and REFUSES to save until one is given', async () => {
    const { user, sent, container } = await setup();
    await user.keyboard('e');
    const reason = screen.getByRole('textbox', { name: 'Reason for excusing' });
    expect(checkbox('Excuse this response').checked).toBe(true);
    expect(document.activeElement).toBe(reason);
    expect(announced(container)).toBe('Excused. Give a reason before saving.');

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(sent).toEqual([]);
    expect(announced(container)).toBe(EXCUSE_REASON_REQUIRED);
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reason);

    await user.keyboard('Fire alarm during this question.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(sent).toEqual([
      {
        responseId: 'r-essay',
        questionId: 'q-essay',
        basedOn: 'v1',
        flagged: false,
        resolution: 'EXCUSE',
        reason: 'Fire alarm during this question.',
        feedback: '',
      },
    ]);
    await assertAccessible(container);
  });

  it('survives the slip the reason exists for: E instead of 3, then Enter, sends nothing', async () => {
    const { user, sent } = await setup();
    await user.keyboard('e');
    // Focus is in the reason field, so the Enter that would have saved a band is a line break in an empty reason.
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
  });

  it('does not move focus when the CHECKBOX is used, because changing a setting should not move the person', async () => {
    const { user } = await setup();
    const excuse = checkbox('Excuse this response');
    await user.click(excuse);
    expect(document.activeElement).toBe(excuse);
  });
});

describe('drafts', () => {
  it('writes the draft to the store on the FIRST keystroke and on every one after, and says where it is', async () => {
    const { user, store, clock } = await setup();
    expect(within(marking()).getByText(DRAFT_NONE)).toBeDefined();

    await user.click(feedbackField());
    await user.keyboard('O');
    const held = () => (store as ReturnType<typeof memoryDraftStore>).entries();
    expect(held()[key()]).toEqual({
      draft: { ...EMPTY_DRAFT, feedback: 'O' },
      keptAt: T0,
      basedOn: 'v1',
    });

    clock.now = T0 + 60_000;
    await user.keyboard('ne force.');
    expect(held()[key()]).toEqual({
      draft: { ...EMPTY_DRAFT, feedback: 'One force.' },
      keptAt: T0 + 60_000,
      basedOn: 'v1',
    });
    expect(
      within(marking()).getByText(
        'Draft kept on this device at TIME 60000. It is not a saved mark yet.',
      ),
    ).toBeDefined();
  });

  it('RESTORES a draft after the tab is closed and reopened, and says it did -- it does not appear silently', async () => {
    const first = await setup();
    await first.user.keyboard('2');
    await first.user.click(feedbackField());
    await first.user.keyboard(' See page 4.');
    first.unmount();

    // A new mount with the same device store: the closed tab, reopened.
    const { container } = await setup({ store: first.store });
    expect(scoreField().value).toBe('2');
    expect(feedbackField().value).toBe(`${ESSAY_FEEDBACK_2} See page 4.`);
    expect(
      within(marking()).getByText(
        'A draft kept on this device was restored, last changed DATE_TIME 0. It is not a saved mark.',
      ),
    ).toBeDefined();
    // Restored is not saved: the response is still awaiting a mark and nothing was sent.
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    expect(first.sent).toEqual([]);
    await assertAccessible(container);
  });

  it('says a restored draft is STALE when the response has changed since it was written', async () => {
    const stale: StoredDraft = {
      draft: { ...EMPTY_DRAFT, score: '4', feedback: 'Written last week.' },
      keptAt: T0 - 1000,
      basedOn: 'v0',
    };
    await setup({ store: memoryDraftStore({ [key()]: stale }) });
    expect(feedbackField().value).toBe('Written last week.');
    expect(
      within(marking()).getByText(/has changed since this draft was written, so check it/),
    ).toBeDefined();
  });

  it('announces a restored draft when the response is ARRIVED at by key, since the status line is not a live region', async () => {
    const waiting: StoredDraft = {
      draft: { ...EMPTY_DRAFT, feedback: 'Half a comment' },
      keptAt: T0,
      basedOn: 'v1',
    };
    const { user, container } = await setup({
      store: memoryDraftStore({ [key()]: waiting }),
      props: { initialIndex: 0 },
    });
    await user.keyboard('j');
    expect(announced(container)).toBe(
      'Response 2 of 5, awaiting a mark. A draft kept on this device was restored.',
    );
  });

  it('never shows one teacher another teacher’s draft for the same response', async () => {
    const theirs: StoredDraft = {
      draft: { ...EMPTY_DRAFT, feedback: 'Someone else’s half-written comment.' },
      keptAt: T0,
      basedOn: 'v1',
    };
    await setup({ store: memoryDraftStore({ [key('teacher-2')]: theirs }) });
    expect(feedbackField().value).toBe('');
    expect(within(marking()).getByText(DRAFT_NONE)).toBeDefined();
  });

  it('DISCARDS on request: the device is cleared, the fields return to the saved mark, and focus goes to the answer', async () => {
    const { user, store, container } = await setup();
    await user.click(feedbackField());
    await user.keyboard('To be thrown away');
    await user.click(screen.getByRole('button', { name: 'Discard this draft' }));

    expect((store as ReturnType<typeof memoryDraftStore>).entries()).toEqual({});
    expect(feedbackField().value).toBe('');
    expect(within(marking()).getByText(DRAFT_NONE)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Discard this draft' })).toBeNull();
    // The button that was pressed no longer exists.
    expect(document.activeElement).toBe(answerPane());
    expect(announced(container)).toBe(DRAFT_DISCARDED);
  });

  it('removes the draft from the device when the text is deleted back to nothing, so it is not "restored" later', async () => {
    const { user, store } = await setup();
    await user.click(feedbackField());
    await user.keyboard('ab{Backspace}{Backspace}');
    expect((store as ReturnType<typeof memoryDraftStore>).entries()).toEqual({});
    expect(within(marking()).getByText(DRAFT_NONE)).toBeDefined();
  });

  it('says in an ALERT when the device refuses the draft, and never says it was kept', async () => {
    const refusing: DraftStore = {
      read: () => ({ kind: 'NONE' }),
      write: () => ({ ok: false, reason: 'STORAGE_REFUSED' }),
      remove: () => {},
    };
    const { user, container } = await setup({ store: refusing });
    await user.click(feedbackField());
    await user.keyboard('This cannot be stored');

    expect(screen.getByRole('alert').textContent).toBe(DRAFT_NOT_KEPT);
    expect(marking().textContent).not.toContain('Draft kept on this device');
    // The typing itself still works: the draft is in the tab.
    expect(feedbackField().value).toBe('This cannot be stored');
    await assertAccessible(container);
  });

  it('asks the browser to confirm leaving ONLY when a draft exists that the device did not keep', async () => {
    const leaving = (): boolean => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    const kept = await setup();
    await kept.user.click(feedbackField());
    await kept.user.keyboard('Kept on the device');
    // On the device: closing the tab loses nothing, so no prompt.
    expect(leaving()).toBe(false);
    kept.unmount();

    const refused = await setup({
      store: {
        read: () => ({ kind: 'NONE' }),
        write: () => ({ ok: false, reason: 'READ_BACK_DIFFERS' }),
        remove: () => {},
      },
    });
    expect(leaving()).toBe(false);
    await refused.user.click(feedbackField());
    await refused.user.keyboard('Only in this tab');
    expect(leaving()).toBe(true);
    // And the listener goes with the workspace.
    refused.unmount();
    expect(leaving()).toBe(false);
  });

  it('says something unreadable is stored, rather than treating it as no draft', async () => {
    const unreadable: DraftStore = {
      read: () => ({ kind: 'UNREADABLE' }),
      write: () => ({ ok: true }),
      remove: () => {},
    };
    await setup({ store: unreadable });
    expect(
      within(marking()).getByText(/could not be read as a draft\. Nothing was restored/),
    ).toBeDefined();
    expect(feedbackField().value).toBe('');
  });
});

describe('saving a mark', () => {
  it('says "saved" only AFTER the server acknowledges, and removes the draft from the device then', async () => {
    const gate = deferred<SaveMarkResult>();
    const { user, store, clock } = await setup({
      responses: [essayAwaiting()],
      props: { initialIndex: 0 },
      respond: () => gate.promise,
    });
    const held = () => (store as ReturnType<typeof memoryDraftStore>).entries();
    await user.keyboard('1');
    await user.keyboard('{Enter}');

    // IN FLIGHT: not saved, and the draft is still on the device.
    expect(within(marking()).getByText('Saving the mark…')).toBeDefined();
    expect(marking().textContent).not.toContain('Mark saved');
    expect(Object.keys(held())).toEqual([key()]);
    expect(within(marking()).getByText('Awaiting a mark. Worth 5.')).toBeDefined();

    clock.now = T0 + 5000;
    gate.settle({ ok: true, version: 'v2' });
    expect(await within(marking()).findByText('Mark saved at TIME 5000.')).toBeDefined();
    expect(held()).toEqual({});
    expect(within(marking()).getByText('Marked by a teacher: 5 of 5.')).toBeDefined();
  });

  it('sends ONE submission for two Enters while the first is still in flight', async () => {
    const gate = deferred<SaveMarkResult>();
    const { user, sent } = await setup({ respond: () => gate.promise });
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(sent).toHaveLength(1);
    gate.settle({ ok: true });
    expect(await screen.findByText('Response 4 of 5, awaiting a mark')).toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it('on a FAILED save: says so in an alert, keeps the draft on the device, and does not move on', async () => {
    const { user, store, container } = await setup({
      respond: () => Promise.resolve({ ok: false, reason: 'another teacher saved a mark first' }),
    });
    await user.keyboard('2');
    await user.keyboard('{Enter}');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The mark was not saved: another teacher saved a mark first. Your draft is still kept on this device.',
    );
    expect(marking().textContent).not.toContain('Mark saved');
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    expect(scoreField().value).toBe('2');
    expect(Object.keys((store as ReturnType<typeof memoryDraftStore>).entries())).toEqual([key()]);
    expect(within(marking()).getByText('Awaiting a mark. Worth 5.')).toBeDefined();
    await assertAccessible(container);
  });

  it('treats a REJECTED request as a failed save, not as silence', async () => {
    const { user } = await setup({ respond: () => Promise.reject(new Error('offline')) });
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The mark was not saved: the request did not complete. Your draft is still kept on this device.',
    );
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
  });

  it('can be retried after a failure, and the retry is a second submission', async () => {
    const answers: SaveMarkResult[] = [{ ok: false, reason: 'timed out' }, { ok: true }];
    const { user, sent } = await setup({
      respond: () => Promise.resolve(answers.shift() ?? { ok: true }),
    });
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Response 4 of 5, awaiting a mark')).toBeDefined();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('keeps what was typed WHILE the save was in flight as a draft, and says it is not saved', async () => {
    const gate = deferred<SaveMarkResult>();
    const { user, store, container, sent } = await setup({ respond: () => gate.promise });
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    await user.click(feedbackField());
    await user.keyboard(' Added during the save.');
    gate.settle({ ok: true, version: 'v2' });

    await screen.findByText('Marked by a teacher: 2 of 5.');
    expect(announced(container)).toBe(CHANGED_WHILE_SAVING);
    // Did not move on, did not lose the text, and the text is on the device as a draft.
    expect(position()).toBe('Response 2 of 5, marked by a teacher');
    expect(feedbackField().value).toBe(`${ESSAY_FEEDBACK_2} Added during the save.`);
    const held = (store as ReturnType<typeof memoryDraftStore>).entries()[key()];
    expect(held?.draft.feedback).toBe(`${ESSAY_FEEDBACK_2} Added during the save.`);
    expect(held?.basedOn).toBe('v2');
    // What was SENT is what was there when Enter was pressed.
    expect(sent[0]).toMatchObject({ feedback: ESSAY_FEEDBACK_2 });
  });

  it('moving past an already-marked, untouched response sends nothing', async () => {
    const marked = essayAwaiting({
      needsHuman: false,
      manual: { points: 2, feedback: 'One force is named.', bandId: 'band-2' },
    });
    const { user, sent, container } = await setup({
      responses: [marked, secondEssay()],
      props: { initialIndex: 0 },
    });
    expect(scoreField().value).toBe('2');
    expect(feedbackField().value).toBe('One force is named.');
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(announced(container)).toBe(
      'Nothing to save on this response. Response 2 of 2, awaiting a mark.',
    );
  });

  it('says when nothing else is awaiting a mark, instead of moving somewhere arbitrary', async () => {
    const { user, container } = await setup({
      responses: [choiceRight(), essayAwaiting()],
      props: { initialIndex: 1 },
    });
    await user.keyboard('1');
    await user.keyboard('{Enter}');
    await screen.findByText('Marked by a teacher: 5 of 5.');
    expect(announced(container)).toBe(
      'Mark saved. No other response in this attempt is awaiting a mark.',
    );
    expect(position()).toBe('Response 2 of 2, marked by a teacher');
  });
});

describe('rubric bands and prefilled feedback', () => {
  it('says the prefilled comment is the teacher’s while it stands untouched, and stops saying so once edited', async () => {
    const { user, container } = await setup();
    const hint = (): string =>
      container.querySelector(`[id="${String(feedbackField().getAttribute('aria-describedby'))}"]`)
        ?.textContent ?? '';
    expect(hint()).toBe(FEEDBACK_HINT);
    await user.keyboard('2');
    expect(hint()).toBe(PREFILL_HINT);
    await user.click(feedbackField());
    await user.keyboard('!');
    expect(hint()).toBe(FEEDBACK_HINT);
  });

  it('NEVER replaces a typed comment when a band is applied: the mark changes, the words stay, the band comment is offered', async () => {
    const { user, container } = await setup();
    await user.click(feedbackField());
    await user.keyboard('The diagram is labelled but the working stops.');
    answerPane().focus();
    await user.keyboard('2');

    expect(scoreField().value).toBe('2');
    expect(feedbackField().value).toBe('The diagram is labelled but the working stops.');
    expect(within(marking()).getByText(OFFER_INTRO)).toBeDefined();
    expect(marking().querySelector('blockquote')?.textContent).toBe(ESSAY_FEEDBACK_2);
    expect(announced(container)).toBe(
      'Band 2 applied: 2 of 5. Your comment was kept; the band’s comment was not inserted.',
    );
    await assertAccessible(container);
  });

  it('appends the offered comment below the teacher’s on request, and puts focus in the feedback field', async () => {
    const { user } = await setup();
    await user.click(feedbackField());
    await user.keyboard('The diagram is labelled.');
    answerPane().focus();
    await user.keyboard('2');
    await user.click(screen.getByRole('button', { name: 'Add it below my comment' }));

    expect(feedbackField().value).toBe(`The diagram is labelled.\n\n${ESSAY_FEEDBACK_2}`);
    expect(within(marking()).queryByText(OFFER_INTRO)).toBeNull();
    // The button is gone; focus is on what it changed, not on <body>.
    expect(document.activeElement).toBe(feedbackField());
  });

  it('replaces only on request, and "Put my comment back" restores the teacher’s words exactly', async () => {
    const { user } = await setup();
    await user.click(feedbackField());
    await user.keyboard('The diagram is labelled.');
    answerPane().focus();
    await user.keyboard('2');
    await user.click(screen.getByRole('button', { name: 'Replace my comment with it' }));
    expect(feedbackField().value).toBe(ESSAY_FEEDBACK_2);
    expect(document.activeElement).toBe(feedbackField());

    await user.click(screen.getByRole('button', { name: 'Put my comment back' }));
    expect(feedbackField().value).toBe('The diagram is labelled.');
    expect(screen.queryByRole('button', { name: 'Put my comment back' })).toBeNull();
    expect(document.activeElement).toBe(feedbackField());
  });

  it('leaves everything as it is on "Leave my comment as it is"', async () => {
    const { user } = await setup();
    await user.click(feedbackField());
    await user.keyboard('Mine.');
    answerPane().focus();
    await user.keyboard('1');
    await user.click(screen.getByRole('button', { name: 'Leave my comment as it is' }));
    expect(feedbackField().value).toBe('Mine.');
    expect(scoreField().value).toBe('5');
    expect(within(marking()).queryByText(OFFER_INTRO)).toBeNull();
  });

  it('prefills NOTHING from a band with no comment, and says so', async () => {
    const { user, container } = await setup();
    await user.keyboard('3');
    expect(scoreField().value).toBe('0');
    expect(feedbackField().value).toBe('');
    expect(announced(container)).toBe(
      'Band 3 applied: 0 of 5. This band has no comment to prefill.',
    );
  });

  it('says there is no such band rather than doing nothing, and 0 is not a band', async () => {
    const { user, container } = await setup();
    await user.keyboard('7');
    expect(announced(container)).toBe('There is no band 7 on this question.');
    await user.keyboard('0');
    expect(announced(container)).toBe('There is no band 0 on this question.');
    expect(scoreField().value).toBe('');
  });

  it('tells the teacher a digit-entered mark is recorded as quick-scored, and stops once it is edited by hand', async () => {
    const { user } = await setup();
    await user.keyboard('2');
    expect(within(marking()).getByText(QUICK_SCORED_NOTE)).toBeDefined();
    await user.click(feedbackField());
    await user.keyboard('.');
    expect(within(marking()).queryByText(QUICK_SCORED_NOTE)).toBeNull();
  });

  it('cannot save a band that is out of range even if the rubric it was GIVEN has one', async () => {
    // A rubric arriving from the server is not trusted either: the mark goes through the same door at save.
    const hostile: MarkingRubric = {
      questionId: 'q-essay',
      maxPoints: 5,
      bands: [
        { id: 'band-1', points: -3, descriptor: 'a penalty dressed as a band', feedback: '' },
        { id: 'band-2', points: 9, descriptor: 'more than the question is worth', feedback: '' },
      ],
    };
    const { user, sent, container } = await setup({ props: { rubrics: { 'q-essay': hostile } } });
    await user.keyboard('1');
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(announced(container)).toContain('A mark cannot be below 0');

    answerPane().focus();
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    expect(sent).toEqual([]);
    expect(announced(container)).toBe('This question is worth 5. A mark cannot be above that.');
  });

  it('on a question with NO rubric, a digit is the mark -- and a digit above the maximum is refused, not clamped', async () => {
    const noBands = essayAwaiting({
      spec: { ...FREE_RESPONSE, rubric: [] } as TeacherQuestionSpec,
    });
    const { user, container } = await setup({
      responses: [noBands],
      props: { initialIndex: 0, rubrics: {} },
    });
    expect(screen.queryByRole('radio')).toBeNull();
    await user.keyboard('3');
    expect(scoreField().value).toBe('3');
    expect(announced(container)).toBe('3 of 5 entered.');
    expect(within(marking()).getByText(QUICK_SCORED_NOTE)).toBeDefined();

    await user.keyboard('9');
    expect(scoreField().value).toBe('3');
    expect(announced(container)).toBe('This question is worth 5. A mark cannot be above that.');
  });

  it('falls back to the bands in the question’s own spec when no rubric is supplied', async () => {
    const { user } = await setup({ props: { rubrics: {} } });
    expect(
      screen.getByRole('radio', {
        name: '1. Worth 5: names both forces and links them to the acceleration',
      }),
    ).toBeDefined();
    // Spec bands carry no comment, so nothing is prefilled.
    await user.keyboard('1');
    expect(scoreField().value).toBe('5');
    expect(feedbackField().value).toBe('');
  });
});

describe('the rubric editor inside the workspace', () => {
  const withEditor = (saved: MarkingRubric[]) =>
    setup({
      props: {
        onSaveRubric: (next) => {
          saved.push(next);
          return Promise.resolve({ ok: true });
        },
      },
    });

  it('is not drawn when the caller cannot save a rubric', async () => {
    await setup();
    expect(screen.queryByText('Edit the rubric for this question')).toBeNull();
  });

  it('changes what a digit applies only AFTER the rubric save is acknowledged', async () => {
    const saved: MarkingRubric[] = [];
    const { user } = await withEditor(saved);
    const marks = within(screen.getByRole('group', { name: 'Band 2' })).getByRole('textbox', {
      name: 'Marks',
    });
    await user.clear(marks);
    await user.type(marks, '3');

    // Edited, not saved: band 2 is still worth 2 to the digit key.
    answerPane().focus();
    await user.keyboard('2');
    expect(scoreField().value).toBe('2');

    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(await screen.findByRole('radio', { name: '2. Worth 3: names one force' })).toBeDefined();
    answerPane().focus();
    await user.keyboard('2');
    expect(scoreField().value).toBe('3');
    expect(saved).toHaveLength(1);
  });

  it('keeps the shortcut keys OFF on the editor’s buttons: E on "Move band 1 down" does not excuse the response', async () => {
    const { user } = await withEditor([]);
    const move = screen.getByRole('button', { name: 'Move band 1 down' });
    expect(move.closest(`[${KEYS_OFF_ATTRIBUTE}="off"]`)).not.toBeNull();
    move.focus();
    await user.keyboard('efj2');
    expect(checkbox('Excuse this response').checked).toBe(false);
    expect(checkbox('Flag this response for follow-up').checked).toBe(false);
    expect(position()).toBe('Response 2 of 5, awaiting a mark');
    expect(scoreField().value).toBe('');
  });
});

describe('a penalised-below-zero response', () => {
  it('shows the raw score and the method, offers to accept it, and warns what typing 0 would do', async () => {
    await setup({ props: { initialIndex: 4 } });
    const mark = within(marking());
    expect(mark.getByText('Awaiting a mark. Worth 4.')).toBeDefined();
    expect(mark.getByText(AWAITING_REASON.PENALISED_BELOW_ZERO)).toBeDefined();
    expect(
      mark.getByText(/^The automatic marker reported: Scored -2 of 4, below zero/),
    ).toBeDefined();
    expect(mark.getByText(ACCEPT_AUTO_NOTE)).toBeDefined();
  });

  it('accepting sends ACCEPT_AUTO_MARK with no points, and the raw score is still shown afterwards', async () => {
    const { user, sent } = await setup({ props: { initialIndex: 4 } });
    await user.click(checkbox('Accept the automatic mark as it stands'));
    await user.click(screen.getByRole('button', { name: 'Save mark and go to the next response' }));
    expect(sent).toEqual([
      {
        responseId: 'r-multi',
        questionId: 'q-multi',
        basedOn: 'v1',
        flagged: false,
        resolution: 'ACCEPT_AUTO_MARK',
        feedback: '',
      },
    ]);
    // It advanced to the next awaiting response; go back and look at what the accepted one now says.
    await screen.findByText('Response 2 of 5, awaiting a mark');
    // It wrapped round to response 2; response 5 is three to the right.
    for (let step = 0; step < 3; step += 1) {
      await user.click(screen.getByRole('button', { name: 'Next response' }));
    }
    expect(position()).toBe('Response 5 of 5, marked automatically');
    expect(
      within(marking()).getByText(
        'Raw score -2. The zero floor is applied to the attempt total, not to this question.',
      ),
    ).toBeDefined();
  });

  it('is NOT offered on an essay or a simulation fault, where the stored zero is not a mark', async () => {
    await setup();
    expect(
      screen.queryByRole('checkbox', { name: 'Accept the automatic mark as it stands' }),
    ).toBeNull();
    cleanup();
    await setup({ props: { initialIndex: 3 } });
    expect(
      screen.queryByRole('checkbox', { name: 'Accept the automatic mark as it stands' }),
    ).toBeNull();
  });
});

describe('a sealed response’s flag', () => {
  it('saves the flag alone, and the mark stays what the grader said', async () => {
    const { user, sent } = await setup({ props: { initialIndex: 2 } });
    await user.keyboard('f');
    await user.keyboard('{Enter}');
    expect(sent).toEqual([
      {
        responseId: 'r-choice-wrong',
        questionId: 'q-choice',
        basedOn: 'v1',
        flagged: true,
        resolution: 'FLAG_ONLY',
      },
    ]);
  });
});

describe('after release', () => {
  it('is read-only: no field, no save, and every marking key says a change is a regrade', async () => {
    const { user, sent, container } = await setup({ props: { released: true } });
    expect(screen.getByText(RELEASED_NOTE)).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save mark and go to the next response' }),
    ).toBeNull();

    for (const pressed of ['2', 'e', 'f', 'r', '{Enter}']) {
      await user.keyboard(pressed);
      expect(announced(container), pressed).toBe(RELEASED_NOTE);
    }
    expect(sent).toEqual([]);
    // Reading and moving still work.
    await user.keyboard('j');
    expect(position()).toBe('Response 3 of 5, marked automatically');
  });
});

describe('the server’s account wins', () => {
  it('drops its own picture of a saved mark as soon as the caller supplies facts with a new version', async () => {
    const { user, rerender, store, sent } = await setup({
      responses: [essayAwaiting()],
      props: { initialIndex: 0 },
    });
    await user.keyboard('2');
    await user.keyboard('{Enter}');
    await screen.findByText('Marked by a teacher: 2 of 5.');

    // The caller refetches, and the server says a second marker has since changed it to 4.
    rerender(
      <GradingWorkspace
        attemptId="attempt-9"
        candidateLabel="Candidate 14"
        responses={[
          essayAwaiting({
            version: 'v9',
            needsHuman: false,
            manual: { points: 4, feedback: 'Moderated.', bandId: null },
          }),
        ]}
        graderId="teacher-1"
        store={store}
        now={() => T0}
        rubrics={RUBRICS}
        onSaveMark={(submission) => {
          sent.push(submission);
          return Promise.resolve({ ok: true });
        }}
      />,
    );
    expect(within(marking()).getByText('Marked by a teacher: 4 of 5.')).toBeDefined();
  });
});
