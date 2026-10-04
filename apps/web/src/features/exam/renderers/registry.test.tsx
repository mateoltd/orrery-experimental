// @vitest-environment jsdom

/**
 * The registry's completeness tests.  (P7-T7)
 *
 * The mapped type in `registry.ts` already makes an unhandled type a COMPILE error, which is the strong guarantee. These
 * tests cover the two things the type system cannot:
 *
 * 1. that the registry's runtime keys match `QuestionTypes` -- a type system checks the annotation, not that the
 *    object literal was not edited down at runtime;
 * 2. that dispatch actually reaches a renderer for every type, so a wiring mistake surfaces here rather than as a
 *    student's blank page.
 */

import { QUESTION_TYPES } from '@orrery/contracts/question';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { QUESTION_RENDERERS, RENDERED_TYPES, renderQuestion } from './registry';

/** Referenced so the classic-runtime JSX requirement is a REAL use rather than a stripped import. */
void React;

afterEach(cleanup);

/** One renderable set of props per type, built from the union's own discriminants. */
const propsFor = (type: (typeof QUESTION_TYPES)[number]): Record<string, unknown> => {
  const base = { prompt: 'Question prompt.', disabled: false };
  switch (type) {
    case 'single_choice':
      return {
        ...base,
        spec: { type, choices: [{ id: 'a', text: 'A' }], key: { choiceId: 'a' } },
      };
    case 'true_false':
      return { ...base, spec: { type, key: { value: true } } };
    case 'multi_select':
      return {
        ...base,
        spec: { type, choices: [{ id: 'a', text: 'A' }], key: { choiceIds: ['a'] } },
      };
    case 'numeric':
      return { ...base, spec: { type, tolerance: { absolute: 0.1 } } };
    case 'short_text':
      return { ...base, spec: { type } };
    case 'ordering':
      return {
        ...base,
        spec: { type, items: [{ id: 'a', text: 'A' }], key: { itemIds: ['a'] } },
        value: ['a'],
        onChange: () => {},
      };
    case 'free_response':
      return { ...base, spec: { type, rubric: [] } };
    case 'file_submission':
      return { ...base, spec: { type }, onChange: () => {} };
    case 'simulation':
      return {
        ...base,
        spec: { type, simId: 'sim', simVersion: '1.0.0' },
        title: 'Sim',
        textAlternative: { shows: 's', task: 't', reportedIn: 'r' },
        onEngage: () => {},
      };
    case 'worked_solution':
      return { ...base, spec: { type, steps: [] } };
    default:
      throw new Error(`unhandled type in test: ${String(type)}`);
  }
};

describe('the registry', () => {
  it('has a renderer for EVERY type, with no extras and none missing', () => {
    expect([...RENDERED_TYPES].sort()).toEqual([...QUESTION_TYPES].sort());
  });

  it('resolves every type to a real component, not undefined', () => {
    for (const type of QUESTION_TYPES) {
      expect(QUESTION_RENDERERS[type], `no renderer for ${type}`).toBeTypeOf('function');
    }
  });

  it('reuses one component for the two multi-choice types and one for the two text types', () => {
    /**
     * `multi_select` and `true_false` are both "a fieldset of checkboxes"; `numeric` and `short_text` differ only in
     * element and `inputMode`. Ten components would be ten places for the same a11y bug to be fixed once.
     *
     * `true_false` is deliberately NOT `SingleChoiceQuestion`, even though "they are both choice questions" sounds
     * right. `SingleChoiceProps.spec` is typed `SingleChoiceSpec`, so the mapped type refuses that mapping outright.
     * Had the annotation been looser it would have been a runtime crash instead: `TrueFalseSpec` has no `choices`, so
     * `spec.choices.map` throws on the first render.
     */
    expect(QUESTION_RENDERERS.multi_select).toBe(QUESTION_RENDERERS.true_false);
    expect(QUESTION_RENDERERS.numeric).toBe(QUESTION_RENDERERS.short_text);
    expect(QUESTION_RENDERERS.true_false).not.toBe(QUESTION_RENDERERS.single_choice);
  });

  it('DISPATCHES every type to something rendered, so a wiring slip is not a blank question', () => {
    for (const type of QUESTION_TYPES) {
      const element = renderQuestion(propsFor(type) as never);
      const { container, unmount } = render(element);
      // Something was actually drawn: a rendered comment node or an empty container would pass a bare "did not throw".
      expect(container.innerHTML.length, `nothing rendered for ${type}`).toBeGreaterThan(0);
      unmount();
    }
  });

  it('dispatches `numeric` and `short_text` to different ELEMENTS, which is why they share a component', () => {
    const numeric = render(renderQuestion(propsFor('numeric') as never));
    expect(numeric.container.querySelector('input')).not.toBeNull();
    expect(numeric.container.querySelector('textarea')).toBeNull();
    numeric.unmount();

    const shortText = render(renderQuestion(propsFor('short_text') as never));
    expect(shortText.container.querySelector('textarea')).not.toBeNull();
    expect(shortText.container.querySelector('input')).toBeNull();
  });

  it('renders the simulation through the registry with its text alternative intact', () => {
    render(renderQuestion(propsFor('simulation') as never));
    // The registry must not drop the type-specific props; the text alternative is the whole question for a blind
    // student, and it is the easiest required field to lose in a dispatcher.
    expect(screen.getByText('What this shows')).toBeDefined();
    expect(screen.getByText('Where your answer is reported')).toBeDefined();
  });
});
