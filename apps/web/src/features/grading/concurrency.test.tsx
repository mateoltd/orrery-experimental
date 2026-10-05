import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeGraders,
  adoptChanged,
  changedElsewhere,
  newestKnown,
  trackingDraftStore,
} from './concurrency';
import * as copy from './copy';
import type { DraftStore } from './draft';
import { EMPTY_DRAFT, memoryDraftStore } from './draft';
import { FeedbackEditor } from './FeedbackEditor';
import { essayAwaiting } from './fixtures';
import { type ConcurrentSaveResult, SafeGradingWorkspace } from './SafeGradingWorkspace';
import type { MarkSubmission } from './submission';
import { assertAccessible } from './workspaceHarness';

afterEach(cleanup);
const target = essayAwaiting({ version: '0' });
const saved = essayAwaiting({
  version: '1',
  needsHuman: false,
  manual: { points: 4, feedback: 'Other teacher', bandId: null },
});
const props = {
  attemptId: 'paper',
  candidateLabel: 'Candidate',
  graderId: 'me',
  store: memoryDraftStore(),
  now: () => 100,
  responses: [target],
  presence: [],
  focusOnOpen: false,
};
const typeMark = () => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Mark, out of 5' }), {
    target: { value: '2' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Feedback to the student' }), {
    target: { value: 'My feedback' },
  });
};
const saveButton = () =>
  screen.getByRole('button', { name: 'Save mark and go to the next response' });

describe('concurrent grading UI', () => {
  it('presence expires and excludes this grader without refusing marking', () => {
    const leases = [
      { graderId: 'me', name: 'Me', responseId: 'r', expiresAt: 999 },
      { graderId: 'other', name: 'Other', responseId: 'r', expiresAt: 100 },
    ];
    expect(activeGraders(leases, 'me', 99)).toHaveLength(1);
    expect(activeGraders(leases, 'me', 100)).toEqual([]);
  });
  it('a restored stale draft keeps its original version and must compare before replacing a saved mark', async () => {
    const store = memoryDraftStore();
    store.write(
      { graderId: 'me', attemptId: 'paper', responseId: target.responseId },
      {
        draft: { ...EMPTY_DRAFT, score: '2', feedback: 'Restored old draft' },
        keptAt: 99,
        basedOn: '0',
      },
    );
    const onSaveMark = vi.fn(
      async (): Promise<ConcurrentSaveResult> => ({
        ok: false,
        reason: 'Conflict',
        conflict: saved,
      }),
    );
    render(
      <SafeGradingWorkspace {...props} responses={[saved]} store={store} onSaveMark={onSaveMark} />,
    );
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('dialog');
    expect(onSaveMark).toHaveBeenCalledWith(
      expect.objectContaining({ basedOn: '0', points: 2, feedback: 'Restored old draft' }),
    );
    expect(dialog).toHaveTextContent('based on version 0');
    expect(dialog).toHaveTextContent('Saved version 1');
  });
  it('a refresh cannot replace a typed draft or its version', async () => {
    const onSaveMark = vi.fn(
      async (): Promise<ConcurrentSaveResult> => ({ ok: false, reason: 'Offline' }),
    );
    const mounted = render(<SafeGradingWorkspace {...props} onSaveMark={onSaveMark} />);
    typeMark();
    mounted.rerender(
      <SafeGradingWorkspace {...props} responses={[saved]} onSaveMark={onSaveMark} />,
    );
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    expect(screen.getByRole('alert')).toHaveTextContent('Your displayed work is retained');
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(onSaveMark).toHaveBeenCalledWith(
        expect.objectContaining({ basedOn: '0', points: 2, feedback: 'My feedback' }),
      ),
    );
  });
  it('keeps an acknowledged mark on refresh and ignores an older cached version', async () => {
    const onSaveMark = async (): Promise<ConcurrentSaveResult> => ({ ok: true, version: '1' });
    const mounted = render(
      <SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />,
    );
    typeMark();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2'),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    mounted.rerender(
      <SafeGradingWorkspace
        {...props}
        responses={[{ ...saved, version: '2' }]}
        onSaveMark={onSaveMark}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your displayed work is retained');
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Feedback to the student' })).toHaveValue(
      'My feedback',
    );
  });
  it('shows both marks on a 409 and rebases only after the explicit replace choice', async () => {
    const sent: MarkSubmission[] = [];
    const onSaveMark = async (submission: MarkSubmission): Promise<ConcurrentSaveResult> => {
      sent.push(submission);
      return sent.length === 1
        ? { ok: false, reason: 'Conflict', conflict: saved }
        : { ok: true, version: '2' };
    };
    const mounted = render(
      <SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />,
    );
    typeMark();
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2 points');
    expect(dialog).toHaveTextContent('4 points');
    expect(dialog).toHaveTextContent('My feedback');
    expect(dialog).toHaveTextContent('Other teacher');
    expect(sent).toHaveLength(1);
    await assertAccessible(mounted.container);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save my draft over version 1' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent.map((s) => s.basedOn)).toEqual(['0', '1']);
    expect(sent[1]).toMatchObject({ points: 2, feedback: 'My feedback' });
  });
  it('keeping the saved mark never sends another write and retains the local draft', async () => {
    const store = memoryDraftStore();
    const onSaveMark = vi.fn(
      async (): Promise<ConcurrentSaveResult> => ({
        ok: false,
        reason: 'Conflict',
        conflict: saved,
      }),
    );
    render(<SafeGradingWorkspace {...props} store={store} onSaveMark={onSaveMark} />);
    typeMark();
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Keep the saved mark and retain my draft' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onSaveMark).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    expect(Object.values(store.entries())[0]?.draft.feedback).toBe('My feedback');
  });
  it('a third grader saving during comparison requires a fresh choice', async () => {
    const onSaveMark = vi.fn(
      async (): Promise<ConcurrentSaveResult> => ({
        ok: false,
        reason: 'Conflict',
        conflict:
          onSaveMark.mock.calls.length <= 1
            ? saved
            : {
                ...saved,
                version: '2',
                manual: { points: 5, feedback: 'Third teacher', bandId: null },
              },
      }),
    );
    render(<SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />);
    typeMark();
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save my draft over version 1' }));
    await screen.findByRole('button', { name: 'Save my draft over version 2' });
    expect(onSaveMark).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog')).toHaveTextContent('Third teacher');
  });
});

