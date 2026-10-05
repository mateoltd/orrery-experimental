/**
 * Simulation answer replay: re-run the grader, show the trace, override with a reason.  (P9-T7)
 *
 * ## THIS IS NOT THE STORED REPLAY PANE, AND SAYING SO IS PART OF THE JOB
 *
 * `GradingWorkspace.tsx`'s private `SimReplay` prints what is STORED, and `copy.ts:245` is explicit that it "does not
 * re-run the grader, and it does not change the mark". That panel is correct and this is a different thing: it asks the
 * sim's Node bundle to grade the stored answer AGAIN, reports the version that produced the verdict, and offers an
 * audited override.
 *
 * Every line here is chosen so a marker cannot mistake one for the other:
 *
 *  · the button says RE-RUN, and the note under it says the grader runs again and that the stored answer is unchanged;
 *  · the version is on screen whether or not it agrees with the stored one, because "which grader is this" is the whole
 *    question;
 *  · the override is a SEPARATE, LOWER section with its own reason field, so reading the trace does not put a mark field
 *    next to it.
 *
 * ## THE TRACE CUTS ARE RENDERED, NOT SWALLOWED
 *
 * `boundTrace` returns `omittedEntries`, `truncatedEntries` and `complete` precisely so this file can say them
 * (`grading-replay-trace.ts`). A marker overriding a mark on the strength of a trace that stops at entry 50 of 900 has
 * been shown a fiction, and `copy.ts`'s second rule -- a response nobody has marked is never described with a number or
 * as wrong -- is the same discipline applied to a document.
 *
 * ## AND NO MARK APPEARS WITHOUT A REASON
 *
 * The override control is disabled until a reason is non-empty, and the reason travels to the server, which refuses it
 * without one too (`SIM_OVERRIDE_REASON_MAX_CHARS`). The disabled button is a courtesy to the marker; the server refusal
 * is the guarantee, and this file is not it.
 */

'use client';

import * as React from 'react';

import type {
  OverrideRefusal,
  SimReplay,
  SimReplayRefusal,
} from '../../../../../packages/db/src/grading-replay.js';
import type { BoundedTrace } from '../../../../../packages/db/src/grading-replay-trace.js';

/** Every string this panel can say. */
export const REPLAY_HEADING = 'Re-run the simulation’s grader';
export const REPLAY_INTRO =
  'This runs the simulation’s grader again against the stored answer. The stored answer is not changed, and the mark is ' +
  'not changed unless you enter an override below.';
export const REPLAY_RUN = 'Re-run the grader on this answer';
export const REPLAY_RUNNING = 'Running the grader…';
export const REPLAY_DID_NOT_RUN =
  'The grader was not run. Try again, or ask for help if it keeps failing.';
export const REPLAY_WHICH_VERSION = (version: string): string => `Grader version used: ${version}.`;
export const REPLAY_STORED_VERSION = (version: string | null): string =>
  version === null
    ? 'No grader version is recorded against this answer, so there is nothing to compare with.'
    : `This answer was marked by ${version}.`;
export const REPLAY_AGREES =
  'Re-running the grader produced the same mark as the one stored. The stored answer has not changed.';
export const REPLAY_DISAGREES =
  'Re-running the grader produced a DIFFERENT mark from the one stored. Nothing has changed yet; read the trace before ' +
  'deciding what to do about it.';
export const REPLAY_RECOMPUTED_AT = (at: string): string => `Run at ${at}.`;
export const REPLAY_TRACE_HEADING = 'Interaction trace';
export const REPLAY_TRACE_EMPTY =
  'No interaction trace is stored for this answer, so there is nothing for a path-sensitive grader to read.';
export const REPLAY_TRACE_CUT = (omitted: number, truncated: number): string =>
  `This trace is shortened: ${String(omitted)} further ${omitted === 1 ? 'entry is' : 'entries are'} not shown, and ` +
  `${String(truncated)} shown ${truncated === 1 ? 'entry has' : 'entries have'} been cut short. A mark decided on a ` +
  'shortened trace is a mark decided on part of what the student did.';
