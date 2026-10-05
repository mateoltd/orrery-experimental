'use client';

/**
 * Presence advises; `basedOn` refuses. A stale lease must not block marking after a crashed tab. (P9-T8)
 * Keep displayed marks until explicit adoption: refetching could replace acknowledged work unnoticed.
 * Adoption remounts cached baselines, so every draft must be on the device before reloading.
 */

import * as React from 'react';
import {
  activeGraders,
  adoptChanged,
  changedElsewhere,
  type GradingPresence,
  newestKnown,
  trackingDraftStore,
} from './concurrency';
import * as copy from './copy';
import { sameDraft } from './draft';
import { GradingWorkspace, type GradingWorkspaceProps } from './GradingWorkspace';
import { type ResponseFacts, storedText } from './markingState';
import {
  applyAcknowledged,
  initialDraftFor,
  type MarkSubmission,
  type SaveMarkResult,
} from './submission';

export type ConcurrentSaveResult =
  | SaveMarkResult
  | {
      ok: false;
      reason: string;
      /** The row as it is stored now. Its `version` is what a deliberate replacement is written on. */
      conflict: ResponseFacts;
    };
export interface SafeGradingWorkspaceProps extends Omit<GradingWorkspaceProps, 'onSaveMark'> {
  onSaveMark: (submission: MarkSubmission) => Promise<ConcurrentSaveResult>;
  /** Supplied by the host's shared presence transport. Names are advisory, never a lock. */
  presence: readonly GradingPresence[];
}
interface Conflict {
  mine: MarkSubmission;
  theirs: ResponseFacts;
  finish: (result: SaveMarkResult) => void;
}

const describeMine = (submission: MarkSubmission): string => {
  switch (submission.resolution) {
    case 'MARK':
      return copy.markSummary(submission.points, submission.feedback);
    case 'EXCUSE':
      return copy.excusedSummary(submission.reason);
    case 'ACCEPT_AUTO_MARK':
      return copy.ACCEPT_AUTO_SUMMARY;
    case 'FLAG_ONLY':
      return copy.flagSummary(submission.flagged);
  }
};
/** What is stored, in the same words. `needsHuman` first: an unmarked response is never given its grader's number. */
const describeStored = (facts: ResponseFacts): string =>
  facts.isExcused
    ? copy.excusedSummary(facts.excuseReason)
    : facts.manual
      ? copy.markSummary(facts.manual.points, facts.manual.feedback)
      : facts.auto && !facts.needsHuman
        ? copy.automaticSummary(facts.auto.points)
        : copy.AWAITING_SUMMARY;

