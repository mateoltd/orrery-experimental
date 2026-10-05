// @vitest-environment jsdom

/**
 * The rubric editor, through the DOM.  (P9-T3)
 *
 * Driven with real typing against the editor's own state. The properties: a band that would take marks away cannot
 * be saved and is not silently corrected; focus is somewhere deliberate after every move, add and remove; and a save
 * that did not happen says so.
 */

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import {
  BAND_COMMENT_HINT,
  RUBRIC_BLOCKED,
  RUBRIC_DOES_NOT_REGRADE,
  RUBRIC_EMPTY,
  RUBRIC_SAVED,
  RUBRIC_UNSAVED,
  rubricBound,
} from './copy';
import { ESSAY_RUBRIC } from './fixtures';
import { KEYS_OFF_ATTRIBUTE } from './keymap';
import { RubricEditor, type SaveRubricResult } from './RubricEditor';
import type { MarkingRubric } from './rubric';
import { assertAccessible, renderAudited } from './workspaceHarness';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

const setup = async (
  rubric: MarkingRubric = ESSAY_RUBRIC,
  respond: () => Promise<SaveRubricResult> = () => Promise.resolve({ ok: true }),
) => {
  const saved: MarkingRubric[] = [];
  const rendered = await renderAudited(
    <RubricEditor
      rubric={rubric}
      onSave={(next) => {
        saved.push(next);
        return respond();
      }}
    />,
  );
  return { saved, user: userEvent.setup(), ...rendered };
};

const band = (position: number): HTMLElement =>
  screen.getByRole('group', { name: `Band ${String(position)}` });
const descriptors = (): readonly string[] =>
  screen
    .getAllByRole('textbox', { name: 'What earns this band' })
    .map((field) => (field as HTMLTextAreaElement).value);