export const REPLAY_TRACE_TOTAL = (bytes: number): string => `${String(bytes)} characters shown.`;
export const REPLAY_INPUTS = (input: SimReplay['inputs']): string => {
  const parts = [
    `${String(input.stateChars ?? 0)} characters of stored state`,
    `${String(input.answerChars ?? 0)} characters of reported answer`,
  ];
  if (input.traceSupplied > 0)
    parts.push(
      `${String(input.traceSupplied)} trace ${input.traceSupplied === 1 ? 'entry' : 'entries'}`,
    );
  if (input.traceDropped > 0)
    parts.push(
      `${String(input.traceDropped)} trace ${input.traceDropped === 1 ? 'entry' : 'entries'} withheld`,
    );
  if (input.fromBlob) parts.push('state read from the store rather than the response row');
  return `The grader was given ${parts.join(', ')}.`;
};
/**
 * KEYED BY THE SERVER'S OWN REFUSAL UNION, NOT BY `string`.
 *
 * `Readonly<Record<string, string>>` indexes to `string | undefined` under `noUncheckedIndexedAccess`, which made three
 * tests fail to compile while passing at runtime -- a screen can render a sentence the type says might not exist.
 * Naming the union here means a server refusal added without a sentence is a COMPILE error, which is the point.
 */
export const REPLAY_REFUSAL: Readonly<Record<SimReplayRefusal, string>> = {
  NOT_A_SIMULATION:
    'This question does not declare what its simulation reads, so there is no replay to run. That is a question to fix, ' +
    'not an answer to re-mark.',
  STATE_TOO_LARGE:
    'The stored state is larger than the grader may be given, so it was not run. Nothing has been marked.',
  ANSWER_TOO_LARGE:
    'The stored answer is larger than the grader may be given, so it was not run. Nothing has been marked.',
  ADMISSION_REFUSED:
    'Too many replays are already running here, so this one did not start. Nothing has been marked. Try again in a moment.',
};
/** The machine-readable bound, in its own paragraph. `REPLAY_BOUND_APPLIED` is the joined form, for tests and for logs. */
export const REPLAY_BOUND_APPLIED = (bound: string): string =>
  `The run stopped at a limit: ${bound}. ${BOUND_MEANING}`;

/** WHY THE RUN STOPPED IS NOT A MARK, in its own sentence so it can be found and quoted on its own. */
export const BOUND_MEANING = 'A limit is not a mark.';

/* ─────────────────────────────────────────────────────── the override ── */

export const OVERRIDE_HEADING = 'Override this mark by hand';
export const OVERRIDE_INTRO =
  'A hand mark is recorded as yours, with this reason, and the grader’s own figure is kept beside it. It is not a second ' +
  'run of the grader.';
export const OVERRIDE_MARK_LABEL = 'Mark, out of';
export const OVERRIDE_REASON_LABEL = 'Why this mark, not the grader’s';
export const OVERRIDE_REASON_REQUIRED =
  'Say why this mark rather than the grader’s before saving it.';
export const OVERRIDE_SAVE = 'Save this mark';
export const OVERRIDE_SAVED = (revision: string): string => `Mark saved at revision ${revision}.`;
export const OVERRIDE_NOT_SAVED = (reason: string): string => `The mark was not saved: ${reason}`;
export const OVERRIDE_REFUSAL: Readonly<Record<OverrideRefusal, string>> = {
  NOT_FOUND: 'That response is not available to you.',
  REASON_REQUIRED: OVERRIDE_REASON_REQUIRED,
  REASON_TOO_LONG: 'That reason is longer than an override can carry.',
  INVALID_POINTS:
    'A mark cannot be below zero or above what the question is worth, and cannot carry more precision than two decimal places.',
  SEALED_REQUIRES_KEY_FLAG:
    'This answer was marked automatically and the grader asked for no second look, so it is sealed. A mark cannot be ' +
    'typed over it here. If the key is wrong, flag the key: every attempt with this question is then looked at together.',
  RELEASED_REQUIRES_REGRADE:
    'This result has been released. A change to it is a regrade, which is recorded and tells the student; it is not made here.',
  RELEASE_IN_PROGRESS:
    'This paper is being released as reviewed, so a mark cannot be entered until that finishes.',
  RELEASE_MEMBERSHIP_CHANGED:
    'This paper was added to a release batch while the mark was saving. Nothing changed.',
  CONFLICT:
    'Somebody else has saved a mark on this response since you opened it. Compare both before saving.',
  NOT_REVIEWABLE: 'This paper is not open for marking, so no mark was saved.',
};