export function SafeGradingWorkspace(props: SafeGradingWorkspaceProps) {
  const [held, setHeld] = React.useState<readonly ResponseFacts[]>(() =>
    props.responses.map((facts) => {
      const kept = props.store.read({
        graderId: props.graderId,
        attemptId: props.attemptId,
        responseId: facts.responseId,
      });
      // Reopening a stale draft must not silently rebase it onto another teacher's saved mark.
      return kept.kind === 'FOUND' &&
        kept.stored.basedOn !== facts.version &&
        !sameDraft(kept.stored.draft, initialDraftFor(facts))
        ? { ...facts, version: kept.stored.basedOn }
        : facts;
    }),
  );
  const heldRef = React.useRef(held);
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const pendingRef = React.useRef<Conflict | null>(null);
  const [fromConflicts, setFromConflicts] = React.useState<Record<string, ResponseFacts>>({});
  const [busy, setBusy] = React.useState(false);
  /** Bumped to remount the paper on the saved versions. */
  const [generation, setGeneration] = React.useState(0);
  const [openAt, setOpenAt] = React.useState(props.initialIndex);
  const [announcement, setAnnouncement] = React.useState('');
  const [offDevice, setOffDevice] = React.useState<readonly string[]>([]);
  const acceptButton = React.useRef<HTMLButtonElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);

  const store = React.useMemo(
    () =>
      trackingDraftStore(props.store, (responseId, onDevice) => {
        setOffDevice((previous) => {
          const without = previous.filter((id) => id !== responseId);
          return onDevice
            ? without.length === previous.length
              ? previous
              : without
            : [...without, responseId];
        });
      }),
    [props.store],
  );

  const changed = changedElsewhere(held, newestKnown(props.responses, fromConflicts));
  const present = activeGraders(props.presence, props.graderId, props.now());
  const positionOf = (responseId: string): number | null => {
    const at = held.findIndex((row) => row.responseId === responseId);
    return at === -1 ? null : at + 1;
  };
  const putHeld = (next: readonly ResponseFacts[]) => {
    heldRef.current = next;
    setHeld(next);
  };

  React.useEffect(() => {
    if (conflict) acceptButton.current?.focus();
  }, [conflict]);
  React.useEffect(
    () => () => {
      pendingRef.current?.finish({ ok: false, reason: copy.CONFLICT_CLOSED });
    },
    [],
  );

  const showConflict = (mine: MarkSubmission, theirs: ResponseFacts): Promise<SaveMarkResult> => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((finish) => {
      const next = { mine, theirs, finish };
      pendingRef.current = next;
      setConflict(next);
    });
  };
  const finishConflict = (result: SaveMarkResult) => {
    pendingRef.current?.finish(result);
    pendingRef.current = null;
    setConflict(null);
    opener.current?.focus();
  };
  const remember = (theirs: ResponseFacts) => {
    setFromConflicts((previous) => ({ ...previous, [theirs.responseId]: theirs }));
  };
  const acknowledge = (
    submission: MarkSubmission,
    result: Extract<SaveMarkResult, { ok: true }>,
  ) => {
    putHeld(
      heldRef.current.map((row) =>
        row.responseId === submission.responseId
          ? applyAcknowledged(row, submission, result.version)
          : row,
      ),
    );
  };
  const save = async (submission: MarkSubmission): Promise<SaveMarkResult> => {
    const result = await props.onSaveMark(submission);
    if (result.ok) {
      acknowledge(submission, result);
      return result;
    }
    if ('conflict' in result) {
      remember(result.conflict);
      return showConflict(submission, result.conflict);
    }
    return result;
  };
  const retry = async () => {
    if (!conflict || busy) return;
    setBusy(true);
    try {
      const rebased = { ...conflict.mine, basedOn: conflict.theirs.version };
      const result = await props.onSaveMark(rebased);
      if (result.ok) {
        acknowledge(rebased, result);
        finishConflict(result);
      } else if ('conflict' in result) {
        // A third save during comparison needs a new explicit choice, not an automatic retry loop.
        remember(result.conflict);
        const next = { ...conflict, theirs: result.conflict };
        pendingRef.current = next;
        setConflict(next);
      } else finishConflict(result);
    } catch {
      finishConflict({ ok: false, reason: copy.CONFLICT_SAVE_FAILED });
    } finally {
      setBusy(false);
    }
  };
  const reload = () => {
    if (changed.length === 0 || offDevice.length > 0 || conflict !== null) return;
    const first = held.findIndex((row) => changed.some((c) => c.responseId === row.responseId));
    putHeld(adoptChanged(held, changed));
    setOpenAt(first === -1 ? undefined : first);
    setGeneration((previous) => previous + 1);
    setAnnouncement(copy.RELOADED);
  };

  return (
    <>
      <aside aria-label={copy.PRESENCE_LABEL}>
        {present.length === 0 ? (
          <p>{copy.PRESENCE_NONE}</p>
        ) : (
          <ul>
            {present.map((lease) => (
              <li key={lease.graderId}>
                {copy.presenceLine(
                  lease.name,
                  lease.responseId === null ? null : positionOf(lease.responseId),
                )}
              </li>
            ))}
          </ul>
        )}
        <p>{copy.PRESENCE_NOTE}</p>
      </aside>
      {changed.length > 0 && (
        <section role="alert" aria-label={copy.CHANGED_LABEL}>
          <p>{copy.CHANGED_ELSEWHERE}</p>
          <ul>
            {changed.map((saved) => {
              const shown = held.find((row) => row.responseId === saved.responseId);
              const position = positionOf(saved.responseId);
              if (shown === undefined || position === null) return null;
              return (
                <li key={saved.responseId}>
                  {copy.changedLine(position, describeStored(shown), describeStored(saved))}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={offDevice.length > 0 || conflict !== null}
            onClick={reload}
          >
            {copy.RELOAD_SAVED}
          </button>
          <p>{offDevice.length > 0 ? copy.RELOAD_BLOCKED : copy.RELOAD_NOTE}</p>
        </section>
      )}
      <p role="status">{announcement}</p>
      <GradingWorkspace
        key={generation}
        {...props}
        store={store}
        responses={held}
        initialIndex={openAt}
        onSaveMark={save}
      />
      {conflict && (
        <section
          role="dialog"
          aria-labelledby="grading-conflict-heading"
          aria-describedby="grading-conflict-description"
        >
          <h2 id="grading-conflict-heading">{copy.CONFLICT_HEADING}</h2>
          <p id="grading-conflict-description">{copy.CONFLICT_DESCRIPTION}</p>
          <p>{copy.conflictQuestion(positionOf(conflict.theirs.responseId) ?? 1)}</p>
          <h3>{copy.conflictMine(conflict.mine.basedOn)}</h3>
          <pre>{describeMine(conflict.mine)}</pre>
          <h3>{copy.conflictTheirs(conflict.theirs.version)}</h3>
          <pre>{describeStored(conflict.theirs)}</pre>
          <details>
            <summary>{copy.CONFLICT_ANSWER}</summary>
            <pre>{storedText(conflict.theirs.answer)}</pre>
          </details>
          <button
            ref={acceptButton}
            type="button"
            disabled={busy}
            onClick={() => {
              void retry();
            }}
          >
            {copy.conflictReplace(conflict.theirs.version)}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              finishConflict({ ok: false, reason: copy.CONFLICT_KEPT });
            }}
          >
            {copy.CONFLICT_KEEP}
          </button>
        </section>
      )}
    </>
  );
}