describe('what another grader changed, and when it is shown', () => {
  const changes = () => screen.getByRole('alert', { name: copy.CHANGED_LABEL });
  const refusing = (): DraftStore => ({
    read: () => ({ kind: 'NONE' }),
    write: () => ({ ok: false, reason: 'STORAGE_REFUSED' }),
    remove: () => undefined,
  });
  it('names the response and both values when the mark this teacher saved has been replaced', async () => {
    const onSaveMark = async (): Promise<ConcurrentSaveResult> => ({ ok: true, version: '1' });
    const mounted = render(
      <SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />,
    );
    typeMark();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: copy.CHANGED_LABEL })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2'),
    );
    mounted.rerender(
      <SafeGradingWorkspace
        {...props}
        responses={[{ ...saved, version: '2' }]}
        onSaveMark={onSaveMark}
      />,
    );
    // Not "this paper changed": WHICH response, what is on this screen, and what is stored.
    expect(changes()).toHaveTextContent(
      copy.changedLine(1, copy.markSummary(2, 'My feedback'), copy.markSummary(4, 'Other teacher')),
    );
    await assertAccessible(mounted.container);
  });
  it('shows the saved versions only when asked, and brings the device draft back labelled as older', async () => {
    const onSaveMark = vi.fn(
      async (): Promise<ConcurrentSaveResult> => ({ ok: false, reason: 'Offline' }),
    );
    const mounted = render(
      <SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />,
    );
    typeMark();
    mounted.rerender(
      <SafeGradingWorkspace {...props} responses={[saved]} onSaveMark={onSaveMark} />,
    );
    // Announced, and nothing on the paper has moved.
    expect(mounted.container).not.toHaveTextContent('Marked by a teacher: 4 of 5.');
    fireEvent.click(screen.getByRole('button', { name: copy.RELOAD_SAVED }));
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: copy.CHANGED_LABEL })).toBeNull(),
    );
    expect(mounted.container).toHaveTextContent('Marked by a teacher: 4 of 5.');
    // The typed mark is still theirs to send, and it says what it was written on.
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    expect(mounted.container).toHaveTextContent('has changed since this draft was written');
    expect(onSaveMark).not.toHaveBeenCalled();
  });
  it('will not reload over a draft the device refused to keep', () => {
    const mounted = render(
      <SafeGradingWorkspace {...props} store={refusing()} onSaveMark={vi.fn()} />,
    );
    typeMark();
    mounted.rerender(
      <SafeGradingWorkspace
        {...props}
        store={refusing()}
        responses={[saved]}
        onSaveMark={vi.fn()}
      />,
    );
    expect(changes()).toHaveTextContent(copy.RELOAD_BLOCKED);
    const reload = screen.getByRole('button', { name: copy.RELOAD_SAVED });
    expect(reload).toBeDisabled();
    fireEvent.click(reload);
    expect(screen.getByRole('textbox', { name: 'Mark, out of 5' })).toHaveValue('2');
    expect(screen.getByRole('textbox', { name: 'Feedback to the student' })).toHaveValue(
      'My feedback',
    );
  });
  it('keeping the saved mark leaves it announced, without waiting for the host to refetch', async () => {
    const onSaveMark = async (): Promise<ConcurrentSaveResult> => ({
      ok: false,
      reason: 'Conflict',
      conflict: saved,
    });
    render(<SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={onSaveMark} />);
    typeMark();
    fireEvent.click(saveButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: copy.CONFLICT_KEEP }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // `props.responses` still says version 0. The teacher was shown version 1 and chose it; the screen says so.
    expect(changes()).toHaveTextContent(copy.markSummary(4, 'Other teacher'));
  });
  it('never gives an unmarked response its grader number in a comparison', () => {
    const unmarked = essayAwaiting({ version: '3' });
    const mounted = render(
      <SafeGradingWorkspace {...props} store={memoryDraftStore()} onSaveMark={vi.fn()} />,
    );
    mounted.rerender(
      <SafeGradingWorkspace {...props} responses={[unmarked]} onSaveMark={vi.fn()} />,
    );
    expect(changes()).toHaveTextContent(
      copy.changedLine(1, copy.AWAITING_SUMMARY, copy.AWAITING_SUMMARY),
    );
  });
});