/**
 * THE SERVER'S REFUSAL, IN THIS FEATURE'S WORDS, OR THE FALLBACK.
 *
 * A refusal this panel does not recognise is reported as "the request did not complete" rather than as itself, because
 * printing an unknown code to a marker is not a service -- and a new server refusal appearing here without a new sentence
 * is a prompt to add one, not a harmless blank.
 */
const refusalLine = (reason: string | undefined): string => {
  if (reason === undefined) return 'the request did not complete';
  const known = (OVERRIDE_REFUSAL as Readonly<Record<string, string | undefined>>)[reason];
  return known ?? `the server refused it (${reason})`;
};

export interface AnswerReplayProps {
  /** `null` before the first run, and after a run that did not complete. */
  readonly replay: SimReplay | null;
  readonly running?: boolean;
  readonly onRun: () => void;
  /** Omitted when the response is sealed automatic, which is the case a marker cannot override. */
  readonly onOverride?: (input: {
    points: number;
    reason: string;
  }) => Promise<{ ok: true; revision: string } | { ok: false; reason?: string }>;
  /** What the question is worth, for the override field's bound. */
  readonly worth: number;
  /** The version the response was marked by, when there is one to compare against. */
  readonly sealed?: boolean;
}

const outcomeLine = (replay: SimReplay): string => {
  const outcome = replay.outcome;
  return outcome.kind === 'GRADED'
    ? `The grader returned ${String(outcome.points)} of ${String(outcome.maxPoints)} (${outcome.code}).`
    : `The grader did not produce a mark (${outcome.reason}: ${outcome.detail}). That is a fault in the platform or the ` +
        'simulation, not in the work, and no mark has been given.';
};

/**
 * A REFUSAL THIS BUILD HAS NO SENTENCE FOR IS NAMED RATHER THAN SWALLOWED.
 *
 * `refusal` is typed as the server's union, so a value outside it can only arrive from a newer server -- and rendering it
 * is how this panel finds out. A gap in a marker-facing panel reads as "nothing to report", which is the one reading a
 * refused replay must never give.
 */
const replayRefusalLine = (refusal: SimReplayRefusal): string =>
  (REPLAY_REFUSAL as Readonly<Record<string, string | undefined>>)[refusal] ??
  `The server refused the run (${String(refusal)}).`;

const TraceList = ({ trace }: { readonly trace: BoundedTrace }) => {
  if (trace.entries.length === 0) return <p>{REPLAY_TRACE_EMPTY}</p>;
  return (
    <>
      <ol>
        {trace.entries.map((entry, position) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an append-only stored log, rendered once and never reordered
          <li key={position}>
            <code style={{ whiteSpace: 'pre-wrap' }}>{entry}</code>
          </li>
        ))}
      </ol>
      <p>{REPLAY_TRACE_TOTAL(trace.bytes)}</p>
      {trace.complete ? null : (
        <p role="status">{REPLAY_TRACE_CUT(trace.omittedEntries, trace.truncatedEntries)}</p>
      )}
    </>
  );
};

