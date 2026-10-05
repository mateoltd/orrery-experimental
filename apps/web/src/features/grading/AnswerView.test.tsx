// @vitest-environment jsdom

/**
 * The student's answer as a teacher reads it.  (P9-T2)
 *
 * Three states that must not look alike: something written, nothing written, and something stored that is not an
 * answer. And a rule about the first: what was written is shown as text, exactly, whatever characters it contains.
 */

import type { TeacherQuestionSpec } from '@orrery/contracts/question';
import { screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { AnswerView } from './AnswerView';
import {
  ANSWER_BLANK,
  ANSWER_NOT_REACHED,
  ANSWER_OMITTED,
  ANSWER_UNREADABLE,
  FILES_NOTE,
  STEP_EMPTY,
} from './copy';
import {
  choiceWrong,
  ESSAY_ANSWER,
  essayAwaiting,
  multiPenalised,
  SINGLE_CHOICE,
  simFault,
} from './fixtures';
import type { ResponseFacts } from './markingState';
import { renderAudited } from './workspaceHarness';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const draw = (facts: ResponseFacts) => renderAudited(<AnswerView facts={facts} />);

const withSpec = (spec: unknown, answer: unknown): ResponseFacts =>
  choiceWrong({ spec: { ...SINGLE_CHOICE, ...(spec as object) } as TeacherQuestionSpec, answer });

const items = (): readonly string[] =>
  screen.getAllByRole('listitem').map((item) => item.textContent ?? '');

describe('something written', () => {
  it('shows a free response exactly as written, line breaks included, as content and not as a disabled field', async () => {
    const { container } = await draw(essayAwaiting());
    const written = container.firstElementChild as HTMLElement;
    // `textContent` is compared whole: the newline between the two sentences is part of what was written.
    expect(written.textContent).toBe(ESSAY_ANSWER);
    expect(ESSAY_ANSWER).toContain('\n');
    // And it is DRAWN with that newline: without `pre-wrap` the browser collapses it to a space.
    expect(written.style.whiteSpace).toBe('pre-wrap');
    // Not a form control: a disabled textarea cannot be scrolled or selected from the keyboard.
    expect(container.querySelector('textarea, input')).toBeNull();
  });

  it('renders markup in an answer as TEXT, never as elements', async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
    const { container } = await draw(essayAwaiting({ answer: { text: hostile } }));
    expect(container.querySelector('img, script, b')).toBeNull();
    expect(container.textContent).toContain(hostile);
  });

  it('marks the selected option and the keyed option IN WORDS, on every option of a single choice', async () => {
    await draw(choiceWrong());
    expect(items()).toEqual([
      'It speeds up (keyed answer)',
      'It slows down (selected)',
      'Its speed does not change',
    ]);
  });

  it('marks an option that is both selected and keyed as both', async () => {
    await draw(multiPenalised());
    expect(items()).toEqual([
      'Gravity (selected; keyed answer)',
      'Thrust (selected)',
      'Drag (keyed answer)',
      'Centripetal force as a separate force',
      'Normal force (selected)',
    ]);
    // The method is shown because under NG a wrong selection costs marks, and a marker needs to know that.
    expect(screen.getByText('Scoring method: NG')).toBeDefined();
  });

  it('SHOWS a selected id that is not one of the question’s options, rather than dropping it', async () => {
    await draw(choiceWrong({ answer: { choiceId: 'zz' } }));
    expect(
      screen.getByText('An option that is not in this question was selected: zz'),
    ).toBeDefined();
  });

  it('shows a number as written beside the key', async () => {
    const { container } = await draw(
      withSpec(
        { type: 'numeric', key: { value: 9.81, unit: 'm/s' }, tolerance: {} },
        { value: 9.81, raw: '9.810', unit: 'm/s' },
      ),
    );
    const definitions = [...container.querySelectorAll('dd')].map((node) => node.textContent);
    expect(definitions).toEqual(['9.810 m/s', '9.81 m/s']);
  });

  it('shows true/false and its key in words', async () => {
    const { container } = await draw(
      withSpec({ type: 'true_false', key: { value: true } }, { value: false }),
    );
    expect([...container.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
      'False',
      'True',
    ]);
  });

  it('shows an ordering in the order GIVEN, then the keyed order', async () => {
    await draw(
      withSpec(
        {
          type: 'ordering',
          items: [
            { id: 'a', text: 'Launch' },
            { id: 'b', text: 'Burn' },
            { id: 'c', text: 'Coast' },
          ],
          key: { itemIds: ['a', 'b', 'c'] },
        },
        { itemIds: ['b', 'a', 'c'] },
      ),
    );
    expect(items()).toEqual(['Burn', 'Launch', 'Coast', 'Launch', 'Burn', 'Coast']);
  });

  it('shows a short text answer with its key and matcher', async () => {
    const { container } = await draw(
      withSpec(
        { type: 'short_text', key: { text: 'photosynthesis' }, matcher: 'NORMALISED' },
        { text: 'Photo synthesis' },
      ),
    );
    expect(container.textContent).toContain('Photo synthesis');
    expect([...container.querySelectorAll('dd')].map((node) => node.textContent)).toEqual([
      'photosynthesis',
      'NORMALISED',
    ]);
  });

  it('lists submitted files by identifier and says it does not preview them', async () => {
    await draw(withSpec({ type: 'file_submission' }, { assetIds: ['asset-1', 'asset-2'] }));
    expect(items()).toEqual(['asset-1', 'asset-2']);
    expect(screen.getByText(FILES_NOTE)).toBeDefined();
  });

  it('shows a simulation’s reported answer as stored', async () => {
    const { container } = await draw(simFault());
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "deltaV": 12.5\n}');
  });

  it('shows worked-solution steps against the question’s own steps, with an empty step said to be empty', async () => {
    const { container } = await draw(
      withSpec(
        {
          type: 'worked_solution',
          steps: [
            { id: 's1', prompt: 'State the law', points: 1, key: { text: 'F = ma' } },
            { id: 's2', prompt: 'Apply it', points: 2 },
          ],
        },
        { steps: ['F = ma', '', 'An extra line of working'] },
      ),
    );
    const steps = items();
    expect(steps).toHaveLength(3);
    expect(steps[0]).toBe('State the law (worth 1)F = maKeyed answer: F = ma');
    expect(steps[1]).toBe(`Apply it (worth 2)${STEP_EMPTY}`);
    // Working written beyond the question's steps is shown, not dropped.
    expect(steps[2]).toContain('An extra line of working');
    expect(container.textContent).not.toContain('undefined');
  });

  it('does not crash on a spec whose key is not what the type says', async () => {
    // A spec out of a JSON column. The grader reports this as an unreadable key; the view must still draw.
    const broken = { ...SINGLE_CHOICE, key: null } as unknown as TeacherQuestionSpec;
    await draw(choiceWrong({ spec: broken }));
    expect(items()).toEqual([
      'It speeds up',
      'It slows down (selected)',
      'Its speed does not change',
    ]);
  });
});

