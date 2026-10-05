/**
 * The replay panel: the version is on screen, the trace's cuts are on screen, and no mark saves without a reason.  (P9-T7)
 *
 * ## WHAT THIS FILE HOLDS THAT THE SERVER FILE CANNOT
 *
 * `grading-replay.integration.test.ts` proves the grader really re-runs. This proves a marker can TELL that it did -- the
 * version is rendered whether or not it agrees with the stored one, the disagreement is stated in words, and the run is
 * visibly a run rather than a second reading of the same row. A replay that is indistinguishable from the stored replay
 * pane is a replay nobody will act on.
 *
 * And it holds the trace's arithmetic at the boundary: `boundTrace`'s `omittedEntries` and `truncatedEntries` are rendered
 * as words, because a marker who cannot see that a trace stops short has been shown a fiction.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { SimReplay } from '../../../../../packages/db/src/grading-replay.js';
import type { BoundedTrace } from '../../../../../packages/db/src/grading-replay-trace.js';
import {
  AnswerReplay,
  OVERRIDE_REASON_REQUIRED,
  OVERRIDE_REFUSAL,
  REPLAY_DID_NOT_RUN,
  REPLAY_DISAGREES,
  REPLAY_REFUSAL,
  REPLAY_TRACE_CUT,
} from './AnswerReplay';
import { assertAccessible, renderAudited } from './workspaceHarness';

const trace = (over: Partial<BoundedTrace> = {}): BoundedTrace => ({
  entries: ['{"t":0,"event":"burn","value":3}', '{"t":4,"event":"burn","value":1}'],
  omittedEntries: 0,
  truncatedEntries: 0,
  bytes: 44,
  complete: true,
  ...over,
});

const replay = (over: Partial<SimReplay> = {}): SimReplay => ({
  responseId: 'r1',
  attemptId: 'a1',
  questionId: 'q1',
  simId: 'orbit-decay',
  replayedGraderVersion: '1.2.0',
  storedGraderVersion: 'sim-grader-1.2.0',
  outcome: { kind: 'GRADED', points: 3, maxPoints: 4, code: 'CORRECT' },
  trace: trace(),
  stored: { points: 3, rawPoints: 3, version: 'sim-grader-1.2.0', needsHuman: false },
  differsFromStored: false,
  inputs: {
    stateChars: 10,
    answerChars: 15,
    traceChars: 0,
    traceSupplied: 0,
    traceDropped: 0,
    fromBlob: false,
  },
  gradedInputDigest: 'a'.repeat(64),
  stoppedBy: null,
  refusal: null,
  replayedAt: '2026-10-05T14:32:00.000Z',
  ...over,
});

/** `await` IS NOT OPTIONAL: spreading the Promise gives an undefined mount and axe runs that collide. */
const draw = async (props: {
  replay?: SimReplay | null;
  running?: boolean;
  onRun?: () => void;
  onOverride?: (input: {
    points: number;
    reason: string;
  }) => Promise<{ ok: true; revision: string } | { ok: false; reason?: string }>;
  worth?: number;
  sealed?: boolean;
}) => {
  const onRun = props.onRun ?? vi.fn();
  const onOverride = props.onOverride;
  const rendered = await renderAudited(
    <AnswerReplay
      replay={props.replay === undefined ? replay() : props.replay}
      running={props.running}
      onRun={onRun}
      {...(onOverride === undefined ? {} : { onOverride })}
      worth={props.worth ?? 4}
      {...(props.sealed === undefined ? {} : { sealed: props.sealed })}
    />,
  );
  return { ...rendered, onRun };
};