export function AnswerReplay(props: AnswerReplayProps) {
  const [points, setPoints] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const saving = React.useRef(false);
  const replay = props.replay;
  const canOverride = props.onOverride !== undefined && props.sealed !== true;
  const trimmed = reason.trim();
  const entered = Number(points);
  const markInRange =
    points.trim() !== '' && Number.isFinite(entered) && entered >= 0 && entered <= props.worth;
  const saveDisabled = !canOverride || saving.current || trimmed === '' || !markInRange;

  const save = async () => {
    if (saving.current || !props.onOverride) return;
    saving.current = true;
    setNotice('');
    try {
      const result = await props.onOverride({ points: entered, reason: trimmed });
      setNotice(
        result.ok
          ? OVERRIDE_SAVED(result.revision)
          : OVERRIDE_NOT_SAVED(refusalLine(result.reason)),
      );
    } catch {
      setNotice(OVERRIDE_NOT_SAVED('the request did not complete'));
    } finally {
      saving.current = false;
    }
  };

  return (
    <section aria-label="Re-run the simulation’s grader">
      <h3>{REPLAY_HEADING}</h3>
      <p>{REPLAY_INTRO}</p>
      <button type="button" disabled={props.running === true} onClick={() => props.onRun()}>
        {props.running === true ? REPLAY_RUNNING : REPLAY_RUN}
      </button>

      {replay === null ? null : (
        <>
          <p>{outcomeLine(replay)}</p>
          <p>{REPLAY_WHICH_VERSION(replay.replayedGraderVersion)}</p>
          <p>{REPLAY_STORED_VERSION(replay.storedGraderVersion)}</p>
          <p>{replay.differsFromStored ? REPLAY_DISAGREES : REPLAY_AGREES}</p>
          <p>{REPLAY_INPUTS(replay.inputs)}</p>
          <p>{REPLAY_RECOMPUTED_AT(replay.replayedAt)}</p>
          {/*
           * THE BOUND NAME AND WHAT IT MEANS ARE SEPARATE PARAGRAPHS.
           *
           * `REPLAY_BOUND_APPLIED` reads "The run stopped at a limit: INPUT_LIMIT. A limit is not a mark." as one string,
           * which is correct to read and impossible to query for either half -- and the second half is the sentence that
           * stops a marker treating a refused run as a zero. The first version concatenated them and this test failed on
           * `getByText('A limit is not a mark.')`, which is how the split was found.
           */}
          {replay.stoppedBy === null ? null : (
            <>
              <p>{`The run stopped at a limit: ${replay.stoppedBy}.`}</p>
              <p>{BOUND_MEANING}</p>
            </>
          )}
          {replay.refusal === null ? null : <p>{replayRefusalLine(replay.refusal)}</p>}
          <h4>{REPLAY_TRACE_HEADING}</h4>
          <TraceList trace={replay.trace} />
        </>
      )}

      {canOverride ? (
        <section aria-label="Override this mark by hand">
          <h4>{OVERRIDE_HEADING}</h4>
          <p>{OVERRIDE_INTRO}</p>
          <label htmlFor="answer-replay-mark">
            {OVERRIDE_MARK_LABEL} {String(props.worth)}
          </label>
          <input
            id="answer-replay-mark"
            type="number"
            min={0}
            max={props.worth}
            step={0.01}
            value={points}
            onChange={(event) => {
              setPoints(event.target.value);
            }}
          />
          <label htmlFor="answer-replay-reason">{OVERRIDE_REASON_LABEL}</label>
          <textarea
            id="answer-replay-reason"
            value={reason}
            aria-describedby="answer-replay-reason-hint"
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <p id="answer-replay-reason-hint">
            This reason is stored with the mark and shown to anyone who asks where it came from.
          </p>
          <button type="button" disabled={saveDisabled} onClick={() => void save()}>
            {OVERRIDE_SAVE}
          </button>
          {trimmed === '' && reason !== '' ? <p>{OVERRIDE_REASON_REQUIRED}</p> : null}
          {points.trim() !== '' && !markInRange ? <p>{OVERRIDE_REFUSAL.INVALID_POINTS}</p> : null}
          <p role="status">{notice}</p>
        </section>
      ) : null}
    </section>
  );
}
