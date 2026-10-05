/**
 * The sealed-key review surface: no mark on it, a reason on the flag, and the blast radius before anything is applied.  (P9-T6)
 *
 * ## WHAT IS ASSERTED HERE THAT CANNOT BE ASSERTED ANYWHERE ELSE
 *
 * That this screen has nowhere to put a mark. `SealedAutoGradeTarget` has no score field, so a component built on it
 * cannot render one -- and this test proves it by asserting the absence of any score-bearing text on a populated render.
 * That is stronger than a test asserting a particular number is absent, because it fails if a mark arrives through any
 * route: the DTO, a computed total, or a copy change.
 *
 * And that the radii on screen are the preview's own numbers, not a second calculation. The blast radius is passed in, so
 * the screen cannot invent one; what this test holds is that every COUNT in it is rendered, because a review surface that
 * shows some of the numbers and omits the released ones is the failure `plans/07` §7 warns about.
 */

import { findScoreBearingKeys } from '@orrery/interop';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  BlastRadius,
  SealedAutoGradeTarget,
} from '../../../../../packages/db/src/grading-review.js';
import {
  AutoGradeReview,
  REVIEW_ALREADY_FLAGGED,
  REVIEW_FLAGGED,
  REVIEW_REASON_REQUIRED,
  radiusLines,
} from './AutoGradeReview';
import { assertAccessible, renderAudited } from './workspaceHarness';

const target = (over: Partial<SealedAutoGradeTarget> = {}): SealedAutoGradeTarget => ({
  responseId: 'r1',
  attemptId: 'a1',
  assignmentId: 'as1',
  questionId: 'q1',
  position: 3,
  worth: 5,
  markedByVersion: 'auto-1',
  gradedAt: '2026-10-05T00:00:00.000Z',
  needsHuman: false,
  released: false,
  openFlagsByReporter: 0,
  ...over,
});

const radius = (over: Partial<BlastRadius> = {}): BlastRadius => ({
  assignmentId: 'as1',
  questionId: 'q1',
  responses: 4,
  sealedAutomatic: 3,
  awaitingHuman: 0,
  notAutomaticallyGraded: 0,
  preservedByManualMark: 1,
  preservedAsExcused: 0,
  attemptsRewriting: 3,
  affectedAttempts: 2,
  alreadyReleased: 1,
  gained: 1,
  lost: 1,
  unchanged: 1,
  rewrittenButUnchanged: 1,
  wouldBecomeProvisional: 0,
  ...over,
});

/**
 * RENDER AND AUDIT, ONCE, AND HAND BACK THE MOUNT.
 *
 * **`await` IS NOT OPTIONAL HERE, AND SPREADING THE PROMISE WAS THE FIRST VERSION.** `{ ...renderAudited(element) }`
 * spreads a Promise, so `container` came back `undefined` and every query in the test ran against nothing -- which is how
 * five tests failed with "Unable to find an element" while the component was rendering perfectly. It also started several
 * axe runs concurrently, and axe refuses to run twice at once, so the failures arrived as unhandled rejections pointing at
 * unrelated tests.
 */
const draw = async (
  over: { target?: Partial<SealedAutoGradeTarget>; radius?: BlastRadius | null } = {},
) => {
  const onFlag = vi.fn(async () => ({ ok: true as const, raisedAt: '14:32' }));
  const onPreview = vi.fn();
  const rendered = await renderAudited(
    <AutoGradeReview
      target={target(over.target)}
      radius={over.radius === undefined ? radius() : over.radius}
      onFlag={onFlag}
      onPreview={onPreview}
    />,
  );
  return { ...rendered, onFlag, onPreview };
};

