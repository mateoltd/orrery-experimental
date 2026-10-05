import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ReleasedResults,
  sealedResults,
} from '../../../../../packages/db/dist/student-results.js';
import { resultsResponse } from './results-response';
import { StudentResultsView } from './StudentResultsView';

afterEach(cleanup);
const receipt = {
  attemptId: 'a',
  submittedAt: '2026-10-05T10:00:00.000Z',
  receiptHash: 'stored receipt hash',
  answers: [{ questionId: 'q', answer: 'My answer' }],
};
const question: ReleasedResults['questions'][number] = {
  questionId: 'q',
  position: 0,
  score: 2,
  max: 4,
  outcome: 'PARTIAL',
  feedback: ['Try drawing the forces'],
  correctAnswer: null,
};
const released: ReleasedResults = {
  state: 'RELEASED',
  receipt,
  releasedAt: '2026-10-05T12:00:00.000Z',
  breakdown: {
    rawTotal: 2,
    maxTotal: 4,
    percentage: 0.5,
    finalScore: 45,
    latePenaltyApplied: 0.1,
    provisional: false,
  },
  questions: [question],
  feedback: ['Good explanation'],
  regradeNotice: null,
  accommodationMarker: null,
};

describe('results view', () => {
  it('sealed rendering has only reassurance, submitted answers and the receipt', () => {
    render(<StudentResultsView results={sealedResults(receipt)} />);
    expect(screen.getByRole('status').textContent).toContain('teacher is reviewing');
    expect(screen.getByText('stored receipt hash')).toBeDefined();
    expect(screen.getByText('My answer')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Question outcomes' })).toBeNull();
    expect(screen.queryByText(/Correct answer|Late penalty|Marks awarded/)).toBeNull();
  });
  it('renders released outcomes, feedback, penalty and stored receipt without author-disallowed answers', () => {
    render(<StudentResultsView results={released} />);
    expect(screen.getByText('partial')).toBeDefined();
    expect(screen.getByText('Try drawing the forces')).toBeDefined();
    expect(screen.getByText('Good explanation')).toBeDefined();
    expect(screen.getByText('45.00%')).toBeDefined();
    expect(screen.getByText('stored receipt hash')).toBeDefined();
    expect(screen.queryByText(/Correct answer/)).toBeNull();
  });
  it('renders authorised model answers and a rights marker without attributing marks to accommodation', () => {
    render(
      <StudentResultsView
        results={{
          ...released,
          accommodationMarker:
            'An accommodation was in force for this attempt. Accommodations are a right.',
          questions: [{ ...question, correctAnswer: 'Both forces point inward' }],
        }}
      />,
    );
    expect(screen.getByText('Correct answer: Both forces point inward')).toBeDefined();
    expect(screen.getByText(/Accommodations are a right/)).toBeDefined();
  });
  it('labels unresolved marks provisional and zero-denominator results not applicable', () => {
    render(
      <StudentResultsView
        results={{
          ...released,
          breakdown: {
            ...released.breakdown,
            percentage: null,
            finalScore: null,
            provisional: true,
          },
          questions: [{ ...question, outcome: 'AWAITING_REVIEW', score: null }],
        }}
      />,
    );
    expect(screen.getByText('Not applicable (provisional)')).toBeDefined();
    expect(screen.getByText('Awaiting review')).toBeDefined();
  });
  it('status and cache headers depend only on ownership/release, never hidden marks', async () => {
    const sealed = resultsResponse(sealedResults(receipt));
    const visible = resultsResponse(released);
    expect(sealed.status).toBe(200);
    expect(visible.status).toBe(200);
    expect([...sealed.headers.entries()]).toEqual([...visible.headers.entries()]);
    expect(sealed.headers.get('cache-control')).toBe('private, no-store');
    const otherOwner = resultsResponse(null),
      missing = resultsResponse(null);
    expect(otherOwner.status).toBe(404);
    expect(await otherOwner.text()).toBe(await missing.text());
    expect(otherOwner.headers.get('cache-control')).toBe('private, no-store');
  });
});