describe('nothing written, in its three different meanings', () => {
  it('says "no answer was submitted" for a blank', async () => {
    await draw(essayAwaiting({ answer: { text: '   ' } }));
    expect(screen.getByText(ANSWER_BLANK)).toBeDefined();
  });

  it('says "left unanswered" for an omission', async () => {
    await draw(essayAwaiting({ answer: null, isOmitted: true }));
    expect(screen.getByText(ANSWER_OMITTED)).toBeDefined();
    expect(screen.queryByText(ANSWER_BLANK)).toBeNull();
  });

  it('says the CLOCK ran out for a question that was never reached (V-4)', async () => {
    await draw(essayAwaiting({ answer: null, notReached: true }));
    expect(screen.getByText(ANSWER_NOT_REACHED)).toBeDefined();
    expect(screen.queryByText(ANSWER_BLANK)).toBeNull();
    expect(screen.queryByText(ANSWER_OMITTED)).toBeNull();
  });
});

describe('something stored that is NOT an answer', () => {
  it('says the fault is the platform’s and shows it exactly as stored -- never as a blank', async () => {
    const { container } = await draw(essayAwaiting({ answer: { text: 42, extra: ['x'] } }));
    expect(screen.getByText(ANSWER_UNREADABLE)).toBeDefined();
    expect(screen.queryByText(ANSWER_BLANK)).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ text: 42, extra: ['x'] }, null, 2),
    );
  });
});