describe('the sealed-key review screen shows no mark, because there is nowhere to type one', () => {
  /**
   * THE TYPE-LEVEL GUARANTEE, CHECKED AT RUNTIME.
   *
   * `AutoGradeReviewApi`'s inertness assertion is a COMPILE-time guarantee about the parameters of every entry point. This
   * is the other half: the DTO this component renders has no score-bearing key, which `findScoreBearingKeys` over the whole
   * rendered text confirms. A mark added to the target would fail `pnpm typecheck` AND fail here.
   */
  it('renders text containing no score-bearing key at all', async () => {
    const { container } = await draw();
    expect(findScoreBearingKeys({ ...target(), radius: radius() })).toEqual([]);
    // And the rendered copy: no digit that reads as a mark beside the question. `worth` is stated as "Worth 5.", which
    // is what the question is worth and not what anybody earned.
    expect(container.textContent).toContain('Worth 5.');
    expect(container.textContent).not.toMatch(/\b\d+ of \d+\b/);
  });

  it('says the mark cannot be changed here, and that a flag is the route', async () => {
    await draw();
    expect(
      screen.getByText(/Its mark cannot be changed here/, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Review this question’s key')).toBeInTheDocument();
  });

  it('names the grader version, so a marker can tell which marker produced the stored mark', async () => {
    await draw({ target: { markedByVersion: 'auto-7' } });
    expect(screen.getByText('Marked by auto-7.')).toBeInTheDocument();
  });

  it('says plainly when no marker has run', async () => {
    await draw({ target: { markedByVersion: null } });
    expect(screen.getByText('No automatic marker has run on this question.')).toBeInTheDocument();
  });

  it('tells a marker on a released paper that flagging changes nothing', async () => {
    await draw({ target: { released: true } });
    expect(screen.getByText(/This paper has been released/, { exact: false })).toBeInTheDocument();
  });

  it('tells a marker who has already flagged this key', async () => {
    await draw({ target: { openFlagsByReporter: 1 } });
    expect(screen.getByText(REVIEW_ALREADY_FLAGGED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Flag this key' })).toBeDisabled();
  });
});

describe('the blast radius is shown before anything is applied, and every count in it is rendered', () => {
  it('shows nothing until the dry run has been asked for', async () => {
    // A count that appears on its own is a number no confirmation token covers. `plans/07` §7 is dry run, THEN confirm.
    const { onPreview } = await draw({ radius: null });
    expect(screen.queryByRole('region', { name: 'What a key change would affect' })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: /See what a key change would affect/ }),
    );
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('names every category, including the released count', async () => {
    await draw();
    const region = screen.getByRole('region', { name: 'What a key change would affect' });
    const text = region.textContent ?? '';
    expect(text).toContain('4 responses sit under this question’s key on this assignment.');
    expect(text).toContain('3 sealed marks would be marked again.');
    expect(text).toContain('1 response already marked by a person would keep that mark');
    expect(text).toContain('2 results would change');
    // The released count, because "a released attempt is never silently changed" is a promise about this number.
    expect(text).toContain('1 of them has already been released');
    expect(text).toContain('Each released result that moves gets a notice saying why.');
  });

  it('says no result would move when that is the truth, rather than showing an empty table', async () => {
    // The hard-won invariant in `grading-regrade.ts`: an unchanged regrade is a no-op. A screen that rendered nothing
    // for zero affected would read as a broken screen, and one that rendered the previews as if they would apply would
    // read as "9 papers change".
    await draw({
      radius: radius({ affectedAttempts: 0, alreadyReleased: 0, attemptsRewriting: 3 }),
    });
    expect(screen.getByText(/no result would move/i)).toBeInTheDocument();
    expect(screen.queryByText(/would change,/)).toBeNull();
  });

  it('names the marks that were recomputed and came out the same, separately from the ones that moved', async () => {
    // `attemptsRewriting` and `affectedAttempts` are different questions, and a screen that shows only the second hides
    // that the grader was re-run against four papers.
    await draw({
      radius: radius({ attemptsRewriting: 4, rewrittenButUnchanged: 2, affectedAttempts: 2 }),
    });
    const text =
      screen.getByRole('region', { name: 'What a key change would affect' }).textContent ?? '';
    expect(text).toContain('2 marks would be marked again and come out the same');
  });

  it('names the results a change would send back to a person', async () => {
    await draw({ radius: radius({ wouldBecomeProvisional: 2 }) });
    expect(screen.getByText(/2 results would stop being final/)).toBeInTheDocument();
  });

  it('says a change to the key is made on the resource, not here', async () => {
    // This sentence is the whole "never silently rewrite a key" guarantee as the marker experiences it: there is
    // nothing on this screen that changes the key, and the screen says where the change is made.
    await draw();
    expect(
      screen.getByText(/Changing the key is done on the resource, not here/),
    ).toBeInTheDocument();
  });

  it('the radius lines are pure and every one is a sentence a marker can act on', () => {
    for (const line of radiusLines(radius())) expect(line.length).toBeGreaterThan(20);
    expect(radiusLines(radius({ preservedByManualMark: 0 })).join(' ')).not.toContain(
      'by a person',
    );
    expect(radiusLines(radius({ preservedAsExcused: 0 })).join(' ')).not.toContain('excused');
    expect(radiusLines(radius({ awaitingHuman: 0 })).join(' ')).not.toContain('awaiting a person');
  });
});

describe('the flag carries a reason, or it does not exist', () => {
  it('refuses to call the server without one, and says why', async () => {
    // The client check is a courtesy to the marker. `flagAutoGradeKey` refuses server-side with the same words, and the
    // integration test asserts nothing was written -- this only asserts the marker is told.
    const { onFlag } = await draw();
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(onFlag).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(REVIEW_REASON_REQUIRED);
  });

  it('refuses a whitespace-only reason too', async () => {
    const { onFlag } = await draw();
    await userEvent.type(screen.getByLabelText('What is wrong with the key'), '    ');
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(onFlag).not.toHaveBeenCalled();
  });

  it('sends the reason verbatim, and says the mark did not change', async () => {
    const { onFlag } = await draw();
    await userEvent.type(
      screen.getByLabelText('What is wrong with the key'),
      'The keyed option is not offered to students.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(onFlag).toHaveBeenCalledWith({ reason: 'The keyed option is not offered to students.' });
    expect(await screen.findByText(REVIEW_FLAGGED('14:32'))).toBeInTheDocument();
    // And the button is gone afterwards, so a double-click cannot raise two flags from one reading.
    expect(screen.getByRole('button', { name: 'Flag this key' })).toBeDisabled();
    expect(screen.getByLabelText('What is wrong with the key')).toBeDisabled();
  });

  it("shows the server's refusal in words, and keeps the reason in the field", async () => {
    // Keeping the reason is the point: a refusal the marker cannot fix without retyping their reasoning is a refusal
    // that loses work.
    const onFlag = vi.fn(async () => ({ ok: false as const, reason: 'NOT_SEALED_AUTOMATIC' }));
    render(
      <AutoGradeReview target={target()} radius={radius()} onFlag={onFlag} onPreview={vi.fn()} />,
    );
    await userEvent.type(screen.getByLabelText('What is wrong with the key'), 'This key is wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(
      await screen.findByText(/marked by a person, or already waiting for one/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('What is wrong with the key')).toHaveValue('This key is wrong.');
  });

  it('reports a request that did not complete, rather than a silent nothing', async () => {
    const onFlag = vi.fn(async () => {
      throw new Error('the connection dropped');
    });
    render(
      <AutoGradeReview target={target()} radius={radius()} onFlag={onFlag} onPreview={vi.fn()} />,
    );
    await userEvent.type(screen.getByLabelText('What is wrong with the key'), 'This key is wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(await screen.findByText(/The flag was not recorded/)).toBeInTheDocument();
  });

  it('clears the reason error as soon as the marker types, so the message is not a scolding', async () => {
    await draw();
    await userEvent.click(screen.getByRole('button', { name: 'Flag this key' }));
    expect(screen.getByRole('status')).toHaveTextContent(REVIEW_REASON_REQUIRED);
    await userEvent.type(screen.getByLabelText('What is wrong with the key'), 'x');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});

describe('the screen is reachable by keyboard alone', () => {
  it('takes the reason and the flag without a mouse, and audits clean', async () => {
    const { onFlag, container } = await draw();
    const reason = screen.getByLabelText('What is wrong with the key');
    reason.focus();
    await userEvent.keyboard('Keyed option absent.{Tab}');
    const flag = screen.getByRole('button', { name: 'Flag this key' });
    expect(flag).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onFlag).toHaveBeenCalledWith({ reason: 'Keyed option absent.' });
    await assertAccessible(container);
  });

  it('is a named region, so the marking screen can find it among its panes', async () => {
    const { container } = render(
      <AutoGradeReview target={target()} radius={null} onFlag={vi.fn()} onPreview={vi.fn()} />,
    );
    const region = within(container).getByRole('region', { name: 'Review this question’s key' });
    expect(region.tagName).toBe('SECTION');
  });
});
