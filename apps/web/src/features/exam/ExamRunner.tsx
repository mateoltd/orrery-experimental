'use client';

/**
 * EXAM RUNNER: the composition P8-T17 exists to build.  (P8-T17)
 *
 * Loads nothing itself -- the server component hands it resolved `RunnerQuestion[]` -- and owns three
 * wirings that previously existed only as separate tested parts:
 *
 *   1. **questions -> registry**: every response renders through `renderQuestion`, so the registry's
 *      100%-covered-zero-caller status ends here. Nothing renders except through the registry, and the
 *      registry's exhaustiveness check is what keeps a new question type from arriving as a blank.
 *   2. **answers -> store**: each renderer's `onChange` dispatches an `ANSWER` event into the reducer and
 *      enqueues a `QueuedWrite` with a client uuid, because `plans/01` §9.3 makes a duplicate key an
 *      idempotent SUCCESS and a retry must reuse it.
 *   3. **store -> server**: the IndexedDB outbox flushes through `POST /api/exam/answers`, which re-derives
 *      membership, revision and ledger state per write -- so the runner never sends a revision and never
 *      pre-checks anything the route owns. A 409 becomes a CONFLICT with the server's answer and revision
 *      (the reconcile dialog's input); anything else retryable becomes RETRY with the reason attached.
 *
 * ## SEVEN TYPES CAPTURE, THREE RENDER EXPLICITLY UNWIRED
 *
 * The per-type adapter below covers single_choice, true_false, multi_select, numeric, short_text,
 * ordering and free_response with the stored answer as `value`. Simulation, file_submission and
 * worked_solution render through the registry with `disabled` and an explicit notice: sim answer capture
 * needs the sim bridge and its bounded state save (B15), file capture needs upload infrastructure, and
 * worked_solution is reveal-only by design. **A dead control with no notice would be worse than the
 * notice; a silent gap is how P8 read 17/17 with no runner.**
 *
 * ## NO CASTS ACROSS THE REGISTRY BOUNDARY
 *
 * Each adapter arm constructs its renderer's exact props, so a renderer whose props change breaks this
 * file at compile time rather than at a student's desk. The first version of this file cast a uniform
 * object `as QuestionRenderProps` -- which compiled while meaning nothing, because the cast silenced the
 * very exhaustiveness the registry exists to provide.
 */

import type { ExamPolicy } from '@orrery/contracts/policy';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { RunnerQuestion } from '@/server/exam-runner.js';
import {
  type AttemptState,
  initialAttemptState,
  type QueuedWrite,
  reduceAttempt,
} from './answerStore.js';
import { flush, type OutboxStore, type WriteOutcome } from './outbox.js';
import { indexedDbOutboxStore } from './outboxIndexedDb.js';
import type { ChoiceGroupProps } from './renderers/ChoiceGroupQuestion.js';
import type { FreeResponseProps } from './renderers/FreeResponseQuestion.js';
import type { OrderingProps } from './renderers/OrderingQuestion.js';
import { renderQuestion } from './renderers/registry.js';
import type { SingleChoiceProps } from './renderers/SingleChoiceQuestion.js';
import type { TextFieldProps } from './renderers/TextFieldQuestion.js';
import { palette } from './ux/palette.js';

export interface ExamRunnerProps {
  readonly attemptId: string;
  readonly policy: ExamPolicy;
  readonly questions: readonly RunnerQuestion[];
  /**
   * Injected for tests: the production store is IndexedDB (durable across reloads, which is the
   * whole point of the outbox), but jsdom has no IndexedDB and adding a fake would test the fake.
   * The default is the real store; a test passes `memoryOutboxStore()`.
   */
  readonly store?: OutboxStore;
}

function answerPayload(type: string, value: unknown): unknown {
  switch (type) {
    case 'single_choice':
    case 'true_false':
    case 'numeric':
    case 'short_text':
    case 'free_response':
      return typeof value === 'string' ? value : '';
    case 'multi_select':
    case 'ordering':
      return Array.isArray(value) ? value : [];
    default:
      return value;
  }
}

function storedAnswer(question: RunnerQuestion, state: AttemptState): unknown {
  // The REDUCER's answer, not the server snapshot's: the snapshot is what the paper opened with, and
  // rendering from it means the UI never reflects what the student just did -- the probe showed a radio
  // staying unchecked after click. The snapshot seeds the reducer at mount (see initialAttemptState);
  // after that the reducer is the truth.
  if (question.questionId in state.answers) return state.answers[question.questionId];
  return question.answer ?? null;
}