describe('the pure halves', () => {
  it('a conflict row outranks an older refresh and yields to a newer one', () => {
    const at = (version: string) => essayAwaiting({ version });
    expect(newestKnown([at('0')], { [target.responseId]: at('2') })[0]?.version).toBe('2');
    expect(newestKnown([at('3')], { [target.responseId]: at('2') })[0]?.version).toBe('3');
    // An opaque token cannot be ordered, so the host's account stands.
    expect(newestKnown([at('etag-b')], { [target.responseId]: at('etag-a') })[0]?.version).toBe(
      'etag-b',
    );
  });
  it('adopts only the changed rows and keeps paper order', () => {
    const other = { ...essayAwaiting({ version: '0' }), responseId: 'other' };
    const next = adoptChanged([target, other], changedElsewhere([target, other], [saved, other]));
    expect(next.map((row) => [row.responseId, row.version])).toEqual([
      [target.responseId, '1'],
      ['other', '0'],
    ]);
    expect(next[1]).toBe(other);
  });
  it('reports a refused draft write as off the device, and a removal as nothing left to lose', () => {
    const report = vi.fn();
    let ok = false;
    const store = trackingDraftStore(
      {
        read: () => ({ kind: 'NONE' }),
        write: () => (ok ? { ok: true } : { ok: false, reason: 'STORAGE_REFUSED' }),
        remove: () => undefined,
      },
      report,
    );
    const key = { graderId: 'me', attemptId: 'paper', responseId: 'r' };
    const stored = { draft: {} as never, keptAt: 1 as never, basedOn: '0' };
    expect(store.write(key, stored)).toEqual({ ok: false, reason: 'STORAGE_REFUSED' });
    ok = true;
    store.write(key, stored);
    store.remove(key);
    expect(report.mock.calls).toEqual([
      ['r', false],
      ['r', true],
      ['r', true],
    ]);
  });
});

describe('feedback composer', () => {
  it('restores a draft, records visibility edits, and distinguishes server drafts from published feedback', async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const keepDraft = vi.fn(() => true);
    const mounted = render(
      <FeedbackEditor
        scopeLabel="whole paper"
        initial={{ body: '', visibility: 'STUDENT_AFTER_RELEASE' }}
        readDraft={() => ({ body: 'Restored', visibility: 'TEACHER_ONLY' })}
        keepDraft={keepDraft}
        save={save}
      />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('Restored');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'STUDENT_AFTER_RELEASE' } });
    expect(keepDraft).toHaveBeenCalledWith({
      body: 'Restored',
      visibility: 'STUDENT_AFTER_RELEASE',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        body: 'Restored',
        visibility: 'STUDENT_AFTER_RELEASE',
        isDraft: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save feedback' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        body: 'Restored',
        visibility: 'STUDENT_AFTER_RELEASE',
        isDraft: false,
      }),
    );
    await assertAccessible(mounted.container);
  });
  it('a failed draft write and rejected save leave the teacher words intact', async () => {
    render(
      <FeedbackEditor
        scopeLabel="question 1"
        initial={{ body: '', visibility: 'TEACHER_ONLY' }}
        readDraft={() => null}
        keepDraft={() => false}
        save={async () => ({ ok: false, reason: 'Conflict: compare both comments' })}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My words' } });
    expect(screen.getByRole('status')).toHaveTextContent('could not be kept');
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Conflict'));
    expect(screen.getByRole('textbox')).toHaveValue('My words');
  });
  it('drops the device copy only once the server holds the words, and never on a refusal', async () => {
    const clearDraft = vi.fn();
    let ok = false;
    render(
      <FeedbackEditor
        scopeLabel="question 1"
        initial={{ body: 'Shown to the student', visibility: 'STUDENT_AFTER_RELEASE' }}
        readDraft={() => null}
        keepDraft={() => true}
        clearDraft={clearDraft}
        save={async () =>
          ok ? { ok: true } : { ok: false, reason: 'STUDENT_FEEDBACK_AFTER_RELEASE' }
        }
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    // The server's code is put into words, and the words say what still works.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        copy.FEEDBACK_REFUSAL.STUDENT_FEEDBACK_AFTER_RELEASE,
      ),
    );
    expect(clearDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Shown to the student');
    ok = true;
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
    await waitFor(() => expect(clearDraft).toHaveBeenCalledTimes(1));
  });
});
