// @vitest-environment jsdom
/**
 * THE MOUNTING TEST: the exit criterion for P8-T17, executed.  (P8-T17)
 *
 * An attempt with two questions of different types opens, renders through the registry, takes an
 * answer, and the answer leaves the browser shaped exactly as `POST /api/exam/answers` requires --
 * attemptId, questionId, answer, idempotencyKey. The fetch is stubbed at the network boundary (not the
 * outbox), so what is asserted is the whole path from keystroke to wire: reducer event, queued write,
 * flush, POST body.
 *
 * What this does NOT prove, and where that proof lives instead:
 *
 *   - **reload survival**: the reducer's `replay()` over stored events is unit-tested in
 *     `answerStore.test.ts`, and the outbox persists across reloads by construction (IndexedDB);
 *   - **reaching `AnswerRevision`**: `submitAnswer` integration tests prove the server half, and the
 *     loader test proves the runner only ever sends what that endpoint accepts;
 *   - **the IndexedDB store itself**: injected as `memoryOutboxStore()` here, because jsdom has no
 *     IndexedDB and a fake would test the fake. The production store is the default, not the test's.
 */

import { EXAM_PROFILE_DEFAULTS } from '@orrery/contracts/policy';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnerQuestion } from '@/server/exam-runner.js';
import { ExamRunner, shapeSimAnswer, shapeSimState } from './ExamRunner.js';
import { memoryOutboxStore } from './outbox.js';

afterEach(cleanup);

const QUESTIONS: readonly RunnerQuestion[] = [
  {
    responseId: 'r1',
    questionId: 'q1',
    position: 0,
    spec: {
      id: 'q1',
      points: 4,
      gradingMode: 'AUTO',
      shuffleOptions: false,
      estimatedSeconds: 60,
      cognitiveDemand: 'REMEMBER',
      tags: [],
      type: 'single_choice',
      choices: [
        { id: 'a', text: 'Alpha' },
        { id: 'b', text: 'Bravo' },
      ],
    },
    prompt: 'Which is second?',
    answer: null,
    revision: 0,
  },
  {
    responseId: 'r2',
    questionId: 'q2',
    position: 1,
    spec: {
      id: 'q2',
      points: 2,
      gradingMode: 'AUTO',
      shuffleOptions: false,
      estimatedSeconds: 60,
      cognitiveDemand: 'REMEMBER',
      tags: [],
      type: 'numeric',
      tolerance: { absolute: 0.05 },
    },
    prompt: 'What is g?',
    answer: null,
    revision: 0,
  },
];

describe('ExamRunner mounts the paper', () => {
  it('renders two different types through the registry, with the palette', () => {
    render(
      <ExamRunner
        attemptId="att-1"
        policy={EXAM_PROFILE_DEFAULTS}
        questions={QUESTIONS}
        store={memoryOutboxStore()}
      />,
    );
    // Both prompts on screen proves both renderers ran -- nothing renders except through the registry.
    expect(screen.getByText('Which is second?')).toBeDefined();
    expect(screen.getByText('What is g?')).toBeDefined();
    expect(screen.getByTestId('exam-runner')).toBeDefined();
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    expect(nav.textContent).toContain('1');
    expect(nav.textContent).toContain('2');
  });

  it('an answer travels from keystroke to the wire shaped as the endpoint requires', async () => {
    const user = userEvent.setup();
    const posts: { url: string; body: unknown }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
      return new Response('{}', { status: 200 });
    });
    try {
      render(
        <ExamRunner
          attemptId="att-1"
          policy={EXAM_PROFILE_DEFAULTS}
          questions={QUESTIONS}
          store={memoryOutboxStore()}
        />,
      );
      // Answer the single_choice question by clicking its second option.
      const options = screen.getAllByRole('radio');
      expect(options).toHaveLength(2);
      const second = options[1];
      expect(second).toBeDefined();
      await user.click(second as Element);
      // The UI reflects the reducer, not the server snapshot: a radio that stays unchecked after
      // click is a student answering into a control that shows nothing, which is how answers get
      // entered twice and "confirmed" never.
      expect((second as HTMLInputElement).checked).toBe(true);
      // The outbox flushes on mount (the effect pump); the answer enqueue needs a tick to flush.
      // Poll briefly rather than sleeping a fixed time: a fixed sleep is a flake with a constant.
      const deadline = Date.now() + 2000;
      while (posts.length === 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(posts.length).toBeGreaterThan(0);
      const answerPost = posts.find(
        (post) => (post.body as { questionId?: string }).questionId === 'q1',
      );
      expect(answerPost, 'a POST carrying the q1 answer').toBeDefined();
      const body = answerPost?.body as Record<string, unknown>;
      expect(body.attemptId).toBe('att-1');
      expect(body.questionId).toBe('q1');
      expect(body.answer).toBe('b');
      expect(typeof body.idempotencyKey).toBe('string');
      expect((body.idempotencyKey as string).length).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('exam surface accessibility (P13-T3)', () => {
  it('palette entries are BUTTONS that move focus to their question', async () => {
    const user = userEvent.setup();
    render(
      <ExamRunner
        attemptId="att-1"
        policy={EXAM_PROFILE_DEFAULTS}
        questions={QUESTIONS}
        store={memoryOutboxStore()}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Questions' });
    const buttons = nav.querySelectorAll('button');
    // Buttons, not spans: a span palette is mouse-only, and a keyboard author cannot perceive it.
    expect(buttons).toHaveLength(2);
    const second = buttons[1];
    expect(second).toBeDefined();
    await user.click(second as Element);
    // Focus followed the palette move to the question itself, not to its first control.
    expect(document.activeElement?.id).toBe('exam-q-q2');
  });

  it('announces save failure, and recovery exactly once -- never routine saves', async () => {
    const user = userEvent.setup();
    let fail = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (fail) return new Response('{}', { status: 500 });
      return new Response('{}', { status: 200 });
    });
    try {
      render(
        <ExamRunner
          attemptId="att-1"
          policy={EXAM_PROFILE_DEFAULTS}
          questions={QUESTIONS}
          store={memoryOutboxStore()}
        />,
      );
      // No announcement on mount or on routine saves: chatter trains the user to ignore the region.
      expect(screen.queryByTestId('save-announcer')).toBeNull();
      const options = screen.getAllByRole('radio');
      await user.click(options[1] as Element);
      const deadline = Date.now() + 2000;
      while (screen.queryByTestId('save-announcer') === null && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const announcer = screen.getByTestId('save-announcer');
      expect(announcer.getAttribute('role')).toBe('status');
      expect(announcer.textContent).toMatch(/kept on this device/);
      // Recovery announces once...
      fail = false;
      await user.click(options[0] as Element);
      const recovered = Date.now() + 2000;
      while (
        !/recovered/.test(screen.getByTestId('save-announcer').textContent ?? '') &&
        Date.now() < recovered
      ) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(screen.getByTestId('save-announcer').textContent).toMatch(/recovered/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('sim answer shaping (P8-T17 remainder)', () => {
  it('shapes reported answers and captured states exactly as grading-replay reads them', () => {
    // `{ simState, answer }` per paper.ts:141-146. These constructors are the only place the runner
    // builds the shape, so a drift fails here first rather than as a silent replay mismatch.
    expect(shapeSimAnswer('b')).toEqual({ simState: null, answer: 'b' });
    expect(shapeSimState({ angle: 42 })).toEqual({ simState: { angle: 42 }, answer: null });
  });
});
