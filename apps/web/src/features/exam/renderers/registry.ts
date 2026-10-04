'use client';

/**
 * The renderer registry: a module keyed by `QuestionType`.  (P7-T7)
 *
 * ## NAMED `registry.ts`, NOT `index.ts`
 *
 * ADR-0016 forbids barrel files, and the first draft of this was `renderers/index.ts`. That is a barrel by another
 * name: it re-exports eight components so a caller can import the one it needs from a single path, which couples
 * every renderer to every other renderer's module graph -- and here it would couple the type-only consumers of
 * `QuestionType` to all eight components as well. An explicit `registry` subpath says what the module is for.
 *
 * ## WHY A REGISTRY AND NOT A `switch` SOMEWHERE ELSE
 *
 * Ten renderers with ten different prop shapes is exactly the situation where a `switch` grows quietly. A new
 * question type then compiles, renders nothing, and is discovered by a student as a blank page -- and nothing in the
 * type system says so, because the `switch` had no obligation to be exhaustive.
 *
 * `QUESTION_RENDERERS` is typed as a mapped type over `QuestionType`, so **adding a type to the union breaks the
 * build here** rather than in production. That is the whole point: `plans/01`'s `QUESTION_TYPES` is the single list of
 * what can exist, and this file is where a divergence from it becomes a compile error.
 *
 * `renderQuestion` then dispatches on the same union, and its `switch` carries no `default`: `never` in the default
 * branch means a type added to the union without a renderer is a type error, not a blank screen.
 */

import type { QuestionType } from '@orrery/contracts/question';
import * as React from 'react';

import { type ChoiceGroupProps, ChoiceGroupQuestion } from './ChoiceGroupQuestion';
import { type FileSubmissionProps, FileSubmissionQuestion } from './FileSubmissionQuestion';
import { type FreeResponseProps, FreeResponseQuestion } from './FreeResponseQuestion';
import { type OrderingProps, OrderingQuestion } from './OrderingQuestion';
import { type SimulationProps, SimulationQuestion } from './SimulationQuestion';
import { type SingleChoiceProps, SingleChoiceQuestion } from './SingleChoiceQuestion';
import { type TextFieldProps, TextFieldQuestion } from './TextFieldQuestion';
import { type WorkedSolutionProps, WorkedSolutionQuestion } from './WorkedSolutionQuestion';

/**
 * EVERY RENDERER'S PROPS, AS ONE DISCRIMINATED UNION.
 *
 * The union is discriminated on `spec.type`, which every spec carries, so `renderQuestion` can narrow to the exact
 * prop type and hand it to a component that accepts exactly that.
 */
export type QuestionRenderProps =
  | SingleChoiceProps
  | ChoiceGroupProps
  | TextFieldProps
  | OrderingProps
  | FreeResponseProps
  | FileSubmissionProps
  | SimulationProps
  | WorkedSolutionProps;

/**
 * The props a question of type `K` must be given.
 *
 * `Extract` on `spec.type` is what keeps `renderQuestion` honest: for `numeric` it yields `TextFieldProps`, and for
 * `simulation` it yields `SimulationProps`, so the simulation's mandatory `textAlternative` cannot be forgotten at a
 * call site that is only supplying a generic question.
 */
export type PropsFor<T extends QuestionType> = Extract<QuestionRenderProps, { spec: { type: T } }>;

/**
 * THE REGISTRY. Adding to `QuestionTypes` without adding here is a compile error.
 *
 * Two components serve two types each: `ChoiceGroupQuestion` draws `multi_select` and `true_false`, and
 * `TextFieldQuestion` draws `numeric` and `short_text`. Both groupings are real rather than convenient --
 * `multi_select`/`true_false` are both "a fieldset of checkboxes", and `numeric`/`short_text` differ only in element
 * and `inputMode`.
 *
 * **`true_false` IS `ChoiceGroupQuestion`, NOT `SingleChoiceQuestion`, and getting that wrong is not a type error.**
 * `SingleChoiceProps.spec` is `SingleChoiceSpec`, whose `type` is the literal `'single_choice'`, so
 * `PropsFor<'true_false'>` excludes it and the registry will not let you map `true_false` to it. That annotation is
 * what stops the mistake; the first draft of this file mapped `true_false` to `SingleChoiceQuestion` on the reasoning
 * that "they are both choice questions", and the mapped type rejected it immediately. Left alone it would have been a
 * runtime crash -- `TrueFalseSpec` has no `choices`, so `spec.choices.map` throws on the first render.
 */
export const QUESTION_RENDERERS: {
  readonly [K in QuestionType]: React.ComponentType<PropsFor<K>>;
} = {
  single_choice: SingleChoiceQuestion,
  true_false: ChoiceGroupQuestion,
  multi_select: ChoiceGroupQuestion,
  numeric: TextFieldQuestion,
  short_text: TextFieldQuestion,
  ordering: OrderingQuestion,
  free_response: FreeResponseQuestion,
  file_submission: FileSubmissionQuestion,
  simulation: SimulationQuestion,
  worked_solution: WorkedSolutionQuestion,
};

/** The types that have a renderer, in `QuestionTypes` order. Derived, so it cannot fall behind. */
export const RENDERED_TYPES = Object.keys(QUESTION_RENDERERS) as readonly QuestionType[];

/**
 * DISPATCH.
 *
 * The `default` branch narrows `props.spec.type` to `never`, which is what makes an unhandled type a compile error.
 * `React.createElement` is used rather than JSX so the registry lookup and the dispatch are the same expression -- a
 * `switch` returning JSX would have to name all ten components again, and the second list is the one that would rot.
 */
export function renderQuestion(props: QuestionRenderProps): React.ReactElement {
  const { type } = props.spec;

  /**
   * THE EXHAUSTIVENESS CHECK, SEPARATE FROM THE LOOKUP.
   *
   * `type` is destructured before the `switch` because inside the `default` branch TypeScript narrows `props` itself
   * to `never` -- so reading `props.spec.type` there is an error rather than the intended check. Narrowing a local is
   * what keeps the `never` assignment meaningful.
   *
   * `React.createElement` is used instead of JSX so the registry lookup and the dispatch are the same expression. A
   * `switch` returning JSX would have to name all ten components again, and that second list is the one that rots.
   */
  switch (type) {
    case 'single_choice':
    case 'true_false':
    case 'multi_select':
    case 'numeric':
    case 'short_text':
    case 'ordering':
    case 'free_response':
    case 'file_submission':
    case 'simulation':
    case 'worked_solution':
      break;
    default: {
      /**
       * `never` HERE IS THE POINT. Adding a member to `QuestionTypes` without a case above makes this assignment a
       * compile error, which is the difference between noticing at build time and shipping a blank question.
       */
      const exhaustive: never = type;
      throw new Error(`no renderer registered for question type: ${String(exhaustive)}`);
    }
  }

  /**
   * One documented cast, and it is the unavoidable one.
   *
   * Indexing the registry with the full `type` union yields a UNION of component types, and `createElement` cannot
   * pick an overload for a union of component types. Narrowing the union member by member instead would require
   * naming all ten components in this function as well -- reintroducing exactly the duplicate list the registry
   * exists to eliminate.
   *
   * It is sound because `type` has just been proven to cover every member of `QuestionTypes` and `props` is
   * discriminated on that same `spec.type`: the component selected is the one whose `spec.type` equals the props'
   * own. The registry's `Record<QuestionType, ...>` is what enforces that, and it is a compile error to get it wrong.
   */
  const Renderer = QUESTION_RENDERERS[type] as React.ComponentType<QuestionRenderProps>;
  return React.createElement(Renderer, props);
}