describe('the panel says what it does before it does it', () => {
  it('says it runs the grader again and changes nothing by itself', async () => {
    /**
     * THE ONE SENTENCE THAT DISTINGUISHES THIS FROM `GradingWorkspace`'s STORED REPLAY PANE.
     *
     * `copy.ts:245` promises the stored pane "does not re-run the grader, and it does not change the mark". A marker with
     * both panels open must be able to tell them apart from the copy alone, before pressing anything.
     */
    await draw({ replay: null });
    expect(
      screen.getByText(/runs the simulation’s grader again against the stored answer/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not changed unless you enter an override below/)).toBeInTheDocument();
  });

  it('offers nothing before a run, rather than printing stored values under a replay heading', async () => {
    // Printing the stored outcome before any run would make the panel a second copy of the stored pane for the moment
    // before it becomes the real thing, and a marker would have no way to know which they were reading.
    await draw({ replay: null });
    expect(screen.queryByText(/The grader returned/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Interaction trace' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Override this mark by hand/ })).toBeNull();
  });

  it('runs on demand, and disables the button while it runs', async () => {
    const onRun = vi.fn();
    await draw({ replay: null, onRun });
    await userEvent.click(screen.getByRole('button', { name: 'Re-run the grader on this answer' }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('says which version ran, and which version produced the stored mark, whether or not they agree', async () => {
    // "Which grader is this" is the whole question a marker re-running a replay is asking, so both are on screen.
    await draw({ replay: replay({ replayedGraderVersion: '2.0.0', differsFromStored: true }) });
    expect(screen.getByText('Grader version used: 2.0.0.')).toBeInTheDocument();
    expect(screen.getByText('This answer was marked by sim-grader-1.2.0.')).toBeInTheDocument();
  });

  it('says plainly when the two disagree, and that nothing has changed yet', async () => {
    await draw({
      replay: replay({
        outcome: { kind: 'GRADED', points: 1, maxPoints: 4, code: 'PARTIAL' },
        differsFromStored: true,
      }),
    });
    expect(screen.getByText(REPLAY_DISAGREES)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has changed yet/)).toBeInTheDocument();
  });

  it('says they agree, without pretending the stored answer was re-read', async () => {
    await draw({ replay: replay({ differsFromStored: false }) });
    expect(screen.getByText(/produced the same mark as the one stored/)).toBeInTheDocument();
    expect(screen.getByText(/The stored answer has not changed/)).toBeInTheDocument();
  });

  it('says when no grader version is recorded, which is different from one that matches', async () => {
    await draw({ replay: replay({ storedGraderVersion: null }) });
    expect(screen.getByText(/No grader version is recorded/)).toBeInTheDocument();
  });

  it('reports a grader fault as a fault in the platform, never as a mark', async () => {
    // `copy.ts:35` has the vocabulary and `INV-SIM-2` has the reason: a zero is indistinguishable, in a release batch,
    // from a wrong answer.
    await draw({
      replay: replay({
        outcome: {
          kind: 'NEEDS_HUMAN',
          reason: 'GRADER_THREW',
          detail: 'TypeError: state.burns is not iterable',
        },
      }),
    });
    expect(screen.getByText(/did not produce a mark \(GRADER_THREW/)).toBeInTheDocument();
    expect(
      screen.getByText(/That is a fault in the platform or the simulation, not in the work/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^0 of/)).toBeNull();
  });

  it('shows what the grader was actually given, so a surprising verdict can be traced', async () => {
    await draw({
      replay: replay({
        inputs: {
          stateChars: 65_000,
          answerChars: 15,
          traceChars: 4_096,
          traceSupplied: 12,
          traceDropped: 30,
          fromBlob: true,
        },
      }),
    });
    const text = screen.getByText(/The grader was given/).textContent ?? '';
    expect(text).toContain('65000 characters of stored state');
    expect(text).toContain('12 trace entries');
    expect(text).toContain('30 trace entries withheld');
    expect(text).toContain('state read from the store rather than the response row');
  });

  it('reports which bound stopped the run, and that a limit is not a mark', async () => {
    await draw({
      replay: replay({
        stoppedBy: 'INPUT_LIMIT',
        refusal: 'STATE_TOO_LARGE',
        outcome: {
          kind: 'NEEDS_HUMAN',
          reason: 'GRADER_UNREADABLE',
          detail: 'the stored state is above the limit',
        },
      }),
    });
    // TWO PARAGRAPHS, because "The run stopped at a limit: INPUT_LIMIT. A limit is not a mark." as one run of text
    // cannot be queried for either half, and the second half is the one that matters to a marker reading it.
    expect(screen.getByText(/The run stopped at a limit: INPUT_LIMIT/)).toBeInTheDocument();
    expect(screen.getByText('A limit is not a mark.')).toBeInTheDocument();
    expect(screen.getByText(REPLAY_REFUSAL.STATE_TOO_LARGE)).toBeInTheDocument();
  });

  it('reports a refused run as refused, not as a grader fault', async () => {
    await draw({
      replay: replay({
        stoppedBy: 'ADMISSION',
        refusal: 'ADMISSION_REFUSED',
        outcome: {
          kind: 'NEEDS_HUMAN',
          reason: 'GRADER_TIMED_OUT',
          detail: 'too many replays are already running here',
        },
      }),
    });
    expect(screen.getByText(REPLAY_REFUSAL.ADMISSION_REFUSED)).toBeInTheDocument();
  });

  it('NAMES an unrecognised refusal rather than rendering nothing, because a gap reads as "nothing to report"', async () => {
    // A refusal from a newer server has no sentence here. Printing its own name is how this panel tells a developer the
    // sentence is missing; printing `REPLAY_DID_NOT_RUN` would be a sentence about the WRONG cause, and the first version
    // did exactly that.
    await draw({
      replay: replay({
        refusal: 'SOMETHING_NEW' as SimReplay['refusal'],
        outcome: { kind: 'NEEDS_HUMAN', reason: 'GRADER_UNREADABLE', detail: 'x' },
      }),
    });
    expect(screen.getByText('The server refused the run (SOMETHING_NEW).')).toBeInTheDocument();
    expect(screen.queryByText(REPLAY_DID_NOT_RUN)).toBeNull();
  });
});

describe('the trace is rendered as far as it goes, and its cuts are named', () => {
  it('lists the entries it has, and says the character count', async () => {
    // A COMPLETE trace, so the only thing this asserts is the rendering of what `boundTrace` returned.
    await draw({});
    const list = within(screen.getByRole('list'));

    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('44 characters shown.')).toBeInTheDocument();
  });

  it('says nothing was cut when nothing was, rather than showing a zero', async () => {
    await draw({ replay: replay({ trace: trace({ complete: true }) }) });
    expect(screen.queryByText(/shortened/)).toBeNull();
  });

  /**
   * THE FAILURE THIS PREVENTS.
   *
   * A marker who sees entries 0–49 and overrides a mark on that evidence has been shown a fiction, and `boundTrace`'s
   * whole reason for returning `omittedEntries` is so that this sentence can exist. The first version of the panel printed
   * the entries and dropped the counts, and `boundTrace` had them computed for nobody.
   */
  it('names the entries it is not showing', async () => {
    await draw({
      replay: replay({
        trace: trace({ omittedEntries: 850, truncatedEntries: 0, complete: false }),
      }),
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'This trace is shortened: 850 further entries are not shown, and 0 shown entries have been cut short.',
    );
  });

  it('names a shortened entry separately from a dropped one', async () => {
    // They are different lies: a dropped entry is absent, a shortened one is present and misleading.
    await draw({
      replay: replay({ trace: trace({ omittedEntries: 0, truncatedEntries: 3, complete: false }) }),
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'This trace is shortened: 0 further entries are not shown, and 3 shown entries have been cut short.',
    );
  });

  it('uses the singular for one, because "1 entrys" is how a screen stops being read', async () => {
    await draw({
      replay: replay({ trace: trace({ omittedEntries: 1, truncatedEntries: 1, complete: false }) }),
    });
    expect(screen.getByRole('status')).toHaveTextContent(REPLAY_TRACE_CUT(1, 1));
    expect(REPLAY_TRACE_CUT(1, 1)).toContain('1 further entry is not shown');
    expect(REPLAY_TRACE_CUT(1, 1)).toContain('1 shown entry has been cut short');
  });

  it('says a shortened trace is a mark decided on part of what the student did', async () => {
    await draw({ replay: replay({ trace: trace({ omittedEntries: 2, complete: false }) }) });
    expect(screen.getByText(/A mark decided on a shortened trace/)).toBeInTheDocument();
  });

  it('says there is no trace rather than rendering an empty list', async () => {
    // An empty list reads as "the student did nothing"; a stored trace that is not an array is a platform defect, and
    // `copy.ts:35` has the words for it.
    await draw({ replay: replay({ trace: trace({ entries: [], complete: false }) }) });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(/No interaction trace is stored/)).toBeInTheDocument();
  });
});

describe('the override is behind a reason, and a refusal keeps the reason', () => {
  it('does not offer the override at all when there is no handler, because a sealed mark has no override', async () => {
    await draw({ sealed: true });
    expect(screen.queryByRole('region', { name: 'Override this mark by hand' })).toBeNull();
    expect(screen.queryByLabelText(/Mark, out of/)).toBeNull();
  });

  it('saves nothing without a reason, and says what is missing', async () => {
    const onOverride = vi.fn();
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '2');
    expect(screen.getByRole('button', { name: 'Save this mark' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why this mark, not the grader’s'), '  ');
    expect(screen.getByRole('button', { name: 'Save this mark' })).toBeDisabled();
    expect(onOverride).not.toHaveBeenCalled();
    expect(screen.getByText(OVERRIDE_REASON_REQUIRED)).toBeInTheDocument();
  });

  it("refuses a mark outside the question's worth, before the server does", async () => {
    const onOverride = vi.fn();
    await draw({ onOverride, worth: 4 });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '9');
    expect(screen.getByRole('button', { name: 'Save this mark' })).toBeDisabled();
    expect(screen.getByText(OVERRIDE_REFUSAL.INVALID_POINTS)).toBeInTheDocument();
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('sends the mark and the reason together, and reports the new revision', async () => {
    const onOverride = vi.fn(async () => ({ ok: true as const, revision: '4' }));
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '2');
    await userEvent.type(
      screen.getByLabelText('Why this mark, not the grader’s'),
      'The simulation stopped early.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save this mark' }));
    expect(onOverride).toHaveBeenCalledWith({ points: 2, reason: 'The simulation stopped early.' });
    expect(await screen.findByText('Mark saved at revision 4.')).toBeInTheDocument();
  });

  it("says the mark is recorded as the marker's, and the grader's figure is kept", async () => {
    // This is the sentence that makes an override auditable to the marker rather than only to the database.
    await draw({ onOverride: vi.fn() });
    expect(screen.getByText(/recorded as yours, with this reason/)).toBeInTheDocument();
    expect(screen.getByText(/grader’s own figure is kept beside it/)).toBeInTheDocument();
  });

  it('explains a sealed refusal in terms of the key flag, which is the other feature', async () => {
    // The screen a marker lands on after "this mark should have been different" is not a form; it is a sentence telling
    // them where the real route is.
    const onOverride = vi.fn(async () => ({
      ok: false as const,
      reason: 'SEALED_REQUIRES_KEY_FLAG',
    }));
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '4');
    await userEvent.type(screen.getByLabelText('Why this mark, not the grader’s'), 'Wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Save this mark' }));
    const status = await screen.findByText(/The mark was not saved/);
    expect(status.textContent).toContain('sealed');
    expect(status.textContent).toContain('flag the key');
  });

  it('keeps what was typed after a refusal, because a reason the marker must retype is lost work', async () => {
    const onOverride = vi.fn(async () => ({ ok: false as const, reason: 'CONFLICT' }));
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '2');
    await userEvent.type(
      screen.getByLabelText('Why this mark, not the grader’s'),
      'The state was truncated.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save this mark' }));
    await screen.findByText(/Somebody else has saved a mark/);
    expect(screen.getByLabelText('Mark, out of 4')).toHaveValue(2);
    expect(screen.getByLabelText('Why this mark, not the grader’s')).toHaveValue(
      'The state was truncated.',
    );
  });

  it('reports a released refusal in the words INV-RELEASE-1 uses', async () => {
    const onOverride = vi.fn(async () => ({
      ok: false as const,
      reason: 'RELEASED_REQUIRES_REGRADE',
    }));
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '2');
    await userEvent.type(screen.getByLabelText('Why this mark, not the grader’s'), 'Better.');
    await userEvent.click(screen.getByRole('button', { name: 'Save this mark' }));
    expect(await screen.findByText(/A change to it is a regrade/)).toBeInTheDocument();
  });

  it('reports a request that did not complete rather than a silent nothing', async () => {
    const onOverride = vi.fn(async () => {
      throw new Error('the connection dropped');
    });
    await draw({ onOverride });
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '2');
    await userEvent.type(screen.getByLabelText('Why this mark, not the grader’s'), 'Better.');
    await userEvent.click(screen.getByRole('button', { name: 'Save this mark' }));
    expect(await screen.findByText(/the request did not complete/)).toBeInTheDocument();
  });

  it('says the reason is stored and shown to anyone who asks where the mark came from', async () => {
    await draw({ onOverride: vi.fn() });
    expect(
      screen.getByText(/stored with the mark and shown to anyone who asks/),
    ).toBeInTheDocument();
  });
});

