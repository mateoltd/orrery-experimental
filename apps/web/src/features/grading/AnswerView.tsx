'use client';

/**
 * The student's answer, as a teacher reads it.  (P9-T2)
 *
 * ## WHY THIS IS NOT THE EXAM RENDERER WITH `disabled`
 *
 * `features/exam/renderers` already draws all ten types, and each takes a `disabled` prop. Reusing them looks free
 * and is wrong for a marker: a disabled textarea is skipped by the tab order, cannot be scrolled from the keyboard,
 * is drawn at reduced contrast, and in several browsers cannot have its text selected. A teacher reading a 400-word
 * answer needs all four. So the answer is drawn as CONTENT -- paragraphs and lists -- not as a form with the
 * controls switched off.
 *
 * ## THREE THINGS THAT MUST NOT LOOK THE SAME
 *
 * A written answer, an empty answer, and something stored that is not an answer. `readAnswer` keeps them apart and
 * this component has a branch for each. The third is drawn EXACTLY AS STORED with a sentence saying the fault is the
 * platform's, because the alternative -- an empty pane -- tells a marker the student wrote nothing.
 *
 * ## EVERYTHING HERE IS A TEXT NODE
 *
 * Student answers, choice text and stored JSON are all rendered as React children. There is no `innerHTML` in this
 * lane: an answer is content written by whoever sat the paper, and a marking screen runs with a teacher's session.
 *
 * ## THE KEY IS SHOWN IN WORDS
 *
 * "selected" and "keyed answer" are text after each option, not a tick and a colour. `plans/15` rule 6: colour is
 * never the only signal -- and this screen uses none at all, so there is no green and red to read a judgement from.
 */

import type { TeacherQuestionSpec } from '@orrery/contracts/question';
import type * as React from 'react';

import {
  ANSWER_BLANK,
  ANSWER_NOT_REACHED,
  ANSWER_OMITTED,
  ANSWER_UNREADABLE,
  CHOICE_KEYED,
  CHOICE_SELECTED,
  FILES_NOTE,
  STEP_EMPTY,
  unknownChoice,
} from './copy';
import { answerPresenceOf, type ReadAnswer, type ResponseFacts, readAnswer } from './markingState';

/** Whitespace exactly as written: a student's line breaks are part of a worked answer. */
const AS_WRITTEN: React.CSSProperties = { whiteSpace: 'pre-wrap' };

const Stored = ({ text }: { readonly text: string }) => <pre style={AS_WRITTEN}>{text}</pre>;