export function ExamRunner(props: ExamRunnerProps): React.ReactElement {
  const slots = useMemo(
    () =>
      props.questions.map((question) => ({
        questionId: question.questionId,
        questionDeadlineAt: null,
      })),
    [props.questions],
  );
  const [state, dispatch] = useReducer(
    reduceAttempt,
    { attemptId: props.attemptId, policy: props.policy, slots, deadlineAt: null },
    initialAttemptState,
  );
  // A lazy initializer so the store is created once: `useState(() => ...)` runs the function only on
  // mount, and an IndexedDB handle created per render would leak a connection per keystroke.
  const [store] = useState<OutboxStore>(
    () => props.store ?? (indexedDbOutboxStore() as unknown as OutboxStore),
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const attemptRef = useRef(props.attemptId);
  attemptRef.current = props.attemptId;

  const pump = useCallback(async (): Promise<void> => {
    const send = async (write: QueuedWrite): Promise<WriteOutcome> => {
      let response: Response;
      try {
        response = await fetch('/api/exam/answers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            attemptId: attemptRef.current,
            questionId: write.questionId,
            answer: write.answer,
            idempotencyKey: write.idempotencyKey,
          }),
        });
      } catch (error) {
        return {
          kind: 'RETRY',
          message: error instanceof Error ? error.message : 'network failure',
        };
      }
      if (response.ok) return { kind: 'ACK' };
      if (response.status === 409) {
        try {
          const body = (await response.json()) as { answer?: unknown; revision?: unknown };
          if ('revision' in body && typeof body.revision === 'number') {
            return {
              kind: 'CONFLICT',
              serverAnswer: body.answer ?? null,
              serverRevision: body.revision,
            };
          }
        } catch {
          // A 409 whose body is unreadable is still a conflict only if it says what the server
          // holds; otherwise it is a retry, because guessing at reconciliation is how answers are lost.
        }
        return {
          kind: 'RETRY',
          message: `conflict without a server revision (status ${String(response.status)})`,
        };
      }
      return { kind: 'RETRY', message: `status ${String(response.status)}` };
    };
    const result = await flush(store, send);
    setSaveState(result.kind === 'DRAINED' || result.kind === 'NOTHING_TO_DO' ? 'saved' : 'saving');
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    if (!cancelled) void pump();
    return () => {
      cancelled = true;
    };
  }, [pump]);

  const answer = (question: RunnerQuestion, value: unknown): void => {
    const idempotencyKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${String(Date.now())}-${question.questionId}`;
    const payload = answerPayload(question.spec.type, value);
    dispatch({
      type: 'ANSWER',
      questionId: question.questionId,
      answer: payload,
      idempotencyKey,
      at: Date.now(),
    });
    // Sequenced AFTER the put resolves, not merely after it is called: `outboxOver.put`
    // serializes through a promise chain, so the write lands asynchronously even for the memory plug.
    // Pumping before it lands flushes an empty queue and reports success -- the answer would then sit
    // until something else re-rendered, which in production is an answer lost to a fast navigation.
    // The mounting test caught exactly this: the POST never fired.
    void store
      .put({
        seq: 0,
        questionId: question.questionId,
        answer: payload,
        revision: question.revision,
        idempotencyKey,
        issuedAt: Date.now(),
      })
      .then(() => void pump());
  };

  const items = palette(state, Date.now());

  return (
    <div data-testid="exam-runner" data-save-state={saveState}>
      <ol>
        {props.questions.map((question) => (
          <li key={question.questionId}>{renderRunnerQuestion(question, state, answer)}</li>
        ))}
      </ol>
      <nav aria-label="Questions">
        {items.entries.map((entry) => (
          <span key={entry.questionId} data-status={entry.status}>
            {entry.index + 1}
          </span>
        ))}
      </nav>
    </div>
  );
}

function renderRunnerQuestion(
  question: RunnerQuestion,
  state: AttemptState,
  answer: (question: RunnerQuestion, value: unknown) => void,
): React.ReactElement {
  const { spec, prompt } = question;
  const value = storedAnswer(question, state);
  // Each arm annotates its EXACT props, so a renderer whose props change breaks this file rather
  // than falling back to untyped callbacks. The union argument to `renderQuestion` cannot narrow
  // contextual types, which is why the annotation lives on the object, not on the call.
  switch (spec.type) {
    case 'single_choice': {
      const props: SingleChoiceProps = {
        spec,
        prompt,
        value: typeof value === 'string' ? value : null,
        onChange: (choiceId: string) => answer(question, choiceId),
      };
      return renderQuestion(props);
    }
    case 'true_false':
    case 'multi_select': {
      const props: ChoiceGroupProps = {
        spec,
        prompt,
        value: Array.isArray(value) ? (value as readonly string[]) : [],
        onChange: (choiceIds: readonly string[]) => answer(question, choiceIds),
      };
      return renderQuestion(props);
    }
    case 'numeric':
    case 'short_text': {
      const props: TextFieldProps = {
        spec,
        prompt,
        value: typeof value === 'string' ? value : '',
        onChange: (raw: string) => answer(question, raw),
      };
      return renderQuestion(props);
    }
    case 'free_response': {
      const props: FreeResponseProps = {
        spec,
        prompt,
        value: typeof value === 'string' ? value : '',
        onChange: (raw: string) => answer(question, raw),
      };
      return renderQuestion(props);
    }
    case 'ordering': {
      const props: OrderingProps = {
        spec,
        prompt,
        value: Array.isArray(value) ? (value as readonly string[]) : [],
        onChange: (itemIds: readonly string[]) => answer(question, itemIds),
      };
      return renderQuestion(props);
    }
    case 'simulation': {
      const sim = question.sim;
      // Unreachable when the loader did its job: it refuses papers with unresolvable sim extras.
      // The fallback renders the frame's absence as a message rather than crashing the paper.
      if (sim === undefined) {
        return (
          <p role="note">
            This simulation question cannot be displayed: its text alternative is missing.
          </p>
        );
      }
      return (
        <>
          {renderQuestion({
            spec,
            prompt,
            title: sim.title,
            textAlternative: sim.textAlternative,
            onEngage: () => {},
            disabled: true,
          })}
          <p role="note">Answer capture for this question type is not yet wired in the runner.</p>
        </>
      );
    }
    case 'file_submission':
      return (
        <>
          {renderQuestion({ spec, prompt, value: [], onChange: () => {}, disabled: true })}
          <p role="note">Answer capture for this question type is not yet wired in the runner.</p>
        </>
      );
    case 'worked_solution':
      return renderQuestion({ spec, prompt, answered: false, disabled: true });
  }
}