describe('as DRAWN', () => {
  it('draws each band as a named group with three labelled fields', async () => {
    await setup();
    expect(screen.getAllByRole('group')).toHaveLength(3);
    const first = within(band(1));
    expect((first.getByRole('textbox', { name: 'Marks' }) as HTMLInputElement).value).toBe('5');
    expect(
      (first.getByRole('textbox', { name: 'What earns this band' }) as HTMLTextAreaElement).value,
    ).toBe('names both forces and links them to the acceleration');
    expect(
      (
        first.getByRole('textbox', {
          name: 'Comment prefilled when this band is applied',
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Both forces are named and linked to the acceleration.');
  });

  it('states the bound with the question’s own maximum, and that editing does not regrade', async () => {
    await setup();
    expect(screen.getByText(rubricBound(5))).toBeDefined();
    expect(screen.getByText(RUBRIC_DOES_NOT_REGRADE)).toBeDefined();
  });

  it('ties the "write about the answer" hint to every comment field, so it is read with the field', async () => {
    const { container } = await setup();
    for (const field of screen.getAllByRole('textbox', {
      name: 'Comment prefilled when this band is applied',
    })) {
      const describedBy = field.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(container.querySelector(`[id="${String(describedBy)}"]`)?.textContent).toBe(
        BAND_COMMENT_HINT,
      );
    }
  });

  it('switches the grading shortcut keys off for everything inside it', async () => {
    await setup();
    for (const control of screen.getAllByRole('button')) {
      expect(
        control.closest(`[${KEYS_OFF_ATTRIBUTE}="off"]`),
        control.textContent ?? '',
      ).not.toBeNull();
    }
  });

  it('says so when the question has no bands, rather than drawing an empty list', async () => {
    await setup({ ...ESSAY_RUBRIC, bands: [] });
    expect(screen.getByText(RUBRIC_EMPTY)).toBeDefined();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });
});

describe('the bound, as TYPED', () => {
  it('REFUSES to save a negative band, leaves the typed value in the field, and says why next to it', async () => {
    const { user, saved, container } = await setup();
    const marks = within(band(3)).getByRole('textbox', { name: 'Marks' });
    await user.clear(marks);
    await user.type(marks, '-2');

    // NOT corrected to 0: the field holds what was typed.
    expect((marks as HTMLInputElement).value).toBe('-2');
    expect(marks.getAttribute('aria-invalid')).toBe('true');
    const issues = container.querySelector(
      `[id="${String(marks.getAttribute('aria-describedby'))}"]`,
    );
    expect(issues?.textContent).toContain('A mark cannot be below 0');

    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe(RUBRIC_BLOCKED);
    await assertAccessible(container);
  });

  it('REFUSES a band worth more than the question, and text that is not a number', async () => {
    const { user, saved } = await setup();
    const marks = within(band(1)).getByRole('textbox', { name: 'Marks' });
    await user.clear(marks);
    await user.type(marks, '6');
    expect(
      within(band(1)).getByText('This question is worth 5. A mark cannot be above that.'),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));

    await user.clear(marks);
    await user.type(marks, 'lots');
    expect(within(band(1)).getByText('A mark has to be a number.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));

    expect(saved).toEqual([]);
  });

  it('keeps a half-typed number as typed, so "2." can become "2.5"', async () => {
    const { user, saved } = await setup();
    const marks = within(band(2)).getByRole('textbox', { name: 'Marks' });
    await user.clear(marks);
    await user.type(marks, '2.');
    expect((marks as HTMLInputElement).value).toBe('2.');
    await user.type(marks, '5');
    expect((marks as HTMLInputElement).value).toBe('2.5');

    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.bands[1]?.points).toBe(2.5);
  });

  it('REFUSES a band with its descriptor deleted', async () => {
    const { user, saved } = await setup();
    await user.clear(within(band(2)).getByRole('textbox', { name: 'What earns this band' }));
    expect(
      within(band(2)).getByText('Say what an answer has to do to earn this band.'),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toEqual([]);
  });

  it('SAVES with only an advisory standing, and shows the advisory', async () => {
    const { user, saved } = await setup();
    const marks = within(band(1)).getByRole('textbox', { name: 'Marks' });
    await user.clear(marks);
    await user.type(marks, '4');
    expect(
      screen.getByText(
        'No band awards the full 5. Full marks can still be typed into the mark field.',
      ),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.bands.map((b) => b.points)).toEqual([4, 2, 0]);
  });
});

describe('saving', () => {
  it('sends exactly what was edited, and only then says it is saved', async () => {
    const { user, saved } = await setup();
    const comment = within(band(3)).getByRole('textbox', {
      name: 'Comment prefilled when this band is applied',
    });
    await user.type(comment, 'No force is identified in the answer.');
    expect(screen.getByText(RUBRIC_UNSAVED)).toBeDefined();
    expect(screen.queryByText(RUBRIC_SAVED)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toEqual([
      {
        ...ESSAY_RUBRIC,
        bands: [
          ESSAY_RUBRIC.bands[0],
          ESSAY_RUBRIC.bands[1],
          { ...ESSAY_RUBRIC.bands[2], feedback: 'No force is identified in the answer.' },
        ],
      },
    ]);
    expect(await screen.findByText(RUBRIC_SAVED)).toBeDefined();
  });

  it('says a save FAILED, in an alert, and never says saved', async () => {
    const { user } = await setup(ESSAY_RUBRIC, () =>
      Promise.resolve({ ok: false, reason: 'someone else changed this rubric' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The rubric was not saved: someone else changed this rubric.',
    );
    expect(screen.queryByText(RUBRIC_SAVED)).toBeNull();
  });

  it('treats a rejected request as a failure, not as nothing', async () => {
    const { user } = await setup(ESSAY_RUBRIC, () => Promise.reject(new Error('offline')));
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The rubric was not saved: the request did not complete.',
    );
  });

  it('goes back to "not saved" the moment something is edited after a save', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(await screen.findByText(RUBRIC_SAVED)).toBeDefined();
    await user.type(within(band(1)).getByRole('textbox', { name: 'What earns this band' }), '!');
    expect(screen.queryByText(RUBRIC_SAVED)).toBeNull();
    expect(screen.getByText(RUBRIC_UNSAVED)).toBeDefined();
  });
});

describe('reordering, by keyboard, with focus kept', () => {
  it('moves a band up with the keyboard alone, and focus stays on that band’s own button', async () => {
    const { user } = await setup();
    const moveUp = screen.getByRole('button', { name: 'Move band 3 up' });
    moveUp.focus();
    await user.keyboard('{Enter}');

    expect(descriptors()).toEqual([
      'names both forces and links them to the acceleration',
      'names no force',
      'names one force',
    ]);
    // The band is now second, its button is renamed, and it still has focus -- so a second Enter moves it again.
    const active = document.activeElement as HTMLElement;
    expect(active.textContent).toBe('Move band 2 up');
    expect(active).not.toBe(document.body);
    expect(screen.getByText('Band 3 is now band 2.')).toBeDefined();

    await user.keyboard('{Enter}');
    expect(descriptors()[0]).toBe('names no force');
    expect((document.activeElement as HTMLElement).textContent).toBe('Move band 1 up');
  });

  it('does not lose focus at the top: the button stays focusable, nothing moves, and it says so', async () => {
    const { user } = await setup();
    const moveUp = screen.getByRole('button', { name: 'Move band 1 up' });
    // `aria-disabled`, not `disabled`: a focused button that becomes disabled drops focus to the page.
    expect(moveUp.getAttribute('aria-disabled')).toBe('true');
    expect(moveUp.hasAttribute('disabled')).toBe(false);
    moveUp.focus();
    await user.keyboard('{Enter}');
    expect(descriptors()).toEqual(ESSAY_RUBRIC.bands.map((b) => b.descriptor));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move band 1 up' }));
    expect(screen.getByText('Band 1 is already first.')).toBeDefined();
    // A move that did not happen is not an unsaved change.
    expect(screen.queryByText(RUBRIC_UNSAVED)).toBeNull();
  });

  it('saves the bands in the order they were moved to', async () => {
    const { user, saved } = await setup();
    await user.click(screen.getByRole('button', { name: 'Move band 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved[0]?.bands.map((b) => b.id)).toEqual(['band-2', 'band-1', 'band-3']);
  });
});

describe('adding and removing, with focus kept', () => {
  it('adds a band worth 0 and puts focus in its descriptor, which is the thing to type next', async () => {
    const { user, container } = await setup();
    await user.click(screen.getByRole('button', { name: 'Add a band' }));
    expect(screen.getAllByRole('group')).toHaveLength(4);
    const descriptor = within(band(4)).getByRole('textbox', { name: 'What earns this band' });
    expect(document.activeElement).toBe(descriptor);
    expect(
      (within(band(4)).getByRole('textbox', { name: 'Marks' }) as HTMLInputElement).value,
    ).toBe('0');
    await assertAccessible(container);
  });

  it('will not save a band that was added and left undescribed', async () => {
    const { user, saved } = await setup();
    await user.click(screen.getByRole('button', { name: 'Add a band' }));
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved).toEqual([]);
  });

  it('removes a band and moves focus to "Add a band", not to nowhere', async () => {
    const { user, saved } = await setup();
    const remove = screen.getByRole('button', { name: 'Remove band 2' });
    remove.focus();
    await user.keyboard('{Enter}');
    expect(descriptors()).toEqual([
      'names both forces and links them to the acceleration',
      'names no force',
    ]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a band' }));
    expect(screen.getByText('Band 2 removed.')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(saved[0]?.bands.map((b) => b.id)).toEqual(['band-1', 'band-3']);
  });
});