const marks = (selected: boolean, keyed: boolean): string => {
  const parts = [selected ? CHOICE_SELECTED : null, keyed ? CHOICE_KEYED : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
};

const Choices = ({
  choices,
  selected,
  keyed,
}: {
  readonly choices: readonly { readonly id: string; readonly text: string }[];
  readonly selected: readonly string[];
  readonly keyed: readonly string[];
}) => {
  const known = new Set(choices.map((choice) => choice.id));
  // A selected id that is not one of the question's options is shown, not dropped: it means the stored answer and
  // the question disagree, and a marker should see that rather than a selection that looks smaller than it was.
  const strays = selected.filter((id) => !known.has(id));
  return (
    <>
      <ul>
        {choices.map((choice) => (
          <li key={choice.id}>
            {choice.text}
            {marks(selected.includes(choice.id), keyed.includes(choice.id))}
          </li>
        ))}
      </ul>
      {strays.map((id) => (
        <p key={id}>{unknownChoice(id)}</p>
      ))}
    </>
  );
};

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * THE ANSWER, per type. The `switch` has no `default` returning markup: an eleventh question type is a compile error
 * here, in the same way it is in the exam renderers' registry.
 */
const Written = ({
  spec,
  answer,
}: {
  readonly spec: TeacherQuestionSpec;
  readonly answer: Exclude<ReadAnswer, { kind: 'BLANK' | 'UNREADABLE' }>;
}): React.ReactElement => {
  switch (spec.type) {
    case 'single_choice':
      return (
        <Choices
          choices={spec.choices}
          selected={answer.kind === 'CHOICES' ? answer.selected : []}
          // The key is read defensively: a spec out of a JSON column can have a key that is not what the type says,
          // and that case is already reported as `KEY_UNREADABLE` rather than crashed on.
          keyed={typeof spec.key?.choiceId === 'string' ? [spec.key.choiceId] : []}
        />
      );
    case 'multi_select':
      return (
        <>
          <Choices
            choices={spec.choices}
            selected={answer.kind === 'CHOICES' ? answer.selected : []}
            keyed={stringList(spec.key?.choiceIds)}
          />
          <p>Scoring method: {spec.partialCredit}</p>
        </>
      );
    case 'true_false':
      return (
        <dl>
          <dt>Answered</dt>
          <dd>{answer.kind === 'BOOLEAN' ? (answer.value ? 'True' : 'False') : ''}</dd>
          <dt>Keyed answer</dt>
          <dd>{spec.key?.value === true ? 'True' : spec.key?.value === false ? 'False' : ''}</dd>
        </dl>
      );
    case 'numeric':
      return (
        <dl>
          <dt>Answered, as written</dt>
          <dd>
            {answer.kind === 'NUMBER' ? answer.written : ''}
            {answer.kind === 'NUMBER' && answer.unit !== null ? ` ${answer.unit}` : ''}
          </dd>
          <dt>Keyed answer</dt>
          <dd>
            {String(spec.key?.value ?? '')}
            {spec.key?.unit === undefined ? '' : ` ${spec.key.unit}`}
          </dd>
        </dl>
      );
    case 'short_text':
      return (
        <>
          <div style={AS_WRITTEN}>{answer.kind === 'TEXT' ? answer.text : ''}</div>
          <dl>
            <dt>Keyed answer</dt>
            <dd>{String(spec.key?.text ?? '')}</dd>
            <dt>Matched by</dt>
            <dd>{spec.matcher}</dd>
          </dl>
        </>
      );
    case 'free_response':
      return <div style={AS_WRITTEN}>{answer.kind === 'TEXT' ? answer.text : ''}</div>;
    case 'ordering': {
      const text = new Map(spec.items.map((item) => [item.id, item.text]));
      const order = answer.kind === 'ORDER' ? answer.itemIds : [];
      return (
        <>
          <p>Order given:</p>
          <ol>
            {order.map((id, position) => (
              // The position is part of the key because the same id twice is a possible (malformed) answer.
              <li key={`${String(position)}-${id}`}>{text.get(id) ?? unknownChoice(id)}</li>
            ))}
          </ol>
          <p>Keyed order:</p>
          <ol>
            {stringList(spec.key?.itemIds).map((id) => (
              <li key={id}>{text.get(id) ?? id}</li>
            ))}
          </ol>
        </>
      );
    }
    case 'file_submission':
      return (
        <>
          <ul>
            {(answer.kind === 'FILES' ? answer.assetIds : []).map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
          <p>{FILES_NOTE}</p>
        </>
      );
    case 'simulation':
      return (
        <>
          <p>Reported answer:</p>
          <Stored text={answer.kind === 'SIMULATION' ? answer.reported : ''} />
        </>
      );
    case 'worked_solution': {
      const steps = answer.kind === 'STEPS' ? answer.steps : [];
      return (
        <ol>
          {spec.steps.map((step, index) => {
            const written = steps[index] ?? '';
            return (
              <li key={step.id}>
                <p>
                  {step.prompt} (worth {String(step.points)})
                </p>
                {written.trim() === '' ? (
                  <p>{STEP_EMPTY}</p>
                ) : (
                  <div style={AS_WRITTEN}>{written}</div>
                )}
                {step.key === undefined ? null : <p>Keyed answer: {step.key.text}</p>}
              </li>
            );
          })}
          {/* Steps written beyond the question's own are shown, not dropped. */}
          {steps.slice(spec.steps.length).map((written, extra) => (
            <li key={`extra-${String(extra)}`}>
              <p>A step with no matching part of the question:</p>
              <div style={AS_WRITTEN}>{written}</div>
            </li>
          ))}
        </ol>
      );
    }
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
};

export function AnswerView({ facts }: { readonly facts: ResponseFacts }) {
  const presence = answerPresenceOf(facts);
  if (presence === 'NOT_REACHED') return <p>{ANSWER_NOT_REACHED}</p>;
  if (presence === 'OMITTED') return <p>{ANSWER_OMITTED}</p>;

  const answer = readAnswer(facts.spec, facts.answer);
  if (answer.kind === 'BLANK') return <p>{ANSWER_BLANK}</p>;
  if (answer.kind === 'UNREADABLE') {
    return (
      <>
        <p>{ANSWER_UNREADABLE}</p>
        <Stored text={answer.stored} />
      </>
    );
  }
  return <Written spec={facts.spec} answer={answer} />;
}
