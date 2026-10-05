/**
 * The review surface for a sealed auto-grade, and the flag it raises.  (P9-T6)
 *
 * ## THE MARK IS NOT ON THIS SCREEN, AND THAT IS THE POINT
 *
 * `SealedAutoGradeTarget` has no score field and `AutoGradeReviewApi`'s inertness assertion fails to COMPILE if one is
 * added (`grading-review-flag.ts`). The screen is built on that type, so it has nowhere to put a mark even by accident --
 * which is what makes the "no inline override on a sealed auto-grade" rule from `plans/07` §5.1 a property of the
 * component rather than a thing it is asked to remember.
 *
 * What the screen DOES carry is the blast radius, because a marker who is about to say "this key is wrong" is owed the
 * size of what they are about to say before they say it. `plans/07` §7: a regrade is "affected attempts, score deltas,
 * count of already-released attempts", then a confirmation. Those numbers come from `blastRadius` over the confirmed
 * preview, so the figures on this screen are the figures the confirmation commits.
 *
 * ## NOTHING HERE CHANGES THE KEY
 *
 * There is no "fix the key" button, no editable spec, and no field that could become one. The marker's one action is a
 * reason attached to a question. Whether the key is then changed is an authoring decision made on the resource, and the
 * consequence is a reviewed regrade -- which is `RegradePreview.tsx` and is not this component.
 */

'use client';

import * as React from 'react';
import type {
  BlastRadius,
  KeyFlagRefusal,
  SealedAutoGradeTarget,
} from '../../../../../packages/db/src/grading-review.js';

/** Every string the screen can say, in one place, for the same three rules `copy.ts` holds. */
export const REVIEW_HEADING = 'Review this question’s key';
export const REVIEW_INTRO =
  'This response was marked automatically and is sealed. Its mark cannot be changed here. If the key is wrong, ' +
  'say so and every attempt that had this question is looked at together.';
export const REVIEW_WORTH = (worth: number): string => `Worth ${String(worth)}.`;
export const REVIEW_MARKED_BY = (version: string | null): string =>
  version === null ? 'No automatic marker has run on this question.' : `Marked by ${version}.`;
export const REVIEW_ALREADY_FLAGGED =
  'You have already flagged this question’s key. A reviewer will read it.';
export const REVIEW_REASON_LABEL = 'What is wrong with the key';
export const REVIEW_REASON_HINT =
  'Say what the key gets wrong and what it should say instead. Whoever reviews this will not see the paper.';
export const REVIEW_REASON_REQUIRED =
  'Give a reason before flagging. A flag with no reason cannot be acted on.';
export const REVIEW_REASON_TOO_LONG =
  'That reason is longer than a flag can carry. Keep it to what is wrong with the key.';
export const REVIEW_FLAG = 'Flag this key';
export const REVIEW_FLAGGED = (at: string): string =>
  `Flag recorded at ${at}. No mark has changed.`;
export const REVIEW_RELEASED_NOTE =
  'This paper has been released. Flagging it changes nothing; the key is fixed on the resource and the regrade that ' +
  'follows sends each changed student a notice.';
export const REVIEW_REFUSAL: Readonly<Record<KeyFlagRefusal, string>> = {
  NOT_FOUND: 'That response is not available to you.',
  REASON_REQUIRED: REVIEW_REASON_REQUIRED,
  REASON_TOO_LONG: REVIEW_REASON_TOO_LONG,
  NOT_SEALED_AUTOMATIC:
    'This response is not a sealed automatic mark, so there is no key to dispute here. A response already marked by a ' +
    'person, or already waiting for one, is marked rather than flagged.',
  ALREADY_FLAGGED: REVIEW_ALREADY_FLAGGED,
};
export const REVIEW_NOT_SAVED = 'The flag was not recorded. Your reason is still here; try again.';

const refusalLine = (reason: string | undefined): string =>
  reason === undefined
    ? REVIEW_NOT_SAVED
    : (REVIEW_REFUSAL[reason as KeyFlagRefusal] ?? REVIEW_NOT_SAVED);

const plural = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * THE BLAST RADIUS, AS SENTENCES, AND WHY EACH COUNT IS NAMED SEPARATELY.
 *
 * "4 papers change" and "3 papers are under this key" are different facts and the screen states both, because a marker
 * who reads only the first will tell a student their mark changed when it did not, and `plans/07` §7's "an already
 * released attempt is never silently changed" is a promise about exactly that.
 */
