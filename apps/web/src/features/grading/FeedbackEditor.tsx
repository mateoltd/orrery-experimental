'use client';

import * as React from 'react';
import * as copy from './copy';

export interface FeedbackDraft {
  body: string;
  visibility: 'TEACHER_ONLY' | 'STUDENT_AFTER_RELEASE';
}
export interface FeedbackEditorProps {
  /** "question 2", or "the whole paper". The same composer serves both; the host decides which row it writes. */
  scopeLabel: string;
  initial: FeedbackDraft;
  /** Storage is keyed by grader, attempt and response (or whole attempt) by the host. */
  readDraft: () => FeedbackDraft | null;
  keepDraft: (draft: FeedbackDraft) => boolean;
  /**
   * Called once the SERVER holds these words. A device copy left behind is restored over whatever the server holds
   * the next time this opens, which shows a teacher last week's wording as though it were current.
   */
  clearDraft?: () => void;
  /** `reason` is the server's refusal code, or a sentence. A code is put into words by `copy.feedbackRefusal`. */
  save: (draft: FeedbackDraft & { isDraft: boolean }) => Promise<{ ok: boolean; reason?: string }>;
}

/** Publishing still obeys the server's release gate: nothing here decides what a student can read. */
export function FeedbackEditor(props: FeedbackEditorProps) {
  const [draft, setDraft] = React.useState(() => props.readDraft() ?? props.initial);
  const [status, setStatus] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();
  const edit = (next: FeedbackDraft) => {
    setDraft(next);
    setStatus(props.keepDraft(next) ? copy.FEEDBACK_DRAFT_KEPT : copy.FEEDBACK_DRAFT_NOT_KEPT);
  };
  const save = async (isDraft: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await props.save({ ...draft, isDraft });
      if (result.ok) {
        props.clearDraft?.();
        setStatus(isDraft ? copy.FEEDBACK_DRAFT_SAVED : copy.FEEDBACK_SAVED);
      } else setStatus(copy.feedbackRefusal(result.reason));
    } catch {
      setStatus(copy.FEEDBACK_NOT_SAVED);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={copy.feedbackFor(props.scopeLabel)}>
      <label htmlFor={`${id}-body`}>{copy.feedbackFor(props.scopeLabel)}</label>
      <textarea
        id={`${id}-body`}
        value={draft.body}
        disabled={busy}
        onChange={(event) => {
          edit({ ...draft, body: event.target.value });
        }}
      />
      <label htmlFor={`${id}-visibility`}>{copy.FEEDBACK_VISIBILITY_LABEL}</label>
      <select
        id={`${id}-visibility`}
        value={draft.visibility}
        disabled={busy}
        onChange={(event) => {
          edit({ ...draft, visibility: event.target.value as FeedbackDraft['visibility'] });
        }}
      >
        <option value="TEACHER_ONLY">{copy.VISIBILITY_TEACHERS}</option>
        <option value="STUDENT_AFTER_RELEASE">{copy.VISIBILITY_STUDENT}</option>
      </select>
      <p>{copy.FEEDBACK_VISIBILITY_NOTE}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void save(true);
        }}
      >
        {copy.FEEDBACK_SAVE_DRAFT}
      </button>
      <button
        type="button"
        disabled={busy || !draft.body.trim()}
        onClick={() => {
          void save(false);
        }}
      >
        {copy.FEEDBACK_SAVE}
      </button>
      <p role="status">{status}</p>
    </section>
  );
}
