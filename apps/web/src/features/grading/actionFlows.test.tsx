import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegradePreview as RegradePlan } from '../../../../../packages/db/src/grading-regrade.js';
import { BulkGradingActions } from './BulkGradingActions';
import { RegradePreview } from './RegradePreview';
import { assertAccessible } from './workspaceHarness';

afterEach(cleanup);
const targets = [{ attemptId: 'paper', responseId: 'response', basedOn: '1' }];
const apply = () => screen.getByRole('button', { name: 'Apply to 1 paper(s)' });
describe('bulk actions', () => {
  it('refuses void without a reason or human decision, then sends the exact selection and recorded context', async () => {
    const onApply = vi.fn(async () => ({ ok: true }));
    const mounted = render(<BulkGradingActions targets={targets} onApply={onApply} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
      target: { value: 'VOID' },
    });
    fireEvent.click(apply());
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Evidence upheld' },
    });
    fireEvent.click(apply());
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I reviewed the evidence and uphold the integrity concern',
      }),
    );
    fireEvent.click(apply());
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        targets,
        releaseBatchId: undefined,
        action: {
          kind: 'VOID',
          reason: 'Evidence upheld',
          humanConfirmed: true,
          consideredAccessibilityContext: false,
        },
      }),
    );
    await assertAccessible(mounted.container);
  });
  it('a human decision does not carry to a changed selection or response version', () => {
    const onApply = vi.fn(async () => ({ ok: true }));
    const mounted = render(<BulkGradingActions targets={targets} onApply={onApply} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
      target: { value: 'VOID' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Evidence upheld' },
    });
    const checkbox = screen.getByRole('checkbox', {
      name: 'I reviewed the evidence and uphold the integrity concern',
    });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    mounted.rerender(
      <BulkGradingActions
        targets={[{ attemptId: 'different', responseId: 'different-response', basedOn: '2' }]}
        onApply={onApply}
      />,
    );
    expect(checkbox).not.toBeChecked();
    fireEvent.click(apply());
    expect(onApply).not.toHaveBeenCalled();
  });
  it('release carries a reason and the selected batch; rejection makes no success claim', async () => {
    const onApply = vi.fn(async () => ({
      ok: false,
      reason: 'The selection differs from the batch',
    }));
    render(<BulkGradingActions targets={targets} releaseBatchId="batch" onApply={onApply} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
      target: { value: 'RELEASE' },
    });
    fireEvent.click(apply());
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Review complete' },
    });
    fireEvent.click(apply());
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        targets,
        releaseBatchId: 'batch',
        action: { kind: 'RELEASE', reason: 'Review complete' },
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('selection differs');
  });
  it('feedback carries visibility and refuses an empty comment', async () => {
    const onApply = vi.fn(async () => ({ ok: true }));
    render(<BulkGradingActions targets={targets} onApply={onApply} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
      target: { value: 'FEEDBACK' },
    });
    fireEvent.click(apply());
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Feedback for the selection' }), {
      target: { value: 'Please show working' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Who can read this feedback' }), {
      target: { value: 'TEACHER_ONLY' },
    });
    fireEvent.click(apply());
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          action: {
            kind: 'FEEDBACK',
            body: 'Please show working',
            visibility: 'TEACHER_ONLY',
            isDraft: false,
          },
        }),
      ),
    );
  });
});
const preview: RegradePlan = {
  token: 'preview-token',
  request: { assignmentId: 'assignment', actorId: 'teacher', reason: 'Corrected key' },
  affectedCount: 1,
  alreadyReleasedCount: 1,
  batches: [{ id: 'batch', status: 'RELEASED', members: ['paper'] }],
  attempts: [
    {
      attemptId: 'paper',
      studentId: 'student',
      released: true,
      changes: [],
      before: { finalScore: 20, percentage: 0.2, maxScore: 5 },
      after: {
        rawTotal: 3,
        maxTotal: 5,
        percentage: 0.6,
        finalScore: 60,
        lateFactor: 1,
        latePenaltyApplied: 0,
        isProvisional: false,
      },
      delta: 40,
    },
  ],
};
describe('regrade dry run', () => {
  it('shows old/new/delta/released count/reason and confirms the displayed token exactly once', async () => {
    let finish: (value: { ok: boolean }) => void = () => {
      throw new Error('Uninitialized');
    };
    const onConfirm = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = render(
      <RegradePreview
        preview={preview}
        paperLabels={{ paper: 'Candidate 14' }}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('table')).toHaveTextContent('Candidate 14');
    expect(screen.getByRole('table')).toHaveTextContent('20');
    expect(screen.getByRole('table')).toHaveTextContent('60');
    expect(screen.getByRole('table')).toHaveTextContent('+40');
    expect(screen.getByText(/1 already released/)).toBeInTheDocument();
    expect(screen.getByText('Reason: Corrected key')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Confirm this regrade' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(preview);
    finish({ ok: true });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('accepted'));
    await assertAccessible(mounted.container);
  });
  it('a stale preview rejection requests a new dry run and never reports acceptance', async () => {
    render(
      <RegradePreview
        preview={preview}
        onConfirm={async () => ({ ok: false, reason: 'Preview stale: review a fresh dry run' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this regrade' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('fresh dry run'));
    expect(screen.getByRole('status')).not.toHaveTextContent('accepted');
  });
  it('an acknowledgement for an older preview does not label a refreshed preview as accepted', async () => {
    let finish: (value: { ok: boolean }) => void = () => {
      throw new Error('Uninitialized');
    };
    const mounted = render(
      <RegradePreview
        preview={preview}
        onConfirm={() =>
          new Promise((resolve) => {
            finish = resolve;
          })
        }
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this regrade' }));
    mounted.rerender(
      <RegradePreview
        preview={{ ...preview, token: 'new-preview' }}
        onConfirm={async () => ({ ok: true })}
      />,
    );
    finish({ ok: true });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Previous preview: Regrade request accepted.',
      ),
    );
  });
  it('an unchanged regrade cannot be confirmed', () => {
    const onConfirm = vi.fn(async () => ({ ok: true }));
    render(<RegradePreview preview={{ ...preview, affectedCount: 0 }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this regrade' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