export const radiusLines = (radius: BlastRadius): readonly string[] => {
  const lines: string[] = [
    `${plural(radius.responses, 'response')} sit under this question’s key on this assignment.`,
  ];
  if (radius.sealedAutomatic > 0)
    lines.push(`${plural(radius.sealedAutomatic, 'sealed mark')} would be marked again.`);
  if (radius.preservedByManualMark > 0)
    lines.push(
      `${plural(radius.preservedByManualMark, 'response')} already marked by a person would keep that mark; a change to ` +
        'the key does not touch a decision somebody made.',
    );
  if (radius.preservedAsExcused > 0)
    lines.push(`${plural(radius.preservedAsExcused, 'response')} excused would stay excused.`);
  if (radius.awaitingHuman > 0)
    lines.push(
      `${plural(radius.awaitingHuman, 'response')} awaiting a person may be marked by the change, because their own ` +
        'automatic marker did not finish.',
    );
  if (radius.affectedAttempts === 0) {
    lines.push(
      'On the current key, no result would move. A change to the key is still worth recording.',
    );
    return lines;
  }
  lines.push(
    `${plural(radius.affectedAttempts, 'result')} would change` +
      (radius.alreadyReleased > 0
        ? `, and ${plural(radius.alreadyReleased, 'of them has')} already been released. Each released result that moves ` +
          'gets a notice saying why.'
        : '. None of them has been released yet.'),
  );
  if (radius.rewrittenButUnchanged > 0)
    lines.push(
      `${plural(radius.rewrittenButUnchanged, 'mark')} would be marked again and come out the same, which is recorded ` +
        'rather than presented as a change.',
    );
  if (radius.wouldBecomeProvisional > 0)
    lines.push(
      `${plural(radius.wouldBecomeProvisional, 'result')} would stop being final and go to a person, because the new key ` +
        'left something unread.',
    );
  return lines;
};

export interface AutoGradeReviewProps {
  readonly target: SealedAutoGradeTarget;
  /** `null` until the marker has asked for the dry run. Nothing is counted speculatively. */
  readonly radius: BlastRadius | null;
  readonly onFlag: (input: {
    reason: string;
  }) => Promise<{ ok: true; raisedAt: string } | { ok: false; reason?: string }>;
  readonly onPreview: () => void;
  readonly previewing?: boolean;
}

export function AutoGradeReview(props: AutoGradeReviewProps) {
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState('');
  const [raisedAt, setRaisedAt] = React.useState('');
  const running = React.useRef(false);
  /**
   * THE FLAG BUTTON IS DISABLED WHEN THE REPORTER ALREADY HAS AN OPEN FLAG, NOT ONLY AFTER THIS SCREEN RAISED ONE.
   *
   * The first version computed `flagged` for the notice and left the button enabled, so a marker returning to a question
   * they had already flagged could raise a second one and get `ALREADY_FLAGGED` from the server. The refusal is correct
   * and the button should have said so: a control that offers an action it knows will be refused is a control that
   * teaches the screen is unreliable. The server refusal remains the guarantee.
   */
  const flagged = props.target.openFlagsByReporter > 0;
  const raised = raisedAt !== '';
  const cannotFlag = raised || flagged;

  const flag = async () => {
    if (running.current || cannotFlag) return;
    if (reason.trim() === '') {
      setError(REVIEW_REASON_REQUIRED);
      return;
    }
    running.current = true;
    setError('');
    try {
      const result = await props.onFlag({ reason });
      if (result.ok) setRaisedAt(result.raisedAt);
      else setError(refusalLine(result.reason));
    } catch {
      setError(REVIEW_NOT_SAVED);
    } finally {
      running.current = false;
    }
  };

  return (
    <section aria-label="Review this question’s key">
      <h2>{REVIEW_HEADING}</h2>
      <p>{REVIEW_INTRO}</p>
      {/*
       * TWO PARAGRAPHS, NOT ONE WITH BOTH SENTENCES IN IT. `worth` and the marker version are separate facts and
       * rendering them as one run of text meant a screen reader read "Worth five. Marked by auto seven." as a single
       * utterance and every test querying one of them by text failed against the combined string. Splitting them also
       * means a change to one sentence cannot silently reword the other.
       */}
      <p>{REVIEW_WORTH(props.target.worth)}</p>
      <p>{REVIEW_MARKED_BY(props.target.markedByVersion)}</p>
      {props.target.released ? <p>{REVIEW_RELEASED_NOTE}</p> : null}
      {flagged ? <p>{REVIEW_ALREADY_FLAGGED}</p> : null}

      {/*
       * THE DRY RUN IS A BUTTON, NOT A COUNT THAT APPEARS ON ITS OWN. The counts are only true for the preview the
       * confirmation token commits, so showing a number that no token covers would be showing a number nobody is about
       * to act on.
       */}
      <button
        type="button"
        disabled={props.previewing === true || raised}
        onClick={() => {
          props.onPreview();
        }}
      >
        {props.previewing === true
          ? 'Working out what a key change would affect…'
          : 'See what a key change would affect'}
      </button>

      {props.radius === null ? null : (
        <section aria-label="What a key change would affect">
          <h3>If this key is changed</h3>
          <ul>
            {radiusLines(props.radius).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            Changing the key is done on the resource, not here. After it is changed, this list is
            shown again as a dry run and confirmed before any mark moves.
          </p>
        </section>
      )}

      <label htmlFor="auto-grade-review-reason">{REVIEW_REASON_LABEL}</label>
      <textarea
        id="auto-grade-review-reason"
        value={reason}
        disabled={cannotFlag}
        aria-describedby="auto-grade-review-reason-hint"
        onChange={(event) => {
          setReason(event.target.value);
          if (error !== '') setError('');
        }}
      />
      <p id="auto-grade-review-reason-hint">{REVIEW_REASON_HINT}</p>
      <button type="button" disabled={cannotFlag} onClick={() => void flag()}>
        {REVIEW_FLAG}
      </button>
      {raised ? <p role="status">{REVIEW_FLAGGED(raisedAt)}</p> : <p role="status">{error}</p>}
    </section>
  );
}