describe('the panel is reachable by keyboard alone and audits clean in both states', () => {
  it('re-runs and overrides without a mouse', async () => {
    const onRun = vi.fn();
    const onOverride = vi.fn(async () => ({ ok: true as const, revision: '2' }));
    const { container } = await draw({ replay: null, onRun, onOverride });
    screen.getByRole('button', { name: 'Re-run the grader on this answer' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onRun).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByLabelText('Mark, out of 4'), '3');
    await userEvent.tab();
    await userEvent.keyboard('The trace shows an early stop.');
    await userEvent.tab();
    const save = screen.getByRole('button', { name: 'Save this mark' });
    expect(save).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onOverride).toHaveBeenCalledWith({
      points: 3,
      reason: 'The trace shows an early stop.',
    });
    await assertAccessible(container);
  });

  it('audits clean with a shortened trace on screen, because a status region is the easy miss', async () => {
    const { container } = await draw({
      replay: replay({ trace: trace({ omittedEntries: 40, complete: false }) }),
      onOverride: vi.fn(),
    });
    await assertAccessible(container);
  });

  it('is a named region, so the marking screen can place it', async () => {
    const { container } = render(<AnswerReplay replay={replay()} onRun={vi.fn()} worth={4} />);
    expect(
      within(container).getByRole('region', { name: 'Re-run the simulation’s grader' }),
    ).toBeInTheDocument();
  });
});
